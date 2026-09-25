"""Evaluator: ground truth + fixed-budget harness for baseline vs candidate.

Ground truth uses a sieve, which is independent of both arms, so correctness
is never self-reported by the arm under test.
"""

BUDGET_OPS = 2_000_000
N_MAX = 200_000


def sieve_count(n_max):
    """Exact prime count in [1, n_max] via sieve of Eratosthenes."""
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


def run_arm(module, n_max, budget_ops):
    """Run one arm under the fixed budget. Returns a result dict."""
    count, ops, exhausted = module.count_primes(n_max, budget_ops)
    return {
        "count": count,
        "ops_used": ops,
        "exhausted": exhausted,
        "completed": not exhausted,
    }


def evaluate(module, truth, n_max, budget_ops):
    r = run_arm(module, n_max, budget_ops)
    r["truth"] = truth
    r["correct"] = bool(r["completed"] and r["count"] == truth)
    return r
