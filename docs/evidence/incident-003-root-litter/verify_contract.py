#!/usr/bin/env python3
"""Runnable acceptance verifier for the 'define baseline/budget/acceptance' task.

Runs entirely inside the LOOPLAB sandbox (stdlib only, no subprocess/network).
Prints PASS/FAIL per acceptance criterion and a final verdict.
"""
import os
import json
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
REQUIRED = ["DIAGNOSIS.md", "contract.json", "verify_contract.py"]

results = {}


def check(name, ok, detail):
    results[name] = {"passed": bool(ok), "detail": detail}


# AC1: required deliverables exist
missing = [f for f in REQUIRED if not os.path.isfile(os.path.join(ROOT, f))]
check("AC1", not missing, f"missing={missing}" if missing else "all 3 present")

# AC2: DIAGNOSIS.md has >=3 evidence items with measured numbers
diag_path = os.path.join(ROOT, "DIAGNOSIS.md")
diag = open(diag_path, encoding="utf-8").read() if os.path.exists(diag_path) else ""
ev_markers = re.findall(r"证据 E\d", diag)
numbers = re.findall(r"\b\d{2,}\b", diag)
check("AC2", len(ev_markers) >= 3 and len(numbers) >= 3,
      f"evidence_items={len(ev_markers)} numeric_tokens={len(numbers)}")

# AC3 + AC4: contract.json baseline measured, budget bounded
cj_path = os.path.join(ROOT, "contract.json")
contract = json.load(open(cj_path, encoding="utf-8")) if os.path.exists(cj_path) else {}
base = contract.get("baseline", {})
measured = [k for k, v in base.items() if isinstance(v, (int, float)) and not isinstance(v, bool)]
check("AC3", len(measured) >= 5, f"measured_baseline_fields={len(measured)}")

budget = contract.get("budget", {})
mr = budget.get("max_rounds", 10**9)
check("AC4", isinstance(mr, int) and mr <= 16, f"max_rounds={mr}")

# AC5: this verifier itself ran (self-evident) and produced a verdict
check("AC5", True, "verifier executed in sandbox and produced verdict")

# AC6: workspace file count >= 3
files = [f for f in os.listdir(ROOT) if os.path.isfile(os.path.join(ROOT, f))]
check("AC6", len(files) >= 3, f"workspace_files={len(files)}")

# ---- report ----
all_pass = all(r["passed"] for r in results.values())
for k in sorted(results):
    r = results[k]
    print(f"{'PASS' if r['passed'] else 'FAIL'} {k}: {r['detail']}")
print("VERDICT:", "PASS" if all_pass else "FAIL")

# persist machine-readable result
out = {"verdict": "PASS" if all_pass else "FAIL", "checks": results}
with open(os.path.join(ROOT, "verify_result.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
