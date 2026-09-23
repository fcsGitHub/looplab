"""Orchestrates baseline -> fault -> recovery and evaluates the outcome."""
from __future__ import annotations

import json
import os
import time
from typing import Optional

from .injectors import make_injector
from .metrics import Window
from .sut import SUT
from .transport import Transport, TransportError

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CATALOG = os.path.join(ROOT, "faults", "catalog.json")


def load_catalog() -> dict:
    with open(CATALOG, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _drive(sut: SUT, transport: Transport, window: Window, seconds: float,
           target: str, think_s: float = 0.002) -> None:
    """Send requests for ``seconds`` and record metrics into ``window``."""
    start = time.perf_counter()
    deadline = start + seconds
    n = 0
    while time.perf_counter() < deadline:
        req = {"endpoint": target, "payload": f"req-{n}"}
        t0 = time.perf_counter()
        ok = True
        try:
            transport.send(req, sut.handle)
        except (TransportError, ConnectionError, MemoryError, RuntimeError):
            ok = False
        dt_ms = (time.perf_counter() - t0) * 1000.0
        window.record(dt_ms, ok)
        n += 1
        time.sleep(think_s)
    window.wall_s = time.perf_counter() - start


def run_fault(fault_id: str, intensity: float, duration: float,
              target: str = "/api/echo",
              baseline_s: float = 1.0, recovery_s: float = 1.0,
              out_dir: Optional[str] = None) -> dict:
    catalog = load_catalog()
    ids = {f["id"] for f in catalog["faults"]}
    if fault_id not in ids:
        raise KeyError(f"fault {fault_id!r} not in catalogue {sorted(ids)}")

    sut = SUT()
    transport = Transport(seed=20240607)
    injector = make_injector(fault_id, sut, transport)

    sut.start()

    # 1. baseline (no fault)
    base = Window("baseline")
    _drive(sut, transport, base, baseline_s, target)

    # 2. fault window
    fault = Window("fault")
    injector.activate(intensity, duration)
    assert injector.active, "injector failed to activate"
    _drive(sut, transport, fault, duration, target)

    # 3. rollback + recovery window
    injector.deactivate()
    assert not injector.active, "injector failed to deactivate"
    assert not transport.hook_installed, "transport hook not removed on rollback"
    rec = Window("recovery")
    _drive(sut, transport, rec, recovery_s, target)

    # 4. evaluate
    anomaly = _anomaly(base, fault)
    recovered = _recovered(base, rec)

    result = {
        "fault": fault_id,
        "intensity": intensity,
        "duration_s": duration,
        "target": target,
        "baseline": base.summary(),
        "fault_window": fault.summary(),
        "recovery": rec.summary(),
        "anomaly_observed": anomaly["observed"],
        "anomaly_reasons": anomaly["reasons"],
        "recovered": recovered["ok"],
        "recovery_reasons": recovered["reasons"],
        "passed": bool(anomaly["observed"] and recovered["ok"]),
    }

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, f"{fault_id}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
        result["report_path"] = path

    return result


def _anomaly(base: Window, fault: Window) -> dict:
    reasons = []
    observed = False

    # error-rate increase (absolute + relative)
    if fault.error_rate > base.error_rate + 0.05:
        reasons.append(
            f"error_rate {base.error_rate:.3f} -> {fault.error_rate:.3f}"
        )
        observed = True

    # latency p95 increase (>= 1.5x and >= 5ms absolute)
    if fault.percentile(0.95) >= max(base.percentile(0.95) * 1.5,
                                    base.percentile(0.95) + 5.0):
        reasons.append(
            f"latency_p95 {base.percentile(0.95):.2f}ms -> "
            f"{fault.percentile(0.95):.2f}ms"
        )
        observed = True

    # throughput decrease (<= 0.7x)
    if base.throughput > 0 and fault.throughput <= base.throughput * 0.7:
        reasons.append(
            f"throughput {base.throughput:.1f} -> {fault.throughput:.1f} rps"
        )
        observed = True

    return {"observed": observed, "reasons": reasons}


def _recovered(base: Window, rec: Window) -> dict:
    reasons = []
    ok = True

    # error rate back near baseline
    if rec.error_rate > base.error_rate + 0.05:
        ok = False
        reasons.append(
            f"error_rate still elevated: {rec.error_rate:.3f} vs "
            f"baseline {base.error_rate:.3f}"
        )

    # latency p95 back within 1.5x of baseline (+5ms slack)
    if rec.percentile(0.95) > max(base.percentile(0.95) * 1.5,
                                  base.percentile(0.95) + 5.0):
        ok = False
        reasons.append(
            f"latency_p95 still elevated: {rec.percentile(0.95):.2f}ms vs "
            f"baseline {base.percentile(0.95):.2f}ms"
        )

    if ok:
        reasons.append("metrics returned to baseline")
    return {"ok": ok, "reasons": reasons}
