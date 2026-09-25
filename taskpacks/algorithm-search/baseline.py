"""Trusted baseline for bin-packing: First-Fit Decreasing (FFD).

This file is controlled by the platform maintainers only. Candidates never
touch it; the evaluator imports it as the comparison anchor.
"""


def pack(items, capacity=100):
    """First-Fit Decreasing. items: list[int]; returns list[list[int]]."""
    bins = []
    for size in sorted(items, reverse=True):
        placed = False
        for b in bins:
            if sum(b) + size <= capacity:
                b.append(size)
                placed = True
                break
        if not placed:
            bins.append([size])
    return bins


if __name__ == "__main__":
    import random
    rng = random.Random(7)
    items = [rng.randint(10, 90) for _ in range(60)]
    bs = pack(items, 100)
    assert sorted(x for b in bs for x in b) == sorted(items)
    print(f"{len(bs)} bins for {len(items)} items")
