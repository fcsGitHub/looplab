# README_pi.md — π to 500 Decimal Places (Standard Library Only)

This document consolidates the results of tasks **t1–t4** for the π-computation
deliverable. It describes the algorithm, how to run it, the measured output
size, the independent verification conclusion (from the t4 report), and the
role/limits of the Monte Carlo cross-check.

---

## 1. Deliverables

| File | Role |
|---|---|
| `pi_est.py` | Producer. Computes π to a requested number of decimals (default 500) using only the Python standard library. |
| `pi_output.txt` | Produced artifact. Contains `pi = 3.<500 decimal digits>` (502-character numeric string). |
| `README_pi.md` | This document (consolidated t1–t4 summary). |

Supporting/verification artifacts present in the workspace:
`verify_pi.py` (independent verifier), `pi_est_check.py` (t3 checker),
`t3_pi_output.txt`, `ref500.txt`, `VERIFICATION_REPORT.md` (t4 report).

---

## 2. Algorithm

**Primary method — Chudnovsky series (arbitrary-precision `decimal`).**

The Chudnovsky formula is evaluated in the classic integer-recurrence form:

```
pi = 426880 * sqrt(10005) / S

S = sum_{k>=0} (-1)^k (6k)! (13591409 + 545140134 k)
                / ((3k)! (k!)^3 (-262537412640768000)^k)
```

Implementation notes (`pi_est.py`):

- Each term of the series adds ≈ **14.18** correct decimal digits
  (`DIGITS_PER_TERM = 14.181647462725477`), so the number of terms used is
  `int(digits / 14.1816...) + 2`.
- Working precision is `digits + 20` **guard digits** to absorb accumulated
  rounding during the final division.
- The result is **truncated** (`ROUND_DOWN`) rather than rounded, so the
  printed string is a genuine *prefix* of π's decimal expansion.
- `sqrt(10005)` is computed with `Decimal.sqrt()` at guard precision.
- Only the standard library is used (`argparse`, `decimal`, `random`, `sys`).

**Secondary method — Monte Carlo (cross-check only, off by default).**
See §5.

---

## 3. How to Run

```bash
# Default: print pi to 500 decimal places
python3 pi_est.py

# Custom precision
python3 pi_est.py --digits 1000

# Optional Monte Carlo cross-check (N samples, fixed seed)
python3 pi_est.py --monte-carlo 1000000
python3 pi_est.py --monte-carlo 1000000 --seed 12345
```

Output format on stdout:

```
pi = 3.14159265358979...
```

Exit code `0` on success.

### Independent verification

```bash
python3 verify_pi.py        # Machin + hardcoded reference + math.pi sanity check
python3 pi_est_check.py     # Chudnovsky recomputation vs pi_output.txt
```

Both are expected to end with `RESULT: PASS`.

---

## 4. Measured Output Size

Measured directly from `pi_output.txt` (real run, not estimated):

| Quantity | Value |
|---|---|
| Numeric string length (`3` + `.` + decimals) | **502 characters** |
| Decimal digits after the point | **500** |
| Leading digits | `3.1415926535897932384626433832795028841971693993751058209749...` |
| Trailing digits | `...188575272489122793818301194912` |

The `pi_est.py` algorithm was re-executed in this task and reproduced a
502-character string with exactly 500 decimals, byte-identical to
`pi_output.txt`.

---

## 5. Monte Carlo Error Note (applicability & limits)

`pi_est.py` includes a Monte Carlo estimator (`monte_carlo_pi`) as an
**independent, coarse sanity check**. It is **not** part of the default output
and must be requested explicitly with `--monte-carlo N`.

**Method:** throw `N` uniform points into `[0,1)×[0,1)`; the fraction inside
the quarter unit circle estimates `pi/4`, so `pi ≈ 4·hits/N`.

**Error scaling:** the standard error of this estimator is

```
sigma ≈ 0.5 / sqrt(N)      (absolute error on pi)
```

so gaining **one extra correct decimal digit requires ~100× more samples**.
It is therefore *unsuitable* for producing 500 digits and is used only as a
rough plausibility check.

**Measured behaviour** (seed = 12345, real runs in this task):

| N samples | Estimate | Abs. error vs π | 1/sqrt(N) |
|---|---|---|---|
| 10,000 | 3.139200 | 0.002393 | 0.010000 |
| 100,000 | 3.143640 | 0.002047 | 0.003162 |
| 1,000,000 | 3.139676 | 0.001917 | 0.001000 |

The observed errors are consistent with the `O(1/sqrt(N))` bound. **Conclusion:
Monte Carlo is applicable only as a low-precision cross-check; the 500-digit
result relies exclusively on the Chudnovsky series.**

---

## 6. Verification Conclusion (from t4 report)

Source: `VERIFICATION_REPORT.md` (t4), plus independent re-checks performed in
this task.

**Artifact under test:** `pi_output.txt` — format `pi = 3.<500 decimals>`,
numeric string length 502, decimal digits 500.

**Independent methods used (no code reused from the producing task):**

1. **Machin's formula** — `pi/4 = 4·arctan(1/5) − arctan(1/239)`, computed with
   exact integer arithmetic and 20 guard digits (no floating point, no
   `math.pi`).
2. **Hardcoded published 500-digit expansion** of π.
3. **`math.pi`** (15–16 significant digits) as a coarse sanity check.
4. **Chudnovsky recomputation** (`pi_est_check.py`) as a second algorithm.

**Results:**

| Comparison | All equal | First mismatch | Compared length |
|---|---|---|---|
| produced vs hardcoded reference | **True** | none | 502 |
| produced vs Machin (integer) | **True** | none | 502 |
| Machin vs hardcoded reference | **True** | none | 502 |
| produced vs Chudnovsky (re-run) | **True** | none | 502 |

- Consecutive matching decimal digits (produced vs hardcoded ref): **500 / 500**
- Consecutive matching decimal digits (produced vs Machin): **500 / 500**
- `math.pi` leading 15 decimals match: **True**

**Conclusion: PASS.** All 500 decimal digits in `pi_output.txt` match two
independent references; there is no first-mismatch position. This conclusion
was reproduced in the current task by re-running both the Machin and
Chudnovsky checks against the file contents.

---

## 7. File Checklist

Confirmed present in the workspace:

- [x] `pi_est.py` — producer script (standard library only)
- [x] `pi_output.txt` — 500-decimal π output (502-char numeric string)
- [x] `README_pi.md` — this consolidated document

Verification/support artifacts also present: `verify_pi.py`,
`pi_est_check.py`, `t3_pi_output.txt`, `ref500.txt`, `VERIFICATION_REPORT.md`.
