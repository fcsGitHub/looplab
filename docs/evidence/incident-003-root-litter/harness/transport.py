"""Pluggable transport between the load generator and the SUT.

The transport is the single fault-injection point for network-class faults.
An injector installs a *hook* here; when the hook is removed the transport is
byte-for-byte back to its original behaviour (clean rollback).
"""
from __future__ import annotations

import random
import time
from typing import Callable, Optional


class TransportError(Exception):
    """Raised when the transport drops / resets a request."""


class Transport:
    def __init__(self, seed: int = 1234) -> None:
        self._rng = random.Random(seed)
        # hook signature: (request) -> None ; may sleep, raise, or mutate.
        self._hook: Optional[Callable[[dict], None]] = None
        self.calls = 0

    # ---- fault injection surface -------------------------------------
    def install_hook(self, hook: Callable[[dict], None]) -> None:
        self._hook = hook

    def remove_hook(self) -> None:
        self._hook = None

    @property
    def hook_installed(self) -> bool:
        return self._hook is not None

    # ---- request path -------------------------------------------------
    def send(self, request: dict, handler: Callable[[dict], dict]) -> dict:
        self.calls += 1
        if self._hook is not None:
            self._hook(request)  # may sleep / raise TransportError
        return handler(request)

    @property
    def rng(self) -> random.Random:
        return self._rng
