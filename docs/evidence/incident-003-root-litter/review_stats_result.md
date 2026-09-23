# Independent Review of stats.py Results

## Method
Independent script (no import of stats.py). Regenerated the sequence with
`random.seed(42)` -> 100 `random.random()` values, then computed:

- **A (stdlib):** `statistics.mean`, `statistics.pvariance`
- **B (manual):** `sum(x)/n`, `sum((x-m)**2)/n`

Compared A vs B (tol 1e-9) and both against t2's reported values.

## Numbers
- n = 100
- first 5: 0.6394267984578837, 0.025010755222666936, 0.27502931836911926, 0.22321073814882275, 0.7364712141640124
- A: mean = 0.4795692431264169, var = 0.08615704820019793
- B: mean = 0.47956924312641697, var = 0.08615704820019791

## Differences
- |A-B| mean = 5.551e-17  (<= 1e-9)
- |A-B| var  = 1.388e-17  (<= 1e-9)
- |A-t2| mean = 2.431e-07, |A-t2| var = 4.820e-08 (t2 rounded to 6dp; tol 5e-7)

## Conclusion
- A and B are **consistent** (differences ~1e-17, far below 1e-9).
- Recomputed values **match t2's report** `mean=0.479569 var=0.086157`
  (differences are pure 6-decimal rounding).
- **VERDICT: t2's statistics are CORRECT.**
