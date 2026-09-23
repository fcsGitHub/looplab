"""Frozen evaluation protocol v1.0 - baseline (FFD) runner.

Standard library only. Deterministic. Produces baseline_results.json.
"""
import json
import math
import random
import hashlib
import time
import statistics
from datetime import datetime, timezone

# ----------------------------------------------------------------------------
# Protocol constants (FROZEN)
# ----------------------------------------------------------------------------
PROTOCOL_VERSION = "1.0"
CAPACITY = 1.0
EPS = 1e-9
SEEDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
INSTANCES_PER_SEED = 20          # 10 seeds * 20 = 200 instances per (dist, n)
DISTRIBUTIONS = ["uniform", "normal", "bimodal"]
SIZES = [50, 100, 200]
BUDGET_EVALS_PER_INSTANCE = 10_000
WALL_CLOCK_LIMIT_PER_INSTANCE = 5.0
ROUND_DECIMALS = 6


# ----------------------------------------------------------------------------
# Instance generation (deterministic)
# ----------------------------------------------------------------------------
def _draw(rng, dist):
    if dist == "uniform":
        return rng.uniform(0.05, 1.0)
    if dist == "normal":
        x = rng.gauss(0.5, 0.15)
        return min(1.0, max(0.05, x))
    if dist == "bimodal":
        if rng.random() < 0.5:
            return rng.uniform(0.05, 0.35)
        return rng.uniform(0.65, 1.0)
    raise ValueError(dist)


def generate_instance(dist, n, seed, index):
    rng = random.Random(f"{dist}|{n}|{seed}|{index}")
    items = [round(_draw(rng, dist), ROUND_DECIMALS) for _ in range(n)]
    return items


def instance_id(dist, n, seed, index):
    return f"{dist}-n{n}-s{seed}-i{index}"


# ----------------------------------------------------------------------------
# Baseline: First Fit Decreasing
# ----------------------------------------------------------------------------
def ffd(items, capacity=CAPACITY):
    """Return (bins_used, bin_loads). Deterministic."""
    sorted_items = sorted(items, reverse=True)
    loads = []
    for it in sorted_items:
        placed = False
        for b in range(len(loads)):
            if loads[b] + it <= capacity + EPS:
                loads[b] += it
                placed = True
                break
        if not placed:
            loads.append(it)
    return len(loads), loads


def lower_bound(items, capacity=CAPACITY):
    return math.ceil(sum(items) / capacity - EPS)


# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
def main():
    t0 = time.time()
    per_instance = []
    groups = {}  # (dist, n) -> list of records

    for dist in DISTRIBUTIONS:
        for n in SIZES:
            key = f"{dist}|n{n}"
            groups[key] = []
            for seed in SEEDS:
                for index in range(INSTANCES_PER_SEED):
                    items = generate_instance(dist, n, seed, index)
                    iid = instance_id(dist, n, seed, index)
                    lb = lower_bound(items)
                    st = time.time()
                    bins_used, loads = ffd(items)
                    elapsed = time.time() - st

                    # verification
                    total = sum(items)
                    feasible = total <= bins_used * CAPACITY + 1e-6
                    assert feasible, f"infeasible {iid}"
                    assert bins_used >= lb, f"below LB {iid}"

                    rec = {
                        "id": iid,
                        "distribution": dist,
                        "n": n,
                        "seed": seed,
                        "index": index,
                        "bins_used": bins_used,
                        "lower_bound": lb,
                        "sum_items": round(total, 6),
                        "gap_to_lb": (bins_used - lb) / lb,
                        "elapsed_sec": round(elapsed, 6),
                        "timeout": False,
                    }
                    groups[key].append(rec)
                    per_instance.append(rec)

    # ---- aggregate per (dist, n) ----
    def agg(records):
        bins = [r["bins_used"] for r in records]
        gaps = [r["gap_to_lb"] for r in records]
        return {
            "count": len(records),
            "mean_bins": round(statistics.fmean(bins), 6),
            "min_bins": min(bins),
            "max_bins": max(bins),
            "stdev_bins": round(statistics.pstdev(bins), 6),
            "mean_gap_to_lb": round(statistics.fmean(gaps), 6),
            "worst_gap_to_lb": round(max(gaps), 6),
            "timeout_count": sum(1 for r in records if r["timeout"]),
        }

    group_metrics = {k: agg(v) for k, v in groups.items()}

    # ---- per distribution and per n ----
    by_dist = {}
    for dist in DISTRIBUTIONS:
        recs = [r for r in per_instance if r["distribution"] == dist]
        by_dist[dist] = agg(recs)
    by_n = {}
    for n in SIZES:
        recs = [r for r in per_instance if r["n"] == n]
        by_n[f"n{n}"] = agg(recs)

    overall = agg(per_instance)

    # ---- baseline-relative metrics (baseline vs itself => 0) ----
    baseline_relative = {
        "reference": "FFD",
        "improvement_rate": 0.0,
        "worst_case_degradation": 0.0,
        "note": "Baseline compared against itself; future algorithms use these same formulas.",
    }

    # ---- protocol hash ----
    with open("protocol.md", "rb") as f:
        proto_bytes = f.read()
    proto_sha = hashlib.sha256(proto_bytes).hexdigest()

    result = {
        "protocol": {
            "version": PROTOCOL_VERSION,
            "status": "FROZEN",
            "capacity": CAPACITY,
            "distributions": DISTRIBUTIONS,
            "sizes": SIZES,
            "seeds": SEEDS,
            "instances_per_seed": INSTANCES_PER_SEED,
            "instances_per_group": len(SEEDS) * INSTANCES_PER_SEED,
            "total_instances": len(per_instance),
            "budget": {
                "evals_per_instance": BUDGET_EVALS_PER_INSTANCE,
                "wall_clock_limit_per_instance_sec": WALL_CLOCK_LIMIT_PER_INSTANCE,
            },
            "metrics": [
                "mean_bins",
                "improvement_rate",
                "worst_case_degradation",
                "mean_gap_to_lb",
                "timeout_count",
            ],
            "protocol_sha256": proto_sha,
            "frozen_at": datetime.now(timezone.utc).isoformat(),
        },
        "baseline": {
            "algorithm": "First Fit Decreasing (FFD)",
            "deterministic": True,
            "overall": overall,
            "by_distribution": by_dist,
            "by_size": by_n,
            "by_group": group_metrics,
            "baseline_relative": baseline_relative,
        },
        "verification": {
            "all_feasible": True,
            "all_above_lower_bound": True,
            "instance_count_ok": len(per_instance) == 3 * 3 * 200,
            "total_instances": len(per_instance),
        },
        "runtime_sec": round(time.time() - t0, 3),
        "per_instance": per_instance,
    }

    with open("baseline_results.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print("instances:", len(per_instance))
    print("overall mean_bins:", overall["mean_bins"])
    print("overall mean_gap_to_lb:", overall["mean_gap_to_lb"])
    for k in sorted(group_metrics):
        g = group_metrics[k]
        print(f"  {k:16s} mean_bins={g['mean_bins']:.3f} gap_lb={g['mean_gap_to_lb']:.4f}")
    print("runtime_sec:", result["runtime_sec"])


if __name__ == "__main__":
    main()
