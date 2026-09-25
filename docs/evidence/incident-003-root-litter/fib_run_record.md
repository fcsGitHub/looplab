# Experiment Record: Run fib.py and record actual output

## Target
- Script: `D:\project\looplab\fib.py` (NOT modified)
- Working directory: `D:\project\looplab`

## Commands executed
1. `python3 fib.py`
2. `python fib.py`   (fallback, since python3 was unavailable)

## Result 1: `python3 fib.py`
- Resolved interpreter: `C:\Users\xiaoc\AppData\Local\Microsoft\WindowsApps\python3.EXE`
  (Windows Microsoft Store stub — not a real interpreter)
- Exit code: **9009**
- stdout: `` (empty)
- stderr: `` (empty)
- Note: 9009 is the Windows "command not found" code; the Store stub produced no output.

## Result 2: `python fib.py` (fallback)
- Resolved interpreter: `D:\software\miniconda\python.EXE`
- Exit code: **0**
- stdout (raw):
  ```
  fib(30) = 832040
  ```
- stderr: `` (empty)

## Independent verification
- Recomputed fib(30) with a standalone loop: 832040 → matches program output.

## Conclusion
`fib.py` runs successfully under `python` (exit 0) and prints `fib(30) = 832040`.
`python3` is not a usable interpreter in this environment (Store stub, exit 9009).
