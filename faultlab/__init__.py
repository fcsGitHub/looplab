"""faultlab: sandbox-compatible fault injection test environment.

Design constraints (discovered by diagnosis):
  * subprocess.Popen is DENIED by the sandbox -> no process spawning.
  * socket.getaddrinfo / network is DENIED -> no network faults.
  * tempfile.gettempdir() is redirected INTO the workspace -> temp files are fine
    as long as they stay under the workspace.

Therefore faults are injected IN-PROCESS by wrapping callables of a target
object with deterministic fault behaviours (raise / delay / corrupt / drop).
"""

from .harness import FaultInjector, FaultSpec, FaultKind, run_scenario
from .target import ServiceUnderTest

__all__ = [
    "FaultInjector",
    "FaultSpec",
    "FaultKind",
    "run_scenario",
    "ServiceUnderTest",
]
