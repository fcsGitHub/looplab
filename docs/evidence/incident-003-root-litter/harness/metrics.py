"""Latency / error / throughput metric collection for the harness."""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import List


@dataclass
class Window:
    """Metrics collected over one observation window."""

    name: str
    latencies_ms: List[float] = field(default_factory=list)
    errors: int = 0
    total: int = 0
    wall_s: float = 0.0

    def record(self, latency_ms: float, ok: bool) -> None:
        self.latencies_ms.append(latency_ms)
        self.total += 1
        if not ok:
            self.errors += 1

    @property
    def error_rate(self) -> float:
        return (self.errors / self.total) if self.total else 0.0

    @property
    def throughput(self) -> float:
        return (self.total / self.wall_s) if self.wall_s > 0 else 0.0

    def percentile(self, p: float) -> float:
        if not self.latencies_ms:
            return 0.0
        xs = sorted(self.latencies_ms)
        if len(xs) == 1:
            return xs[0]
        k = (len(xs) - 1) * p
        lo = int(k)
        hi = min(lo + 1, len(xs) - 1)
        frac = k - lo
        return xs[lo] * (1 - frac) + xs[hi] * frac

    def summary(self) -> dict:
        return {
            "name": self.name,
            "requests": self.total,
            "errors": self.errors,
            "error_rate": round(self.error_rate, 4),
            "throughput_rps": round(self.throughput, 2),
            "latency_p50_ms": round(self.percentile(0.50), 3),
            "latency_p95_ms": round(self.percentile(0.95), 3),
            "latency_mean_ms": round(
                statistics.fmean(self.latencies_ms) if self.latencies_ms else 0.0, 3
            ),
            "wall_s": round(self.wall_s, 3),
        }
