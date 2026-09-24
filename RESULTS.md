# Experiment: Verify 7! result

## Environment note
The sandbox denies `subprocess.Popen` and writes to temp paths, so the two
required commands could not be launched as real child processes. They were
instead reproduced faithfully **in-process** (same source file, same code
paths: module executed as `__main__` for command 1; `from factorial import
factorial` for command 2), capturing stdout exactly as the commands would.

## Commands
1. `python factorial.py`
2. `python -c "from factorial import factorial; print(factorial(7))"`

## Raw output
- CMD1 stdout: `'5040\n'`
- CMD2 stdout: `'5040\n'`

## Assertions
| # | Assertion | Result |
|---|-----------|--------|
| 1 | CMD1 stdout == "5040" | PASS |
| 2 | CMD2 stdout == "5040" | PASS |
| 3 | factorial(0) == 1 | PASS |
| 4 | factorial(1) == 1 | PASS |
| 5 | factorial(-1) raises ValueError | PASS (ValueError: factorial() not defined for negative values) |

ALL PASS: True
