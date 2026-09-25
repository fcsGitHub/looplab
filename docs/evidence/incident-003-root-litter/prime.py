"""Prime number utilities with a built-in 10-case test harness.

The test harness covers the required inputs:
    -7, 0, 1, 2, 3, 4, 9, 17, 97, 7919 (the 1000th prime).

Running ``python prime.py`` prints a per-case report and exits with code 0
if and only if all 10 cases pass.
"""

from typing import Any

__all__ = ["is_prime"]


def is_prime(n: Any) -> bool:
    """Return ``True`` if *n* is prime, ``False`` otherwise.

    ``bool`` inputs are rejected (they are ``int`` subclasses but not treated
    as numbers here). Non-integer types raise ``TypeError``.
    """
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"n must be an int, got {type(n).__name__}")

    if n < 2:
        return False
    if n in (2, 3):
        return True
    if n % 2 == 0:
        return False

    limit = int(n ** 0.5) + 1
    d = 3
    while d <= limit:
        if n % d == 0:
            return False
        d += 2
    return True


# The 10 required test cases: (input, expected result).
CASES: list[tuple[Any, Any]] = [
    (-7, False),
    (0, False),
    (1, False),
    (2, True),
    (3, True),
    (4, False),
    (9, False),
    (17, True),
    (97, True),
    (7919, True),  # 7919 is the 1000th prime
]


def _run_tests() -> bool:
    """Run the built-in test cases and print a per-case report."""
    print(f"{'input':>10} | {'expected':>10} | {'actual':>10} | pass")
    print("-" * 48)

    passed = 0
    for value, expected in CASES:
        try:
            actual: Any = is_prime(value)
        except TypeError:
            actual = TypeError
        ok = actual is expected
        passed += int(ok)
        print(f"{value!r:>10} | {expected!s:>10} | {actual!s:>10} | {ok}")

    total = len(CASES)
    print("-" * 48)
    print(f"summary: {passed}/{total} passed")
    return passed == total


if __name__ == "__main__":
    import sys

    sys.exit(0 if _run_tests() else 1)
