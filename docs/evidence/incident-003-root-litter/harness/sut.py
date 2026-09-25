"""In-process service under test (SUT).

Models a small request handler with a downstream dependency. The SUT exposes
its own state (``down``, ``cpu_budget_ms``, ``mem_budget_mb``) so resource and
availability injectors can perturb it and cleanly restore it afterwards.
"""
from __future__ import annotations

import time
from typing import Optional


class Downstream:
    """A dependency the SUT calls on every request."""

    def __init__(self) -> None:
        self.error_prob = 0.0  # set by dependency_error injector

    def call(self, request: dict) -> dict:
        if self.error_prob > 0.0 and _rand() < self.error_prob:
            raise RuntimeError("downstream unavailable")
        return {"dep": "ok"}


class SUT:
    def __init__(self) -> None:
        self.down = False
        self.cpu_budget_ms = 0.0
        self.mem_budget_mb = 0.0
        self.downstream = Downstream()
        self._sink: list = []

    # ---- lifecycle ----------------------------------------------------
    def start(self) -> None:
        self.down = False

    def stop(self) -> None:
        self.down = True

    def reset(self) -> None:
        """Full restore to pristine state (used by rollback)."""
        self.down = False
        self.cpu_budget_ms = 0.0
        self.mem_budget_mb = 0.0
        self.downstream.error_prob = 0.0
        self._sink.clear()

    # ---- request handling --------------------------------------------
    def handle(self, request: dict) -> dict:
        if self.down:
            raise ConnectionError("SUT instance is down")

        # resource pressure: burn CPU / allocate memory per request
        if self.cpu_budget_ms > 0:
            _burn_cpu(self.cpu_budget_ms)
        if self.mem_budget_mb > 0:
            self._sink.append(bytearray(int(self.mem_budget_mb * 1024 * 1024)))
            if len(self._sink) > 8:  # bounded, then simulate OOM-style failure
                self._sink.clear()
                raise MemoryError("SUT memory pressure")

        dep = self.downstream.call(request)
        return {"status": "ok", "echo": request.get("payload"), "dep": dep["dep"]}


def _burn_cpu(ms: float) -> None:
    end = time.perf_counter() + ms / 1000.0
    x = 0
    while time.perf_counter() < end:
        x = (x * 31 + 7) % 1000003


def _rand() -> float:
    # deterministic-ish jitter source; injectors set explicit probabilities
    import random

    return random.random()
