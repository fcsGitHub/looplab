"""LoopLab optimizer backend: OpenEvolve 0.3.2 adapter for the bin-packing TaskPack.

Authorized-infrastructure process (spawned by the control service, same trust
tier as the GEPA backend / evaluator.py). Invariants — identical to the GEPA
backend (optimizers/gepa-backend/backend.py):

- It NEVER holds a model API key. OpenEvolve drives its own LLM calls, so a
  loopback-only shim (127.0.0.1, ephemeral port) speaks OpenAI
  /v1/chat/completions and forwards every completion to the control service's
  metered proxy (Bearer run-token from LOOPLAB_OPT_TOKEN); each call is
  reserved/settled against the goal budget there.
- The CODE IT EVALUATES is untrusted and always runs in the audit-hook child
  sandbox (candidate_runner.py, `python -I`), never in this process.

Contract (mirrors packages/contracts/src/optimizer.ts):
  argv[1] = manifest.json (OptimizerRunManifest)
  writes   out_dir/result.json = {proposals, usage, stopped_reason}

Recursion depth 1 (§6.8): the only component this port carries is
`heuristic_source` — task-domain code. No prompt or output channel reaches
evaluators, sealed suites, kernel code, or this backend itself.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from openevolve import OpenEvolve
from openevolve.config import Config, LLMModelConfig

# fixed per-evaluation batch: every candidate is judged on the SAME problems,
# so comparisons within a run are fair; the independent selection pipeline is
# the real arbiter (dev-suite scores only steer the search)
EVAL_BATCH_SIZE = 4
PROBLEM_TIME_LIMIT_MS = 500


class BudgetStop(Exception):
    """Metric cap reached: stop evaluating, keep what we have."""


class ProxyBudgetStop(Exception):
    """The metered proxy answered 402: stop asking, keep what we have."""


def log(msg: str) -> None:
    print(f"[openevolve-backend] {msg}", file=sys.stderr, flush=True)


class Usage:
    def __init__(self) -> None:
        self.metric_calls = 0
        self.llm_calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.cost_usd = 0.0
        self.model: str | None = None

    def as_dict(self) -> dict:
        return {
            "metric_calls": self.metric_calls,
            "llm_calls": self.llm_calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_usd": round(self.cost_usd, 6),
            "model": self.model,
        }


# ---- metered LLM shim (OpenAI-compatible on loopback) -----------------------
class MeteredShim:
    """Translates OpenAI /v1/chat/completions -> the control metered proxy.

    OpenEvolve constructs its own OpenAI clients pointed at api_base; this
    shim is the ONLY network path those calls can take — loopback to the
    control service, authenticated with the run token. No model key exists
    anywhere in this process.
    """

    def __init__(self, gateway_url: str, token: str, usage: Usage):
        self.usage = usage
        self.gateway_url = gateway_url
        self.token = token
        self._llm_seq = 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    req = json.loads(raw)
                except Exception:  # noqa: BLE001
                    self.send_error(400, "bad json")
                    return
                try:
                    content, usage = outer.forward(req)
                except ProxyBudgetStop:
                    body = json.dumps({"error": {"message": "optimizer LLM cost cap reached", "type": "budget_exceeded"}}).encode()
                    self.send_response(402)
                except Exception as exc:  # noqa: BLE001
                    body = json.dumps({"error": {"message": str(exc)[:200], "type": "proxy_error"}}).encode()
                    self.send_response(502)
                else:
                    body = json.dumps({
                        "id": f"looplab-{self._llm_id()}",
                        "object": "chat.completion",
                        "model": usage.get("model") or "looplab-metered",
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": content}}],
                        "usage": {
                            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                            "completion_tokens": int(usage.get("completion_tokens") or 0),
                            "total_tokens": int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0),
                        },
                    }).encode()
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _llm_id(self) -> int:
                return outer.usage.llm_calls

            def log_message(self, fmt, *args) -> None:  # silence request log
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]

    def forward(self, req: dict) -> tuple[str, dict]:
        self._llm_seq += 1
        body = json.dumps({
            "call_seq": self._llm_seq,
            "messages": req.get("messages") or [],
            "max_tokens": int(req.get("max_tokens") or 2600),
        }).encode()
        http_req = urllib.request.Request(
            self.gateway_url, data=body, method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(http_req, timeout=180) as resp:
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 402:
                raise ProxyBudgetStop("optimizer LLM cost cap reached (402)") from exc
            raise
        usage = payload.get("usage") or {}
        self.usage.llm_calls += 1
        self.usage.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.usage.completion_tokens += int(usage.get("completion_tokens") or 0)
        self.usage.cost_usd += float(usage.get("cost_usd") or 0)
        if usage.get("model"):
            self.usage.model = usage["model"]
        return str(payload.get("content") or ""), usage

    def start(self) -> None:
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self.server.shutdown()


# ---- sandboxed evaluation bridge -------------------------------------------
EVALUATION_FILE_SRC = '''"""LoopLab OpenEvolve evaluation bridge (GENERATED by the backend).

Self-contained on purpose: OpenEvolve may import this file in worker
processes with a fresh interpreter state, so the sandbox protocol, the fixed
problem batch and the metric-budget state file all travel with the file.
"""
import json
import os
import subprocess
import sys

WORK_DIR = {work_dir!r}
RUNNER = {runner!r}
BATCH = {batch_json}
MAX_METRIC_CALLS = {max_metric_calls}
PROBLEM_TIME_LIMIT_MS = {time_limit_ms}
STATE_PATH = os.path.join(WORK_DIR, "metric_state.json")


def _take_metric_calls(n):
    state = {{"used": 0}}
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as f:
            state = json.load(f)
    if state["used"] + n > MAX_METRIC_CALLS:
        raise RuntimeError("BUDGET_STOP: metric budget exhausted ({{}})".format(MAX_METRIC_CALLS))
    state["used"] += n
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f)


def evaluate(program_path):
    _take_metric_calls(len(BATCH))
    eval_seq = 0
    while True:
        eval_seq += 1
        candidate_file = os.path.join(WORK_DIR, "candidate_{{}}.py".format(eval_seq))
        if not os.path.exists(candidate_file):
            break
    with open(program_path, encoding="utf-8") as f:
        src = f.read()
    with open(candidate_file, "w", encoding="utf-8", newline="\\n") as f:
        f.write(src)
    req = {{"problems": [{{"id": p["id"], "items": p["items"], "capacity": p["capacity"]}} for p in BATCH]}}
    proc = subprocess.run(
        [sys.executable, "-I", RUNNER],
        input=json.dumps(req).encode(),
        cwd=WORK_DIR,
        timeout=max(30, PROBLEM_TIME_LIMIT_MS * len(BATCH) / 1000.0 + 30),
        capture_output=True,
        env={{
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\\\Windows"),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LOOPLAB_SANDBOX_DIR": WORK_DIR,
            "LOOPLAB_CANDIDATE_FILE": os.path.basename(candidate_file),
        }},
    )
    results, err = [], None
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-500:]
    else:
        try:
            results = json.loads(proc.stdout.decode()).get("results") or []
        except Exception as exc:
            err = "runner output unparsable: {{}}".format(exc)
    stderr_tail = proc.stderr.decode("utf-8", "replace")[-300:]
    if "LOOPLAB_SANDBOX:" in stderr_tail:
        err = "sandbox violation: {{}}".format(stderr_tail)
    by_id = {{r.get("id"): r for r in results}}
    scores = []
    for p in BATCH:
        total = sum(p["items"])
        r = by_id.get(p["id"])
        bins = r.get("bins_used") if r else None
        feasible = bool(r and r.get("feasible")) and bins is not None
        scores.append(round(total / (bins * p["capacity"]), 6) if (feasible and bins) else 0.0)
    mean = round(sum(scores) / len(scores), 6) if scores else 0.0
    return {{"score": mean, "runs_ok": 1.0 if not err else 0.0}}
'''


def write_evaluation_file(manifest: dict, batch: list[dict]) -> str:
    taskpack_dir = os.path.dirname(os.path.abspath(manifest["baseline_path"]))
    runner = os.path.join(taskpack_dir, "candidate_runner.py")
    content = EVALUATION_FILE_SRC.format(
        work_dir=manifest["work_dir"],
        runner=runner,
        batch_json=json.dumps([{ "id": p["id"], "items": p["items"], "capacity": p["capacity"] } for p in batch]),
        max_metric_calls=manifest["budget"]["max_metric_calls"],
        time_limit_ms=PROBLEM_TIME_LIMIT_MS,
    )
    path = os.path.join(manifest["work_dir"], "evaluator_bridge.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def load_suite(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pick_batch(problems: list[dict], seed: int) -> list[dict]:
    """Deterministic fixed batch: every candidate sees the SAME problems."""
    ordered = sorted(problems, key=lambda p: p["id"])
    start = seed % len(ordered)
    stride = max(1, len(ordered) // EVAL_BATCH_SIZE)
    return [ordered[(start + i * stride) % len(ordered)] for i in range(EVAL_BATCH_SIZE)]


def main() -> int:
    manifest_path = sys.argv[1]
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    t0 = time.time()
    suite = load_suite(manifest["dev_suite_path"])
    batch = pick_batch(suite["problems"], int(manifest["seed"]))

    baseline_path = os.path.join(manifest["work_dir"], "initial_program.py")
    with open(manifest["baseline_path"], encoding="utf-8") as f:
        baseline_src = f.read()
    with open(baseline_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(baseline_src)

    usage = Usage()
    shim = MeteredShim(manifest.get("gateway_url") or "", os.environ.get("LOOPLAB_OPT_TOKEN", ""), usage)
    shim.start()
    log(f"run {manifest['run_id']} shim=127.0.0.1:{shim.port} batch={[p['id'] for p in batch]}")

    evaluation_file = write_evaluation_file(manifest, batch)
    state_path = os.path.join(manifest["work_dir"], "metric_state.json")

    cfg = Config()
    cfg.max_iterations = max(2, manifest["budget"]["max_metric_calls"] // EVAL_BATCH_SIZE)
    cfg.random_seed = int(manifest["seed"])
    cfg.diff_based_evolution = False  # full-file rewrites, like the GEPA flow
    cfg.max_code_length = 20000
    cfg.log_level = "WARNING"
    cfg.log_dir = os.path.join(manifest["out_dir"], "logs")
    os.makedirs(cfg.log_dir, exist_ok=True)
    cfg.checkpoint_interval = cfg.max_iterations + 1  # no mid-run checkpoints
    cfg.llm.api_base = f"http://127.0.0.1:{shim.port}/v1"
    # the OpenAI client requires a non-empty key; real auth happens at the
    # shim, which swaps in the run token. The OpenAI key value is ignored.
    cfg.llm.api_key = os.environ.get("LOOPLAB_OPT_TOKEN", "") or "looplab-local-shim"
    cfg.llm.models = [LLMModelConfig(
        name="looplab-metered", api_base=cfg.llm.api_base, api_key=cfg.llm.api_key,
        temperature=0.7, max_tokens=2600, timeout=180, retries=2, retry_delay=2,
    )]
    cfg.database.population_size = 20
    cfg.database.archive_size = 10
    cfg.evaluator.timeout = 120
    cfg.evaluator.cascade_evaluation = False
    cfg.evaluator.use_llm_feedback = False
    cfg.evaluator.parallel_evaluations = 1

    stopped_reason = "completed"
    best_code = None
    best_score = None
    try:
        oe = OpenEvolve(
            initial_program_path=baseline_path,
            evaluation_file=evaluation_file,
            config=cfg,
            output_dir=os.path.join(manifest["out_dir"], "evolution"),
        )
        result = asyncio.run(oe.run(iterations=cfg.max_iterations))
        best_code = getattr(result, "best_code", None)
        best_score = getattr(result, "best_score", None)
        if best_score is not None:
            best_score = round(float(best_score), 6)
    except BudgetStop as exc:
        log(f"budget stop: {exc}")
        stopped_reason = f"budget_stop: {exc}"
    except ProxyBudgetStop as exc:
        log(f"budget stop: {exc}")
        stopped_reason = f"budget_stop: {exc}"
    finally:
        shim.stop()
        # metric usage is accounted inside the (possibly worker-process)
        # evaluation bridge via the state file — read it back as authority
        if os.path.exists(state_path):
            with open(state_path, encoding="utf-8") as f:
                used = int(json.load(f).get("used") or 0)
            usage.metric_calls = used
            max_calls = int(manifest["budget"]["max_metric_calls"])
            if used >= max_calls and stopped_reason == "completed":
                stopped_reason = f"budget_stop: metric budget exhausted ({max_calls})"

    proposals = []
    if best_code and best_code.strip() != baseline_src.strip():
        proposals.append({
            "mechanism": "OpenEvolve best program (MAP-elites archive)",
            "changed_summary": "heuristic_source variant discovered by openevolve@0.3.2",
            "candidate_code": best_code,
            "expected_effect": "validated on the fixed in-run batch; independent pipeline evaluation decides",
            "train_score": None,
            "val_score": best_score,
        })
    else:
        log("best == seed (no accepted mutation) — honest empty result")

    payload = {"proposals": proposals, "usage": usage.as_dict(), "stopped_reason": stopped_reason}
    with open(os.path.join(manifest["out_dir"], "result.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"done in {time.time()-t0:.1f}s: {len(proposals)} proposals, usage={json.dumps(usage.as_dict())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
