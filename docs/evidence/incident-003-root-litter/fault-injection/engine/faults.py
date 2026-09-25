"""Fault catalogue and injector.

This module is the single source of truth for fault behaviour. It is imported
by both the in-process reference runtime (engine/run_demo.py) and the HTTP
injector sidecar (injector/app.py), so a scenario behaves identically in both.

Pure standard library. No network, no subprocess.
"""
from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# --------------------------------------------------------------------------- #
# Fault specification
# --------------------------------------------------------------------------- #
@dataclass
class FaultSpec:
    kind: str                 # latency | error | cpu | memory | partition
    intensity: float          # meaning depends on kind (see README)
    duration: float = 0.0     # seconds; 0 == until explicitly cleared
    started_at: float = field(default_factory=time.time)

    def expired(self, now: Optional[float] = None) -> bool:
        if self.duration <= 0:
            return False
        now = time.time() if now is None else now
        return (now - self.started_at) >= self.duration

    def to_dict(self) -> Dict:
        return {
            "kind": self.kind,
            "intensity": self.intensity,
            "duration": self.duration,
            "started_at": self.started_at,
        }


SUPPORTED_FAULTS = ("latency", "error", "cpu", "memory", "partition")


class FaultError(RuntimeError):
    """Raised by the injector to simulate an injected failure."""


# --------------------------------------------------------------------------- #
# Injector
# --------------------------------------------------------------------------- #
class FaultInjector:
    """Holds the active fault and applies it to requests.

    ``apply`` is called by the target service on every request. It may:
      * sleep            (latency)
      * raise FaultError (error / partition)
      * burn CPU         (cpu)
      * allocate memory  (memory)
    """

    def __init__(self, seed: Optional[int] = None) -> None:
        self._lock = threading.Lock()
        self._fault: Optional[FaultSpec] = None
        self._rng = random.Random(seed)
        self._allocated: List[bytearray] = []
        self._history: List[Dict] = []

    # -- control ---------------------------------------------------------- #
    def set_fault(self, kind: str, intensity: float, duration: float = 0.0) -> FaultSpec:
        if kind not in SUPPORTED_FAULTS:
            raise ValueError(f"unsupported fault {kind!r}; choose from {SUPPORTED_FAULTS}")
        if kind in ("error", "partition") and not (0.0 <= intensity <= 1.0):
            raise ValueError(f"{kind} intensity must be a rate in [0, 1]")
        if kind == "latency" and intensity < 0:
            raise ValueError("latency intensity must be >= 0 ms")
        if kind == "cpu" and intensity < 1:
            raise ValueError("cpu intensity must be >= 1 (blocked worker count)")
        if kind == "memory" and intensity < 0:
            raise ValueError("memory intensity must be >= 0 MB")
        spec = FaultSpec(kind=kind, intensity=float(intensity), duration=float(duration))
        with self._lock:
            self._fault = spec
            self._history.append(spec.to_dict())
        return spec

    def clear(self) -> None:
        with self._lock:
            self._fault = None
            self._allocated.clear()

    def active(self) -> Optional[FaultSpec]:
        with self._lock:
            f = self._fault
            if f is not None and f.expired():
                self._fault = None
                self._allocated.clear()
                return None
            return f

    def history(self) -> List[Dict]:
        with self._lock:
            return list(self._history)

    # -- application ------------------------------------------------------ #
    def apply(self) -> None:
        """Apply the active fault to the current request. Called by the SUT."""
        f = self.active()
        if f is None:
            return
        if f.kind == "latency":
            time.sleep(f.intensity / 1000.0)
        elif f.kind == "error":
            if self._rng.random() < f.intensity:
                raise FaultError(f"injected error (rate={f.intensity})")
        elif f.kind == "cpu":
            # Burn CPU proportional to intensity for a short, bounded slice.
            deadline = time.perf_counter() + min(0.05, 0.005 * f.intensity)
            x = 0
            while time.perf_counter() < deadline:
                x += 1
        elif f.kind == "memory":
            # Allocate intensity MB and retain it (released on clear()).
            self._allocated.append(bytearray(int(f.intensity) * 1024 * 1024))
        elif f.kind == "partition":
            if self._rng.random() < f.intensity:
                raise FaultError(f"network partition (drop rate={f.intensity})")

    def allocated_bytes(self) -> int:
        with self._lock:
            return sum(len(b) for b in self._allocated)
