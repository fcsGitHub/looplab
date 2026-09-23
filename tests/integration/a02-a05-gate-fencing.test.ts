// A02: 模型提出未获授权的工具调用 → 执行前拒绝，有拒绝事件；无实际副作用。
// A05: 两个 Worker 抢同一任务，旧 Worker 迟到 → 只有当前 fencing token 可推进状态。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 500 });
});
afterAll(async () => { await env.close(); });

describe("A02 policy gate blocks unauthorized tools", () => {
  it("denies a tool not in the allowed set, records a denial event, no side effects", async () => {
    const user = await authedUser(env);
    const me = await user.get("/v1/me");
    const userId = me.json().user.id;
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(userId);
    const { goalId } = await f.createGoalWithTasks(userId, projectId, sessionId, [{ key: "t1" }]);

    const claim = await user.post("/v1/worker/claim", { worker_id: "evil-01" });
    expect(claim.statusCode).toBe(200);
    const attemptId = claim.json().attempt.id;
    await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: "evil-01", lease_epoch: 1 });

    // request a tool that is NOT in the RunSpec allowlist
    const denied = await user.post(`/v1/attempts/${attemptId}/tools/authorize`, {
      worker_id: "evil-01", lease_epoch: 1,
      tool: "network_fetch", args: { url: "https://evil.example.com" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().allowed).toBe(false);
    expect(denied.json().reason).toContain("not in the authorized tool set");

    // an allowed tool but with a path escaping the sandbox is also denied
    const escape = await user.post(`/v1/attempts/${attemptId}/tools/authorize`, {
      worker_id: "evil-01", lease_epoch: 1,
      tool: "workspace_write", args: { path: "../../../pwned.txt", content: "x" },
    });
    expect(escape.json().allowed).toBe(false);
    expect(escape.json().reason).toContain("escapes sandbox");

    // denial events exist; nothing was executed
    const evs = await user.get(`/v1/attempts/${attemptId}/events`);
    const types = evs.json().events.map((e: any) => e.event_type);
    expect(types).toContain("tool.call_denied");
    // no side effect: repo root and data dir have no pwned.txt
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${env.dataDir}/pwned.txt`)).toBe(false);
  });
});

describe("A05 lease fencing", () => {
  it("rejects the stale worker's commit and heartbeat after preemption", async () => {
    const user = await authedUser(env, "tester2");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [{ key: "t1" }]);

    // worker A claims; task becomes RUNNING with epoch 1
    const claimA = await user.post("/v1/worker/claim", { worker_id: "worker-a" });
    expect(claimA.statusCode).toBe(200);
    const attemptId = claimA.json().attempt.id;
    await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: "worker-a", lease_epoch: 1 });

    // lease expires; supervisor bumps the epoch (fencing token), reschedules
    await fixture(env).expireLease(attemptId);
    const rec = await env.app.services.scheduler.reconcileExpiredLeases();
    expect(rec.lost).toBeGreaterThanOrEqual(1);

    // worker B claims the same task -> new attempt with epoch 1 (fresh attempt)
    const claimB = await user.post("/v1/worker/claim", { worker_id: "worker-b" });
    expect(claimB.statusCode).toBe(200);
    const attemptB = claimB.json().attempt.id;
    expect(attemptB).not.toBe(attemptId);
    await user.post(`/v1/attempts/${attemptB}/start`, { worker_id: "worker-b", lease_epoch: 1 });
    await user.post(`/v1/attempts/${attemptB}/checkpoint`, { worker_id: "worker-b", lease_epoch: 1, step_index: 1, summary: "progress", state: {}, progress_kind: "tool_progress" });

    // late worker A: heartbeat says abort (fencing mismatch), commit is rejected+quarantined
    const hbA = await user.post(`/v1/attempts/${attemptId}/heartbeat`, { worker_id: "worker-a", lease_epoch: 1 });
    expect(hbA.json().action).toBe("abort");

    const lateCommit = await user.post(`/v1/attempts/${attemptId}/commit`, {
      worker_id: "worker-a", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptId, outcome: "SUCCEEDED", summary: "late result",
      artifacts: [], usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });
    expect(lateCommit.statusCode).toBe(409);
    expect(lateCommit.json().quarantined).toBe(true);

    // late commit did NOT advance B's task state
    const tasks = await user.get(`/v1/goals/${goalId}/tasks`);
    const t1 = tasks.json().tasks.find((t: any) => t.node_key === "t1");
    expect(t1.state).toBe("RUNNING"); // B still holds it

    // B commits with the CURRENT epoch -> succeeds exactly once
    const okCommit = await user.post(`/v1/attempts/${attemptB}/commit`, {
      worker_id: "worker-b", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptB, outcome: "SUCCEEDED", summary: "B result",
      artifacts: [], usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });
    expect(okCommit.statusCode).toBe(200);

    // double commit with same epoch is rejected (already COMMITTED)
    const dup = await user.post(`/v1/attempts/${attemptB}/commit`, {
      worker_id: "worker-b", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptB, outcome: "SUCCEEDED", summary: "dup",
      artifacts: [], usage: { model_calls: 0, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });
    expect(dup.statusCode).toBe(409);
  });
});
