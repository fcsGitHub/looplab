"""Independent verification of pi(10000) using three independent methods.

Deliberately does NOT import or read primes_count.py.

  Method A: Sieve of Eratosthenes (bytearray slice assignment)
  Method B: Naive trial division
  Method C: sympy.primepi (if available)

Also runs the delivered primes_count.py as a subprocess and checks that its
stdout matches the contract regex ^count=\\d+\\n$ exactly.
"""

import re
import subprocess
import sys

N = 10000


def sieve_count(n):
    if n < 2:
        return 0, []
    is_prime = bytearray([1]) * (n + 1)
    is_prime[0] = 0
    is_prime[1] = 0  # 1 is NOT prime
    p = 2
    while p * p <= n:
        if is_prime[p]:
            is_prime[p * p::p] = bytearray(len(is_prime[p * p::p]))
        p += 1
    primes = [i for i in range(2, n + 1) if is_prime[i]]
    return len(primes), primes


def is_prime_trial(n):
    if n < 2:
        return False
    if n < 4:
        return True
    if n % 2 == 0:
        return False
    d = 3
    while d * d <= n:
        if n % d == 0:
            return False
        d += 2
    return True


def trial_count(n):
    return sum(1 for k in range(2, n + 1) if is_prime_trial(k))


def main():
    count_a, primes_a = sieve_count(N)
    count_b = trial_count(N)

    count_c = None
    try:
        import sympy
        count_c = int(sympy.primepi(N))
        sympy_ver = sympy.__version__
    except Exception as e:  # pragma: no cover
        sympy_ver = "unavailable: %r" % (e,)

    print("[Method A] Sieve of Eratosthenes  count =", count_a)
    print("  first 10 primes:", primes_a[:10])
    print("  last 10 primes :", primes_a[-10:])
    print("[Method B] Trial division         count =", count_b)
    print("[Method C] sympy.primepi(%d) = %s (%s)" % (N, count_c, sympy_ver))

    print("\n[Boundary checks]")
    print("  is 1 prime?     ", is_prime_trial(1), "(expected False)")
    print("  is 2 prime?     ", is_prime_trial(2), "(expected True)")
    print("  is 10000 prime? ", is_prime_trial(10000), "(expected False)")
    print("  sieve counts 1? ", 1 in primes_a, "(expected False)")

    print("\n[Agreement]")
    print("  A == B :", count_a == count_b)
    if count_c is not None:
        print("  A == C :", count_a == count_c)
    print("  A == 1229 :", count_a == 1229)

    # --- Contract check on the delivered script ---
    print("\n[Contract check: primes_count.py]")
    proc = subprocess.run([sys.executable, "primes_count.py"],
                          capture_output=True)
    out = proc.stdout
    print("  returncode:", proc.returncode)
    print("  stdout bytes:", out)
    print("  stderr:", proc.stderr)
    ok_regex = bool(re.fullmatch(rb"count=\d+\n", out))
    print("  matches ^count=\\d+\\n$ :", ok_regex)
    value = None
    m = re.fullmatch(rb"count=(\d+)\n", out)
    if m:
        value = int(m.group(1))
    print("  parsed value:", value)

    all_ok = (
        count_a == count_b == 1229
        and (count_c is None or count_c == 1229)
        and proc.returncode == 0
        and ok_regex
        and value == 1229
    )
    print("\nFINAL INDEPENDENT RESULT: pi(10000) =", count_a)
    print("ALL CHECKS PASS:", all_ok)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
