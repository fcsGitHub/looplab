
def pack(items, capacity=100):
    # Best-Fit Decreasing
    bins = []  # list of remaining capacities
    contents = []
    for size in sorted(items, reverse=True):
        best = -1; best_rem = None
        for i, rem in enumerate(bins):
            if rem >= size and (best_rem is None or rem < best_rem):
                best_rem = rem; best = i
        if best >= 0:
            bins[best] -= size; contents[best].append(size)
        else:
            bins.append(capacity - size); contents.append([size])
    return contents
