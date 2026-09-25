"""Count primes in [1, 5000] using the Sieve of Eratosthenes.

Standard library only. Prints the count as a single integer.

Usage:
    python primes_1_5000.py
"""


def count_primes(limit: int) -> int:
    """Return the number of primes in the inclusive range [1, limit]."""
    if limit < 2:
        return 0
    sieve = [True] * (limit + 1)
    sieve[0] = sieve[1] = False
    for i in range(2, int(limit ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, limit + 1, i):
                sieve[j] = False
    return sum(sieve)


def main() -> None:
    print(count_primes(5000))


if __name__ == "__main__":
    main()
