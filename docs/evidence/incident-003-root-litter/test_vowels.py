"""Verify count_vowels with exactly 5 test cases.

Run: python test_vowels.py
"""

from vowels import count_vowels

# (description, input, expected)
CASES = [
    ("all lowercase 'hello'", "hello", 2),
    ("all uppercase 'AEIOU'", "AEIOU", 5),
    ("mixed case 'Programming'", "Programming", 3),
    ("no vowels 'rhythm'", "rhythm", 0),
    ("empty string ''", "", 0),
]


def main() -> int:
    passed = 0
    failed = 0
    for i, (desc, text, expected) in enumerate(CASES, 1):
        actual = count_vowels(text)
        ok = actual == expected
        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        else:
            failed += 1
        print(
            f"[{status}] case {i}: {desc} | input={text!r} "
            f"expected={expected} actual={actual}"
        )
    print(f"\n{passed}/{len(CASES)} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
