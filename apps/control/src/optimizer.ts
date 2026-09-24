// OptimizerService — the control-kernel side of OptimizerPort (design §5.3, §6.8).
//
// Trust architecture (mirrors EvalBroker): the optimizer backend process is
// authorized infrastructure spawned by this service with a run-scoped token;
// candidate code it evaluates runs inside the existing audit-hook child
// sandbox (candidate_runner.py). The backend NEVER sees the model API key —
// its reflection LM calls go through the metered proxy below, which reserves
// and settles budget exactly like every other model call. Backends can only
// emit change_proposals, which flow through the SAME independent
// dev/selection/release evaluation and human promote gates as the
// simple-baseline proposer — an optimizer cannot approve its own candidate.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OptimizerRunManifestSchema,
  OptimizerCompletePayloadSchema,
  assertOptimizerAuthorized,
  nextEpochWinner,
  type OptimizerEpoch,
  type OptimizerProposal,
  type OptimizerUsage,
} from "@looplab/contracts";
import { estimateCostUsd, type ChatMessage } from "@looplab/llm";
import { EventStore } from "./eventstore.js";
import { LlmGateway } from "./llmgateway.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

const RUN_TOKEN_TTL_MS = 6 * 3600_000;

export interface OptimizerRunRow {
  id: string; goal_id: string; backend: string; mode: string;
  epoch_index: number; status: string; budget_max_metric_calls: number;
  budget_max_llm_cost_usd: string; spent_usd: string; llm_calls: number;
  metric_calls: number; manifest: any; stopped_reason: string | null;
  created_at: string; ended_at: string | null;
}

export class OptimizerBudgetExceededError extends Error {}
export class OptimizerAuthError extends Error {}

export class OptimizerService {
  private llm: LlmGateway;

  constructor(private db: Db, private config: Config) {
    this.llm = new LlmGateway(db, config);
  }

  async currentEpoch(): Promise<OptimizerEpoch | null> {
    const row = (
      await this.db.query(
        `SELECT index, active_backend, frozen, status FROM optimizer_epochs WHERE status <> 'CLOSED' ORDER BY index DESC LIMIT 1`,
      )
    ).rows[0];
    if (!row) return null;
    return {
      index: Number(row.index), active_backend: String(row.active_backend),
      frozen: row.frozen, status: row.status,
    };
  }

  /** Create a run + opaque token; authorization checked against the epoch. */
  async createRun(input: {
    goalId: string;
    backend: string;
    mode: "active" | "epoch_trial";
    maxMetricCalls: number;
    maxLlmCostUsd: number;
    reflection: "gateway" | "scripted";
    gatewayUrl?: string;
  }): Promise<{ runId: string; token: string; manifest: unknown }> {
    const epoch = await this.currentEpoch();
    const verdict = assertOptimizerAuthorized({ epoch, backend: input.backend, mode: input.mode });
    if (!verdict.ok) throw new Error(verdict.reason);

    const taskpackId = "algorithm-search.bin-packing";
    const tpDir = path.join(this.config.dataDir, "taskpacks", taskpackId);
    const runId = `opt_${randomBytes(6).toString("hex")}`;
    const token = `optk_${randomBytes(24).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const outDir = path.join(this.config.dataDir, "optimizer", runId);
    const workDir = path.join(outDir, "work");
    mkdirSync(workDir, { recursive: true });

    const full = OptimizerRunManifestSchema.parse({
      run_id: runId, goal_id: input.goalId, backend: input.backend,
      mode: input.mode, epoch_index: epoch?.index ?? 0, taskpack_id: taskpackId,
      component: {
        name: "heuristic_source", kind: "python_source", entry_export: "pack",
        signature: "pack(items: list[int], capacity: int) -> list[list[int]]",
      },
      dev_suite_path: path.join(tpDir, "dev-suite.json"),
      baseline_path: path.join(tpDir, "baseline.py"),
      work_dir: workDir, out_dir: outDir,
      budget: { max_metric_calls: input.maxMetricCalls, max_llm_cost_usd: input.maxLlmCostUsd },
      seed: 7 + (epoch?.index ?? 0) * 1000,
      reflection: input.reflection,
      ...(input.gatewayUrl ? { gateway_url: input.gatewayUrl } : {}),
    });
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO optimizer_runs (id, goal_id, backend, mode, epoch_index, token_hash,
           budget_max_metric_calls, budget_max_llm_cost_usd, manifest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [runId, input.goalId, input.backend, input.mode, full.epoch_index, tokenHash,
          full.budget.max_metric_calls, full.budget.max_llm_cost_usd, JSON.stringify(full)],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: input.goalId, eventType: "optimizer.run_started",
        goalId: input.goalId, actor: { kind: "optimizer", id: input.backend },
        payload: {
          run_id: runId, backend: input.backend, mode: input.mode,
          epoch_index: full.epoch_index, max_metric_calls: full.budget.max_metric_calls,
          reflection: full.reflection, // token is NEVER in the event ledger
        },
      });
    });
    return { runId, token, manifest: full };
  }

  /** Hash-lookup a run token; throws OptimizerAuthError when invalid/expired/closed. */
  private async runByToken(token: string): Promise<OptimizerRunRow> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = (await this.db.query(
      `SELECT *, created_at FROM optimizer_runs WHERE token_hash=$1`, [tokenHash],
    )).rows[0] as OptimizerRunRow;
    if (!row) throw new OptimizerAuthError("invalid optimizer run token");
    if (row.status !== "RUNNING") throw new OptimizerAuthError(`run ${row.id} is ${row.status}`);
    if (Date.now() - new Date(row.created_at).getTime() > RUN_TOKEN_TTL_MS) {
      await this.db.tx(async (client) => {
        await client.query(`UPDATE optimizer_runs SET status='EXPIRED', ended_at=now() WHERE id=$1`, [row.id]);
      });
      throw new OptimizerAuthError("optimizer run token expired");
    }
    return row;
  }

  /**
   * Metered reflection-LM proxy called by the backend process. The model key
   * stays here; the call reserves before / settles after, and its cost counts
   * against BOTH the goal budget and the run's own LLM cost cap.
   */
  async meteredLlm(input: {
    token: string;
    callSeq: number;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number; model: string } }> {
    const run = await this.runByToken(input.token);
    if (Number(run.spent_usd) >= Number(run.budget_max_llm_cost_usd)) {
      throw new OptimizerBudgetExceededError(
        `optimizer run ${run.id} reached its LLM cost cap ${run.budget_max_llm_cost_usd} USD`,
      );
    }
    const result = await this.llm.call({
      goalId: run.goal_id,
      scope: "evolution_search",
      kind: "optimizer_llm",
      maxTokens: input.maxTokens ?? 2048,
      temperature: input.temperature ?? 0.4,
      idempotencyKey: `${run.id}_llm_${input.callSeq}`,
      actor: { kind: "optimizer", id: run.backend },
      messages: input.messages,
    });
    const cost = estimateCostUsd(result.usage, this.config.costPer1kPromptUsd, this.config.costPer1kCompletionUsd);
    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE optimizer_runs SET llm_calls = llm_calls + 1, spent_usd = spent_usd + $2 WHERE id=$1`,
        [run.id, cost],
      );
    });
    return {
      content: result.message.content ?? "",
      usage: {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        cost_usd: Number(cost.toFixed(6)),
        model: result.model,
      },
    };
  }

  /** Backend finished: validate payload, register proposals, close the run. */
  async completeRun(input: {
    token: string;
    payload: { proposals: OptimizerProposal[]; usage: OptimizerUsage; stopped_reason?: string };
  }): Promise<{ runId: string; proposalIds: string[] }> {
    const run = await this.runByToken(input.token);
    const parsed = OptimizerCompletePayloadSchema.safeParse(input.payload);
    if (!parsed.success) throw new Error(`optimizer payload invalid: ${parsed.error.message.slice(0, 300)}`);
    if (parsed.data.usage.metric_calls > run.budget_max_metric_calls) {
      throw new Error(`run exceeded its metric budget: ${parsed.data.usage.metric_calls} > ${run.budget_max_metric_calls}`);
    }

    const proposalIds: string[] = [];
    for (const prop of parsed.data.proposals) {
      const fingerprint = createHash("sha256")
        .update(`${run.id}:${prop.mechanism}:${prop.candidate_code.slice(0, 500)}`)
        .digest("hex").slice(0, 16);
      const id = `prop_${randomBytes(6).toString("hex")}`;
      await this.db.tx(async (client) => {
        await client.query(
          `INSERT INTO change_proposals (id, problem_id, goal_id, mechanism, parent_digests, allowed_paths,
             expected_effect, min_experiment, risks, rollback, fingerprint)
           VALUES ($1,NULL,$2,$3,'{}',$4,$5,'','[]','',$6)
           ON CONFLICT (goal_id, fingerprint) DO NOTHING`,
          [id, run.goal_id, prop.mechanism, ["heuristic.py"], prop.expected_effect, fingerprint],
        );
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: run.goal_id, eventType: "proposal.created",
          goalId: run.goal_id, actor: { kind: "optimizer", id: run.backend },
          payload: {
            proposal_id: id, mechanism: prop.mechanism, problem_id: null,
            candidate_code: prop.candidate_code,
            changed_summary: prop.changed_summary,
            optimizer_run: { run_id: run.id, backend: run.backend, epoch_index: run.epoch_index },
            internal_scores: { train: prop.train_score, val: prop.val_score },
          },
        });
      });
      proposalIds.push(id);
    }

    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE optimizer_runs SET status='COMPLETED', ended_at=now(), metric_calls=$2, stopped_reason=$3 WHERE id=$1`,
        [run.id, parsed.data.usage.metric_calls, parsed.data.stopped_reason ?? "completed"],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: run.goal_id, eventType: "optimizer.run_completed",
        goalId: run.goal_id, actor: { kind: "optimizer", id: run.backend },
        payload: { run_id: run.id, usage: parsed.data.usage, proposals: proposalIds.length },
      });
    });
    return { runId: run.id, proposalIds };
  }

  async failRun(runId: string, reason: string): Promise<void> {
    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE optimizer_runs SET status='FAILED', ended_at=now(), stopped_reason=$2 WHERE id=$1 AND status='RUNNING'`,
        [runId, reason.slice(0, 500)],
      );
    });
  }

  async listRuns(goalId: string): Promise<OptimizerRunRow[]> {
    return (await this.db.query(
      `SELECT id, goal_id, backend, mode, epoch_index, status, budget_max_metric_calls,
              budget_max_llm_cost_usd, spent_usd, llm_calls, metric_calls, manifest,
              stopped_reason, created_at, ended_at
         FROM optimizer_runs WHERE goal_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [goalId],
    )).rows as OptimizerRunRow[];
  }

  /**
   * Spawn the backend process and feed its output into completeRun. The
   * backend is authorized infrastructure (same trust tier as evaluator.py);
   * candidate code it evaluates remains sandboxed via candidate_runner.py.
   */
  async runBackendRound(input: {
    goalId: string;
    backend: string;
    mode: "active" | "epoch_trial";
    maxMetricCalls: number;
    maxLlmCostUsd: number;
    reflection: "gateway" | "scripted";
    baseUrl: string;
    timeoutMs?: number;
  }): Promise<{ runId: string; proposalIds: string[]; usage: OptimizerUsage }> {
    const { runId, token } = await this.createRun({
      goalId: input.goalId, backend: input.backend, mode: input.mode,
      maxMetricCalls: input.maxMetricCalls, maxLlmCostUsd: input.maxLlmCostUsd,
      reflection: input.reflection,
      gatewayUrl: `${input.baseUrl}/v1/optimizer/llm`,
    });
    const row = (await this.db.query(`SELECT manifest FROM optimizer_runs WHERE id=$1`, [runId])).rows[0];
    if (!row) throw new Error(`optimizer run ${runId} disappeared`);
    const manifest = row.manifest;
    const manifestPath = path.join(manifest.out_dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const backendScript = path.resolve(path.join(rootDir(), "optimizers", "gepa-backend", "backend.py"));
    if (!existsSync(backendScript)) throw new Error(`optimizer backend missing: ${backendScript}`);
    const python = this.config.optimizerPython;
    if (!existsSync(python)) throw new Error(`optimizer python missing: ${python} (create .venv-gepa, pip install gepa==0.1.4)`);

    const exit = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(python, [backendScript, manifestPath], {
        cwd: manifest.work_dir,
        timeout: input.timeoutMs ?? 30 * 60_000,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
          // the ONLY credential the backend gets: a run-scoped token that
          // authorizes the metered LLM proxy — never the model API key
          LOOPLAB_OPT_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.stdout.on("data", () => { /* backend logs to out_dir files */ });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    if (exit.code !== 0) {
      const reason = `backend exited ${exit.code}: ${exit.stderr.slice(-800)}`;
      await this.failRun(runId, reason);
      throw new Error(reason);
    }

    const outDir: string = manifest.out_dir;
    const payload = JSON.parse(readFileSync(path.join(outDir, "result.json"), "utf8"));
    try {
      const res = await this.completeRun({ token, payload });
      return { ...res, usage: payload.usage };
    } catch (err) {
      await this.failRun(runId, `complete rejected: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
      throw err;
    }
  }

  /**
   §6.8 epoch trial: incumbent vs challenger with EQUAL budgets on the same
   frozen task family. Returns whether the epoch pointer advances to the
   challenger for the NEXT epoch (current epoch stays authoritative until the
   switch). Recursion depth is structurally 1: the port only carries the
   task-domain component, so the challenger cannot touch the kernel or this
   trial machinery itself.
   */
  async settleEpochTrial(input: {
    incumbent: string;
    challenger: string;
    incumbentImprovement: number;
    challengerImprovement: number;
    minMargin: number;
  }): Promise<{ switched: boolean; nextEpochIndex: number | null; reason: string }> {
    const epoch = await this.currentEpoch();
    if (!epoch || epoch.status !== "OPEN") throw new Error("no OPEN epoch to settle");
    const verdict = nextEpochWinner({
      incumbent: input.incumbent, challenger: input.challenger,
      incumbentImprovement: input.incumbentImprovement,
      challengerImprovement: input.challengerImprovement,
      minMargin: input.minMargin,
    });
    let nextEpochIndex: number | null = null;
    if (verdict.switched) {
      nextEpochIndex = epoch.index + 1;
      await this.db.tx(async (client) => {
        await client.query(`UPDATE optimizer_epochs SET status='CLOSED' WHERE index=$1`, [epoch.index]);
        await client.query(
          `INSERT INTO optimizer_epochs (index, active_backend, frozen, status)
           VALUES ($1,$2,$3,'OPEN')`,
          [nextEpochIndex, verdict.winner,
            JSON.stringify({ ...epoch.frozen, predecessor_epoch: epoch.index, switched_from: input.incumbent })],
        );
        await EventStore.append(client, {
          aggregateType: "optimizer", aggregateId: String(nextEpochIndex),
          eventType: "optimizer.epoch_switched",
          actor: { kind: "system", id: "meta-evolution" },
          payload: {
            from_epoch: epoch.index, to_epoch: nextEpochIndex,
            from_backend: input.incumbent, to_backend: verdict.winner,
            reason: verdict.reason,
            incumbent_improvement: input.incumbentImprovement,
            challenger_improvement: input.challengerImprovement,
          },
        });
      });
    }
    return { switched: verdict.switched, nextEpochIndex, reason: verdict.reason };
  }
}

function rootDir(): string {
  // apps/control/src → repo root is three levels up
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}
