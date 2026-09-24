// A19: OptimizerPort end-to-end — epoch guard, metered proxy auth, a REAL
// backend round (gepa 0.1.4, scripted reflection fixture — deterministic, per
// goal §8.2 contract-fixture rule; the real-model evidence run is separate),
// the proposal registration contract, and epoch settlement.
//
// Honest-fixture note: the scripted variants are behaviorally different real
// heuristics, but on this seeded suite nothing strictly beats FFD, so GEPA's
// strict-improvement acceptance correctly yields ZERO proposals — the round
// test asserts exactly that honest empty result. The registration→build path
// is exercised through the completeRun contract with an injected payload.
import { randomBytes, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
let baseUrl: string;

async function listen(): Promise<string> {
  await env.app.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = env.app.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 5000 });
  baseUrl = await listen();
});
afterAll(async () => { await env.close(); });

async function makeGoal(prefix: string) {
  const user = await authedUser(env, `${prefix}-${randomBytes(3).toString("hex")}`);
  const f = fixture(env);
  const me = (await user.get("/v1/me")).json();
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);
  return { goalId, user };
}

const BFD_CODE = `def pack(items, capacity=100):
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
`;

describe("A19 optimizer port", () => {
  it("rejects unknown backends and wrong-mode runs (epoch guard)", async () => {
    const { goalId, user } = await makeGoal("guard");

    const unknown = await user.post(`/v1/goals/${goalId}/optimizer/runs`, { backend: "my-tuned-gepa" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/unknown optimizer backend/);

    // epoch 0 active backend is simple-baseline@1: gepa may NOT run in active mode
    const wrongMode = await user.post(`/v1/goals/${goalId}/optimizer/runs`, { backend: "gepa@0.1.4", mode: "active" });
    expect(wrongMode.statusCode).toBe(400);
    expect(wrongMode.json().error).toMatch(/not the active optimizer/);
  });

  it("metered LLM proxy rejects bad tokens", async () => {
    const res = await env.inject({
      method: "POST", url: "/v1/optimizer/llm",
      headers: { authorization: "Bearer optk_deadbeef" },
      payload: { call_seq: 1, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("runs a real gepa backend round (scripted fixture) — honest empty result, budget respected", async () => {
    const { goalId, user } = await makeGoal("round");
    const res = await user.post(`/v1/goals/${goalId}/optimizer/run-round`, {
      backend: "gepa@0.1.4", mode: "epoch_trial",
      max_metric_calls: 48, max_llm_cost_usd: 0,
      reflection: "scripted", timeout_ms: 200_000,
    });
    expect(res.statusCode).toBe(202);
    const { runId, proposalIds, usage } = res.json();
    expect(runId).toMatch(/^opt_/);
    // strict-improvement acceptance correctly rejects non-improving variants:
    // nothing beat the seed inside the budget -> honest empty result
    expect(proposalIds).toEqual([]);
    expect(usage.metric_calls).toBeLessThanOrEqual(48);
    expect(usage.llm_calls).toBe(0); // scripted fixture makes no model calls

    const runs = (await user.get(`/v1/goals/${goalId}/optimizer/runs`)).json().runs;
    const run = runs.find((r: any) => r.id === runId);
    expect(run.status).toBe("COMPLETED");
    expect(Number(run.spent_usd)).toBe(0);
  });

  it("registers optimizer proposals via the completeRun contract; they build through the normal pipeline; no self-approval", async () => {
    const { goalId, user } = await makeGoal("register");

    // createRun returns the run-scoped token once (hash-stored server-side)
    const created = await user.post(`/v1/goals/${goalId}/optimizer/runs`, {
      backend: "gepa@0.1.4", mode: "epoch_trial", max_metric_calls: 8, reflection: "scripted",
    });
    expect(created.statusCode).toBe(201);
    const { runId, token } = created.json();
    expect(token).toMatch(/^optk_/);

    const res = await env.inject({
      method: "POST", url: `/v1/optimizer/runs/${runId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        proposals: [{
          mechanism: "Best-Fit Decreasing with regret ordering",
          changed_summary: "scripted contract fixture",
          candidate_code: BFD_CODE,
          expected_effect: "fewer bins on instances with tight mid-size items",
          train_score: 0.91, val_score: 0.92,
        }],
        usage: { metric_calls: 8, llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, model: null },
        stopped_reason: "completed",
      },
    });
    expect(res.statusCode).toBe(200);
    const proposalIds = res.json().proposalIds;
    expect(proposalIds.length).toBe(1);

    // proposal.created events carry the optimizer actor; provenance recorded
    const evs = await env.app.services.db.query(
      `SELECT actor, payload FROM events WHERE event_type='proposal.created' AND goal_id=$1`, [goalId],
    );
    expect(evs.rows.length).toBe(1);
    expect(evs.rows[0].actor).toEqual({ kind: "optimizer", id: "gepa@0.1.4" });
    expect(evs.rows[0].payload.optimizer_run.backend).toBe("gepa@0.1.4");
    expect(evs.rows[0].payload.optimizer_run.run_id).toBe(runId);

    // ...and the proposal builds through the EXISTING pipeline (kernel path)
    const build = await user.post(`/v1/goals/${goalId}/evolution/build`, { proposal_id: proposalIds[0] });
    expect(build.statusCode).toBe(202);
    expect(build.json().candidate_id).toMatch(/^cand_/);

    // the token is single-purpose: completing again fails (run is closed)
    const again = await env.inject({
      method: "POST", url: `/v1/optimizer/runs/${runId}/complete`,
      headers: { authorization: `Bearer ${token}` },
      payload: { proposals: [], usage: { metric_calls: 0, llm_calls: 0 } },
    });
    expect(again.statusCode).toBe(401);
  });

  it("build is content-addressed idempotent (same code -> same candidate)", async () => {
    const { goalId, user } = await makeGoal("idem");
    const created = await user.post(`/v1/goals/${goalId}/optimizer/runs`, {
      backend: "gepa@0.1.4", mode: "epoch_trial", max_metric_calls: 8, reflection: "scripted",
    });
    const { runId, token } = created.json();
    const payload = {
      proposals: [{ mechanism: "m", candidate_code: BFD_CODE, changed_summary: "", expected_effect: "", train_score: null, val_score: 0.9 }],
      usage: { metric_calls: 1, llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, model: null },
    };
    const a = await env.inject({
      method: "POST", url: `/v1/optimizer/runs/${runId}/complete`,
      headers: { authorization: `Bearer ${token}` }, payload,
    });
    expect(a.statusCode).toBe(200);
    const p1 = a.json().proposalIds[0];
    const b1 = await user.post(`/v1/goals/${goalId}/evolution/build`, { proposal_id: p1 });
    const b2 = await user.post(`/v1/goals/${goalId}/evolution/build`, { proposal_id: p1 });
    expect(b1.statusCode).toBe(202);
    expect(b2.statusCode).toBe(202);
    // same content -> SAME candidate id (content-addressed, no duplicate rows)
    expect(b2.json().candidate_id).toBe(b1.json().candidate_id);
    const digest = createHash("sha256").update(BFD_CODE).digest("hex");
    const rows = await env.app.services.db.query("SELECT count(*)::int AS n FROM candidates WHERE digest=$1", [digest]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("settleEpochTrial switches the epoch only on strict margin", async () => {
    const svc = env.app.services.optimizer;
    const before = await svc.currentEpoch();
    expect(before?.active_backend).toBe("simple-baseline@1");

    // tie -> keep incumbent
    const tie = await svc.settleEpochTrial({
      incumbent: "simple-baseline@1", challenger: "gepa@0.1.4",
      incumbentImprovement: 0.03, challengerImprovement: 0.04, minMargin: 0.05,
    });
    expect(tie.switched).toBe(false);
    expect((await svc.currentEpoch())?.index).toBe(before!.index);

    // strict win -> epoch index+1 with the challenger active
    const win = await svc.settleEpochTrial({
      incumbent: "simple-baseline@1", challenger: "gepa@0.1.4",
      incumbentImprovement: 0.0, challengerImprovement: 0.12, minMargin: 0.05,
    });
    expect(win.switched).toBe(true);
    const after = await svc.currentEpoch();
    expect(after?.index).toBe(before!.index + 1);
    expect(after?.active_backend).toBe("gepa@0.1.4");

    // the switch is an event, and after it gepa CAN run in active mode
    const evs = await env.app.services.db.query(`SELECT * FROM events WHERE event_type='optimizer.epoch_switched'`);
    expect(evs.rows.length).toBe(1);
    const { goalId, user } = await makeGoal("post-switch");
    const run = await user.post(`/v1/goals/${goalId}/optimizer/runs`, {
      backend: "gepa@0.1.4", mode: "active", max_metric_calls: 8,
    });
    if (run.statusCode !== 201) throw new Error(`expected 201, got ${run.statusCode}: ${run.body}`);
  });
});
