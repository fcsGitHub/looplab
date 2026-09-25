#!/usr/bin/env python3
"""Monte Carlo estimation of pi.

Fixed seed and fixed budget for reproducibility.
Prints the estimate as a plain numeric string (no '3.' prefix stripping,
no extra characters) to stdout.
"""
import random
import sys

SEED = 20240607
N = 1_000_000


def estimate_pi(n: int, seed: int) -> float:
    rng = random.Random(seed)
    inside = 0
    for _ in range(n):
        x = rng.random()
        y = rng.random()
        if x * x + y * y <= 1.0:
            inside += 1
    return 4.0 * inside / n


def main() -> int:
    pi = estimate_pi(N, SEED)
    # Emit only the numeric string
    sys.stdout.write(repr(pi) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
