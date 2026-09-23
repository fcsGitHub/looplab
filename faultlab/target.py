"""A tiny in-process service used as the target of fault injection.

It deliberately has no external dependencies (no sockets, no subprocesses) so
that it runs inside the restricted sandbox.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List


class ServiceError(Exception):
    """Raised by the service when an operation fails."""


@dataclass
class ServiceUnderTest:
    """A minimal key/value service with retry-free, observable operations.

    Operations:
        get(key)        -> value or raises ServiceError(KeyError)
        put(key, value) -> stores value
        compute(n)      -> returns n * 2 (pure, used for corruption faults)
        flush()         -> persists buffered writes (used for delay faults)
    """

    store: Dict[str, Any] = field(default_factory=dict)
    buffer: List[Any] = field(default_factory=list)
    calls: Dict[str, int] = field(default_factory=dict)

    def _count(self, name: str) -> None:
        self.calls[name] = self.calls.get(name, 0) + 1

    def get(self, key: str) -> Any:
        self._count("get")
        if key not in self.store:
            raise ServiceError(f"missing key: {key}")
        return self.store[key]

    def put(self, key: str, value: Any) -> None:
        self._count("put")
        self.buffer.append((key, value))

    def compute(self, n: int) -> int:
        self._count("compute")
        return n * 2

    def flush(self) -> int:
        self._count("flush")
        time.sleep(0.001)  # simulate small IO latency
        for k, v in self.buffer:
            self.store[k] = v
        n = len(self.buffer)
        self.buffer.clear()
        return n
