"""Prime counting with the Sieve of Eratosthenes.

Counts the number of primes in the inclusive range [1, n] and prints a
short human-checkable summary. Standard library only.
"""


def count_primes(n: int) -> int:
    """Return the number of primes in [1, n] using the Sieve of Eratosthenes.

    Args:
        n: Upper bound of the range (inclusive). Values < 2 yield 0.

    Returns:
        The count of prime numbers p with 1 <= p <= n.
    """
    if n < 2:
        return 0

    # is_prime[i] is True while i is still considered a candidate prime.
    # Index 0 and 1 are never prime, so mark them False up front.
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False

    # Only need to sieve with factors up to sqrt(n): any composite <= n
    # has a prime factor <= sqrt(n).
    limit = int(n ** 0.5)
    for p in range(2, limit + 1):
        if is_prime[p]:
            # Start at p*p: smaller multiples were already crossed out
            # by smaller prime factors.
            for multiple in range(p * p, n + 1, p):
                is_prime[multiple] = False

    return sum(is_prime)


def primes_up_to(n: int) -> list:
    """Return the sorted list of primes in [1, n] (helper for reporting)."""
    if n < 2:
        return []
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False
    for p in range(2, int(n ** 0.5) + 1):
        if is_prime[p]:
            for multiple in range(p * p, n + 1, p):
                is_prime[multiple] = False
    return [i for i, flag in enumerate(is_prime) if flag]


def main() -> None:
    n = 5000
    count = count_primes(n)
    primes = primes_up_to(n)

    # Required output line.
    print(f"Primes in [1, {n}]: {count}")

    # Extra lines for manual cross-checking.
    print(f"First 10 primes: {primes[:10]}")
    print(f"Last prime: {primes[-1]}")


if __name__ == "__main__":
    main()
