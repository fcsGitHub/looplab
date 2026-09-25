"""Deterministic fault-injection harness simulator (trusted).

Input:  {"config": {...}, "scenarios": [{...}]}
Output: {"results": [{"id","success","calls","runtime_ms","seed"}]}

Success model (deterministic per scenario seed):
- The tool fails with probability p (scenario.fail_probability) in the
  scenario's mode until the harness gives up.
- retry_on modes: which failure modes the harness retries ("timeout",
  "transient_5xx"; huge_output/empty are handled by truncation/streaming).
- A "huge_output" failure overflows the context unless truncate_chars > 0;
  an "empty" result corrupts the task unless the harness re-asks (max_retries
  with empty in retry semantics) — modeled as: empty counts as retryable.
- success = task finished within n_tool_calls budget without context overflow.
"""
import json
import random
import sys
import time

RETRYABLE_MODES = {"timeout", "transient_5xx", "empty"}


def run_scenario(sc, cfg):
    rng = random.Random(sc["seed"] * 100003 + hash(json.dumps(cfg, sort_keys=True)) % 99991)
    p = float(sc["fail_probability"])
    budget = int(sc["n_tool_calls"]) + int(cfg.get("max_retries", 0))
    truncate = int(cfg.get("truncate_chars", 0))
    retry_on = set(cfg.get("retry_on", []))
    overflow = 0
    calls = 0
    success = False
    while calls < budget:
        calls += 1
        mode = sc["tool_fail_mode"]
        fail = rng.random() < p
        if mode == "huge_output":
            if fail:
                overflow += 8000 - truncate
                if truncate <= 0:
                    continue
            else:
                success = overflow == 0 or truncate > 0
                break
        elif mode == "empty":
            if fail:
                if "empty" in retry_on and calls < budget:
                    continue
                success = False
                break
            success = True
            break
        else:  # timeout / transient_5xx
            if fail:
                if mode in retry_on and calls < budget:
                    continue
                success = False
                break
            success = True
            break
    return {"id": sc["id"], "seed": sc["seed"], "success": int(bool(success)),
            "calls": calls, "runtime_ms": 0}


def main():
    req = json.loads(sys.stdin.read())
    cfg = req["config"]
    out = {"results": [run_scenario(sc, cfg) for sc in req["scenarios"]]}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
