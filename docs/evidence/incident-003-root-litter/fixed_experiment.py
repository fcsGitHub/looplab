"""Fixed-budget baseline-vs-candidate comparison (self-contained, sandbox-safe).

Root cause addressed (see diagnosis_report.md):
  RC-1: baseline.py imported non-existent names from eval_harness -> ImportError
        -> run_experiment.py crashed at import time -> reported as 'unknown'.
  RC-2: sandbox denies subprocess.Popen and open('nul')/tempfile.
  RC-3: BUDGET_OPS=2e6 too small for N_MAX=200000 -> degenerate comparison.

This script:
  * is pure standard library,
  * never uses subprocess / os.devnull / tempfile,
  * loads nothing from the broken baseline.py (baseline defined inline per spec.md),
  * runs every arm under the SAME fixed budget,
  * checks correctness against an independent sieve ground truth,
  * applies the spec decision rule and writes results.json inside the workspace.

Run:  python fixed_experiment.py
"""
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- task instance (from spec.md) ------------------------------------------
N_MAX = 200_000
# Fixed budget must exceed the slowest arm's completion cost.
# Measured: baseline needs 7,167,463 ops; candidate_good needs 3,729,198 ops.
BUDGET_OPS = 20_000_000


# ---- independent ground truth (sieve; independent of both arms) ------------
def sieve_count(n_max):
    if n_max < 2:
        return 0
    flags = bytearray([1]) * (n_max + 1)
    flags[0] = flags[1] = 0
    i = 2
    while i * i <= n_max:
        if flags[i]:
            flags[i * i::i] = bytearray(len(flags[i * i::i]))
        i += 1
    return sum(flags)


# ---- arms ------------------------------------------------------------------
def baseline_count_primes(n_max, budget_ops):
    """Baseline: trial division by ALL integers 2..sqrt(n)."""
    ops = 0
    count = 0
    exhausted = False
    for n in range(2, n_max + 1):
        is_prime = True
        d = 2
        while d * d <= n:
            ops += 1
            if ops > budget_ops:
                exhausted = True
                break
            if n % d == 0:
                is_prime = False
                break
            d += 1
        if exhausted:
            break
        if is_prime:
            count += 1
    return count, ops, exhausted


def candidate_good_count_primes(n_max, budget_ops):
    """Candidate (correct): trial division by 2, then odd divisors only."""
    ops = 0
    count = 0
    exhausted = False
    for n in range(2, n_max + 1):
        is_prime = True
        if n > 2:
            ops += 1
            if ops > budget_ops:
                exhausted = True
                break
            if n % 2 == 0:
                is_prime = False
        if is_prime:
            d = 3
            while d * d <= n:
                ops += 1
                if ops > budget_ops:
                    exhausted = True
                    break
                if n % d == 0:
                    is_prime = False
                    break
                d += 2
        if exhausted:
            break
        if is_prime:
            count += 1
    return count, ops, exhausted


def candidate_bad_count_primes(n_max, budget_ops):
    """Candidate (deliberately WRONG) - negative control.

    Skips the even-divisor check entirely, so it counts 2 and every odd
    number as prime. Fast but incorrect; the harness must reject it.
    """
    ops = 0
    count = 0
    exhausted = False
    for n in range(2, n_max + 1):
        is_prime = True
        d = 3
        while d * d <= n:
            ops += 1
            if ops > budget_ops:
                exhausted = True
                break
            if n % d == 0:
                is_prime = False
                break
            d += 2
        if exhausted:
            break
        if is_prime:
            count += 1
    return count, ops, exhausted


ARMS = {
    "baseline": baseline_count_primes,
    "candidate_good": candidate_good_count_primes,
    "candidate_bad": candidate_bad_count_primes,
}


# ---- harness ---------------------------------------------------------------
def evaluate(fn, truth, n_max, budget_ops):
    t0 = time.time()
    count, ops, exhausted = fn(n_max, budget_ops)
    wall_ms = round((time.time() - t0) * 1000.0, 3)
    completed = not exhausted
    return {
        "count": count,
        "ops_used": ops,
        "exhausted": exhausted,
        "completed": completed,
        "truth": truth,
        "correct": bool(completed and count == truth),
        "wall_ms": wall_ms,
    }


def wins(cand, ref):
    """Spec decision rule: candidate wins iff correct and (ref wrong or fewer ops)."""
    return bool(cand["correct"] and (not ref["correct"] or
                                     cand["ops_used"] < ref["ops_used"]))


def main():
    truth = sieve_count(N_MAX)
    results = {name: evaluate(fn, truth, N_MAX, BUDGET_OPS)
               for name, fn in ARMS.items()}

    base = results["baseline"]
    good = results["candidate_good"]
    bad = results["candidate_bad"]

    verdict = {
        "candidate_good_beats_baseline": wins(good, base),
        "candidate_bad_beats_baseline": wins(bad, base),
        "candidate_bad_rejected": not bad["correct"],
        "ops_reduction_vs_baseline": (
            round(1.0 - good["ops_used"] / base["ops_used"], 6)
            if base["ops_used"] else None
        ),
    }

    out = {
        "config": {
            "n_max": N_MAX,
            "budget_ops": BUDGET_OPS,
            "ground_truth_count": truth,
            "ground_truth_method": "sieve of Eratosthenes (independent)",
        },
        "results": results,
        "verdict": verdict,
    }

    path = os.path.join(HERE, "results.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=True)

    print(json.dumps(out, indent=2, sort_keys=True))
    print("wrote", path)
    return out


if __name__ == "__main__":
    main()
