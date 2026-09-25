"""
Reproducible evaluation harness + baseline for a bin-packing task.

Design constraints discovered by diagnosis (see DIAGNOSIS.md):
  * subprocess.Popen is DENIED in this sandbox -> candidates MUST be executed
    in-process (import + call), never shelled out.
  * multiprocessing 'spawn' is unusable here -> single-process only.
  * builtin hash() is randomized per process (PYTHONHASHSEED unset) -> NEVER
    use hash()/set-iteration for anything that affects results. Use SHA-256.
  * random must be explicitly seeded with a fixed constant.

The harness is deterministic: given the same candidate module, it produces a
byte-identical result digest on every run.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import random
import sys
import time
from typing import Callable, Dict, List, Sequence

# ----------------------------------------------------------------------------
# Deterministic primitives
# ----------------------------------------------------------------------------

SEED = 20240101  # fixed; never derived from time/os entropy


def stable_hash(obj) -> str:
    """Deterministic hash. Replaces builtin hash() which is salted per process."""
    payload = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def make_instances(n: int, seed: int = SEED) -> List[Dict]:
    """Deterministically generate bin-packing instances.

    Each instance: capacity C and a list of item sizes.
    """
    rng = random.Random(seed)  # local RNG, explicitly seeded
    instances = []
    for i in range(n):
        capacity = rng.choice([10, 12, 15, 20])
        k = rng.randint(5, 12)
        items = [rng.randint(1, capacity) for _ in range(k)]
        instances.append({"id": i, "capacity": capacity, "items": items})
    return instances


# ----------------------------------------------------------------------------
# Baseline: First-Fit Decreasing (deterministic)
# ----------------------------------------------------------------------------

def baseline_first_fit_decreasing(capacity: int, items: Sequence[int]) -> int:
    """Return number of bins used by First-Fit Decreasing.

    Deterministic: sorts items descending with a stable tie-break on value.
    """
    ordered = sorted(items, key=lambda x: (-x, x))
    bins: List[int] = []  # remaining capacity per bin
    for it in ordered:
        placed = False
        for b in range(len(bins)):
            if bins[b] >= it:
                bins[b] -= it
                placed = True
                break
        if not placed:
            bins.append(capacity - it)
    return len(bins)


# ----------------------------------------------------------------------------
# Candidate loading (IN-PROCESS, no subprocess)
# ----------------------------------------------------------------------------

def load_candidate(path: str) -> Callable:
    """Import a candidate .py file in-process and return its solve() callable.

    Raises a descriptive error (never a bare 'unknown') on any problem.
    """
    if not os.path.exists(path):
        raise FileNotFoundError(f"candidate not found: {path}")
    name = "candidate_" + hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:12]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot build import spec for {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)  # in-process execution
    if not hasattr(mod, "solve"):
        raise AttributeError(f"candidate {path} has no solve() function")
    return mod.solve


# ----------------------------------------------------------------------------
# Evaluation
# ----------------------------------------------------------------------------

def evaluate(candidate_solve: Callable, instances: List[Dict]) -> Dict:
    """Run candidate on every instance; return per-instance + aggregate results.

    A candidate solve(capacity, items) -> int (bins used).
    Score = mean over instances of (baseline_bins / candidate_bins), capped at 1.0
    (so a candidate can never beat the baseline's own bound here; this is a
    ratio-to-baseline quality metric).
    """
    per_instance = []
    ratios = []
    for inst in instances:
        cap, items = inst["capacity"], inst["items"]
        base = baseline_first_fit_decreasing(cap, items)
        try:
            got = candidate_solve(cap, list(items))
            got = int(got)
            valid = got >= 1
        except Exception as e:  # candidate bug -> recorded, not fatal
            per_instance.append({
                "id": inst["id"], "baseline": base, "candidate": None,
                "ratio": 0.0, "error": f"{type(e).__name__}: {e}",
            })
            ratios.append(0.0)
            continue
        ratio = min(1.0, base / got) if valid else 0.0
        ratios.append(ratio)
        per_instance.append({
            "id": inst["id"], "baseline": base, "candidate": got,
            "ratio": round(ratio, 6), "error": None,
        })
    score = sum(ratios) / len(ratios) if ratios else 0.0
    return {
        "score": round(score, 6),
        "n_instances": len(instances),
        "per_instance": per_instance,
    }


def run_eval(candidate_path: str, n_instances: int = 20) -> Dict:
    instances = make_instances(n_instances)
    solve = load_candidate(candidate_path)
    result = evaluate(solve, instances)
    result["instances_digest"] = stable_hash(instances)
    result["candidate_path"] = os.path.basename(candidate_path)
    result["seed"] = SEED
    return result


def result_digest(result: Dict) -> str:
    """Digest of the *scored* content only (excludes timing/paths)."""
    core = {
        "score": result["score"],
        "per_instance": result["per_instance"],
        "instances_digest": result["instances_digest"],
        "seed": result["seed"],
    }
    return stable_hash(core)


# ----------------------------------------------------------------------------
# Reproducibility self-check
# ----------------------------------------------------------------------------

def reproducibility_check(candidate_path: str, n_instances: int = 20) -> Dict:
    """Run the full evaluation twice and compare digests."""
    r1 = run_eval(candidate_path, n_instances)
    r2 = run_eval(candidate_path, n_instances)
    d1, d2 = result_digest(r1), result_digest(r2)
    return {
        "digest_run1": d1,
        "digest_run2": d2,
        "reproducible": d1 == d2,
        "score": r1["score"],
        "instances_digest": r1["instances_digest"],
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    rep = reproducibility_check(args.candidate, args.n)
    full = run_eval(args.candidate, args.n)
    payload = {"reproducibility": rep, "result": full}
    text = json.dumps(payload, indent=2, sort_keys=True)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
