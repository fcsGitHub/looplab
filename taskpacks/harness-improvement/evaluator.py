"""Trusted evaluator for the harness-improvement TaskPack.

Simulates a coding-agent harness consuming a flaky tool under fault injection.
A harness "run" is deterministic given (scenario, config): the tool fails in
the scenario's mode with `fail_probability`; the harness retries per config;
oversized outputs are truncated to `truncate_chars`. A scenario succeeds when
the task completes within the call budget and the context overflow does not
corrupt the final answer (simulated deterministically; see harness.py).

Usage:
  python evaluator.py --candidate harness_config.json --suite suite.json --layer dev --out result.json
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWED_FIELDS = {"max_retries", "backoff_base_ms", "truncate_chars", "retry_on", "stream_output"}


def run_config(cfg, scenarios, eval_dir):
    req = {"config": cfg, "scenarios": scenarios}
    proc = subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, "harness.py")],
        input=json.dumps(req).encode(),
        cwd=eval_dir,
        timeout=120,
        capture_output=True,
        env={
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
            "PYTHONIOENCODING": "utf-8",
        },
    )
    if proc.returncode != 0:
        return None, proc.stderr.decode("utf-8", "replace")[-800:]
    return json.loads(proc.stdout.decode()), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--suite", required=True)
    ap.add_argument("--layer", required=True, choices=["dev", "selection", "release"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval-dir", default=None)
    args = ap.parse_args()

    with open(args.suite, encoding="utf-8") as f:
        suite = json.load(f)
    with open(os.path.join(HERE, "baseline_config.json"), encoding="utf-8") as f:
        base_cfg = json.load(f)

    with open(args.candidate, encoding="utf-8") as f:
        cand_raw = f.read()
    try:
        cand_cfg = json.loads(cand_raw)
    except Exception as exc:  # noqa: BLE001
        cand_cfg = None
        parse_err = str(exc)

    eval_dir = args.eval_dir or os.path.dirname(os.path.abspath(args.candidate))
    scenarios = suite["scenarios"]

    constraints = []
    if cand_cfg is None:
        constraints.append({"name": "config_parses", "passed": False, "detail": parse_err})
    else:
        unknown = set(cand_cfg) - ALLOWED_FIELDS
        constraints.append({
            "name": "only_allowed_fields",
            "passed": not unknown,
            "detail": f"modified fields outside the allowed set: {sorted(unknown)}" if unknown else "ok",
        })
        if not unknown:
            merged = {**base_cfg, **cand_cfg}
            base_res, err_b = run_config(base_cfg, scenarios, eval_dir)
            cand_res, err_c = run_config(merged, scenarios, eval_dir)
            constraints.append({"name": "harness_runs", "passed": cand_res is not None,
                                "detail": (err_c or err_b or "ok")[:300]})
        else:
            base_res = cand_res = None

    all_hard = all(c["passed"] for c in constraints)
    if not all_hard or base_res is None or cand_res is None:
        result = {
            "contract_version": suite.get("contract_version", "harness/v1"),
            "suite_ref": f"{args.layer}://{suite.get('taskpack_id', 'harness-improvement.tool-failures')}",
            "layer": args.layer,
            "primary_metric": suite.get("metric", "success_rate"),
            "primary_value": 0.0,
            "baseline_value": 0.0,
            "paired_delta": None,
            "hard_constraints": constraints,
            "trials": [],
            "verdict": "REJECTED",
            "reason": "hard constraint failed (config parse / field scope / harness crash)",
            "evaluator_digest": hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest(),
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=1)
        print(json.dumps({"verdict": "REJECTED"}))
        return

    delta = float(suite.get("min_effect_delta", 0.08))
    epsilon = float(suite.get("max_regression_epsilon", 0.03))
    minimize = bool(suite.get("minimize", False))

    trials = []
    deltas = []
    for b, c in zip(base_res["results"], cand_res["results"]):
        d = (c["success"] - b["success"]) if not minimize else (b["success"] - c["success"])
        deltas.append(d)
        trials.append({
            "task_id": c["id"], "seed": c.get("seed", 0),
            "value": c["success"], "feasible": True,
            "runtime_ms": c.get("runtime_ms", 0),
        })

    base_avg = sum(d["success"] for d in base_res["results"]) / len(base_res["results"])
    cand_avg = sum(d["success"] for d in cand_res["results"]) / len(cand_res["results"])
    paired = sum(deltas) / len(deltas)
    worst_regression = max(0.0, -min(deltas)) if not minimize else max(0.0, -max(deltas))

    if paired >= delta and worst_regression <= epsilon + 1e-9:
        verdict, reason = "ELIGIBLE", f"success rate +{paired:.3f} >= delta {delta}; no key regression"
    elif paired < -epsilon:
        verdict, reason = "REJECTED", f"success rate drops {paired:.3f} beyond -epsilon"
    elif abs(paired) < delta / 2:
        verdict, reason = "INCONCLUSIVE", f"|delta| {abs(paired):.3f} below {delta / 2:.3f} on {len(trials)} scenarios; evidence insufficient"
    else:
        verdict, reason = "INCONCLUSIVE", f"mixed: mean {paired:.3f}, worst regression {worst_regression:.3f}"

    result = {
        "contract_version": suite.get("contract_version", "harness/v1"),
        "suite_ref": f"{args.layer}://{suite.get('taskpack_id', 'harness-improvement.tool-failures')}",
        "layer": args.layer,
        "primary_metric": suite.get("metric", "success_rate"),
        "primary_value": round(cand_avg, 6),
        "baseline_value": round(base_avg, 6),
        "paired_delta": round(paired, 6),
        "hard_constraints": constraints,
        "trials": trials,
        "verdict": verdict,
        "reason": reason,
        "evaluator_digest": hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest(),
        "environment": {"python": sys.version.split()[0], "platform": sys.platform},
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    print(json.dumps({"verdict": verdict, "reason": reason}))


if __name__ == "__main__":
    main()
