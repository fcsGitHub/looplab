"""Trusted evaluator for the bin-packing TaskPack (design §12.2).

Reads the suite file (for release suites this lives under sealed/, resolvable
ONLY from this process), evaluates the trusted baseline and the candidate
(in a sandboxed child), computes paired differences and hard-constraint
checks, and emits an EvaluationResult JSON.

Usage:
  python evaluator.py --candidate <file> --suite <suite.json> --layer dev|selection|release --out result.json
"""
import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_baseline(baseline_mod, problems, time_limit_ms):
    trials = []
    for p in problems:
        t0 = time.perf_counter()
        bins = baseline_mod.pack(list(p["items"]), int(p["capacity"]))
        dt = (time.perf_counter() - t0) * 1000.0
        trials.append({"task_id": p["id"], "bins": len(bins), "runtime_ms": round(dt, 3)})
    return trials


def run_candidate(candidate_path, problems, eval_dir, time_limit_ms):
    # the candidate runs on a COPY inside the sandbox dir
    sandbox_candidate = os.path.join(eval_dir, "candidate_heuristic.py")
    with open(candidate_path, "rb") as src, open(sandbox_candidate, "wb") as dst:
        dst.write(src.read())
    req = {"problems": [{"id": p["id"], "items": p["items"], "capacity": p["capacity"]} for p in problems]}
    proc = subprocess.run(
        [sys.executable, "-I", os.path.join(HERE, "candidate_runner.py")],
        input=json.dumps(req).encode(),
        cwd=eval_dir,
        timeout=max(30, time_limit_ms * len(problems) / 1000.0 + 20),
        capture_output=True,
        env={
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LOOPLAB_SANDBOX_DIR": eval_dir,
            "LOOPLAB_CANDIDATE_FILE": "candidate_heuristic.py",
        },
    )
    if proc.returncode != 0:
        return None, proc.stderr.decode("utf-8", "replace")[-2000:]
    try:
        parsed = json.loads(proc.stdout.decode())
        # sandbox denials are written to stderr by the audit hook even when
        # the candidate swallows the exception: always inspect them
        parsed["_stderr"] = proc.stderr.decode("utf-8", "replace")[-2000:]
        return parsed, None
    except Exception as exc:  # noqa: BLE001
        return None, f"runner output unparsable: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidate", required=True)
    ap.add_argument("--suite", required=True)
    ap.add_argument("--layer", required=True, choices=["dev", "selection", "release"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval-dir", default=None, help="directory the candidate runs in (sandbox root)")
    args = ap.parse_args()

    with open(args.suite, encoding="utf-8") as f:
        suite = json.load(f)
    problems = suite["problems"]
    metric = suite.get("metric", "bins_avg")
    minimize = suite.get("minimize", True)
    delta = float(suite.get("min_effect_delta", 0.05))
    epsilon = float(suite.get("max_regression_epsilon", 0.02))
    time_limit = int(suite.get("time_limit_ms_per_problem", 500))

    baseline_mod = load_module(os.path.join(HERE, "baseline.py"), "trusted_baseline")
    base_trials = run_baseline(baseline_mod, problems, time_limit)

    eval_dir = args.eval_dir or os.path.dirname(os.path.abspath(args.candidate))
    cand, err = run_candidate(args.candidate, problems, eval_dir, time_limit)

    runner_stderr = err or (cand or {}).get("_stderr", "")
    sandbox_violation = "LOOPLAB_SANDBOX" in runner_stderr
    if cand is not None:
        cand.pop("_stderr", None)
    constraints = [
        {"name": "candidate_runs", "passed": cand is not None,
         "detail": (err or "ok")[:300]},
        {"name": "no_sandbox_violation", "passed": not sandbox_violation,
         "detail": ("sandbox denial observed: " + runner_stderr[-200:]) if sandbox_violation else "ok"},
    ]

    trials = []
    if cand is not None:
        cmap = {r["id"]: r for r in cand["results"]}
        all_feasible = True
        within_time = True
        deltas = []
        worst_regression = 0.0
        for p, b in zip(problems, base_trials):
            r = cmap.get(p["id"])
            if r is None:
                all_feasible = False
                continue
            feasible = bool(r.get("feasible"))
            all_feasible = all_feasible and feasible
            within_time = within_time and (r["runtime_ms"] <= time_limit)
            b_bins, c_bins = b["bins"], r.get("bins_used")
            d = (b_bins - c_bins) if (c_bins is not None and minimize) else 0.0 if c_bins is not None else None
            if d is not None:
                deltas.append(d)
                worst_regression = max(worst_regression, -d)
            trials.append({
                "task_id": p["id"], "seed": int(p.get("seed", 0)),
                "value": (c_bins if c_bins is not None else -1),
                "feasible": feasible,
                "runtime_ms": r["runtime_ms"],
            })
        constraints.append({"name": "feasibility", "passed": all_feasible,
                            "detail": "all items packed within capacity on every problem" if all_feasible else "infeasible packing produced"})
        constraints.append({"name": "runtime", "passed": within_time,
                            "detail": f"per-problem limit {time_limit}ms" if within_time else "time limit exceeded"})

    base_avg = sum(b["bins"] for b in base_trials) / len(base_trials)
    all_hard_pass = all(c["passed"] for c in constraints)

    if not all_hard_pass:
        verdict, reason = "REJECTED", ("sandbox violation; candidate quarantined" if sandbox_violation
                                       else (err or "hard constraint failed")[:200])
        cand_avg, paired = None, None
    else:
        cand_avg = sum(t["value"] for t in trials) / len(trials)
        paired = sum(deltas) / len(deltas)
        # verdict policy (design §12.2-§12.3): hard constraints first, then the
        # pre-registered effect threshold; small |delta| on the selection and
        # release layers is INCONCLUSIVE (证据不足), never "direction failed".
        if paired >= delta and worst_regression <= max(epsilon, 0) + 1e-9:
            verdict, reason = "ELIGIBLE", f"mean improvement {paired:.4f} >= delta {delta}; worst regression {worst_regression:.4f}"
        elif paired < -epsilon:
            verdict, reason = "REJECTED", f"candidate regresses: mean {paired:.4f} beyond -epsilon"
        elif worst_regression > epsilon and paired < delta:
            verdict, reason = "INCONCLUSIVE", f"mixed results: mean {paired:.4f}, worst regression {worst_regression:.4f} exceeds epsilon on some problems; needs a discriminating experiment"
        else:
            verdict, reason = "INCONCLUSIVE", f"|delta| {abs(paired):.4f} below pre-registered effect {delta} on {len(trials)} problems; evidence insufficient, direction neither supported nor refuted"

    result = {
        "contract_version": suite.get("contract_version", "bin-packing/v1"),
        "suite_ref": f"{args.layer}://{suite.get('taskpack_id', 'algorithm-search.bin-packing')}",
        "layer": args.layer,
        "primary_metric": metric,
        "primary_value": round(cand_avg, 6) if cand_avg is not None else 0.0,
        "baseline_value": round(base_avg, 6),
        "paired_delta": (round(paired, 6) if paired is not None else None),
        "hard_constraints": constraints,
        "trials": trials,
        "verdict": verdict,
        "reason": reason,
        "baseline_trials": base_trials,
        "evaluator_digest": hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest(),
        "environment": {"python": sys.version.split()[0], "platform": sys.platform},
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    print(json.dumps({"verdict": verdict, "reason": reason}))


if __name__ == "__main__":
    main()
