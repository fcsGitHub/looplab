"""LoopLab optimizer backend: GEPA 0.1.4 adapter for the bin-packing TaskPack.

Authorized-infrastructure process (spawned by the control service, same trust
tier as evaluator.py — see docs/architecture/threat-model.md). What this
process is and is not allowed to do:

- It NEVER holds a model API key. Reflection-LM calls go to the control
  service's metered proxy (Bearer run-token from LOOPLAB_OPT_TOKEN env);
  every call is reserved/settled against the goal budget there.
- The CODE IT EVALUATES is untrusted and always runs in the audit-hook child
  sandbox (candidate_runner.py, `python -I`), never in this process.

Contract (mirrors packages/contracts/src/optimizer.ts):
  argv[1] = manifest.json (OptimizerRunManifest)
  writes   out_dir/result.json = {proposals, usage, stopped_reason}

Recursion depth 1 (§6.8): the only component this port carries is
`heuristic_source` — task-domain code. There is no manifest field, prompt or
output channel by which the optimizer could touch evaluators, sealed suites,
kernel code, or itself.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

import gepa
from gepa.core.adapter import EvaluationBatch, GEPAAdapter

Candidate = dict[str, str]


class BudgetStop(Exception):
    """Raised internally when the run must stop (metric or cost cap)."""


class GatewayBudgetStop(Exception):
    """The metered proxy answered 402: stop asking, keep what we have."""


def log(msg: str) -> None:
    print(f"[gepa-backend] {msg}", file=sys.stderr, flush=True)


class LoopLabBinPackAdapter(GEPAAdapter):
    def __init__(self, manifest: dict, problems: list[dict], train: list[dict], val: list[dict], baseline_src: str):
        self.manifest = manifest
        self.problems = problems
        self.train = train
        self.val = val
        self.baseline_src = baseline_src
        self.taskpack_dir = os.path.dirname(os.path.abspath(manifest["baseline_path"]))
        self.work_dir = manifest["work_dir"]
        self.reflection_mode = manifest["reflection"]
        self.gateway_url = manifest.get("gateway_url")
        self.token = os.environ.get("LOOPLAB_OPT_TOKEN", "")
        self.time_limit_ms = 500
        # honest usage accounting
        self.metric_calls = 0          # example-level, same unit as max_metric_calls
        self.max_metric_calls = manifest["budget"]["max_metric_calls"]
        self.llm_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost_usd = 0.0
        self.model: str | None = None
        self.budget_stopped = False
        self._reflection_failures = 0
        self._eval_seq = 0
        self._llm_seq = 0
        self._scripted_variants = _scripted_variants(baseline_src)
        self._scripted_idx = 0

    # ---- metric calls -----------------------------------------------------
    def _check_metric_budget(self, count: int) -> None:
        # pre-check: a batch that would overshoot the cap is not started at
        # all — the kernel-side completeRun rejects any overspent run.
        if self.metric_calls + count > self.max_metric_calls:
            self.budget_stopped = True
            raise BudgetStop(f"metric budget exhausted ({self.max_metric_calls})")
        self.metric_calls += count

    # ---- GEPAAdapter ------------------------------------------------------
    def evaluate(self, batch: list[dict], candidate: Candidate, capture_traces: bool = False) -> EvaluationBatch:
        self._check_metric_budget(len(batch))
        src = candidate.get("heuristic_source", "")
        results, err = self._run_sandboxed(src, batch)
        outputs: list[dict] = []
        scores: list[float] = []
        trajectories: list[dict] | None = [] if capture_traces else None
        by_id = {r["id"]: r for r in (results or [])}
        for p in batch:
            total = sum(p["items"])
            r = by_id.get(p["id"])
            bins_used = r.get("bins_used") if r else None
            feasible = bool(r and r.get("feasible")) and bins_used is not None
            score = round(total / (bins_used * p["capacity"]), 6) if (feasible and bins_used > 0) else 0.0
            out = {
                "problem_id": p["id"], "bins_used": bins_used,
                "feasible": feasible, "runtime_ms": r["runtime_ms"] if r else None,
                "score": score, "error": err or ("" if feasible else "infeasible packing"),
            }
            outputs.append(out)
            scores.append(score)
            if trajectories is not None:
                trajectories.append({
                    "problem_id": p["id"], "capacity": p["capacity"],
                    "n_items": len(p["items"]), "bins_used": out["bins_used"],
                    "feasible": feasible, "runtime_ms": out["runtime_ms"],
                    "feedback_note": "feasible" if feasible else f"failure: {out['error'][:200]}",
                })
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate: Candidate, eval_batch: EvaluationBatch, components_to_update: list[str]) -> dict:
        # rank worst cases first: biggest bin count / failures carry the signal
        rows = sorted(eval_batch.outputs, key=lambda o: (o["score"], -(o["bins_used"] or 10**9)))
        dataset: dict = {}
        for comp in components_to_update:
            records = []
            for o in rows[:6]:
                records.append({
                    "Inputs": {"problem_id": o["problem_id"], "capacity": None, "note": "items arrive as a list of integer sizes"},
                    "Generated Outputs": {"bins_used": o["bins_used"], "feasible": o["feasible"], "runtime_ms": o["runtime_ms"]},
                    "Feedback": o["error"] or f"feasible; packing efficiency {o['score']} (1.0 = perfect fill)",
                })
            avg = sum(o["score"] for o in rows) / max(len(rows), 1)
            records.append({
                "Inputs": {"aggregate": "whole batch"},
                "Generated Outputs": {"mean_efficiency": round(avg, 4)},
                "Feedback": "Improve the placement strategy. Failures (feasible=false, score=0) are the highest priority; then raise mean fill efficiency. Keep the same pack(items, capacity) interface; stdlib only; no network/subprocess/file IO.",
            })
            dataset[comp] = records
        return dataset

    def propose_new_texts(self, candidate: Candidate, reflective_dataset, components_to_update: list[str]) -> dict[str, str]:
        if self._reflection_failures >= 3:
            # circuit breaker: don't burn the metric budget on doomed iterations
            self.budget_stopped = True
            raise GatewayBudgetStop(f"reflection failed {self._reflection_failures}x consecutively; stopping")
        new_texts: dict[str, str] = {}
        for comp in components_to_update:
            if self.reflection_mode == "scripted":
                # deterministic fixture for contract/integration tests ONLY —
                # never passed off as real-model acceptance.
                new_texts[comp] = self._scripted_variants[self._scripted_idx % len(self._scripted_variants)]
                self._scripted_idx += 1
                continue
            prompt = _code_edit_prompt(candidate[comp], reflective_dataset.get(comp, []))
            try:
                raw = self._call_gateway(prompt, max_tokens=2600)
            except GatewayBudgetStop:
                raise
            except Exception as exc:  # noqa: BLE001
                self._reflection_failures += 1
                self._log_error(f"reflection call {self._llm_seq} failed: {exc}")
                raise
            code = _extract_python_block(raw)
            if not code:
                self._reflection_failures += 1
                self._log_error("reflection LM produced no ```python block")
                raise ValueError("reflection LM produced no ```python block")
            self._reflection_failures = 0
            new_texts[comp] = code
        return new_texts

    def _log_error(self, msg: str) -> None:
        with open(os.path.join(self.manifest["out_dir"], "errors.log"), "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}" + "\n")

    # ---- sandboxed candidate execution ------------------------------------
    def _run_sandboxed(self, src: str, batch: list[dict]) -> tuple[list[dict] | None, str | None]:
        self._eval_seq += 1
        candidate_file = os.path.join(self.work_dir, f"candidate_{self._eval_seq}.py")
        with open(candidate_file, "w", encoding="utf-8", newline="\n") as f:
            f.write(src)
        runner = os.path.join(self.taskpack_dir, "candidate_runner.py")
        req = {"problems": [{"id": p["id"], "items": p["items"], "capacity": p["capacity"]} for p in batch]}
        try:
            proc = subprocess.run(
                [sys.executable, "-I", runner],
                input=json.dumps(req).encode(),
                cwd=self.work_dir,
                timeout=max(30, self.time_limit_ms * len(batch) / 1000.0 + 30),
                capture_output=True,
                env={
                    "PATH": os.environ.get("PATH", ""),
                    "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "LOOPLAB_SANDBOX_DIR": self.work_dir,
                    "LOOPLAB_CANDIDATE_FILE": os.path.basename(candidate_file),
                },
            )
        except subprocess.TimeoutExpired:
            return None, f"candidate timed out after {self.time_limit_ms}ms/problem"
        if proc.returncode != 0:
            return None, proc.stderr.decode("utf-8", "replace")[-1500:]
        try:
            parsed = json.loads(proc.stdout.decode())
        except Exception as exc:  # noqa: BLE001
            return None, f"runner output unparsable: {exc}"
        # sandbox denials land on fd2 even when the candidate swallows them
        stderr = proc.stderr.decode("utf-8", "replace")[-1500:]
        if "LOOPLAB_SANDBOX:" in stderr:
            return None, f"sandbox violation: {stderr[-500:]}"
        return parsed.get("results") or [], None

    # ---- metered reflection ------------------------------------------------
    def _call_gateway(self, prompt: str, max_tokens: int) -> str:
        self._llm_seq += 1
        body = json.dumps({
            "call_seq": self._llm_seq,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
        }).encode()
        req = urllib.request.Request(
            self.gateway_url or "", data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 402:
                self.budget_stopped = True
                raise GatewayBudgetStop("optimizer LLM cost cap reached (402)") from exc
            raise
        usage = payload.get("usage") or {}
        self.llm_calls += 1
        self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.completion_tokens += int(usage.get("completion_tokens") or 0)
        self.cost_usd += float(usage.get("cost_usd") or 0)
        self.model = usage.get("model") or self.model
        return str(payload.get("content") or "")

    def budget_stopper(self, gepa_state) -> bool:
        return self.budget_stopped

    def usage(self) -> dict:
        return {
            "metric_calls": self.metric_calls,
            "llm_calls": self.llm_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "model": self.model,
        }


def _code_edit_prompt(current_code: str, records: list) -> str:
    import json as _json
    return f"""You are improving a bin-packing heuristic for the LoopLab optimizer.

Current heuristic source (component `heuristic_source`, entry `pack(items, capacity)`):
```python
{current_code}
```

Evaluation feedback (worst cases first):
```json
{_json.dumps(records[-4:], ensure_ascii=False, indent=1)[:4000]}
```

Write an IMPROVED full replacement for the heuristic source. Requirements:
- Keep the exact interface: def pack(items: list[int], capacity: int) -> list[list[int]]
- Every item must appear in exactly one bin; no bin may exceed capacity.
- Standard library only. No network, subprocess, or file access (sandboxed).
- Explore a materially different placement/ordering strategy when feedback suggests the current one plateaus.

Return the complete new source in ONE ```python block and nothing else."""


def _extract_python_block(text: str) -> str | None:
    import re
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    if not blocks:
        return None
    return max(blocks, key=len).strip() + "\n"


def _scripted_variants(baseline_src: str) -> list[str]:
    """Deterministic behavioral alternatives used when reflection=scripted
    (contract/integration tests only - never real-model acceptance)."""
    merge_pass = (
        "\n\ndef _merge_pass(bins, capacity):\n"
        "    merged = True\n"
        "    while merged:\n"
        "        merged = False\n"
        "        for i in range(len(bins)):\n"
        "            for j in range(i + 1, len(bins)):\n"
        "                if sum(bins[i]) + sum(bins[j]) <= capacity:\n"
        "                    bins[i] = bins[i] + bins[j]\n"
        "                    del bins[j]\n"
        "                    merged = True\n"
        "                    break\n"
        "            if merged:\n"
        "                break\n"
        "    return bins\n"
    )
    header = '"""Scripted deterministic variant (contract fixture)."""\n'
    return [
        # FFD + two-bin merge post-pass: never worse, strictly better whenever
        # FFD leaves a mergeable pair - deterministic improvement seed
        header + merge_pass + """

def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        for b in bins:
            if sum(b) + size <= capacity:
                b.append(size)
                break
        else:
            bins.append([size])
    return _merge_pass(bins, capacity)
""",
        # worst-fit decreasing + merge pass
        header + merge_pass + """

def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        best_i, best_room = -1, -1
        for i, b in enumerate(bins):
            room = capacity - sum(b) - size
            if room >= 0 and room > best_room:
                best_i, best_room = i, room
        if best_i >= 0:
            bins[best_i].append(size)
        else:
            bins.append([size])
    return _merge_pass(bins, capacity)
""",
        # plain best-fit decreasing
        header + """

def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        best_i, best_rem = -1, None
        for i, b in enumerate(bins):
            rem = capacity - sum(b) - size
            if rem >= 0 and (best_rem is None or rem < best_rem):
                best_i, best_rem = i, rem
        if best_i >= 0:
            bins[best_i].append(size)
        else:
            bins.append([size])
    return bins
""",
    ]


def load_suite(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def split_train_val(problems: list[dict], fraction: float) -> tuple[list[dict], list[dict]]:
    # deterministic: sort by id, stride-split — same protocol for every backend
    ordered = sorted(problems, key=lambda p: p["id"])
    n_train = max(2, int(len(ordered) * fraction))
    return ordered[:n_train], ordered[n_train:]


def main() -> int:
    manifest_path = sys.argv[1]
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    t0 = time.time()
    suite = load_suite(manifest["dev_suite_path"])
    problems = suite["problems"]
    train, val = split_train_val(problems, manifest.get("train_split", 0.5))
    adapter = LoopLabBinPackAdapter(
        manifest=manifest,
        problems=problems,
        train=train,
        val=val,
        baseline_src=open(manifest["baseline_path"], encoding="utf-8").read(),
    )
    log(f"run {manifest['run_id']} backend={manifest['backend']} reflection={manifest['reflection']} "
        f"train={len(train)} val={len(val)} max_metric_calls={manifest['budget']['max_metric_calls']}")

    seed_candidate = {"heuristic_source": adapter.baseline_src}
    stopped_reason = "completed"
    try:
        result = gepa.optimize(
            seed_candidate=seed_candidate,
            trainset=train,
            valset=val,
            adapter=adapter,
            reflection_lm=None,  # adapter.propose_new_texts owns the metered LM call
            max_metric_calls=manifest["budget"]["max_metric_calls"],
            stop_callbacks=[adapter.budget_stopper],
            seed=manifest["seed"],
            raise_on_exception=False,
            display_progress_bar=False,
            track_best_outputs=False,
        )
    except (BudgetStop, GatewayBudgetStop) as exc:
        log(f"budget stop: {exc}")
        stopped_reason = f"budget_stop: {exc}"
        result = None

    if result is not None and getattr(result, "candidates", None):
        val_scores = list(result.val_aggregate_scores)
        best_idx = int(result.best_idx)
        seed_val = val_scores[0] if val_scores else None
        proposals = []
        # best candidate first, then other distinct improvements (dedup by code)
        seen = set()
        order = [best_idx] + [i for i in sorted(range(len(val_scores)), key=lambda i: -val_scores[i]) if i != best_idx]
        gepa_version = None
        try:
            from importlib.metadata import version as _v
            gepa_version = _v("gepa")
        except Exception:  # noqa: BLE001
            gepa_version = "unknown"
        seed_src = seed_candidate["heuristic_source"]
        for idx in order:
            code = result.candidates[idx].get("heuristic_source", "")
            if not code or code in seen:
                continue
            if code == seed_src:
                # "best == seed" means NO mutation was accepted this run —
                # that is an honest empty result, not a proposal
                continue
            seen.add(code)
            proposals.append({
                "mechanism": f"GEPA candidate {idx} (parents={result.parents[idx]})",
                "changed_summary": f"heuristic_source variant discovered by gepa@{gepa_version}",
                "candidate_code": code,
                "expected_effect": "validated on GEPA internal train/val split; independent pipeline evaluation decides",
                "train_score": None,
                "val_score": round(float(val_scores[idx]), 6) if idx < len(val_scores) else None,
            })
            if len(proposals) >= 3:
                break
    else:
        proposals = []
        seed_val = None

    payload = {
        "proposals": proposals,
        "usage": adapter.usage(),
        "stopped_reason": stopped_reason,
    }
    with open(os.path.join(manifest["out_dir"], "result.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"done in {time.time()-t0:.1f}s: {len(proposals)} proposals, usage={json.dumps(adapter.usage())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
