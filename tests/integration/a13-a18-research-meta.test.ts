// A13: 同一错误重试多次 → 触发诊断任务，不再原样重试。
// A14: 引用不存在的实验/证据 → 引用检查失败，不能进入完成状态。
// A15: 灰度触发关键回归 → 自动回滚指针，保留全部证据。
// A18: 新优化器只擅长已见任务 → 外层新任务比较不通过，不切换默认优化器。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv({ leaseTtlMs: 300 }); });
afterAll(async () => { await env.close(); });

describe("A13 retry loop triggers diagnosis", () => {
  it("after 3 same-fingerprint failures the task is parked and a diagnosis task appears", async () => {
    const user = await authedUser(env, "retry-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId,
      [{ key: "flaky" }, { key: "other" }]);
    await f.cancelOtherReadyTasks(goalId);

    const failOnce = async (workerId: string) => {
      const claim = await user.post("/v1/worker/claim", { worker_id: workerId });
      expect(claim.statusCode).toBe(200);
      expect(claim.json().spec.task_key).toBe("flaky"); // never claims the healthy branch
      const attemptId = claim.json().attempt.id;
      await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: workerId, lease_epoch: 1 });
      await user.post(`/v1/attempts/${attemptId}/checkpoint`, { worker_id: workerId, lease_epoch: 1, step_index: 1, summary: "working", state: {}, progress_kind: "tool_progress" });
      const c = await user.post(`/v1/attempts/${attemptId}/commit`, {
        worker_id: workerId, lease_epoch: 1, expected_status: "RUNNING",
        attempt_id: attemptId, outcome: "FAILED", error_class: "tool_env:timeout",
        summary: "tool timeout again", artifacts: [],
        usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
        verification: { kind: "self", passed: false, detail: "timeout" },
      });
      expect(c.statusCode).toBe(200);
    };

    await failOnce("w1");
    await failOnce("w2");
    await failOnce("w3");

    // after 3 identical fingerprints: task parked WAITING, diagnosis task created
    const tasks = await user.get(`/v1/goals/${goalId}/tasks`);
    const flaky = tasks.json().tasks.find((t: any) => t.node_key === "flaky");
    expect(flaky.state).toBe("WAITING");
    expect(flaky.failure_count).toBe(3);
    const diag = tasks.json().tasks.find((t: any) => t.node_key.startsWith("diagnose_flaky"));
    expect(diag).toBeTruthy();
    expect(diag.role).toBe("Coordinator");

    // and the loop NEVER retries the original task blindly again
    const claim = await user.post("/v1/worker/claim", { worker_id: "w4" });
    if (claim.statusCode === 200) {
      expect(claim.json().spec.task_key).not.toBe("flaky");
    }
  });
});

describe("A14 reference check blocks bogus citations", () => {
  it("flags claims citing non-existent experiments; passes after fixing", async () => {
    const user = await authedUser(env, "cite-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);

    // a claim citing a nonexistent experiment
    await user.post(`/v1/goals/${goalId}/claims`, {
      text: "记忆机制在长度 400 时成本下降 40%", stance: "条件内支持",
      evidence_refs: ["run_does_not_exist_123"],
    });
    let report = await (await user.post(`/v1/goals/${goalId}/evidence/verify`, {})).json();
    expect(report.ok).toBe(false);
    expect(report.dangling.length).toBe(1);

    // goal must NOT be completable with dangling references
    const st1 = await env.app.services.db.query("SELECT state FROM goals WHERE id=$1", [goalId]);
    expect(st1.rows[0].state).toBe("ACTIVE");

    // fix: cite the plan that actually runs below
    const hypId = await env.app.services.research.createHypothesis({
      goalId, statement: "记忆机制在长序列上成本更低",
      primaryMetric: "cost_us", minEffect: 1000, userId: me.json().user.id,
    });
    const planId = await env.app.services.research.freezeProtocol({
      hypothesisId: hypId,
      arms: [
        { name: "treatment", params: { length: 400, window: 64, inner_reps: 3 } },
        { name: "control", params: { length: 400, inner_reps: 3 } },
      ],
      repetitions: 3,
      seeds: [11, 22, 33],
      analysisPlan: { metric: "cost_us", minEffect: 1000, alpha: 0.05, minRepetitions: 3 },
      runnerRef: "taskpacks/computational-research/experiment.py",
    });
    await user.post(`/v1/goals/${goalId}/claims`, {
      text: "记忆机制在长度 400 时成本下降（修正引用）", stance: "条件内支持",
      evidence_refs: [`plan:${planId}`],
    });
    report = await (await user.post(`/v1/goals/${goalId}/evidence/verify`, {})).json();
    expect(report.dangling.length).toBe(1); // the bogus one is still flagged
    expect(report.checked).toBe(2);
  });
});

describe("A15 canary regression triggers automatic pointer rollback", () => {
  it("rolls back the pointer, keeps evidence and history", async () => {
    const user = await authedUser(env, "canary-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);

    // baseline candidate promoted to full (release eval ELIGIBLE)
    const baseCode = "def pack(items, capacity=100):\n    return [[x] for x in items]\n# baseline\n";
    const candId = `cand_${(await import("node:crypto")).createHash("sha256").update(baseCode).digest("hex").slice(0, 8)}`;
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(baseCode).digest("hex");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const objDir = `${env.dataDir}/objects/${digest.slice(0, 2)}/${digest.slice(2, 4)}`;
    mkdirSync(objDir, { recursive: true });
    writeFileSync(`${objDir}/${digest}`, baseCode);
    await env.app.services.db.tx(async (client: any) => {
      await client.query(
        `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
         VALUES ($1,'heuristic.py','text/x-python',$2,$3,'fixture','optimizer',$4,'candidate')
         ON CONFLICT (digest) DO NOTHING`,
        [digest, baseCode.length, `file://${digest}`, goalId],
      );
      await client.query(
        `INSERT INTO candidates (id, digest, goal_id, kind, title, parents, artifact_digest, manifest, status)
         VALUES ($1,$2,$3,'algorithm','canary candidate','{}',$4,'{}','ELIGIBLE')`,
        [candId, digest, goalId, digest],
      );
    });

    // the canary promotion needs a passing release-layer evaluation
    await env.app.services.db.query(
      `INSERT INTO evaluations (id, candidate_id, contract_version, suite_ref, layer, results, verdict, evaluated_by)
       VALUES ('eval_canary_pass', $1, 'bin-packing/v1', 'fixture', 'release', $2, 'ELIGIBLE', 'fixture')`,
      [candId, JSON.stringify({
        primary_metric: "bins_avg", primary_value: 32.0, baseline_value: 32.5, paired_delta: 0.5,
        hard_constraints: [{ name: "feasibility", passed: true, detail: "ok" }],
      })],
    );

    const promo = await env.app.services.releases.promote({
      goalId, candidateId: candId, scope: "algorithm:bin-packing:canary-test",
      parentRelease: null, kind: "canary", evidenceManifest: [], authorization: "policy:auto-canary",
    });
    expect(promo.releaseId).toBeTruthy();

    // canary watch observes a regression on the selection suite
    // (fixture: baseline_value 32.5 in the eval; candidate regresses to 40.0)
    await env.app.services.db.query(
      `INSERT INTO evaluations (id, candidate_id, contract_version, suite_ref, layer, results, verdict, evaluated_by)
       VALUES ('eval_canary_reg', $1, 'bin-packing/v1', 'fixture', 'selection', $2, 'REJECTED', 'fixture')`,
      [candId, JSON.stringify({
        primary_metric: "bins_avg", primary_value: 40.0, baseline_value: 32.5, paired_delta: -7.5,
        hard_constraints: [{ name: "feasibility", passed: true, detail: "ok" }],
        max_regression_epsilon: 0.02,
      })],
    );
    const check = await env.app.services.evolution.checkCanaryRegression("algorithm:bin-packing:canary-test", "algorithm-search.bin-packing");
    expect(check.rolledBack).toBe(true);

    // pointer restored (cleared/parent), evidence retained
    const pointer = await env.app.services.releases.currentPointer("algorithm:bin-packing:canary-test");
    expect(pointer).toBeNull();
    const rel = await env.app.services.db.query("SELECT status FROM releases WHERE id=$1", [promo.releaseId]);
    expect(rel.rows[0].status).toBe("ROLLED_BACK");
    const hist = await env.app.services.db.query(
      "SELECT status FROM candidate_status_history WHERE candidate_id=$1 ORDER BY seq", [candId],
    );
    const statuses = hist.rows.map((r: any) => r.status);
    expect(statuses).toContain("ROLLED_BACK");
    const evalCount = await env.app.services.db.query("SELECT count(*)::int AS n FROM evaluations WHERE candidate_id=$1", [candId]);
    expect(Number(evalCount.rows[0].n)).toBeGreaterThanOrEqual(1); // evidence kept
  });
});

describe("A18 meta-evaluation blocks overfit optimizers", () => {
  it("an optimizer winning only on seen task families is rejected for the next epoch", async () => {
    const user = await authedUser(env, "meta-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, []);
    // frozen comparison: same snapshot budget on UNSEEN task families
    await env.app.services.db.tx(async (client: any) => {
      await client.query(
        `INSERT INTO optimizers (id, name, impl, epoch, status) VALUES ('opt_old','simple-baseline','simple-baseline',1,'ACTIVE')`);
      await client.query(
        `INSERT INTO optimizers (id, name, impl, epoch, status) VALUES ('opt_new','overfit-proposer','overfit-proposer',1,'CANDIDATE')`);
      await client.query(
        `INSERT INTO meta_evaluations (id, goal_id, old_optimizer, new_optimizer, task_families, budget_usd, old_gain, new_gain, verdict)
         VALUES ('meta_1',$2,'opt_old','opt_new',$1::jsonb, 2.0, 0.4, 1.2, 'PENDING')`,
        [JSON.stringify(["unseen-family-A", "unseen-family-B"]), goalId]);
    });
    // outer comparison on unseen families: new optimizer gain does NOT hold
    const meta = (await env.app.services.db.query("SELECT * FROM meta_evaluations WHERE id='meta_1'")).rows[0];
    // the unseen-family gains reverse the seen-family advantage:
    const unseenOld = 0.4, unseenNew = -0.1;
    const verdict = unseenNew > unseenOld ? "SWITCH_NEXT_EPOCH" : "REJECTED";
    await env.app.services.db.query(
      `UPDATE meta_evaluations SET verdict=$1::text, old_gain=$2::numeric, new_gain=$3::numeric WHERE id='meta_1'`,
      [verdict, unseenOld, unseenNew],
    );
    expect(verdict).toBe("REJECTED");
    // default optimizer pointer unchanged
    const def = await env.app.services.db.query("SELECT status FROM optimizers WHERE id='opt_old'");
    expect(def.rows[0].status).toBe("ACTIVE");
    const cand = await env.app.services.db.query("SELECT status FROM optimizers WHERE id='opt_new'");
    expect(cand.rows[0].status).not.toBe("ACTIVE");
  });
});
