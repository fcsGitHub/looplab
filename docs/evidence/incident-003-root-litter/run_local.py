#!/usr/bin/env python3
"""Offline fault-injection harness entrypoint.

Usage:
    python run_local.py --fault latency --intensity 0.8 --duration 3
    python run_local.py --all
    python run_local.py --list

Exit code 0 iff every requested fault both injected an observable anomaly and
recovered cleanly after rollback.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from harness.runner import load_catalog, run_fault

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Offline fault-injection harness")
    ap.add_argument("--fault", help="fault id to inject")
    ap.add_argument("--intensity", type=float, default=0.8,
                    help="fault strength in [0,1] (default 0.8)")
    ap.add_argument("--duration", type=float, default=3.0,
                    help="fault duration in seconds (default 3)")
    ap.add_argument("--target", default="/api/echo", help="SUT endpoint")
    ap.add_argument("--baseline", type=float, default=1.0,
                    help="baseline window seconds (default 1)")
    ap.add_argument("--recovery", type=float, default=1.0,
                    help="recovery window seconds (default 1)")
    ap.add_argument("--all", action="store_true", help="run every fault")
    ap.add_argument("--list", action="store_true", help="list faults and exit")
    args = ap.parse_args(argv)

    catalog = load_catalog()
    ids = [f["id"] for f in catalog["faults"]]

    if args.list:
        for f in catalog["faults"]:
            print(f"{f['id']:16s} [{f['class']:12s}] {f['description']}")
        return 0

    if not args.all and not args.fault:
        ap.error("provide --fault <id> or --all (or --list)")

    targets = ids if args.all else [args.fault]

    results = []
    for fid in targets:
        print(f"\n=== injecting fault: {fid} "
              f"(intensity={args.intensity}, duration={args.duration}s) ===")
        res = run_fault(
            fid,
            intensity=args.intensity,
            duration=args.duration,
            target=args.target,
            baseline_s=args.baseline,
            recovery_s=args.recovery,
            out_dir=REPORTS,
        )
        results.append(res)
        _print_result(res)

    passed = all(r["passed"] for r in results)
    print("\n" + "=" * 64)
    print(f"SUMMARY: {sum(r['passed'] for r in results)}/{len(results)} faults "
          f"passed (anomaly observed AND recovered)")
    for r in results:
        flag = "PASS" if r["passed"] else "FAIL"
        print(f"  [{flag}] {r['fault']:16s} "
              f"anomaly={r['anomaly_observed']} recovered={r['recovered']}")
    print("=" * 64)
    return 0 if passed else 1


def _print_result(res: dict) -> None:
    b, f, rc = res["baseline"], res["fault_window"], res["recovery"]
    print(f"  baseline : err={b['error_rate']:.3f} "
          f"p95={b['latency_p95_ms']:.2f}ms rps={b['throughput_rps']:.1f}")
    print(f"  fault    : err={f['error_rate']:.3f} "
          f"p95={f['latency_p95_ms']:.2f}ms rps={f['throughput_rps']:.1f}")
    print(f"  recovery : err={rc['error_rate']:.3f} "
          f"p95={rc['latency_p95_ms']:.2f}ms rps={rc['throughput_rps']:.1f}")
    print(f"  anomaly_observed={res['anomaly_observed']} "
          f"reasons={res['anomaly_reasons']}")
    print(f"  recovered={res['recovered']} reasons={res['recovery_reasons']}")
    if "report_path" in res:
        print(f"  report -> {res['report_path']}")


if __name__ == "__main__":
    sys.exit(main())
