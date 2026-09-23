"""
fault_injector.py -- Sandbox-compatible fault injection primitives.

WHY THIS EXISTS (root-cause of the repeated "unknown" failures):
The original task ("build a fault-injection test environment & script") was
implemented by spawning child processes (subprocess/os.system) to inject
crash / timeout / error faults, and by writing scratch files to the system
temp dir.  The execution sandbox (LOOPLAB_SANDBOX) denies BOTH:
    * subprocess.Popen  -> PermissionError: LOOPLAB_SANDBOX: subprocess.Popen denied
    * os.system         -> PermissionError: LOOPLAB_SANDBOX: os.system denied
    * any open() outside the attempt workspace (incl. %TEMP%)
so every attempt aborted with a PermissionError that the outer harness
reported as an opaque `unknown` error.  Retrying the same design cannot work.

This module therefore injects faults *in-process* using only the standard
library and only workspace-local I/O:
    * crash   -> raise a chosen exception inside the target call
    * error   -> return a corrupted / wrong-typed value
    * timeout -> run the target in a daemon thread guarded by a deadline
    * delay   -> sleep a bounded amount before returning
    * silent  -> swallow the result and return None
    * flaky   -> fail the first N invocations, then succeed
No subprocess, no signals (SIGALRM is unavailable on Windows), no external paths.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional


# --------------------------------------------------------------------------
# Fault specification
# --------------------------------------------------------------------------
@dataclass
class Fault:
    """A single fault to inject into a target callable."""
    kind: str                      # crash | error | timeout | delay | silent | flaky
    target: str = "*"              # name of the callable to hit ("*" = any)
    times: int = 1                 # how many matching invocations to affect
    delay_s: float = 0.0           # for kind == "delay"
    timeout_s: float = 0.0         # for kind == "timeout" (deadline for the call)
    exc_type: str = "RuntimeError" # for kind == "crash"
    message: str = "injected fault"
    return_value: Any = None       # for kind == "error"
    seed: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------
# Result records
# --------------------------------------------------------------------------
@dataclass
class InjectionRecord:
    fault_kind: str
    target: str
    invocation: int
    outcome: str          # raised | returned | timed_out | delayed | swallowed
    detail: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RunResult:
    value: Any = None
    raised: Optional[str] = None
    raised_type: Optional[str] = None
    timed_out: bool = False
    elapsed_s: float = 0.0
    records: List[InjectionRecord] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["value_repr"] = repr(self.value)
        d.pop("value", None)
        return d


# --------------------------------------------------------------------------
# The injector
# --------------------------------------------------------------------------
class FaultInjector:
    """In-process fault injector.

    Usage:
        inj = FaultInjector([Fault(kind="crash", target="step", times=1)])
        result = inj.run(lambda: my_pipeline())
    """

    def __init__(self, faults: Optional[List[Fault]] = None):
        self.faults: List[Fault] = list(faults or [])
        self.records: List[InjectionRecord] = []
        self._counters: Dict[str, int] = {}
        self._lock = threading.Lock()

    # -- fault bookkeeping -------------------------------------------------
    def _next_fault_for(self, target: str) -> Optional[Fault]:
        """Return the next applicable fault for `target`, consuming one use."""
        with self._lock:
            for f in self.faults:
                if f.times <= 0:
                    continue
                if f.target not in ("*", target):
                    continue
                f.times -= 1
                return f
        return None

    def _record(self, kind: str, target: str, invocation: int,
                outcome: str, detail: str = "") -> None:
        self.records.append(InjectionRecord(kind, target, invocation, outcome, detail))

    @staticmethod
    def _resolve_exc(name: str) -> type:
        import builtins
        exc = getattr(builtins, name, None)
        if isinstance(exc, type) and issubclass(exc, BaseException):
            return exc
        return RuntimeError

    # -- the guarded call --------------------------------------------------
    def call(self, fn: Callable[..., Any], *args, name: str = "call", **kwargs) -> Any:
        """Invoke `fn`, applying at most one fault for this invocation."""
        self._counters[name] = self._counters.get(name, 0) + 1
        invocation = self._counters[name]

        fault = self._next_fault_for(name)
        if fault is None:
            return fn(*args, **kwargs)

        if fault.kind == "crash":
            self._record("crash", name, invocation, "raised", fault.exc_type)
            exc = self._resolve_exc(fault.exc_type)
            raise exc(fault.message)

        if fault.kind == "error":
            self._record("error", name, invocation, "returned",
                         "corrupted value=%r" % (fault.return_value,))
            return fault.return_value

        if fault.kind == "silent":
            self._record("silent", name, invocation, "swallowed")
            return None

        if fault.kind == "delay":
            self._record("delay", name, invocation, "delayed", "%ss" % fault.delay_s)
            time.sleep(max(0.0, fault.delay_s))
            return fn(*args, **kwargs)

        if fault.kind == "timeout":
            # Run the real call in a daemon thread; if it exceeds the deadline
            # we abandon it (in-process, no signals, no subprocess).
            box: Dict[str, Any] = {}

            def _worker():
                try:
                    box["value"] = fn(*args, **kwargs)
                except BaseException as e:  # noqa: BLE001
                    box["exc"] = e

            t = threading.Thread(target=_worker, daemon=True)
            t.start()
            t.join(fault.timeout_s if fault.timeout_s > 0 else 0.001)
            if t.is_alive():
                self._record("timeout", name, invocation, "timed_out",
                             "deadline=%ss" % fault.timeout_s)
                raise TimeoutError(
                    "injected timeout: %s exceeded %ss" % (name, fault.timeout_s))
            if "exc" in box:
                raise box["exc"]
            return box.get("value")

        if fault.kind == "flaky":
            self._record("flaky", name, invocation, "raised", "flaky failure")
            raise RuntimeError(fault.message or "flaky failure")

        raise ValueError("unknown fault kind: %r" % (fault.kind,))

    # -- top-level run -----------------------------------------------------
    def run(self, fn: Callable[[], Any]) -> RunResult:
        """Run `fn` once, capturing value / exception / timeout."""
        res = RunResult()
        start = time.perf_counter()
        try:
            res.value = fn()
        except TimeoutError as e:
            res.timed_out = True
            res.raised = str(e)
            res.raised_type = "TimeoutError"
        except BaseException as e:  # noqa: BLE001
            res.raised = str(e)
            res.raised_type = type(e).__name__
        res.elapsed_s = time.perf_counter() - start
        res.records = list(self.records)
        return res
