#!/usr/bin/env python3
"""
Independent verification of the first 500 decimal digits of pi.

Three INDEPENDENT computation paths are used, then cross-checked against a
hardcoded authoritative reference string:

  A) mpmath.mp.pi            (library, Chudnovsky internally)
  B) pure-integer Chudnovsky (binary splitting, NO floating point at all)
  C) decimal Machin formula  (pi/4 = 4*atan(1/5) - atan(1/239))

A pass requires: A == B == C == reference on all 500 fractional digits.
"""
import json, math, sys
from decimal import Decimal, getcontext
import mpmath

DIGITS = 500
WORK = 560  # guard digits

REFERENCE = (
"14159265358979323846264338327950288419716939937510"
"58209749445923078164062862089986280348253421170679"
"82148086513282306647093844609550582231725359408128"
"48111745028410270193852110555964462294895493038196"
"44288109756659334461284756482337867831652712019091"
"45648566923460348610454326648213393607260249141273"
"72458700660631558817488152092096282925409171536436"
"78925903600113305305488204665213841469519415116094"
"33057270365759591953092186117381932611793105118548"
"07446237996274956735188575272489122793818301194912"
)
assert len(REFERENCE) == DIGITS


def method_B_chudnovsky_integer(digits):
    """Exact integer arithmetic. Returns '3' + digits fractional digits."""
    C3_OVER_24 = 640320 ** 3 // 24

    def bs(a, b):
        if b - a == 1:
            if a == 0:
                Pab = Qab = 1
            else:
                Pab = (6 * a - 5) * (2 * a - 1) * (6 * a - 1)
                Qab = a * a * a * C3_OVER_24
            Tab = Pab * (13591409 + 545140134 * a)
            if a & 1:
                Tab = -Tab
            return Pab, Qab, Tab
        m = (a + b) // 2
        Pam, Qam, Tam = bs(a, m)
        Pmb, Qmb, Tmb = bs(m, b)
        return Pam * Pmb, Qam * Qmb, Tam * Qmb + Pam * Tmb

    N = int(digits / 14.181647462725477) + 3
    P, Q, T = bs(0, N)
    one = 10 ** (digits + 10)
    sqrt10005 = math.isqrt(10005 * one * one)
    val = (Q * 426880 * sqrt10005) // T
    return str(val // 10 ** 10)  # floor(pi * 10^digits)


def method_C_machin_decimal(digits):
    getcontext().prec = digits + 60

    def arctan_inv(x):
        x = Decimal(x)
        total = term = Decimal(1) / x
        x2 = x * x
        n, sign = 1, -1
        while True:
            term = term / x2
            t = term / (2 * n + 1)
            if t == 0:
                break
            total += sign * t
            sign = -sign
            n += 1
        return total

    pi = 4 * (4 * arctan_inv(5) - arctan_inv(239))
    return str(pi)


def frac500(s):
    s = s.replace(" ", "")
    if "." in s:
        ip, fp = s.split(".")
    else:
        ip, fp = s[0], s[1:]
    return ip, fp[:DIGITS]


def main():
    mpmath.mp.dps = WORK
    sA = mpmath.nstr(mpmath.mp.pi, DIGITS + 20, strip_zeros=False)
    sB = method_B_chudnovsky_integer(DIGITS + 20)
    sC = method_C_machin_decimal(DIGITS + 20)

    ipA, A = frac500(sA)
    ipB, B = frac500(sB)
    ipC, C = frac500(sC)

    checks = {
        "integer_part_is_3": (ipA == ipB == ipC == "3"),
        "A_equals_B": (A == B),
        "A_equals_C": (A == C),
        "B_equals_C": (B == C),
        "A_equals_reference": (A == REFERENCE),
        "B_equals_reference": (B == REFERENCE),
        "C_equals_reference": (C == REFERENCE),
        "length_500": (len(A) == len(B) == len(C) == DIGITS),
    }
    # digit at position 501 (rounding safety: must not be a 9-run boundary)
    d501 = sA.split(".")[1][DIGITS]
    passed = all(checks.values())

    result = {
        "digits_verified": DIGITS,
        "methods": ["mpmath", "integer_chudnovsky", "decimal_machin"],
        "checks": checks,
        "digit_501": d501,
        "pi_500": "3." + A,
        "passed": passed,
    }
    with open("pi_500_verification.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    with open("pi_500.txt", "w", encoding="utf-8") as f:
        f.write("3." + A + "\n")

    print(json.dumps(result, indent=2))
    print("PASSED" if passed else "FAILED")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
