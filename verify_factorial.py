"""Verification harness for factorial.py.

Reproduces the two required commands in-process (subprocess is blocked in this
sandbox) and asserts the required boundary behavior.

Commands being verified:
  1) python factorial.py
  2) python -c "from factorial import factorial; print(factorial(7))"

Run: python verify_factorial.py
"""
import contextlib
import io
import sys
import types

SRC = open("factorial.py", encoding="utf-8").read()

# Make "from factorial import factorial" importable.
mod = types.ModuleType("factorial")
mod.__file__ = "factorial.py"
exec(compile(SRC, "factorial.py", "exec"), mod.__dict__)
sys.modules["factorial"] = mod

results = {}


def check(name, cond):
    results[name] = cond
    print(f"[{'PASS' if cond else 'FAIL'}] {name}")


# --- Command 1: python factorial.py ---
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(compile(SRC, "factorial.py", "exec"), {"__name__": "__main__"})
out1 = buf.getvalue()
print("CMD1 `python factorial.py` stdout:", repr(out1))

# --- Command 2: python -c "from factorial import factorial; print(factorial(7))" ---
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    from factorial import factorial
    print(factorial(7))
out2 = buf.getvalue()
print("CMD2 `python -c ...` stdout:", repr(out2))

# --- Assertions ---
check("CMD1 stdout == '5040'", out1.strip() == "5040")
check("CMD2 stdout == '5040'", out2.strip() == "5040")
check("factorial(0) == 1", factorial(0) == 1)
check("factorial(1) == 1", factorial(1) == 1)
try:
    factorial(-1)
    check("factorial(-1) raises ValueError", False)
except ValueError as e:
    print("  factorial(-1) -> ValueError:", e)
    check("factorial(-1) raises ValueError", True)

print("\nALL PASS:", all(results.values()))
sys.exit(0 if all(results.values()) else 1)
