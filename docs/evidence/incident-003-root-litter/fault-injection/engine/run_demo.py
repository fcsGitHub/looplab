#!/usr/bin/env python3
"""Fault-injection demo / acceptance runner (in-process reference runtime).

Usage:
    python run_demo.py --fault latency --intensity 300 --duration 2
    python run_demo.py --selftest

It drives a real TargetService through a FaultInjector, issues a workload
before / during / after the fault, prints a comparison table, and (with
--selftest) asserts that each fault produces its expected symptom and that
the system recovers after cleanup.

Exit code 0 == all assertions passed.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Dict, List

from faults import FaultInjector, SUPPORTED_FAULTS
from target import TargetService, percentile


def run_phase(svc: TargetService, n: int, work_ms: float) -> Dict:
    lat: List[float] = []
    errs = 0
    t0 = time.perf_counter()
    for _ in range(n):
        r = svc.handle(work_ms=work_ms)
        lat.append(r.latency_ms)
        if not r.ok:
            errs += 1
    wall = time.perf_counter() - t0
    return {
        "n": n,
        "errors": errs,
        "error_rate": errs / n if n else 0.0,
        "p50_ms": round(percentile(lat, 0.50), 2),
        "p95_ms": round(percentile(lat, 0.95), 2),
        "throughput_rps": round(n / wall, 1) if wall > 0 else 0.0,
        "allocated_mb": round(svc.injector.allocated_bytes() / (1024 * 1024), 2),
    }


def scenario(fault: str, intensity: float, duration: float,
             n: int = 200, work_ms: float = 1.0) -> Dict:
    inj = FaultInjector(seed=1234)
    svc = TargetService(inj)

    before = run_phase(svc, n, work_ms)

    inj.set_fault(fault, intensity, duration)
    during = run_phase(svc, n, work_ms)

    # cleanup: clear fault, then re-measure to prove recovery
    inj.clear()
    after = run_phase(svc, n, work_ms)

    return {"fault": fault, "intensity": intensity, "duration": duration,
            "before": before, "during": during, "after": after}


def symptom_ok(fault: str, r: Dict) -> bool:
    b, d = r["before"], r["during"]
    if fault == "latency":
        return d["p95_ms"] > b["p95_ms"] + 0.5 * r["intensity"]
    if fault == "error":
        return d["error_rate"] > 0.2
    if fault == "cpu":
        return d["throughput_rps"] < b["throughput_rps"]
    if fault == "memory":
        return d["allocated_mb"] > 0
    if fault == "partition":
        return d["error_rate"] > 0.2
    return False


def recovery_ok(fault: str, r: Dict) -> bool:
    a, b = r["after"], r["before"]
    if fault in ("error", "partition"):
        return a["error_rate"] < 0.05
    if fault == "memory":
        return a["allocated_mb"] == 0
    # latency / cpu: p95 back within 3x baseline
    return a["p95_ms"] <= max(b["p95_ms"] * 3.0, b["p95_ms"] + 5.0)


def print_report(r: Dict) -> None:
    print(f"\n=== fault={r['fault']} intensity={r['intensity']} duration={r['duration']}s ===")
    print(f"{'phase':<8}{'n':>5}{'err_rate':>10}{'p50_ms':>9}{'p95_ms':>9}{'rps':>9}{'alloc_mb':>10}")
    for phase in ("before", "during", "after"):
        m = r[phase]
        print(f"{phase:<8}{m['n']:>5}{m['error_rate']:>10.3f}"
              f"{m['p50_ms']:>9.2f}{m['p95_ms']:>9.2f}"
              f"{m['throughput_rps']:>9.1f}{m['allocated_mb']:>10.2f}")
    print(f"symptom_ok={symptom_ok(r['fault'], r)}  recovery_ok={recovery_ok(r['fault'], r)}")


def selftest() -> int:
    cases = [
        ("latency", 300, 2.0),
        ("error", 0.5, 2.0),
        ("cpu", 4, 2.0),
        ("memory", 8, 2.0),
        ("partition", 0.5, 2.0),
    ]
    results = []
    failures = []
    for fault, intensity, duration in cases:
        r = scenario(fault, intensity, duration)
        print_report(r)
        s_ok, r_ok = symptom_ok(fault, r), recovery_ok(fault, r)
        results.append({"fault": fault, "symptom_ok": s_ok, "recovery_ok": r_ok})
        if not (s_ok and r_ok):
            failures.append(fault)

    print("\n=== SELFTEST SUMMARY ===")
    for res in results:
        print(f"  {res['fault']:<10} symptom={res['symptom_ok']}  recovery={res['recovery_ok']}")
    print(json.dumps({"passed": not failures, "failed": failures}))
    return 0 if not failures else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Fault injection demo / acceptance runner")
    ap.add_argument("--fault", choices=SUPPORTED_FAULTS)
    ap.add_argument("--intensity", type=float, default=100.0)
    ap.add_argument("--duration", type=float, default=2.0)
    ap.add_argument("--requests", type=int, default=200)
    ap.add_argument("--work-ms", type=float, default=1.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()
    if not args.fault:
        ap.error("either --selftest or --fault is required")

    r = scenario(args.fault, args.intensity, args.duration,
                 n=args.requests, work_ms=args.work_ms)
    print_report(r)
    ok = symptom_ok(args.fault, r) and recovery_ok(args.fault, r)
    print(json.dumps({"fault": args.fault, "passed": ok}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
