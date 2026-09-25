"""Independent review of prime.is_prime: cross-validation + boundary + type checks."""
import sys, math, traceback
sys.path.insert(0, ".")
from prime import is_prime


def naive_is_prime(n):
    """Independent naive trial division reference."""
    if n < 2:
        return False
    if n < 4:
        return True
    if n % 2 == 0:
        return False
    i = 3
    while i * i <= n:
        if n % i == 0:
            return False
        i += 2
    return True


# --- 1) cross-validation n = 0..2000 ---
mismatches = []
for n in range(0, 2001):
    got = is_prime(n)
    exp = naive_is_prime(n)
    if got != exp:
        mismatches.append((n, got, exp))
print("1) cross-check 0..2000 vs naive trial division")
print("   mismatches:", mismatches if mismatches else "NONE")

# sympy if available
try:
    from sympy import isprime as sympy_isprime
    sym_mismatch = [(n, is_prime(n), sympy_isprime(n))
                    for n in range(0, 2001) if is_prime(n) != sympy_isprime(n)]
    print("   sympy available; mismatches vs sympy:", sym_mismatch if sym_mismatch else "NONE")
except ImportError:
    print("   sympy NOT available (used naive reference only)")

# --- 2) boundary cases ---
print("\n2) boundary cases")
boundaries = [2, 3, 4, 1, 0, -1, 2**31 - 1, 10**9 + 7]
for n in boundaries:
    try:
        got = is_prime(n)
        exp = naive_is_prime(n) if n < 10**7 else None
        print(f"   is_prime({n}) = {got}   (naive ref: {exp})")
    except Exception as e:
        print(f"   is_prime({n}) raised {type(e).__name__}: {e}")

# --- 3) type handling vs docstring ---
print("\n3) type handling (docstring: bool rejected, non-int -> TypeError)")
type_cases = [True, False, 2.0, 3.5, "7", None, [2], 2 + 0j]
for v in type_cases:
    try:
        r = is_prime(v)
        print(f"   is_prime({v!r}) -> {r}  (NO exception)")
    except TypeError as e:
        print(f"   is_prime({v!r}) -> TypeError: {e}")
    except Exception as e:
        print(f"   is_prime({v!r}) -> UNEXPECTED {type(e).__name__}: {e}")

# --- 4) float precision hazard: int(n**0.5) for large n ---
print("\n4) float precision hazard on int(n**0.5)")
bad = []
for n in range(2, 5_000_000):
    if int(n ** 0.5) != math.isqrt(n):
        bad.append(n)
        if len(bad) > 5:
            break
print("   first n where int(n**0.5) != isqrt(n):", bad if bad else "NONE in 2..5e6")

# targeted: perfect squares near float boundaries
import random
random.seed(0)
targets = [k*k for k in range(10**6, 10**6 + 2000)]
targets += [k*k for k in range(10**7, 10**7 + 2000)]
targets += [k*k for k in range(10**8, 10**8 + 2000)]
targets += [(2**31 - 1), (2**31 - 1)**2, (10**9 + 7)**2, 2**52, 2**53, 2**53 + 1]
bad2 = [n for n in targets if int(n ** 0.5) != math.isqrt(n)]
print("   mismatches on targeted large squares:", bad2 if bad2 else "NONE")

# does a wrong limit ever cause a wrong answer? test squares of primes
sq_bad = []
for p in [3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]:
    for k in [10**6, 10**7, 10**8, 10**9]:
        n = (k + p) ** 2
        if is_prime(n) != naive_is_prime(n):
            sq_bad.append(n)
print("   wrong answers on large prime squares:", sq_bad if sq_bad else "NONE")
