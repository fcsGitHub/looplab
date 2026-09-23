"""
Runner: freeze the baseline results and verify protocol reproducibility.

Usage:
    python evaluate.py freeze   -> writes frozen_baseline.json
    python evaluate.py verify   -> re-derives baseline and checks against frozen file
"""
import json
import os
import sys

from frozen_protocol import (
    PROTOCOL_VERSION, CAPACITY, SUITE_SIZE, make_suite,
    ffd, lower_bound, validate_instance, protocol_fingerprint,
)

FROZEN_FILE = "frozen_baseline.json"


def compute_baseline():
    suite = make_suite()
    rows = []
    for i, inst in enumerate(suite):
        validate_instance(inst)
        b = ffd(inst)
        lb = lower_bound(inst)
        assert b >= lb, f"baseline {b} below lower bound {lb} on instance {i}"
        rows.append({"id": i, "n_items": len(inst), "bins": b, "lb": lb})
    return rows


def freeze():
    rows = compute_baseline()
    doc = {
        "protocol_version": PROTOCOL_VERSION,
        "capacity": CAPACITY,
        "suite_size": SUITE_SIZE,
        "fingerprint": protocol_fingerprint(),
        "baseline": "FFD",
        "total_bins": sum(r["bins"] for r in rows),
        "mean_bins": sum(r["bins"] for r in rows) / len(rows),
        "rows": rows,
    }
    with open(FROZEN_FILE, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
    return doc


def verify():
    if not os.path.exists(FROZEN_FILE):
        return False, "frozen file missing; run `freeze` first"
    frozen = json.load(open(FROZEN_FILE, encoding="utf-8"))
    rows = compute_baseline()
    problems = []
    if frozen["protocol_version"] != PROTOCOL_VERSION:
        problems.append("protocol_version mismatch")
    if frozen["fingerprint"] != protocol_fingerprint():
        problems.append("protocol fingerprint mismatch (protocol changed!)")
    if frozen["suite_size"] != len(rows):
        problems.append("suite size mismatch")
    for a, b in zip(frozen["rows"], rows):
        if a != b:
            problems.append(f"row mismatch at id {a['id']}: {a} != {b}")
    if problems:
        return False, "; ".join(problems)
    return True, f"all {len(rows)} baseline rows reproduce exactly; fingerprint {frozen['fingerprint'][:16]}..."


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if cmd == "freeze":
        doc = freeze()
        print("frozen:", doc["total_bins"], "total bins,", doc["mean_bins"], "mean")
    elif cmd == "verify":
        ok, detail = verify()
        print("VERIFY", "PASS" if ok else "FAIL", "-", detail)
        sys.exit(0 if ok else 1)
    else:
        print("unknown command", cmd)
        sys.exit(2)
