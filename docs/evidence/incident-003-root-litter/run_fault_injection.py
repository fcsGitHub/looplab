#!/usr/bin/env python3
"""Entry point: run the fault-injection test environment and emit a report.

Sandbox-compatible: uses only in-process fault injection (no subprocess, no
network). Writes JSON + Markdown reports into the workspace.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from faultlab.scenarios import run_all  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    results = run_all()

    rows = []
    detected = 0
    for r in results:
        fault_detected = bool(r.observed.get("deviation"))
        if r.faults and fault_detected:
            detected += 1
        rows.append({
            "name": r.name,
            "faults": [{"target": f.target, "kind": f.kind.value,
                        "magnitude": f.magnitude, "times": f.times} for f in r.faults],
            "observed": r.observed,
            "fault_detected": fault_detected,
            "duration_s": round(r.duration_s, 6),
        })

    injected_scenarios = [r for r in results if r.faults]
    summary = {
        "total_scenarios": len(results),
        "scenarios_with_faults": len(injected_scenarios),
        "faults_detected": detected,
        "detection_rate": round(detected / len(injected_scenarios), 3) if injected_scenarios else 0.0,
        "baseline_clean": all(not r.observed.get("deviation") for r in results if not r.faults),
    }

    report = {"summary": summary, "scenarios": rows}
    with open(os.path.join(OUT_DIR, "fault_injection_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    lines = ["# Fault Injection Report", "",
             f"- total scenarios: {summary['total_scenarios']}",
             f"- scenarios with faults: {summary['scenarios_with_faults']}",
             f"- faults detected: {summary['faults_detected']}",
             f"- detection rate: {summary['detection_rate']}",
             f"- baseline clean: {summary['baseline_clean']}", "",
             "| scenario | fault | detected | observed |",
             "|---|---|---|---|"]
    for row in rows:
        fault = ",".join(f"{f['target']}:{f['kind']}" for f in row["faults"]) or "-"
        lines.append(f"| {row['name']} | {fault} | {row['fault_detected']} | "
                     f"{json.dumps(row['observed'])} |")
    with open(os.path.join(OUT_DIR, "fault_injection_report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
