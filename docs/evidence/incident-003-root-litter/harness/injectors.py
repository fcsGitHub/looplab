"""One injector per fault id.

Each injector implements the same tiny interface so the runner can treat them
uniformly:

    injector.activate(intensity, duration)   -> installs the fault
    injector.deactivate()                    -> removes the fault (rollback)
    injector.active                          -> bool

``intensity`` in [0, 1] scales the fault strength; ``duration`` is advisory for
the container runtime (Chaos Mesh / Toxiproxy carry their own timers) and is
enforced by the runner's observation window in the harness.
"""
from __future__ import annotations

import time
from typing import Optional

from .sut import SUT
from .transport import Transport, TransportError


class BaseInjector:
    id = "base"

    def __init__(self, sut: SUT, transport: Transport) -> None:
        self.sut = sut
        self.transport = transport
        self.active = False
        self.intensity = 0.0
        self.duration = 0.0

    def activate(self, intensity: float, duration: float) -> None:
        raise NotImplementedError

    def deactivate(self) -> None:
        raise NotImplementedError


class LatencyInjector(BaseInjector):
    id = "latency"
    MAX_SLEEP_S = 0.20

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        sleep_s = self.MAX_SLEEP_S * intensity

        def hook(request: dict) -> None:
            time.sleep(sleep_s)

        self.transport.install_hook(hook)
        self.active = True

    def deactivate(self) -> None:
        self.transport.remove_hook()
        self.active = False


class PacketLossInjector(BaseInjector):
    id = "packet_loss"
    MAX_DROP_PROB = 0.9

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        prob = self.MAX_DROP_PROB * intensity

        def hook(request: dict) -> None:
            if self.transport.rng.random() < prob:
                raise TransportError("packet dropped")

        self.transport.install_hook(hook)
        self.active = True

    def deactivate(self) -> None:
        self.transport.remove_hook()
        self.active = False


class CpuStressInjector(BaseInjector):
    id = "cpu_stress"
    MAX_BURN_MS = 40.0

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        self.sut.cpu_budget_ms = self.MAX_BURN_MS * intensity
        self.active = True

    def deactivate(self) -> None:
        self.sut.cpu_budget_ms = 0.0
        self.active = False


class MemoryStressInjector(BaseInjector):
    id = "memory_stress"
    MAX_ALLOC_MB = 32.0

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        self.sut.mem_budget_mb = self.MAX_ALLOC_MB * intensity
        self.active = True

    def deactivate(self) -> None:
        self.sut.mem_budget_mb = 0.0
        self.sut._sink.clear()
        self.active = False


class PodKillInjector(BaseInjector):
    id = "pod_kill"

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        self.sut.stop()
        self.active = True

    def deactivate(self) -> None:
        self.sut.start()
        self.active = False


class DependencyErrorInjector(BaseInjector):
    id = "dependency_error"
    MAX_ERROR_PROB = 0.9

    def activate(self, intensity: float, duration: float) -> None:
        self.intensity, self.duration = intensity, duration
        self.sut.downstream.error_prob = self.MAX_ERROR_PROB * intensity
        self.active = True

    def deactivate(self) -> None:
        self.sut.downstream.error_prob = 0.0
        self.active = False


REGISTRY = {
    cls.id: cls
    for cls in (
        LatencyInjector,
        PacketLossInjector,
        CpuStressInjector,
        MemoryStressInjector,
        PodKillInjector,
        DependencyErrorInjector,
    )
}


def make_injector(fault_id: str, sut: SUT, transport: Transport) -> BaseInjector:
    if fault_id not in REGISTRY:
        raise KeyError(f"unknown fault id: {fault_id!r} (known: {sorted(REGISTRY)})")
    return REGISTRY[fault_id](sut, transport)
