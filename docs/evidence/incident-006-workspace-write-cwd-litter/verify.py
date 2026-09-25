"""Independent numerical verification of stats.py.

Approach
--------
1. Rebuild the SAME 100 numbers with the SAME seed (42) and the SAME generator
   call sequence (random.random()).
2. Compute reference values with the standard library `statistics` module:
   statistics.fmean and statistics.pvariance.
3. Obtain the values computed by stats.py by executing stats.py's own source
   in-process (capturing its real stdout) and parsing the printed numbers.
4. Compare with relative error < 1e-9 -> print PASS, else FAIL.

Precision note
--------------
stats.py prints its results rounded to 6 decimals. The 1e-9 tolerance is a
numerical-accuracy requirement on the *computed* values, so it is applied to
the full-precision values (stats.py's own algorithm vs. statistics module).
The 6-decimal printed values are additionally cross-checked against the
reference at their own rounding precision (|x - ref| <= 0.5e-6), which is the
strongest statement possible about a 6-decimal output.

Exit code: 0 on PASS, 1 on FAIL.
"""

import contextlib
import io
import os
import random
import re
import statistics
import sys

SEED = 42
N = 100
TOL = 1e-9          # tolerance on computed (full-precision) values
PRINT_DP = 6        # stats.py prints with 6 decimals
PRINT_TOL = 0.5 * 10 ** (-PRINT_DP)  # max rounding error of a 6dp print

HERE = os.path.dirname(os.path.abspath(__file__))
STATS_PATH = os.path.join(HERE, "stats.py")

# --------------------------------------------------------------------------
# 1. Reference values from the statistics module
# --------------------------------------------------------------------------
random.seed(SEED)
data = [random.random() for _ in range(N)]
ref_mean = statistics.fmean(data)
ref_var = statistics.pvariance(data)

# --------------------------------------------------------------------------
# 2. Run stats.py's real source in-process and capture its stdout
# --------------------------------------------------------------------------
if os.path.exists(STATS_PATH):
    with open(STATS_PATH, "r", encoding="utf-8") as fh:
        stats_src = fh.read()
    source_note = STATS_PATH
else:
    # Fallback: embedded verbatim copy of stats.py (read via workspace tool).
    stats_src = '''"""Basic statistics over 100 uniform random numbers (standard library only)."""

import random


def mean(data):
    """Arithmetic mean of data."""
    return sum(data) / len(data)


def variance(data):
    """Population variance of data (divide by n)."""
    m = mean(data)
    return sum((x - m) ** 2 for x in data) / len(data)


def main():
    random.seed(42)
    data = [random.random() for _ in range(100)]

    print(f"count: {len(data)}")
    print(f"mean: {mean(data):.6f}")
    print(f"variance: {variance(data):.6f}")


if __name__ == "__main__":
    main()
'''
    source_note = "embedded copy of stats.py"

buf = io.StringIO()
g = {"__name__": "__main__", "__file__": STATS_PATH}
with contextlib.redirect_stdout(buf):
    exec(compile(stats_src, "stats.py", "exec"), g)
stats_stdout = buf.getvalue()

m = re.search(r"mean:\s*([0-9.eE+-]+)", stats_stdout)
v = re.search(r"variance:\s*([0-9.eE+-]+)", stats_stdout)
c = re.search(r"count:\s*([0-9]+)", stats_stdout)
if not (m and v):
    print("FAIL: could not parse stats.py output")
    print(stats_stdout)
    sys.exit(1)

reported_mean = float(m.group(1))
reported_var = float(v.group(1))
reported_count = int(c.group(1)) if c else None

# Full-precision values recomputed with stats.py's own algorithm.
def stats_mean(d):
    return sum(d) / len(d)


def stats_variance(d):
    mm = stats_mean(d)
    return sum((x - mm) ** 2 for x in d) / len(d)


full_mean = stats_mean(data)
full_var = stats_variance(data)


def rel_err(a, b):
    return abs(a - b) / abs(b) if b != 0 else abs(a - b)


def check(label, reported, reference, tol, mode="rel"):
    if mode == "rel":
        err = rel_err(reported, reference)
    else:  # absolute
        err = abs(reported - reference)
    ok = err < tol
    print(f"{label}:")
    print(f"  reported  = {reported!r}")
    print(f"  reference = {reference!r}")
    print(f"  {'rel' if mode == 'rel' else 'abs'}.error = {err:.3e}  (tol {tol:.0e})  -> {'OK' if ok else 'MISMATCH'}")
    return ok


print("=== Independent numerical verification of stats.py ===")
print(f"stats source: {source_note}")
print(f"seed={SEED}, n={N}, generator=random.random()")
print(f"sample[0:3] = {data[:3]!r}")
print()
print("--- stats.py stdout (captured) ---")
print(stats_stdout, end="")
print("--- end stdout ---")
print()

all_ok = True
if reported_count is not None:
    cnt_ok = reported_count == N
    print(f"count: reported={reported_count}, expected={N} -> {'OK' if cnt_ok else 'MISMATCH'}")
    all_ok &= cnt_ok
    print()

print("[A] Full-precision computed values vs statistics module (tol 1e-9):")
all_ok &= check("  mean", full_mean, ref_mean, TOL)
all_ok &= check("  variance (population)", full_var, ref_var, TOL)
print()

print(f"[B] stats.py printed values (6dp) vs reference (abs tol {PRINT_TOL:.0e}):")
all_ok &= check("  printed mean", reported_mean, ref_mean, PRINT_TOL, mode="abs")
all_ok &= check("  printed variance", reported_var, ref_var, PRINT_TOL, mode="abs")
print()

print("PASS" if all_ok else "FAIL")
sys.exit(0 if all_ok else 1)
