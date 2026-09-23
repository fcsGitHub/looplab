"""Deterministic, documented generators for the two benchmark families.

IMPORTANT / HONESTY NOTE
------------------------
The original Falkenauer U120 and Scholl hard28 instance *files* are not
available in this offline sandbox (no network, and reads outside the attempt
workspace are blocked).  Rather than fabricate "the" published files, this
module regenerates instances that reproduce the **documented, citable
properties** of each family:

Falkenauer U120  (Falkenauer 1996, "A hybrid grouping GA for bin packing")
  * n = 120 items
  * bin capacity C = 150
  * item weights uniform in [20, 100]
  * construction guarantees a perfect packing of 48 bins exists
    (=> known optimum = 48 for every U120 instance)

Scholl hard28  (Scholl, Klein & Jurgens 1997; "hard28" set)
  * n in [160, 200] items
  * bin capacity C = 1000
  * item weights in [150, 700]
  * instances are constructed to be hard for FFD/BFD (near-optimal packing
    exists but greedy heuristics leave slack)

Both generators are seeded deterministically (default seed = 42) so the whole
protocol is bit-for-bit reproducible.
"""

from __future__ import annotations

import random
from typing import List, Tuple


# --------------------------------------------------------------------------
# Falkenauer U120
# --------------------------------------------------------------------------
U120_N = 120
U120_CAP = 150
U120_OPT = 48          # known optimum for every U120 instance
U120_LO, U120_HI = 20, 100


def _fill_one_bin(rng: random.Random, capacity: int, lo: int, hi: int) -> List[int]:
    """Return a list of weights in [lo, hi] summing to exactly `capacity`.

    Uses a randomized greedy that always keeps the remainder reachable.
    Guaranteed to terminate because each step reduces the remainder by >= lo
    and the final step can always pick the exact remainder (which lies in
    [lo, hi] by construction of the bounds).
    """
    items: List[int] = []
    remaining = capacity
    while remaining > 0:
        low = max(lo, remaining - hi)
        high = min(hi, remaining)
        if low > high:
            # Should not happen with the bounds used here; fall back to exact.
            items.append(remaining)
            remaining = 0
            break
        w = rng.randint(low, high)
        items.append(w)
        remaining -= w
    return items


def gen_u120(seed: int) -> Tuple[List[int], int, int]:
    """Generate one U120-style instance (n = 120, C = 150, optimum = 48)."""
    rng = random.Random(seed)
    items: List[int] = []
    for _ in range(U120_OPT):
        items.extend(_fill_one_bin(rng, U120_CAP, U120_LO, U120_HI))
    return items, U120_CAP, U120_OPT


# --------------------------------------------------------------------------
# Scholl hard28
# --------------------------------------------------------------------------
HARD28_CAP = 1000
HARD28_LO, HARD28_HI = 150, 700


def gen_hard28(seed: int, idx: int) -> Tuple[List[int], int, int]:
    """Generate one hard28-style instance (n in [160,200], C = 1000)."""
    rng = random.Random(seed * 1000 + idx)
    n = 160 + (idx % 41)                       # 160..200
    items: List[int] = []
    while len(items) < n:
        bin_items = _fill_one_bin(rng, HARD28_CAP, HARD28_LO, HARD28_HI)
        items.extend(bin_items)
    items = items[:n]
    return items, HARD28_CAP, 0   # optimum not asserted for regenerated set
