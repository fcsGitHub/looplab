"""Verification of is_prime(n) with 10 test cases.

Runs the tests, prints a per-case report, and writes the results
to verification_result.txt.
"""

from prime import is_prime

# (input, expected, description)
TEST_CASES = [
    (1,   False, "1 is not prime (unit)"),
    (2,   True,  "2 is the smallest prime"),
    (3,   True,  "3 is prime"),
    (4,   False, "4 = 2*2 is composite"),
    (9,   False, "9 = 3*3 is composite (odd)"),
    (17,  True,  "17 is prime"),
    (25,  False, "25 = 5*5 is composite"),
    (97,  True,  "97 is prime"),
    (100, False, "100 is composite"),
    (7919, True, "7919 is the 1000th prime"),
]


def main():
    lines = []
    passed = 0
    for n, expected, desc in TEST_CASES:
        got = is_prime(n)
        ok = (got == expected)
        passed += ok
        line = (f"[{'PASS' if ok else 'FAIL'}] is_prime({n}) = {got} "
                f"(expected {expected}) -- {desc}")
        print(line)
        lines.append(line)

    total = len(TEST_CASES)
    summary = f"\n{passed}/{total} test cases passed."
    print(summary)
    lines.append(summary)

    with open("verification_result.txt", "w", encoding="utf-8") as fh:
        fh.write("Verification of is_prime(n) in prime.py\n")
        fh.write("=" * 50 + "\n")
        fh.write("\n".join(lines) + "\n")

    return passed == total


if __name__ == "__main__":
    import sys
    sys.exit(0 if main() else 1)
