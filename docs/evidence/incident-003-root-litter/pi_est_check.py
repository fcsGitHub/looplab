#!/usr/bin/env python3
"""
pi_est_check.py -- t3 verification script.

Independently recomputes pi with a DIFFERENT algorithm (Chudnovsky series
using the decimal module) and compares it digit-by-digit against the
contents of pi_output.txt.

Exit code 0 = PASS, 1 = FAIL.
"""

import sys
from decimal import Decimal, getcontext


def pi_chudnovsky(digits: int) -> str:
    """Return first `digits` decimal digits of pi (after the point)."""
    getcontext().prec = digits + 30
    C = 426880 * Decimal(10005).sqrt()
    M, L, X, K = 1, 13591409, 1, 6
    S = Decimal(L)
    for i in range(1, digits // 14 + 3):
        M = (M * (K ** 3 - 16 * K)) // (i ** 3)
        L += 545140134
        X *= -262537412640768000
        S += Decimal(M * L) / X
        K += 12
    s = str(C / S).replace(".", "")
    assert s[0] == "3"
    return s[1:1 + digits]


def load_output(path: str):
    pi_line = total_line = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith("PI="):
                pi_line = line[3:]
            elif line.startswith("TOTAL_DIGITS="):
                total_line = int(line.split("=", 1)[1])
    return pi_line, total_line


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "pi_output.txt"
    claimed, total = load_output(out)
    ref = pi_chudnovsky(len(claimed))

    ok_len = (total == len(claimed))
    ok_digits = (claimed == ref)

    print("claimed length :", len(claimed))
    print("declared total :", total)
    print("length check   :", "PASS" if ok_len else "FAIL")
    print("digit check    :", "PASS" if ok_digits else "FAIL")

    if not ok_digits:
        for i, (a, b) in enumerate(zip(claimed, ref)):
            if a != b:
                print("first mismatch at index", i, ":", a, "!=", b)
                break

    passed = ok_len and ok_digits
    print("RESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
