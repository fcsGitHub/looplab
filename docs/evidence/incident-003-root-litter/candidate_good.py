"""Candidate (correct): trial division by 2, then odd divisors only.

Same answer as the baseline, roughly half the modulo operations.
"""


def count_primes(n_max, budget_ops):
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
