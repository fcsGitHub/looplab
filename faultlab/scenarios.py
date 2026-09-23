"""Concrete fault-injection scenarios exercised against ServiceUnderTest."""

from __future__ import annotations

from typing import List

from .harness import FaultKind, FaultSpec, ScenarioResult, run_scenario
from .target import ServiceError, ServiceUnderTest


def _exercise_basic(svc: ServiceUnderTest) -> dict:
    svc.put("a", 1)
    svc.flush()
    return {"value": svc.get("a"), "deviation": False}


def _exercise_compute(svc: ServiceUnderTest) -> dict:
    return {"value": svc.compute(21), "deviation": False}


def _exercise_flush(svc: ServiceUnderTest) -> dict:
    svc.put("x", 10)
    n = svc.flush()
    return {"flushed": n, "value": svc.get("x"), "deviation": False}


def build_scenarios() -> List[tuple]:
    """Return (name, faults, exercise) triples."""
    return [
        ("baseline_no_fault", [], _exercise_basic),
        ("get_raises", [FaultSpec("get", FaultKind.RAISE, message="db down")], _exercise_basic),
        ("get_drops", [FaultSpec("get", FaultKind.DROP)], _exercise_basic),
        ("compute_corrupts", [FaultSpec("compute", FaultKind.CORRUPT)], _exercise_compute),
        ("flush_delayed", [FaultSpec("flush", FaultKind.DELAY, magnitude=0.05)], _exercise_flush),
        ("get_raises_once_then_recovers",
         [FaultSpec("get", FaultKind.RAISE, times=1, message="transient")],
         _exercise_basic),
    ]


def run_all() -> List[ScenarioResult]:
    results = []
    for name, faults, exercise in build_scenarios():
        svc = ServiceUnderTest()
        results.append(run_scenario(name, svc, faults, exercise))
    return results
