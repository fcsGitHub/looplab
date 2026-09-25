"""Independent verification: count primes in [1, n] by trial division.

Deliberately uses a different algorithm than primes_count.py (sieve).
"""


def is_prime_trial(k: int) -> bool:
    if k < 2:
        return False
    if k < 4:
        return True
    if k % 2 == 0:
        return False
    d = 3
    while d * d <= k:
        if k % d == 0:
            return False
        d += 2
    return True


def count_primes_trial(n: int) -> int:
    return sum(1 for k in range(2, n + 1) if is_prime_trial(k))


if __name__ == "__main__":
    n = 10000
    print("verify_count=%d" % count_primes_trial(n))
