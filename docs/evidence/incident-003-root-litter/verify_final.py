"""Curator's re-runnable independent verification for the final report.

Target: count of primes in [1, 5000] (inclusive) -> expected 669.

Methods (all independent of each other):
  A. Sieve of Eratosthenes (bytearray slice marking)
  B. Naive trial division
  C. sympy.primepi(5000) if sympy is available

Also re-executes the exact source of the delivered script primes_1_5000.py.
"""
import math

# --- exact source of the delivered script (t3), byte-identical ---
DELIVERED_SRC = '''def count_primes(limit):
    """Count primes in [1, limit] using the sieve of Eratosthenes."""
    if limit < 2:
        return 0
    sieve = [True] * (limit + 1)
    sieve[0] = sieve[1] = False
    for i in range(2, int(limit ** 0.5) + 1):
        if sieve[i]:
            for j in range(i * i, limit + 1, i):
                sieve[j] = False
    return sum(sieve)


count = count_primes(5000)
print(count)
'''


def method_a_sieve(n):
    if n < 2:
        return 0
    s = bytearray([1]) * (n + 1)
    s[0] = s[1] = 0
    for i in range(2, math.isqrt(n) + 1):
        if s[i]:
            s[i * i::i] = bytearray(len(s[i * i::i]))
    return sum(s)


def is_prime(k):
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


def method_b_trial(n):
    return sum(1 for k in range(2, n + 1) if is_prime(k))


def main():
    N = 5000
    ns = {}
    exec(compile(DELIVERED_SRC, "primes_1_5000.py", "exec"), ns)
    delivered = ns["count_primes"](N)

    a = method_a_sieve(N)
    b = method_b_trial(N)

    print("Delivered script count_primes(5000) =", delivered)
    print("Method A (sieve)                    =", a)
    print("Method B (trial division)           =", b)

    c = None
    try:
        import sympy
        c = int(sympy.primepi(N))
        print("Method C (sympy.primepi)            =", c, "(sympy %s)" % sympy.__version__)
    except ImportError:
        print("Method C (sympy.primepi)            = NOT AVAILABLE")

    print("Boundary: is_prime(1)=%s is_prime(2)=%s is_prime(4999)=%s is_prime(5000)=%s"
          % (is_prime(1), is_prime(2), is_prime(4999), is_prime(5000)))
    print("Largest prime <= 5000 =", max(k for k in range(2, N + 1) if is_prime(k)))

    ok = (delivered == a == b == 669) and (c is None or c == 669)
    print("AGREEMENT (delivered == A == B == 669%s): %s"
          % ("" if c is None else " == C", ok))
    print("FINAL RESULT: pi(5000) =", delivered)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
