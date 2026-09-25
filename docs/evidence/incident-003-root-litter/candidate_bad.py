"""Candidate (deliberately WRONG) — negative control.

Skips the even-divisor check entirely, so it counts 2 and every odd number
as prime. It is fast but incorrect; the harness must reject it.
"""


def count_primes(n_max, budget_ops):
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
