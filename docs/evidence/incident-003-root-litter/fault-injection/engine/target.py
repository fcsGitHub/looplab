"""In-process TargetService -- the system under test (SUT).

A minimal request handler that consults a FaultInjector before doing its
"work". The HTTP target (target/app.py) wraps exactly this logic.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, List, Optional

from faults import FaultInjector, FaultError


@dataclass
class Response:
    ok: bool
    latency_ms: float
    status: int
    error: Optional[str] = None


class TargetService:
    def __init__(self, injector: Optional[FaultInjector] = None) -> None:
        self.injector = injector or FaultInjector()
        self._served = 0
        self._errors = 0

    def handle(self, work_ms: float = 1.0) -> Response:
        """Handle one request. Baseline work is `work_ms` of sleep."""
        t0 = time.perf_counter()
        try:
            self.injector.apply()
            time.sleep(work_ms / 1000.0)
            self._served += 1
            return Response(True, (time.perf_counter() - t0) * 1000.0, 200)
        except FaultError as e:
            self._served += 1
            self._errors += 1
            return Response(False, (time.perf_counter() - t0) * 1000.0, 503, str(e))

    def metrics(self) -> Dict:
        return {
            "served": self._served,
            "errors": self._errors,
            "error_rate": (self._errors / self._served) if self._served else 0.0,
            "allocated_bytes": self.injector.allocated_bytes(),
            "active_fault": (self.injector.active().to_dict()
                             if self.injector.active() else None),
        }


def percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)
