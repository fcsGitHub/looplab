"""Prime-counting script (contract-conforming).

Counts the number of primes in [1, 10000] (inclusive). Known value:
pi(10000) = 1229.

Standard library only.

Delivery contract (contract.md):
  - run as: python primes_count.py
  - stdout must be EXACTLY one line matching ^count=\\d+\\n$
    (no trailing CR, no extra text)
  - exit code 0
"""

import math
import sys


def is_prime(n):
    """Return True if n is prime, False otherwise.

    - n < 2        -> False
    - n == 2       -> True
    - even n > 2   -> False
    - odd divisors tested only up to floor(sqrt(n)) via math.isqrt
      (exact integer arithmetic; no float-rounding hazard).
    """
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False

    limit = math.isqrt(n)
    d = 3
    while d <= limit:
        if n % d == 0:
            return False
        d += 2
    return True


def count_primes(limit):
    """Count primes in [1, limit] (inclusive)."""
    count = 0
    for n in range(2, limit + 1):
        if is_prime(n):
            count += 1
    return count


def main():
    # Contract: stdout must be exactly "count=<integer>\n".
    # Write raw bytes with an explicit LF so the output is byte-exact and
    # independent of the platform's default newline translation.
    sys.stdout.buffer.write(b"count=%d\n" % count_primes(10000))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
