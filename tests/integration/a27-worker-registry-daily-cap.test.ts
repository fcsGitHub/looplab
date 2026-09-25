// A27 (P18 observability features).
//   - worker registry: claim() upserts a workers row, heartbeats refresh it,
//     GET /v1/workers derives liveness from last_seen_at vs the lease TTL
//   - daily model-spend fuse: DAILY_BUDGET_USD>0 makes the LLM gateway refuse
//     any call once the rolling day's reserved+settled+unknown reaches the
//     cap — checked BEFORE any network/billing happens
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";
import { LlmGateway } from "../../apps/control/src/llmgateway.js";
import { BudgetExceededError } from "../../apps/control/src/budget.js";

let env: TestEnv;
let capped: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
  capped = await createTestEnv({ dailyBudgetUsd: 0.0005 });
});
afterAll(async () => { await env.close(); await capped.close(); });

describe("A27 worker registry", () => {
  it("claim registers the worker and heartbeat refreshes liveness", async () => {
    const f = fixture(env);
    const user = await authedUser(env, "a27-registry");
    const me = (await user.get("/v1/me")).json();
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);
    await fixture(env).cancelOtherReadyTasks(goalId);

    const workerId = `a27-worker-${randomBytes(3).toString("hex")}`;
    const job = await env.app.services.scheduler.claim(workerId);
    expect(job).not.toBeNull();

    const list = (await user.get("/v1/workers")).json();
    expect(Array.isArray(list.workers)).toBe(true);
    const row = list.workers.find((w: any) => w.id === workerId);
    expect(row).toBeDefined();
    expect(Number(row.claims_total)).toBe(1);
    expect(row.alive).toBe(true);

    // heartbeat bumps counters and pins last_attempt
    await env.app.services.scheduler.heartbeat(job!.attempt.id, workerId, job!.attempt.lease_epoch);
    const after = (await user.get("/v1/workers")).json();
    const row2 = after.workers.find((w: any) => w.id === workerId);
    expect(Number(row2.heartbeats_total)).toBe(1);
    expect(row2.last_attempt_id).toBe(job!.attempt.id);
    expect(row2.last_task_title).toBeTruthy();

    // unauthorized: metrics-style anonymous read stays protected here too
    const anon = await env.inject({ method: "GET", url: "/v1/workers" });
    expect(anon.statusCode).toBe(401);
  });
});

describe("A27 daily spend fuse", () => {
  it("refuses gateway calls once the rolling day reaches the cap — before any network call", async () => {
    const gw = new LlmGateway(capped.app.services.db, capped.app.config);
    // no reservations yet: a tiny worst-case passes the fuse (would then hit
    // the network — not allowed in tests, so assert only the refusal path)
    const seedGoal = `goal_${randomBytes(4).toString("hex")}`;
    // goal row must exist for FK on budget reservation insert; the fuse fires
    // before any insert, so a non-existent goal is fine for the refusal case
    await expect(gw.call({
      goalId: seedGoal, scope: "evolution_search", kind: "fuse-test",
      messages: [{ role: "user", content: "x".repeat(400) }], // worst-case > cap 0.0005
      idempotencyKey: `fuse-${randomBytes(4).toString("hex")}`,
      actor: { kind: "system", id: "a27" },
    })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("reports the fuse in /v1/metrics (last_24h_usd + daily_cap_usd)", async () => {
    const user = await authedUser(capped, "a27-metrics");
    const m = (await user.get("/v1/metrics")).json();
    expect(m.model.daily_cap_usd).toBe(0.0005);
    expect(typeof m.model.last_24h_usd).toBe("number");
    // control env has no cap configured
    const u2 = await authedUser(env, "a27-metrics-ctrl");
    const m2 = (await u2.get("/v1/metrics")).json();
    expect(m2.model.daily_cap_usd).toBeNull();
  });
});
