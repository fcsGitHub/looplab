
def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        placed = False
        for b in bins:
            if sum(b) + size <= capacity:
                b.append(size); placed = True; break
        if not placed:
            bins.append([size])
    return bins
