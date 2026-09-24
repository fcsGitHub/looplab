"""Untrusted-side candidate runner.

Runs INSIDE a child process spawned by the evaluator. A Python audit hook
blocks filesystem access outside this directory, networking and subprocesses,
so a malicious candidate cannot read sealed labels or tamper with the
evaluator even though it shares the OS user (single-host boundary; see
docs/architecture/threat-model.md).

Protocol: stdin = {"problems":[{"id","items","capacity"}]}
          stdout = {"results":[{"id","bins_used","feasible","runtime_ms"}]}
"""
import io
import json
import os
import sys
import time

EVAL_DIR = os.environ.get("LOOPLAB_SANDBOX_DIR") or os.path.dirname(os.path.abspath(__file__))
EVAL_DIR = os.path.realpath(EVAL_DIR)
_ALLOW_PREFIX = EVAL_DIR + os.sep
_CANDIDATE_NAME = os.environ.get("LOOPLAB_CANDIDATE_FILE", "candidate_heuristic.py")


def _deny(msg):
    # report on fd2 BEFORE raising so the denial is visible to the evaluator
    # even if the candidate swallows the exception
    try:
        os.write(2, msg.encode("utf-8", "replace"))
    except Exception:
        pass
    raise PermissionError(msg)


def _stdlib_prefixes():
    # trusted interpreters may load the stdlib from EITHER prefix: in a venv,
    # sys.prefix is the venv but the real library lives under sys.base_prefix
    prefixes = [os.path.realpath(sys.prefix), os.path.realpath(sys.base_prefix)]
    return [p + os.sep for p in prefixes]


def _paths_inside(paths):
    """All real paths inside the sandbox (or the stdlib) -> allowed."""
    for path in paths:
        if path is None:
            continue
        if isinstance(path, bytes):
            path = path.decode("utf-8", "replace")
        if not isinstance(path, str) or not path:
            continue
        p = os.path.realpath(path)
        inside = p.startswith(_ALLOW_PREFIX)
        stdlib = any(p.startswith(pre) for pre in _stdlib_prefixes())
        if not (inside or stdlib):
            return False
    return True


def _guard(event, args):
    if event == "open":
        path = args[0] if args else None
        if isinstance(path, bytes):
            path = path.decode("utf-8", "replace")
        if isinstance(path, str) and path and not _paths_inside([path]):
            _deny(f"LOOPLAB_SANDBOX: open({path!r}) denied")
    elif event in ("os.remove", "os.rmdir", "os.rename"):
        # only deny when a target lies outside the sandbox (import machinery
        # legitimately renames its own temp files inside the sandbox)
        if not _paths_inside(list(args)):
            _deny(f"LOOPLAB_SANDBOX: {event} {args!r} denied")
    elif event in (
        "socket.connect", "socket.bind", "socket.getaddrinfo",
        "subprocess.Popen", "os.system", "os.exec", "os.fork", "os.spawn",
    ):
        _deny(f"LOOPLAB_SANDBOX: {event} denied")


sys.addaudithook(_guard)

# import the candidate AFTER the hook is installed
import importlib.util  # noqa: E402

cand_path = os.path.join(EVAL_DIR, _CANDIDATE_NAME)
spec = importlib.util.spec_from_file_location("candidate_heuristic", cand_path)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


def check_feasible(items, capacity, bins):
    got = [x for b in bins for x in b]
    if sorted(got) != sorted(items):
        return False
    for b in bins:
        if sum(b) > capacity:
            return False
    return True


def main():
    req = json.loads(sys.stdin.read())
    out = {"results": []}
    for prob in req["problems"]:
        items = list(prob["items"])
        cap = int(prob["capacity"])
        t0 = time.perf_counter()
        try:
            bins = candidate.pack(items, cap)
            feasible = check_feasible(items, cap, bins)
            err = None
        except Exception as exc:  # noqa: BLE001 - report candidate failure as data
            bins, feasible, err = None, False, f"{type(exc).__name__}: {exc}"
        dt_ms = (time.perf_counter() - t0) * 1000.0
        out["results"].append({
            "id": prob["id"],
            "bins_used": (len(bins) if bins is not None else None),
            "feasible": feasible,
            "runtime_ms": round(dt_ms, 3),
            "error": err,
        })
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
