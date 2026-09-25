"""Fault injector: applies parameterized faults to the SUT for a duration.

Each fault type maps an *intensity* in [0,1] onto concrete SUT knobs:

    latency   -> downstream_latency_ms = base + intensity * MAX_EXTRA_MS
    error     -> error_probability     = intensity
    cpu       -> cpu_load              = intensity
    network   -> packet_loss           = intensity
    memory    -> memory_pressure       = intensity
    outage    -> dependency_down       = True (intensity ignored / must be > 0)

The injector records an *injection journal* so that cleanup can restore the
exact pre-injection state (full rollback).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .sut import SUT

MAX_EXTRA_LATENCY_MS = 500.0

FAULT_TYPES = ("latency", "error", "cpu", "network", "memory", "outage")


@dataclass
class Injection:
    fault: str
    intensity: float
    duration_s: float
    started_at: float
    ended_at: Optional[float] = None
    knobs_before: Dict[str, float] = field(default_factory=dict)
    knobs_applied: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, object]:
        return {
            "fault": self.fault,
            "intensity": self.intensity,
            "duration_s": self.duration_s,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "knobs_before": self.knobs_before,
            "knobs_applied": self.knobs_applied,
        }


def knobs_for(fault: str, intensity: float, base_downstream_ms: float) -> Dict[str, float]:
    """Translate (fault, intensity) into concrete knob values."""
    if fault not in FAULT_TYPES:
        raise ValueError("unknown fault type %r (choose from %s)" % (fault, FAULT_TYPES))
    i = max(0.0, min(1.0, float(intensity)))
    if fault == "latency":
        return {"downstream_latency_ms": base_downstream_ms + i * MAX_EXTRA_LATENCY_MS}
    if fault == "error":
        return {"error_probability": i}
    if fault == "cpu":
        return {"cpu_load": i}
    if fault == "network":
        return {"packet_loss": i}
    if fault == "memory":
        return {"memory_pressure": i}
    if fault == "outage":
        return {"dependency_down": True}
    raise ValueError(fault)


class FaultInjector:
    """Applies and reverts faults on a SUT instance."""

    def __init__(self, sut: SUT) -> None:
        self.sut = sut
        self.journal: List[Injection] = []
        self._active: Optional[Injection] = None

    # ------------------------------------------------------------------ inject
    def inject(self, fault: str, intensity: float = 0.5, duration_s: float = 2.0) -> Injection:
        if self._active is not None:
            raise RuntimeError("a fault is already active; revert it first")
        before = self.sut.knob_snapshot()
        applied = knobs_for(fault, intensity, self.sut.base_downstream_ms)
        self.sut.set_knobs(**applied)
        inj = Injection(
            fault=fault,
            intensity=float(intensity),
            duration_s=float(duration_s),
            started_at=time.time(),
            knobs_before=before,
            knobs_applied=applied,
        )
        self._active = inj
        self.journal.append(inj)
        return inj

    def wait(self) -> None:
        """Block for the active fault's duration."""
        if self._active is None:
            return
        time.sleep(self._active.duration_s)

    # ------------------------------------------------------------------ revert
    def revert(self) -> Optional[Injection]:
        """Restore the SUT to its pre-injection state (full rollback)."""
        if self._active is None:
            return None
        inj = self._active
        self.sut.set_knobs(**inj.knobs_before)
        inj.ended_at = time.time()
        self._active = None
        return inj

    def revert_all(self) -> None:
        while self._active is not None:
            self.revert()
        self.sut.reset_knobs()

    @property
    def active(self) -> Optional[Injection]:
        return self._active

    def journal_dicts(self) -> List[Dict[str, object]]:
        return [i.to_dict() for i in self.journal]
