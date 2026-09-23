"""
system_under_test.py -- A tiny, deterministic pipeline used as the SUT
(system under test) for the fault-injection environment.

It is deliberately simple and pure-Python so the fault harness can exercise
it entirely in-process (no subprocess, no external I/O).
"""

from __future__ import annotations

import time
from typing import List


class Pipeline:
    """fetch -> transform -> aggregate, with a pluggable 'slow' stage."""

    def __init__(self, data: List[int], slow_stage: str = "", slow_s: float = 0.0):
        self.data = list(data)
        self.slow_stage = slow_stage
        self.slow_s = slow_s

    def fetch(self) -> List[int]:
        if self.slow_stage == "fetch":
            time.sleep(self.slow_s)
        return list(self.data)

    def transform(self, rows: List[int]) -> List[int]:
        if self.slow_stage == "transform":
            time.sleep(self.slow_s)
        # square each element; raises on non-int input (a real bug surface)
        return [int(x) ** 2 for x in rows]

    def aggregate(self, rows: List[int]) -> int:
        if self.slow_stage == "aggregate":
            time.sleep(self.slow_s)
        return sum(rows)

    def run(self) -> int:
        return self.aggregate(self.transform(self.fetch()))


def healthy_run() -> int:
    """Reference healthy behaviour: sum of squares of 1..5 = 55."""
    return Pipeline([1, 2, 3, 4, 5]).run()
