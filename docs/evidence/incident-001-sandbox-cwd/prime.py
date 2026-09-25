"""Prime number utilities.

This module provides :func:`is_prime`, a deterministic primality test for
integers based on trial division by 6k +/- 1 candidates.
"""

from typing import Any

__all__ = ["is_prime"]


def is_prime(n: Any) -> bool:
    """Return ``True`` if *n* is a prime number, otherwise ``False``.

    Type handling
    -------------
    * ``bool`` inputs are rejected: ``True``/``False`` are subclasses of
      ``int`` but are not treated as numbers here, so ``TypeError`` is raised.
    * Non-integer types (``str``, ``float``, ``None``, ``list``, ...) raise
      ``TypeError``.
    * Integer-valued floats such as ``7.0`` are *not* accepted; pass an ``int``.

    Algorithm
    ---------
    * ``n < 2`` -> ``False`` (0, 1 and negatives are not prime).
    * ``n == 2`` or ``n == 3`` -> ``True``.
    * Even ``n`` -> ``False``.
    * Otherwise trial division by candidates of the form ``6k +/- 1``
      (i.e. 5, 7, 11, 13, ...) up to ``int(n ** 0.5) + 1``.

    Parameters
    ----------
    n:
        Value to test. Must be an ``int`` (``bool`` excluded).

    Returns
    -------
    bool
        ``True`` if *n* is prime, ``False`` otherwise.

    Raises
    ------
    TypeError
        If *n* is not an ``int`` (including ``bool``).

    Examples
    --------
    >>> is_prime(2)
    True
    >>> is_prime(1)
    False
    >>> is_prime(97)
    True
    >>> is_prime("7")
    Traceback (most recent call last):
        ...
    TypeError: n must be an int, got str
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


def _run_tests() -> bool:
    """Run the built-in test cases and print a per-case report.

    Returns
    -------
    bool
        ``True`` if every case passed, ``False`` otherwise.
    """
    cases: list[tuple[Any, Any]] = [
        (2, True),
        (3, True),
        (1, False),
        (0, False),
        (-7, False),
        (4, False),
        (97, True),
        (100, False),
        (7919, True),
        ("7", TypeError),
    ]

    print(f"{'input':>10} | {'expected':>10} | {'actual':>10} | pass")
    print("-" * 48)

    passed = 0
    for value, expected in cases:
        try:
            actual: Any = is_prime(value)
        except TypeError as exc:
            actual = TypeError
            _ = exc
        ok = actual is expected
        passed += int(ok)
        print(f"{value!r:>10} | {expected!s:>10} | {actual!s:>10} | {ok}")

    total = len(cases)
    print("-" * 48)
    print(f"summary: {passed}/{total} passed")
    return passed == total


if __name__ == "__main__":
    _run_tests()
