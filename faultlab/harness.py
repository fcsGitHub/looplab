"""In-process fault injection harness (sandbox-compatible).

Faults are applied by temporarily replacing an attribute of a target object
with a wrapper that exhibits the fault behaviour. No subprocesses, no sockets,
no writes outside the workspace.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional


class FaultKind(str, Enum):
    RAISE = "raise"        # operation raises an injected exception
    DELAY = "delay"        # operation sleeps for `magnitude` seconds
    CORRUPT = "corrupt"    # operation returns a corrupted value
    DROP = "drop"          # operation silently does nothing (returns None)


@dataclass
class FaultSpec:
    """Declarative description of one fault."""

    target: str            # attribute name on the service, e.g. "get"
    kind: FaultKind
    magnitude: float = 0.0  # seconds for DELAY, ignored otherwise
    times: int = 1          # how many calls are affected (>=1); -1 = forever
    message: str = "injected fault"

    def __post_init__(self) -> None:
        if not isinstance(self.kind, FaultKind):
            self.kind = FaultKind(self.kind)
        if self.times == 0:
            raise ValueError("times must be >=1 or -1")


class _Injected(Exception):
    """Marker exception raised by RAISE faults."""


class FaultInjector:
    """Context manager that applies a list of FaultSpec to a target object."""

    def __init__(self, target: Any, specs: List[FaultSpec]):
        self.target = target
        self.specs = list(specs)
        self._originals: Dict[str, Callable[..., Any]] = {}
        self._remaining: Dict[str, int] = {}
        self.triggered: Dict[str, int] = {}

    # -- context management -------------------------------------------------
    def __enter__(self) -> "FaultInjector":
        for spec in self.specs:
            self._install(spec)
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.restore()
        return False

    # -- internals ----------------------------------------------------------
    def _install(self, spec: FaultSpec) -> None:
        name = spec.target
        if not hasattr(self.target, name):
            raise AttributeError(f"target has no attribute {name!r}")
        if name not in self._originals:
            self._originals[name] = getattr(self.target, name)
            self._remaining[name] = spec.times
            self.triggered[name] = 0
        original = self._originals[name]

        def wrapper(*args, _spec=spec, _orig=original, **kwargs):
            key = _spec.target
            left = self._remaining.get(key, 0)
            if left == 0:
                return _orig(*args, **kwargs)
            if left > 0:
                self._remaining[key] = left - 1
            self.triggered[key] = self.triggered.get(key, 0) + 1
            return self._apply(_spec, _orig, args, kwargs)

        setattr(self.target, name, wrapper)

    @staticmethod
    def _apply(spec: FaultSpec, original, args, kwargs):
        if spec.kind is FaultKind.RAISE:
            raise _Injected(spec.message)
        if spec.kind is FaultKind.DELAY:
            time.sleep(spec.magnitude)
            return original(*args, **kwargs)
        if spec.kind is FaultKind.CORRUPT:
            real = original(*args, **kwargs)
            if isinstance(real, int):
                return real + 1  # off-by-one corruption
            if isinstance(real, str):
                return real[::-1]
            return None
        if spec.kind is FaultKind.DROP:
            return None
        raise AssertionError(f"unhandled fault kind {spec.kind}")

    def restore(self) -> None:
        for name, original in self._originals.items():
            setattr(self.target, name, original)
        self._originals.clear()


@dataclass
class ScenarioResult:
    name: str
    faults: List[FaultSpec]
    observed: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    duration_s: float = 0.0

    @property
    def fault_detected(self) -> bool:
        """True if the injected fault produced an observable deviation."""
        return bool(self.observed.get("deviation"))


def run_scenario(name: str, service, faults: List[FaultSpec], exercise) -> ScenarioResult:
    """Run one scenario: apply faults, run `exercise(service)`, record outcome.

    `exercise` returns a dict of observations. Any exception is captured, not
    propagated, so a scenario never crashes the harness.
    """
    result = ScenarioResult(name=name, faults=list(faults))
    t0 = time.perf_counter()
    injector = FaultInjector(service, faults)
    try:
        with injector:
            result.observed = exercise(service) or {}
    except _Injected as e:
        result.observed = {"deviation": True, "raised": f"_Injected: {e}"}
    except Exception as e:  # noqa: BLE001 - harness must never crash
        result.observed = {"deviation": True, "raised": f"{type(e).__name__}: {e}"}
    finally:
        result.duration_s = time.perf_counter() - t0
        result.observed.setdefault("triggered", dict(injector.triggered))
    return result
