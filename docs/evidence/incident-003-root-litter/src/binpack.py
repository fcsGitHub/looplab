"""Core bin-packing primitives and baseline heuristics.

Standard-library only. Deterministic.

Baselines implemented here (classic, textbook):
  * First Fit Decreasing  (FFD)  -- Johnson, Demers, Ullman, Garey, Graham (1974)
  * Best  Fit Decreasing  (BFD)  -- same family, best-fit placement rule

Both sort items in non-increasing order and place each item into the first
(FFD) / tightest (BFD) bin that can accommodate it, opening a new bin only
when necessary.  These are the canonical reference implementations used
throughout the bin-packing literature.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple


def first_fit_decreasing(items: Sequence[int], capacity: int) -> List[List[int]]:
    """FFD: sort descending, place into first bin with enough residual room."""
    order = sorted(items, reverse=True)
    bins: List[List[int]] = []
    residual: List[int] = []
    for it in order:
        placed = False
        for i, r in enumerate(residual):
            if r >= it:
                bins[i].append(it)
                residual[i] = r - it
                placed = True
                break
        if not placed:
            bins.append([it])
            residual.append(capacity - it)
    return bins


def best_fit_decreasing(items: Sequence[int], capacity: int) -> List[List[int]]:
    """BFD: sort descending, place into the bin with the smallest sufficient residual."""
    order = sorted(items, reverse=True)
    bins: List[List[int]] = []
    residual: List[int] = []
    for it in order:
        best_i = -1
        best_r = None
        for i, r in enumerate(residual):
            if r >= it and (best_r is None or r < best_r):
                best_r = r
                best_i = i
        if best_i >= 0:
            bins[best_i].append(it)
            residual[best_i] = best_r - it
        else:
            bins.append([it])
            residual.append(capacity - it)
    return bins


def n_bins(bins: Sequence[Sequence[int]]) -> int:
    return len(bins)


def validate_solution(bins: Sequence[Sequence[int]], items: Sequence[int], capacity: int) -> bool:
    """Check every item is used exactly once and no bin exceeds capacity."""
    flat = [x for b in bins for x in b]
    if sorted(flat) != sorted(items):
        return False
    return all(sum(b) <= capacity for b in bins)
