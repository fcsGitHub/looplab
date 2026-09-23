"""Baseline heuristics for the 1-D bin packing problem.

All heuristics are self-implemented (no third-party solver), standard-library only.

Problem
-------
Given item sizes s_i in (0, C] and bin capacity C, assign every item to a bin so
that the sum of sizes in each bin is <= C, minimising the number of bins used.

Heuristics
----------
- first_fit_decreasing (FFD): sort items descending, place each into the first
  bin with enough residual capacity, else open a new bin.
- best_fit_decreasing (BFD): sort items descending, place each into the bin with
  the *smallest* sufficient residual capacity, else open a new bin.
- first_fit (FF): as FFD but in the original (unsorted) input order.

Reference baseline for the experiment contract is BFD (see docs/experiment_contract.md).
"""

from __future__ import annotations

from typing import List, Sequence

__all__ = ["first_fit", "first_fit_decreasing", "best_fit_decreasing", "HEURISTICS"]


def first_fit(sizes: Sequence[int], capacity: int) -> int:
    """First Fit (FF) in the given order. Returns the number of bins used."""
    residual: List[int] = []  # residual capacity of each open bin
    for s in sizes:
        for i in range(len(residual)):
            if residual[i] >= s:
                residual[i] -= s
                break
        else:
            residual.append(capacity - s)
    return len(residual)


def first_fit_decreasing(sizes: Sequence[int], capacity: int) -> int:
    """First Fit Decreasing (FFD). Returns the number of bins used."""
    residual: List[int] = []
    for s in sorted(sizes, reverse=True):
        for i in range(len(residual)):
            if residual[i] >= s:
                residual[i] -= s
                break
        else:
            residual.append(capacity - s)
    return len(residual)


def best_fit_decreasing(sizes: Sequence[int], capacity: int) -> int:
    """Best Fit Decreasing (BFD). Returns the number of bins used."""
    residual: List[int] = []
    for s in sorted(sizes, reverse=True):
        best = -1
        best_res = None
        for i in range(len(residual)):
            r = residual[i]
            if r >= s and (best_res is None or r < best_res):
                best_res = r
                best = i
        if best >= 0:
            residual[best] -= s
        else:
            residual.append(capacity - s)
    return len(residual)


HEURISTICS = {
    "FF": first_fit,
    "FFD": first_fit_decreasing,
    "BFD": best_fit_decreasing,
}


if __name__ == "__main__":  # tiny smoke test
    inst = [70, 60, 50, 40, 30, 20, 10]
    cap = 100
    for name, fn in HEURISTICS.items():
        print(name, fn(inst, cap))
