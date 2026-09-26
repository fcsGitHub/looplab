// EvolutionService: failure -> attribution -> proposal (real LLM) -> build ->
// dev eval -> selection eval -> release eval -> promote/rollback (design §08).
// Kept deliberately simple & explainable for v1; OptimizerPort allows swapping
// in GEPA / ShinkaEvolve / OpenEvolve later without touching the kernel.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { newId, type EvaluationResult } from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import { LlmGateway } from "./llmgateway.js";
import { EvalBroker } from "./evalbroker.js";
import { ReleaseService, ReleaseBlockedError, ReleaseConflictError } from "./releases.js";
import { taskpackPath } from "./taskpackpath.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

const PROPOSER_SYSTEM = `你是 LoopLab 的改进提案器。给定一个失败问题和父版本源代码，提出一个最小补丁。
输出 JSON：{"mechanism":"机制解释","changed_summary":"改了什么","candidate_code":"完整的替换文件内容","expected_effect":"预期效果","risks":["..."],"min_experiment":"最小验证实验","rollback":"回滚方式"}
只改允许的文件。代码必须完整可运行。`;

export interface ProposalRecord {
  id: string; problem_id: string; mechanism: string;
}

export class EvolutionService {
  private llm: LlmGateway;
  private evalBroker: EvalBroker;
  private releases: ReleaseService;

  constructor(private db: Db, private config: Config) {
    this.llm = new LlmGateway(db, config);
    this.evalBroker = new EvalBroker(db, config);
    this.releases = new ReleaseService(db);
  }

  /** Archive real failures (from task.failed events) as deduplicated problems. */
  async collectProblems(goalId: string): Promise<string[]> {
    const failures = (await this.db.query(
      `SELECT DISTINCT ON (t.node_key, a.error_class) t.id AS task_id, t.node_key, a.error_class, t.goal_id
         FROM attempts a JOIN tasks t ON t.id = a.task_id
        WHERE a.goal_id=$1 AND a.status='COMMITTED' AND a.error_class IS NOT NULL
        ORDER BY t.node_key, a.error_class, a.ended_at DESC`,
      [goalId],
    )).rows;
    const ids: string[] = [];
    for (const f of failures) {
      const fingerprint = createHash("sha256").update(`${f.node_key}:${f.error_class}`).digest("hex").slice(0, 16);
      const existing = (await this.db.query(
        "SELECT id FROM problems WHERE goal_id=$1 AND fingerprint=$2", [goalId, fingerprint],
      )).rows[0];
      if (existing) { ids.push(existing.id); continue; }
      const id = newId("prob");
      const failureClass = this.classifyFailure(f.error_class);
      await this.db.tx(async (client) => {
        await client.query(
          `INSERT INTO problems (id, goal_id, title, description, failure_class, fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (goal_id, fingerprint) DO NOTHING`,
          [id, goalId, `任务 ${f.node_key} 反复失败（${f.error_class}）`,
            `节点 ${f.node_key} 以错误类别 ${f.error_class} 失败。`, failureClass, fingerprint],
        );
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: goalId, eventType: "problem.archived",
          goalId, actor: { kind: "system", id: "evolution" },
          payload: { problem_id: id, failure_class: failureClass, node_key: f.node_key },
        });
      });
      ids.push(id);
    }
    return ids;
  }

  /** §8.1: infra errors are not algorithm failures. */
  private classifyFailure(errorClass: string | null): string {
    if (!errorClass) return "algorithm";
    if (/worker_lost|timeout|resource|http|network/i.test(errorClass)) return "tool_env";
    return "algorithm";
  }

  /** Real LLM proposal from a problem + parent source. */
  async proposeChange(input: { goalId: string; problemId: string; taskpackId: string; allowedPath: string; baselinePath?: string }): Promise<ProposalRecord | null> {
    const problem = (await this.db.query("SELECT * FROM problems WHERE id=$1", [input.problemId])).rows[0];
    if (!problem) return null;
    // contained read (V18): taskpackId/baselinePath arrive over HTTP — an
    // unchecked join read arbitrary files (config/.env.local included) into
    // the proposer prompt
    const baseline = readFileSync(
      taskpackPath(this.config.dataDir, input.taskpackId, input.baselinePath ?? "baseline.py"), "utf8",
    );

    const result = await this.llm.call({
      goalId: input.goalId,
      scope: "evolution_search",
      model: "chat",
      maxTokens: 2500,
      temperature: 0.5,
      idempotencyKey: `propose_${input.problemId}`,
      actor: { kind: "optimizer", id: "simple-baseline" },
      messages: [
        { role: "system", content: PROPOSER_SYSTEM },
        { role: "user", content: `失败问题：${problem.title}\n描述：${problem.description}\n\n父版本源码（${input.allowedPath}）：\n\`\`\`\n${baseline.slice(0, 8000)}\n\`\`\`\n请提出最小补丁。注意：父版本是 First-Fit Decreasing；请探索一个有实质差异的放置策略（例如 best-fit、带回退的两阶段策略、或对物品排序的改进），不要复述父版本，否则评测会因零改进而判为证据不足。` },
      ],
    });
    const text = result.message.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const fingerprint = createHash("sha256")
      .update(`${input.problemId}:${parsed.mechanism ?? ""}:${(parsed.candidate_code ?? "").slice(0, 500)}`)
      .digest("hex").slice(0, 16);
    const id = newId("prop");
    const goalId = input.goalId;
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO change_proposals (id, problem_id, goal_id, mechanism, parent_digests, allowed_paths,
           expected_effect, min_experiment, risks, rollback, fingerprint)
         VALUES ($1,$2,$3,$4,'{}',$5,$6,$7,$8,$9,$10)
         ON CONFLICT (goal_id, fingerprint) DO NOTHING`,
        [id, input.problemId, input.goalId, parsed.mechanism ?? "", [input.allowedPath],
          parsed.expected_effect ?? "", parsed.min_experiment ?? "",
          JSON.stringify(parsed.risks ?? []), parsed.rollback ?? "", fingerprint],
      );
      await EventStore.append(client, {
        aggregateType: "goal", aggregateId: input.goalId, eventType: "proposal.created",
        goalId, actor: { kind: "optimizer", id: "simple-baseline" },
        payload: {
          proposal_id: id, mechanism: parsed.mechanism ?? "", problem_id: input.problemId,
          candidate_code: parsed.candidate_code ?? "",
          changed_summary: parsed.changed_summary ?? "",
        },
      });
    });
    return { id, problem_id: input.problemId, mechanism: parsed.mechanism ?? "" };
  }

  /** Build a candidate from a proposal: real code artifact, digest-addressed. */
  async buildCandidate(input: { goalId: string; proposalId: string; taskpackId: string; allowedPath: string }): Promise<string | null> {
    const proposal = (await this.db.query("SELECT * FROM change_proposals WHERE id=$1", [input.proposalId])).rows[0];
    if (!proposal) return null;
    // re-derive candidate code: stored at propose time inside mechanism? No —
    // re-call the proposer deterministically? We store code in the proposal row
    // (candidate_code jsonb) at proposal time.
    const code = (await this.db.query(
      "SELECT payload->>'candidate_code' AS code FROM events WHERE event_type='proposal.created' AND payload->>'proposal_id'=$1 ORDER BY seq DESC LIMIT 1",
      [input.proposalId],
    )).rows[0]?.code;
    if (!code) return null;

    const content = Buffer.from(code, "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    // object store write (object first, then db)
    const objDir = path.join(this.config.dataDir, "objects", digest.slice(0, 2), digest.slice(2, 4));
    mkdirSync(objDir, { recursive: true });
    writeFileSync(path.join(objDir, digest), content);

    // content-addressed: building the same code twice returns the SAME
    // candidate (idempotent); lineage stays in proposal.created events
    const existing = (await this.db.query(
      "SELECT id FROM candidates WHERE digest=$1 ORDER BY created_at LIMIT 1", [digest],
    )).rows[0];
    if (existing) return existing.id as string;

    const candId = newId("cand");
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
         VALUES ($1,$2,'text/x-python',$3,$4,$5,'optimizer',$6,'candidate')
         ON CONFLICT (digest) DO NOTHING`,
        [digest, path.basename(input.allowedPath), content.byteLength, `file://${digest}`, input.proposalId, input.goalId],
      );
      await client.query(
        `INSERT INTO candidates (id, digest, goal_id, kind, title, parents, artifact_digest, manifest, status)
         VALUES ($1,$2,$3,'algorithm',$4,'{}',$5,$6,'BUILT')`,
        [candId, digest, input.goalId, (proposal.mechanism ?? "").slice(0, 80), digest,
          JSON.stringify({ proposal_id: input.proposalId, problem_id: proposal.problem_id, changed_paths: [input.allowedPath] })],
      );
      await client.query("INSERT INTO candidate_status_history (candidate_id, status, reason) VALUES ($1,'BUILT',$2)", [candId, `from proposal ${input.proposalId}`]);
      await EventStore.append(client, {
        aggregateType: "candidate", aggregateId: candId, eventType: "candidate.built",
        goalId: input.goalId, payloadRef: `artifact://sha256/${digest}`,
        payload: { proposal_id: input.proposalId, digest },
      });
    });
    return candId;
  }

  /** dev -> selection -> release with honest verdicts (incl. INCONCLUSIVE). */
  async evaluateCandidate(input: { goalId: string; candidateId: string; taskpackId: string; contractVersion: string }):
    Promise<{ verdict: string; final: EvaluationResult | null }> {
    const cand = (await this.db.query("SELECT * FROM candidates WHERE id=$1", [input.candidateId])).rows[0];
    if (!cand) return { verdict: "REJECTED", final: null };
    await this.db.tx(async (client) => {
      await client.query("UPDATE candidates SET status='EVALUATING', updated_at=now() WHERE id=$1", [input.candidateId]);
      await EventStore.append(client, {
        aggregateType: "candidate", aggregateId: input.candidateId, eventType: "candidate.evaluating",
        goalId: input.goalId, payload: {},
      });
    });

    let dev: EvaluationResult | null = null;
    try {
      dev = await this.evalBroker.runEvaluation({
        candidateId: input.candidateId, candidateArtifactDigest: cand.digest,
        goalId: input.goalId, taskpackId: input.taskpackId, layer: "dev",
        contractVersion: input.contractVersion, budgetUsd: 0,
      });
    } catch (err) {
      await this.setStatus(input.candidateId, "REJECTED", `dev evaluation failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      return { verdict: "REJECTED", final: dev };
    }
    if (!dev.hard_constraints.every((h) => h.passed) || dev.verdict === "REJECTED") {
      await this.setStatus(input.candidateId, "REJECTED", `dev: ${dev.reason}`);
      return { verdict: "REJECTED", final: dev };
    }

    let selection: EvaluationResult;
    try {
      selection = await this.evalBroker.runEvaluation({
        candidateId: input.candidateId, candidateArtifactDigest: cand.digest,
        goalId: input.goalId, taskpackId: input.taskpackId, layer: "selection",
        contractVersion: input.contractVersion, budgetUsd: 0,
      });
    } catch (err) {
      // a crashed selection run must not leave the candidate stuck EVALUATING
      await this.setStatus(input.candidateId, "REJECTED", `selection evaluation failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      return { verdict: "REJECTED", final: null };
    }
    if (!selection.hard_constraints.every((h) => h.passed) || selection.verdict === "REJECTED") {
      await this.setStatus(input.candidateId, "REJECTED", `selection: ${selection.reason}`);
      return { verdict: "REJECTED", final: selection };
    }
    if (selection.verdict === "INCONCLUSIVE") {
      // 证据不足：保留标签与证据，不判死刑，也不晋级
      await this.setStatus(input.candidateId, "INCONCLUSIVE", `selection: ${selection.reason}`);
      return { verdict: "INCONCLUSIVE", final: selection };
    }

    let release: EvaluationResult;
    try {
      release = await this.evalBroker.runEvaluation({
        candidateId: input.candidateId, candidateArtifactDigest: cand.digest,
        goalId: input.goalId, taskpackId: input.taskpackId, layer: "release",
        contractVersion: input.contractVersion, budgetUsd: 0,
      });
    } catch (err) {
      await this.setStatus(input.candidateId, "REJECTED", `release evaluation failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      return { verdict: "REJECTED", final: null };
    }
    if (release.verdict === "ELIGIBLE") {
      await this.setStatus(input.candidateId, "ELIGIBLE", "passed dev/selection/release with hard constraints");
      return { verdict: "ELIGIBLE", final: release };
    }
    if (release.verdict === "INCONCLUSIVE") {
      await this.setStatus(input.candidateId, "INCONCLUSIVE", `release: ${release.reason}`);
      return { verdict: "INCONCLUSIVE", final: release };
    }
    await this.setStatus(input.candidateId, "REJECTED", `release: ${release.reason}`);
    return { verdict: "REJECTED", final: release };
  }

  private async setStatus(candidateId: string, status: string, reason: string) {
    await this.db.tx(async (client) => {
      await client.query("UPDATE candidates SET status=$2, updated_at=now() WHERE id=$1", [candidateId, status]);
      await client.query("INSERT INTO candidate_status_history (candidate_id, status, reason) VALUES ($1,$2,$3)", [candidateId, status, reason]);
      await EventStore.append(client, {
        aggregateType: "candidate", aggregateId: candidateId, eventType: `candidate.${status.toLowerCase()}`,
        actor: { kind: "evaluator", id: "eval-broker" }, payload: { reason },
      });
    });
  }

  /** Promote with CAS; auto-canary policy for low-risk first promotion. */
  async promote(input: { goalId: string; candidateId: string; scope: string; kind: "canary" | "full" }):
    Promise<{ ok: true; releaseId: string } | { ok: false; reason: string }> {
    try {
      const res = await this.releases.promote({
        goalId: input.goalId, candidateId: input.candidateId, scope: input.scope,
        parentRelease: null, kind: input.kind,
        evidenceManifest: (await this.db.query(
          "SELECT id, layer, verdict FROM evaluations WHERE candidate_id=$1 ORDER BY created_at",
          [input.candidateId],
        )).rows.map((r: any) => ({ evaluation_id: String(r.id), layer: String(r.layer), verdict: String(r.verdict) })),
        authorization: input.kind === "canary" ? "policy:auto-canary" : "approval:pending",
      });
      return { ok: true, releaseId: res.releaseId };
    } catch (err) {
      if (err instanceof ReleaseConflictError) {
        return { ok: false, reason: `CAS conflict: current pointer is ${err.current?.release_id ?? "empty"}` };
      }
      if (err instanceof ReleaseBlockedError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  /** Canary regression watch: selection-suite regression flips the pointer back. */
  async checkCanaryRegression(scope: string, _taskpackId: string): Promise<{ rolledBack: boolean; reason: string }> {
    const pointer = await this.releases.currentPointer(scope);
    if (!pointer) return { rolledBack: false, reason: "no pointer" };
    const rel = (await this.db.query("SELECT * FROM releases WHERE id=$1", [pointer.release_id])).rows[0];
    if (!rel || rel.kind !== "canary") return { rolledBack: false, reason: "pointer is not a canary" };
    const candEval = (await this.db.query(
      `SELECT results FROM evaluations WHERE candidate_id=$1 AND layer='selection' ORDER BY created_at DESC LIMIT 1`,
      [pointer.candidate_id],
    )).rows[0];
    if (!candEval) return { rolledBack: false, reason: "insufficient eval data" };
    const r = candEval.results;
    const baselineValue = Number(r.baseline_value);
    const primaryValue = Number(r.primary_value);
    const epsilon = Math.abs(Number(r.max_regression_epsilon ?? 0.02));
    // bins_avg is a minimize metric: primary above baseline = regression
    const regression = primaryValue - baselineValue;
    if (regression > epsilon) {
      await this.releases.rollback({
        scope, releaseId: pointer.release_id,
        reason: `canary regression: primary ${primaryValue.toFixed(4)} vs baseline ${baselineValue.toFixed(4)} (regression ${regression.toFixed(4)} > epsilon ${epsilon})`,
        actor: "canary-watch",
      });
      return { rolledBack: true, reason: `regression ${regression.toFixed(4)}` };
    }
    return { rolledBack: false, reason: `delta ${regression.toFixed(4)} within epsilon` };
  }
}
