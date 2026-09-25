"""System Under Test (SUT): a simulated request-processing microservice.

The SUT models a classic 3-stage pipeline:

    ingress -> bounded queue -> worker pool -> downstream dependency -> response

It exposes runtime *knobs* that the fault injector can perturb, and it emits
metrics (latency percentiles, error rate, throughput, queue depth) that the
verifier uses to detect anomalies.

The model is deterministic given a seed, so results are reproducible.
"""

from __future__ import annotations

import math
import random
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional


@dataclass
class Knobs:
    """Runtime knobs the fault injector can modify."""

    # extra latency (ms) added to every downstream call
    downstream_latency_ms: float = 5.0
    # probability [0,1] that a request fails with an injected error
    error_probability: float = 0.0
    # CPU contention factor [0,1]; scales service time
    cpu_load: float = 0.0
    # packet loss probability [0,1] on the downstream link
    packet_loss: float = 0.0
    # memory pressure [0,1]; above threshold the worker slows down
    memory_pressure: float = 0.0
    # hard dependency outage: downstream always fails
    dependency_down: bool = False

    def snapshot(self) -> Dict[str, float]:
        return {
            "downstream_latency_ms": self.downstream_latency_ms,
            "error_probability": self.error_probability,
            "cpu_load": self.cpu_load,
            "packet_loss": self.packet_loss,
            "memory_pressure": self.memory_pressure,
            "dependency_down": float(self.dependency_down),
        }


@dataclass
class Metrics:
    total: int = 0
    ok: int = 0
    failed: int = 0
    latencies_ms: List[float] = field(default_factory=list)
    queue_depth: int = 0
    dropped: int = 0

    def record(self, latency_ms: float, ok: bool) -> None:
        self.total += 1
        self.latencies_ms.append(latency_ms)
        if ok:
            self.ok += 1
        else:
            self.failed += 1

    def percentile(self, p: float) -> float:
        if not self.latencies_ms:
            return 0.0
        s = sorted(self.latencies_ms)
        k = max(0, min(len(s) - 1, int(math.ceil(p / 100.0 * len(s))) - 1))
        return s[k]

    @property
    def error_rate(self) -> float:
        return (self.failed / self.total) if self.total else 0.0

    def summary(self) -> Dict[str, float]:
        return {
            "total": self.total,
            "ok": self.ok,
            "failed": self.failed,
            "error_rate": round(self.error_rate, 4),
            "p50_ms": round(self.percentile(50), 2),
            "p95_ms": round(self.percentile(95), 2),
            "p99_ms": round(self.percentile(99), 2),
            "queue_depth": self.queue_depth,
            "dropped": self.dropped,
        }


class SUT:
    """Simulated service under test."""

    def __init__(
        self,
        seed: int = 1337,
        queue_capacity: int = 64,
        base_service_ms: float = 4.0,
        base_downstream_ms: float = 5.0,
        workers: int = 4,
    ) -> None:
        self.seed = seed
        self.rng = random.Random(seed)
        self.knobs = Knobs(downstream_latency_ms=base_downstream_ms)
        self.base_service_ms = base_service_ms
        self.base_downstream_ms = base_downstream_ms
        self.queue_capacity = queue_capacity
        self.workers = workers
        self.metrics = Metrics()
        self._lock = threading.Lock()
        self._queue: Deque[float] = deque()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        self._running = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        self._running = False

    def reset_metrics(self) -> None:
        with self._lock:
            self.metrics = Metrics()

    # ------------------------------------------------------------------ knobs
    def set_knobs(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                if not hasattr(self.knobs, k):
                    raise KeyError("unknown knob: %s" % k)
                setattr(self.knobs, k, v)

    def reset_knobs(self) -> None:
        with self._lock:
            self.knobs = Knobs(downstream_latency_ms=self.base_downstream_ms)

    def knob_snapshot(self) -> Dict[str, float]:
        with self._lock:
            return self.knobs.snapshot()

    # ------------------------------------------------------------- request path
    def _service_time_ms(self) -> float:
        """Base service time inflated by CPU load and memory pressure."""
        k = self.knobs
        cpu_factor = 1.0 / max(0.05, (1.0 - 0.9 * k.cpu_load))
        mem_factor = 1.0 + 2.0 * max(0.0, k.memory_pressure - 0.7) / 0.3
        jitter = self.rng.uniform(0.85, 1.15)
        return self.base_service_ms * cpu_factor * mem_factor * jitter

    def _downstream_call(self) -> bool:
        """Returns True on success. Applies latency / loss / outage faults."""
        k = self.knobs
        if k.dependency_down:
            return False
        # packet loss -> one retry, then fail
        if self.rng.random() < k.packet_loss:
            if self.rng.random() < k.packet_loss:
                return False
        if self.rng.random() < k.error_probability:
            return False
        return True

    def handle_request(self) -> Dict[str, object]:
        """Synchronous request path with a bounded queue."""
        t0 = time.perf_counter()
        with self._lock:
            if len(self._queue) >= self.queue_capacity:
                self.metrics.dropped += 1
                self.metrics.record(0.0, ok=False)
                return {"ok": False, "reason": "queue_full", "latency_ms": 0.0}
            self._queue.append(t0)
            self.metrics.queue_depth = len(self._queue)

        # wait for a worker slot (simulated by sleeping service time)
        service_ms = self._service_time_ms()
        time.sleep(service_ms / 1000.0)

        with self._lock:
            if self._queue:
                self._queue.popleft()
            self.metrics.queue_depth = len(self._queue)

        # downstream dependency call
        k = self.knobs
        ds_ms = self.base_downstream_ms + k.downstream_latency_ms
        time.sleep(ds_ms / 1000.0)
        ok = self._downstream_call()

        latency_ms = (time.perf_counter() - t0) * 1000.0
        with self._lock:
            self.metrics.record(latency_ms, ok)
        return {"ok": ok, "latency_ms": round(latency_ms, 2)}

    def _worker_loop(self) -> None:  # kept for API symmetry / future async mode
        while not self._stop.is_set():
            time.sleep(0.05)

    # ----------------------------------------------------------------- metrics
    def metrics_summary(self) -> Dict[str, float]:
        with self._lock:
            return self.metrics.summary()

    def health(self) -> Dict[str, object]:
        m = self.metrics_summary()
        healthy = m["error_rate"] < 0.05 and m["p95_ms"] < 100.0
        return {"healthy": healthy, "metrics": m, "knobs": self.knob_snapshot()}
