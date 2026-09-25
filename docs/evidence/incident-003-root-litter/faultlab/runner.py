"""Experiment runner: baseline -> inject -> observe -> cleanup -> recovery.

Produces a JSON report with the observed anomaly and the recovery check.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Dict, List, Optional

from .injector import FaultInjector
from .sut import SUT


class LoadGenerator:
    """Drives concurrent requests against the SUT and collects responses."""

    def __init__(self, sut: SUT, concurrency: int = 4, rps_target: float = 50.0) -> None:
        self.sut = sut
        self.concurrency = concurrency
        self.rps_target = rps_target
        self._stop = threading.Event()
        self._threads: List[threading.Thread] = []
        self.responses: List[Dict[str, object]] = []
        self._lock = threading.Lock()

    def _worker(self) -> None:
        interval = 1.0 / max(1.0, self.rps_target / self.concurrency)
        while not self._stop.is_set():
            r = self.sut.handle_request()
            with self._lock:
                self.responses.append(r)
            time.sleep(interval)

    def start(self) -> None:
        self._stop.clear()
        self._threads = [
            threading.Thread(target=self._worker, daemon=True)
            for _ in range(self.concurrency)
        ]
        for t in self._threads:
            t.start()

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2.0)
        self._threads = []

    def clear(self) -> None:
        with self._lock:
            self.responses = []


def _phase(sut: SUT, load: LoadGenerator, seconds: float) -> Dict[str, float]:
    sut.reset_metrics()
    load.clear()
    time.sleep(seconds)
    return sut.metrics_summary()


def run_experiment(
    fault: str,
    intensity: float = 0.5,
    duration_s: float = 2.0,
    baseline_s: float = 1.5,
    recovery_s: float = 1.5,
    concurrency: int = 4,
    rps_target: float = 60.0,
    seed: int = 1337,
) -> Dict[str, object]:
    """Run one full fault-injection experiment and return a JSON-able report."""
    sut = SUT(seed=seed)
    sut.start()
    load = LoadGenerator(sut, concurrency=concurrency, rps_target=rps_target)
    injector = FaultInjector(sut)

    report: Dict[str, object] = {
        "fault": fault,
        "intensity": intensity,
        "duration_s": duration_s,
        "seed": seed,
        "phases": {},
    }

    try:
        load.start()
        # 1) baseline
        baseline = _phase(sut, load, baseline_s)
        report["phases"]["baseline"] = baseline

        # 2) inject + observe
        inj = injector.inject(fault, intensity, duration_s)
        report["injection"] = inj.to_dict()
        during = _phase(sut, load, duration_s)
        report["phases"]["during_fault"] = during

        # 3) cleanup / rollback
        injector.revert()
        report["knobs_after_cleanup"] = sut.knob_snapshot()

        # 4) recovery
        recovered = _phase(sut, load, recovery_s)
        report["phases"]["after_cleanup"] = recovered

        # ---- anomaly + recovery verdicts
        anomaly = (
            during["error_rate"] > baseline["error_rate"] + 0.10
            or during["p95_ms"] > max(baseline["p95_ms"] * 2.0, baseline["p95_ms"] + 20.0)
        )
        recovered_ok = (
            recovered["error_rate"] <= baseline["error_rate"] + 0.10
            and recovered["p95_ms"] <= max(baseline["p95_ms"] * 2.0, baseline["p95_ms"] + 20.0)
        )
        report["anomaly_detected"] = bool(anomaly)
        report["recovered"] = bool(recovered_ok)
        report["journal"] = injector.journal_dicts()
    finally:
        load.stop()
        injector.revert_all()
        sut.stop()

    return report


def main(argv: Optional[List[str]] = None) -> int:
    import argparse

    p = argparse.ArgumentParser(description="FaultLab experiment runner")
    p.add_argument("--fault", required=True,
                   choices=["latency", "error", "cpu", "network", "memory", "outage"])
    p.add_argument("--intensity", type=float, default=0.5)
    p.add_argument("--duration", type=float, default=2.0)
    p.add_argument("--baseline", type=float, default=1.5)
    p.add_argument("--recovery", type=float, default=1.5)
    p.add_argument("--concurrency", type=int, default=4)
    p.add_argument("--rps", type=float, default=60.0)
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--out", default=None, help="write JSON report to this path")
    args = p.parse_args(argv)

    rep = run_experiment(
        fault=args.fault,
        intensity=args.intensity,
        duration_s=args.duration,
        baseline_s=args.baseline,
        recovery_s=args.recovery,
        concurrency=args.concurrency,
        rps_target=args.rps,
        seed=args.seed,
    )
    text = json.dumps(rep, indent=2)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    return 0 if (rep["anomaly_detected"] and rep["recovered"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
