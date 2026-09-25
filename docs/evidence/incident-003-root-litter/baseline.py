"""
Frozen baseline for the bin-packing evaluation protocol.

The baseline is FFD (First-Fit-Decreasing) as defined in frozen_protocol.py.
This module exposes a stable interface so candidates can be compared against
a frozen reference without re-deriving it.
"""
from frozen_protocol import ffd, make_suite, CAPACITY


def baseline_bins(items, capacity=CAPACITY):
    return ffd(items, capacity)


def baseline_on_suite(suite=None):
    if suite is None:
        suite = make_suite()
    return [baseline_bins(inst) for inst in suite]


if __name__ == "__main__":
    from frozen_protocol import protocol_fingerprint
    suite = make_suite()
    bins = baseline_on_suite(suite)
    print("protocol_version:", __import__("frozen_protocol").PROTOCOL_VERSION)
    print("fingerprint:", protocol_fingerprint())
    print("suite_size:", len(suite))
    print("baseline_total_bins:", sum(bins))
    print("baseline_mean_bins:", sum(bins) / len(bins))
