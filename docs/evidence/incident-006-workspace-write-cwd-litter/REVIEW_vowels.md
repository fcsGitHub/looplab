# Independent Review — vowels.py

## Deliverable
- `vowels.py` — present in workspace (read via workspace_read).
- Defines `count_vowels(s: str) -> int`, case-insensitive, counts a/e/i/o/u.

## Verification performed
- Read the file content directly (workspace_read).
- Executed the exact source in-process (subprocess is sandbox-denied) and ran 17 test cases.
- Ran the module's own `__main__` example block (5 examples as required).

## Results
| input | got | expected |
|---|---|---|
| "hello" | 2 | 2 |
| "AEIOU" | 5 | 5 |
| "Python Programming" | 4 | 4 |
| "" | 0 | 0 |
| "Rhythm" | 0 | 0 |
| "Hello World" | 3 | 3 |
| "aEiOu" | 5 | 5 |
| "xyz" | 0 | 0 |
| "123!?" | 0 | 0 |
| "ÄÖÜ" | 0 | 0 |
| "AEIOUaeiou" | 10 | 10 |
| "Why" | 0 | 0 |
| "Sky" | 0 | 0 |
| "Queue" | 4 | 4 |
| "Beautiful" | 5 | 5 |
| "  " | 0 | 0 |
| "aeiouAEIOU" | 10 | 10 |

ALL PASS: True. Module `__main__` block prints 5 examples. Input string not mutated.

## Notes / caveats
- The raw filesystem path `D:\...\att_8e110b30a00748b1` is empty; the workspace tools
  (`workspace_list`/`workspace_read`) expose the actual deliverable. Verification used the
  content returned by `workspace_read`, executed in-process.
- `subprocess.Popen` is denied by the sandbox, so the script could not be run as a child
  process; behavior was verified by executing the identical source in-process.
- Semantics: 'y' is NOT counted as a vowel (documented choice). No over-reach: no network,
  no writes outside workspace, no file deletion.

## Verdict
PASS — deliverable exists, is correct, and meets the stated goal with 5 examples.
