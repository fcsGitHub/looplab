// A06: 一项长实验运行时暂停目标 → 新任务停止派发，当前动作按策略排空。
// A08: 预算有未结算模型调用且接近耗尽 → 不把未知费用归零；禁止越限新调用。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 5000 });
});
afterAll(async () => { await env.close(); });

describe("A06 pause stops dispatch and drains running work", () => {
  it("pauses: no new claims; heartbeat says drain; running attempt can still commit", async () => {
    const user = await authedUser(env, "pause-flow");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [
      { key: "t1", title: "long experiment" },
      { key: "t2", title: "next task", depends_on: ["t1"] },
    ]);

    // one running attempt
    const claim = await user.post("/v1/worker/claim", { worker_id: "w-running" });
    expect(claim.statusCode).toBe(200);
    const attemptId = claim.json().attempt.id;
    await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: "w-running", lease_epoch: 1 });
    await user.post(`/v1/attempts/${attemptId}/checkpoint`, { worker_id: "w-running", lease_epoch: 1, step_index: 1, summary: "progress", state: {}, progress_kind: "tool_progress" });

    // pause accepted and applied
    const pause = await user.post(`/v1/goals/${goalId}/commands`, { kind: "pause", command_id: "a06-p" });
    expect(pause.statusCode).toBe(202);
    expect(pause.json().status).toBe("ACCEPTED");
    expect(pause.json().applied).toBe(true);

    // no NEW dispatch: the second task must not be claimable while paused
    const claim2 = await user.post("/v1/worker/claim", { worker_id: "w-new" });
    expect(claim2.statusCode).toBe(204); // nothing claimable

    // the RUNNING attempt is asked to drain (finish the bounded action)
    const st = await env.app.services.db.query("SELECT state FROM goals WHERE id=$1", [goalId]);
    console.log("GOAL STATE AFTER PAUSE:", st.rows[0]);
    const hb = await user.post(`/v1/attempts/${attemptId}/heartbeat`, { worker_id: "w-running", lease_epoch: 1 });
    console.log("HB:", hb.statusCode, hb.body.slice(0, 120));
    expect(hb.json().action).toBe("drain");
    expect(hb.json().reason).toBe("PAUSED_USER");

    // it can still commit its in-flight result (drain semantics, not kill)
    const commit = await user.post(`/v1/attempts/${attemptId}/commit`, {
      worker_id: "w-running", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptId, outcome: "SUCCEEDED", summary: "drained result",
      artifacts: [], usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });
    expect(commit.statusCode).toBe(200);

    // after drain+commit, still no new dispatch while paused
    const claim3 = await user.post("/v1/worker/claim", { worker_id: "w-new2" });
    expect(claim3.statusCode).toBe(204);

    // resume re-opens dispatch
    await user.post(`/v1/goals/${goalId}/commands`, { kind: "resume", command_id: "a06-r" });
    const claim4 = await user.post("/v1/worker/claim", { worker_id: "w-resumed" });
    expect(claim4.statusCode).toBe(200);
    expect(claim4.json().spec.goal_id).toBe(goalId);
  });
});

describe("A08 budget: unknown settlement is never zero; overspend refused", () => {
  it("reserves before model calls, keeps unknown cost, refuses over-cap claims and calls", async () => {
    const user = await authedUser(env, "budget-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    // tiny cap: one reserve exceeds it
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId,
      [{ key: "t1" }, { key: "t2" }], "ACTIVE", "0.001");

    // LLM call path: worst-case reserve (>= 0.0001) must exceed the 0.001 cap
    const claim = await user.post("/v1/worker/claim", { worker_id: "w-budget" });
    expect(claim.statusCode).toBe(200);
    const attemptId = claim.json().attempt.id;
    await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: "w-budget", lease_epoch: 1 });

    const llmRes = await user.post(`/v1/attempts/${attemptId}/llm`, {
      worker_id: "w-budget", lease_epoch: 1,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 200_000, // worst-case reserve far exceeds the 0.001 cap
    });
    expect(llmRes.statusCode).toBe(402);
    expect(llmRes.json().error).toBe("budget_exceeded");

    // unknown settlement: simulate an in-flight call dying after reservation
    // by inserting an unknown-cost reservation the way the gateway does
    const { BudgetService } = await import("../../apps/control/src/budget.js");
    const budget = new BudgetService(env.app.services.db as any);
    await env.app.services.db.tx(async (client: any) => {
      const r = await client.query(
        `INSERT INTO budget_reservations (id, goal_id, attempt_id, scope, kind, reserved_usd, idempotency_key)
         VALUES ('budget_unknown_sim', $1, $2, 'task_execution', 'model', 0.0005, 'sim-unknown-1') RETURNING id`,
        [goalId, attemptId],
      );
      await budget.markUnknown(client, r.rows[0].id);
    });
    const card = await user.get(`/v1/goals/${goalId}`);
    expect(Number(card.json().budget.unknown)).toBeGreaterThan(0); // NOT zero (A08)

    // goal cap reached -> scheduler flips ACTIVE to WAITING_RESOURCE, no claims
    const claim2 = await user.post("/v1/worker/claim", { worker_id: "w-budget2" });
    expect(claim2.statusCode).toBe(204);
    const state = await env.app.services.db.query("SELECT state, paused_reason FROM goals WHERE id=$1", [goalId]);
    expect(state.rows[0].state).toBe("WAITING_RESOURCE");
  });
});
