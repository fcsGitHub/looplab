"""Sum of the first 100 primes (standard library only)."""

import math


def is_prime(n):
    """Return True if n is prime, else False."""
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False
    # Trial division by odd candidates up to sqrt(n).
    limit = int(math.isqrt(n))
    for d in range(3, limit + 1, 2):
        if n % d == 0:
            return False
    return True


def main():
    primes = []          # collect the first 100 primes
    candidate = 2
    while len(primes) < 100:
        if is_prime(candidate):
            primes.append(candidate)
        candidate += 1

    total = sum(primes)
    print(total)


if __name__ == "__main__":
    main()
