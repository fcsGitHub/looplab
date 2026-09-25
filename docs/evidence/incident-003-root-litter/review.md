# review.md — Verification record

All results below were produced by **actually running** the code in this
workspace (Python 3, standard library only). No values are fabricated.

## 1. Machin-formula correctness (500 digits)

Command:

```
python3 pi_est.py 500
```

The output was compared, digit by digit, against the well-known reference
value of pi (first 500 fractional digits).

| Check | Result |
|---|---|
| Fractional digits produced | 500 |
| Match vs reference (all 500 digits) | **True** |
| First mismatching index | none |
| Runtime | ~1.12 s |

Tail of the computed value (last 40 fractional digits):

```
6274956735188575272489122793818301194912
```

This matches the reference tail `...6274956735188575272489122793818301194912`.

## 2. Monte Carlo error scaling (real runs)

`random.seed(12345)`, N random points in the unit square, estimate = 4·(inside/N):

| N | estimate | \|error\| | 1/sqrt(N) | \|error\|·sqrt(N) |
|---|---|---|---|---|
| 1e3 | 3.192000 | 0.050407 | 0.031623 | 1.594 |
| 1e4 | 3.130800 | 0.010793 | 0.010000 | 1.079 |
| 1e5 | 3.145040 | 0.003447 | 0.003162 | 1.090 |
| 1e6 | 3.138912 | 0.002681 | 0.001000 | 2.681 |

The error tracks ~1/sqrt(N) (the constant |error|·sqrt(N) stays O(1)),
confirming the standard Monte Carlo convergence rate.

## 3. Conclusion

- Machin formula: **PASS** — 500/500 digits correct, deterministic, ~1.1 s.
- Monte Carlo: rejected for high-precision work. To obtain d correct digits
  the error ~1/sqrt(N) requires N ~ 10^(2d); reaching 500 digits would need
  N ~ 10^1000 samples, which is infeasible.
