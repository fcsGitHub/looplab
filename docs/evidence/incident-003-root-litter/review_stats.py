"""Independent re-verification of stats.py results.

Does NOT import or modify stats.py. Re-generates the same sequence with
seed=42 and recomputes mean/variance two ways:
  (A) statistics.mean / statistics.pvariance
  (B) hand-written formulas: sum(x)/n and sum((x-m)**2)/n
Then compares A vs B (tol 1e-9) and both against t2's reported values.
"""

import random
import statistics

TOL = 1e-9

# t2 reported values (from stats_run_report.md)
T2_MEAN = 0.479569
T2_VAR = 0.086157

# --- regenerate identical sequence ---
random.seed(42)
nums = [random.random() for _ in range(100)]
n = len(nums)

# --- method A: stdlib ---
mean_a = statistics.mean(nums)
var_a = statistics.pvariance(nums)

# --- method B: hand-written formulas ---
mean_b = sum(nums) / n
var_b = sum((x - mean_b) ** 2 for x in nums) / n

# --- comparisons ---
d_mean = abs(mean_a - mean_b)
d_var = abs(var_a - var_b)
consistent = (d_mean <= TOL) and (d_var <= TOL)

# compare against t2's rounded (6dp) values
d_t2_mean = abs(mean_a - T2_MEAN)
d_t2_var = abs(var_a - T2_VAR)
# t2 values are rounded to 6 decimals -> tolerance 5e-7
ROUND_TOL = 5e-7
match_t2 = (d_t2_mean <= ROUND_TOL) and (d_t2_var <= ROUND_TOL)

print(f"n = {n}")
print(f"first 5 nums = {nums[:5]}")
print(f"method A (statistics): mean={mean_a!r} var={var_a!r}")
print(f"method B (manual)    : mean={mean_b!r} var={var_b!r}")
print(f"|A-B| mean = {d_mean:.3e}")
print(f"|A-B| var  = {d_var:.3e}")
print(f"tol = {TOL:.1e}  -> A==B consistent: {consistent}")
print(f"t2 reported: mean={T2_MEAN} var={T2_VAR}")
print(f"|A-t2| mean = {d_t2_mean:.3e}  |A-t2| var = {d_t2_var:.3e}")
print(f"match t2 (round tol {ROUND_TOL:.1e}): {match_t2}")
print(f"formatted A: mean={mean_a:.6f} var={var_a:.6f}")

assert consistent, "A and B disagree beyond tolerance"
assert match_t2, "values do not match t2 report"
print("ALL CHECKS PASSED")
