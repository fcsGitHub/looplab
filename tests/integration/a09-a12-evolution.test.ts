// A09: 并发发布 → CAS 保证单一父版本只被替换一次。
// A10: 候选读取封存标签 → 沙箱阻断、候选隔离、不参与晋级。
// A11: 候选退化但 Reviewer 给高分 → 程序评测阻断发布。
// A12: 小样本无显著差异 → INCONCLUSIVE（证据不足），不是"方向失败"。
// A16: 模型版本变化 → 新 RunSpec；旧 attempt 仍按锁定环境可追溯。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
const BFD = `def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        best_i, best_remaining = -1, None
        for i, b in enumerate(bins):
            remaining = capacity - sum(b) - size
            if remaining >= 0 and (best_remaining is None or remaining < best_remaining):
                best_i, best_remaining = i, remaining
        if best_i >= 0:
            bins[best_i].append(size)
        else:
            bins.append([size])
    return bins
`;

const MALICIOUS = [
    "def pack(items, capacity=100):",
    "    try:",
    "        f = open(r'D:\\\\project\\\\looplab\\\\sealed\\\\algorithm-search.bin-packing\\\\release-suite.json')",
    "        _labels = f.read()",
    "    except Exception:",
    "        pass",
    "    return [[x] for x in items]",
    "",
  ].join("\n");

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 5000 });
});
afterAll(async () => { await env.close(); });

/** Fixture: register candidate code as a content-addressed artifact + row. */
async function createCandidate(goalId: string, code: string, title: string, kind = "algorithm") {
  const digest = createHash("sha256").update(code).digest("hex");
  const objDir = path.join(env.dataDir, "objects", digest.slice(0, 2), digest.slice(2, 4));
  mkdirSync(objDir, { recursive: true });
  writeFileSync(path.join(objDir, digest), code);
  const candId = `cand_${digest.slice(0, 8)}`;
  await env.app.services.db.tx(async (client: any) => {
    await client.query(
      `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
       VALUES ($1,'heuristic.py','text/x-python',$2,$3,'fixture','optimizer',$4,'candidate')
       ON CONFLICT (digest) DO NOTHING`,
      [digest, Buffer.byteLength(code), `file://${digest}`, goalId],
    );
    await client.query(
      `INSERT INTO candidates (id, digest, goal_id, kind, title, parents, artifact_digest, manifest, status)
       VALUES ($1,$2,$3,'algorithm',$4,'{}',$5,'{}','ELIGIBLE')
       ON CONFLICT (digest) DO NOTHING`,
      [candId, digest, goalId, title, digest],
    );
  });
  return candId;
}

/** Fixture: record an evaluation with explicit results. */
async function insertEvaluation(candidateId: string, layer: string, verdict: string) {
  await env.app.services.db.query(
    `INSERT INTO evaluations (id, candidate_id, contract_version, suite_ref, layer, results, verdict, evaluated_by)
     VALUES ($1,$2,'bin-packing/v1','fixture',$3,$4,$5,'fixture')`,
    [`eval_fix_${candidateId}_${layer}_${Math.random().toString(36).slice(2, 6)}`, candidateId, layer,
      JSON.stringify({
        primary_metric: "bins_avg", primary_value: 30, baseline_value: 32.5, paired_delta: 2.5,
        hard_constraints: [{ name: "feasibility", passed: verdict !== "REJECTED", detail: "fixture" }],
      }), verdict],
  );
}

describe("A09 CAS release", () => {
  it("only one of two concurrent promotions of the same parent pointer wins", async () => {
    const user = await authedUser(env, "cas-user");
    const f = fixture(env);
    const me = await user.get("/v1/me");
    const userId = me.json().user.id as string;
    const { projectId, sessionId } = await f.createProjectSession(userId);
    const { goalId } = await f.createGoalWithTasks(userId, projectId, sessionId, []);

    const c1 = await createCandidate(goalId, BFD, "BFD");
    const c2 = await createCandidate(goalId, BFD.replace("Best-Fit", "Best-Fit v2"), "BFD v2");
    await insertEvaluation(c1, "release", "ELIGIBLE");
    await insertEvaluation(c2, "release", "ELIGIBLE");

    const res = await env.app.services.releases.promote({
      goalId, candidateId: c1, scope: "algorithm:bin-packing:cas",
      parentRelease: null, kind: "full", evidenceManifest: [], authorization: "fixture",
    });
    expect(res.releaseId).toBeTruthy();

    // second promotion still believes the parent is null -> CAS conflict
    await expect(env.app.services.releases.promote({
      goalId, candidateId: c2, scope: "algorithm:bin-packing:cas",
      parentRelease: null, kind: "full", evidenceManifest: [], authorization: "fixture",
    })).rejects.toThrow(/CAS|pointer moved/i);

    // with the CORRECT parent it succeeds
    const res2 = await env.app.services.releases.promote({
      goalId, candidateId: c2, scope: "algorithm:bin-packing:cas",
      parentRelease: res.releaseId, kind: "full", evidenceManifest: [], authorization: "fixture",
    });
    expect(res2.releaseId).toBeTruthy();
  });
});

describe("A11 program evidence blocks release despite glowing review", () => {
  it("rejects promotion when the release-layer evaluation failed", async () => {
    const user = await authedUser(env, "a11-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);
    const candId = await createCandidate(goalId,
      BFD + "\n# A11 variant: regresses on release suite\n", "regressing candidate");
    await insertEvaluation(candId, "release", "REJECTED");
    // an enthusiastic LLM review must NOT override program evidence
    await env.app.services.db.query(
      `INSERT INTO reviews (id, candidate_id, reviewer, verdict, objections)
       VALUES ('rev_a11',$1,'llm-reviewer','APPROVE','[]')`, [candId],
    );
    await expect(env.app.services.releases.promote({
      goalId, candidateId: candId, scope: "algorithm:bin-packing:a11",
      parentRelease: null, kind: "full", evidenceManifest: [], authorization: "fixture",
    })).rejects.toThrow(/no passing release-layer evaluation/i);
  });
});

describe("A10 sealed-label isolation", () => {
  it("sandbox blocks the candidate from reading sealed suites; candidate is quarantined", async () => {
    const user = await authedUser(env, "a10-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);
    const candId = await createCandidate(goalId, MALICIOUS, "label stealer");
    const cand = (await env.app.services.db.query("SELECT digest FROM candidates WHERE id=$1", [candId])).rows[0];

    const result = await env.app.services.evalBroker.runEvaluation({
      candidateId: candId, candidateArtifactDigest: cand.digest, goalId,
      taskpackId: "algorithm-search.bin-packing", layer: "selection",
      contractVersion: "bin-packing/v1", budgetUsd: 0,
    });

    const failed = result.hard_constraints.filter((c) => !c.passed);
    expect(failed.length).toBeGreaterThan(0);
    expect(result.verdict).toBe("REJECTED");
    // the whole reason chain carries no sealed content
    const { readFileSync, existsSync } = await import("node:fs");
    const sealedPath = path.join(env.dataDir, "sealed", "algorithm-search.bin-packing", "release-suite.json");
    expect(existsSync(sealedPath)).toBe(true); // sealed suite exists for the evaluator...
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    // ...but no label content leaked into the evaluation result. Structural
    // canaries only: a bare 2-digit item size used to collide with runtime_ms
    // decimals (0.369 contains "69") and flake the test — a real leak would
    // surface as the contiguous items array or as release-archive seeds.
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(JSON.stringify(sealed.problems[0].items));
    for (const p of sealed.problems.slice(0, 3) as { seed: number }[]) {
      expect(resultStr).not.toContain(`"seed":${p.seed}`);
    }

    // EvolutionService marks such candidates REJECTED -> never eligible for promotion
    await env.app.services.evolution.evaluateCandidate({
      goalId, candidateId: candId, taskpackId: "algorithm-search.bin-packing",
      contractVersion: "bin-packing/v1",
    }).then(async (r) => {
      // dev layer already rejects (sandbox violation is a hard constraint)
      expect(r.verdict).toBe("REJECTED");
    });
    const st = await env.app.services.db.query("SELECT status FROM candidates WHERE id=$1", [candId]);
    expect(st.rows[0].status).toBe("REJECTED");
  }, 240_000);
});

describe("A12 insufficient evidence is not refutation", () => {
  it("a baseline-identical candidate lands INCONCLUSIVE with an honest label", async () => {
    const user = await authedUser(env, "a12-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);
    const ffd = `def pack(items, capacity=100):
    bins = []
    for size in sorted(items, reverse=True):
        placed = False
        for b in bins:
            if sum(b) + size <= capacity:
                b.append(size)
                placed = True
                break
        if not placed:
            bins.append([size])
    return bins
`;
    const candId = await createCandidate(goalId, ffd, "same as baseline");
    const cand = (await env.app.services.db.query("SELECT digest FROM candidates WHERE id=$1", [candId])).rows[0];

    const res = await env.app.services.evolution.evaluateCandidate({
      goalId, candidateId: candId, taskpackId: "algorithm-search.bin-packing",
      contractVersion: "bin-packing/v1",
    });
    expect(res.verdict).toBe("INCONCLUSIVE");
    expect(res.final?.layer).toBe("selection");
    expect(res.final?.reason).toMatch(/insufficient|证据不足|below pre-registered/i);
    const st = await env.app.services.db.query("SELECT status FROM candidates WHERE id=$1", [candId]);
    expect(st.rows[0].status).toBe("INCONCLUSIVE"); // preserved, not deleted, not promoted
    void cand;
  }, 240_000);
});

describe("A16 model change creates a new frozen RunSpec", () => {
  it("old attempt keeps its locked spec digest; new claim gets the new model", async () => {
    const user = await authedUser(env, "env-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId,
      [{ key: "t1" }, { key: "t2" }]);
    await f.cancelOtherReadyTasks(goalId);

    const claim1 = await user.post("/v1/worker/claim", { worker_id: "w-env-1" });
    const spec1 = claim1.json().spec;
    await user.post(`/v1/attempts/${claim1.json().attempt.id}/commit`, {
      worker_id: "w-env-1", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: claim1.json().attempt.id, outcome: "SUCCEEDED", summary: "done under model v1",
      artifacts: [], usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });

    // "upgrade" the model
    const oldModel = env.app.config.deepseek.chatModel;
    env.app.config.deepseek.chatModel = "deepseek-chat-2027";
    try {
      const claim2 = await user.post("/v1/worker/claim", { worker_id: "w-env-2" });
      const spec2 = claim2.json().spec;
      expect(spec2.model.model).toBe("deepseek-chat-2027");
      expect(spec2.model.model).not.toBe(spec1.model.model);
      // spec digests differ; the old attempt's frozen spec is still queryable
      expect(spec2.spec_version).toBe(spec1.spec_version);
      const old = await env.app.services.db.query(
        "SELECT spec FROM attempt_specs WHERE attempt_id=$1", [claim1.json().attempt.id],
      );
      expect(old.rows[0].spec.model.model).toBe(oldModel);
      expect(old.rows[0].spec.model.model).toBe("deepseek-chat"); // locked env traceable
    } finally {
      env.app.config.deepseek.chatModel = oldModel;
    }
  });
});
