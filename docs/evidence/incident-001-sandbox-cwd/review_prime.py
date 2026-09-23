"""Independent review harness for is_prime (copied verbatim from prime.py)."""

from typing import Any


def is_prime(n: Any) -> bool:
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
