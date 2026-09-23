# Test Case Manifest — prime.py

Command: `python prime.py`  |  CWD: `D:\project\looplab`  |  Exit code: **0**

## A. Cases actually printed by the script (10 cases, all pass)

| # | input | expected | actual | pass |
|---|-------|----------|--------|------|
| 1 | 2 | True | True | True |
| 2 | 3 | True | True | True |
| 3 | 1 | False | False | True |
| 4 | 0 | False | False | True |
| 5 | -7 | False | False | True |
| 6 | 4 | False | False | True |
| 7 | 97 | True | True | True |
| 8 | 100 | False | False | True |
| 9 | 7919 | True | True | True |
| 10 | "7" | TypeError | TypeError | True |

Summary line: `summary: 10/10 passed`

## B. Coverage check against task-required inputs

Required set: `-7, 0, 1, 2, 3, 4, 9, 17, 97, 7919`

| required input | present in script cases? | expected | actual (is_prime) | pass |
|----------------|--------------------------|----------|-------------------|------|
| -7   | yes | False | False | True |
| 0    | yes | False | False | True |
| 1    | yes | False | False | True |
| 2    | yes | True  | True  | True |
| 3    | yes | True  | True  | True |
| 4    | yes | False | False | True |
| 9    | **NO (missing)** | False | False | True (function correct) |
| 17   | **NO (missing)** | True  | True  | True (function correct) |
| 97   | yes | True  | True  | True |
| 7919 | yes | True  | True  | True |

Extra cases in script not in required set: `100`, `"7"`.

## C. Findings

1. `python prime.py` runs cleanly: exit code 0, no stderr, prints exactly 10 cases, 10/10 pass.
2. The script's 10 cases do **NOT** match the task-required coverage set:
   - **Missing required inputs: `9` and `17`.**
   - Extra inputs present instead: `100` and `"7"`.
3. The underlying `is_prime()` function is nonetheless correct for all required
   inputs — independently verified against a trial-division reference and by
   direct subprocess invocation (all 10 required inputs pass).
4. Conclusion: the *function* is correct, but the *built-in test suite* does not
   cover the required inputs 9 and 17, so the "10 test cases covering the
   required set" requirement is NOT met by the script as written.
