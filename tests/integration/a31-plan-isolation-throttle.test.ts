// A31 (P22): plan isolation + non-blocking runner + planner throttle.
//   - /v1/plans/:id/run|analyze were reachable by id alone (IDOR): ownership
//     now resolves through hypothesis -> goal, 404 for non-owners
//   - the runner child is async: spawnSync used to freeze the whole control
//     process for up to 120s (heartbeats/SSE/orchestrator all stalled)
//   - a session's FIRST message dispatches a real planning LLM call; per-user
//     throttle caps the metered dispatch rate (5 / 10 min)
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
  // provision the real deterministic research runner into the test data dir
  const src = path.resolve("taskpacks", "computational-research");
  const dst = path.join(env.dataDir, "taskpacks", "computational-research");
  mkdirSync(dst, { recursive: true });
  for (const f of ["experiment.py", "taskpack.json"]) copyFileSync(path.join(src, f), path.join(dst, f));
});
afterAll(async () => { await env.close(); });

async function fixturePlan(ownerName: string): Promise<{ user: Awaited<ReturnType<typeof authedUser>>; planId: string; pending: number }> {
  const user = await authedUser(env, ownerName);
  const me = (await user.get("/v1/me")).json();
  const f = fixture(env);
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const goalId = `goal_${randomBytes(4).toString("hex")}`;
  await env.app.services.db.query(
    `INSERT INTO goals (id, project_id, session_id, owner_id, title, state, current_version, budget_cap_usd, priority)
     VALUES ($1,$2,$3,$4,'fixture research','ACTIVE',1,'5',5)`,
    [goalId, projectId, sessionId, me.user.id],
  );
  const hypId = `hyp_${randomBytes(4).toString("hex")}`;
  await env.app.services.db.query(
    `INSERT INTO hypotheses (id, goal_id, statement, stage, state) VALUES ($1,$2,'seed vs runtime','S2','TESTABLE')`,
    [hypId, goalId],
  );
  const planId = `exp_${randomBytes(4).toString("hex")}`;
  const seeds = [11, 22, 33];
  await env.app.services.db.query(
    `INSERT INTO experiment_plans (id, hypothesis_id, protocol, analysis_plan, control_group, repetitions, seeds, status)
     VALUES ($1,$2,$3,$4,$5,1,$6,'FROZEN')`,
    [planId, hypId,
      JSON.stringify({ runner_ref: "taskpacks/computational-research/experiment.py",
        arms: [{ name: "treatment", params: { k: 1 } }, { name: "control", params: { k: 2 } }] }),
      JSON.stringify({ metric: "runtime_ms", minEffect: 0, alpha: 0.05, minRepetitions: 1 }),
      JSON.stringify({ name: "control", params: { k: 2 } }), JSON.stringify(seeds)],
  );
  for (const arm of ["treatment", "control"]) {
    for (const seed of seeds) {
      await env.app.services.db.query(
        `INSERT INTO experiment_runs (id, plan_id, arm, seed, params, status)
         VALUES ($1,$2,$3,$4,'{}','PENDING')`,
        [`run_${randomBytes(4).toString("hex")}`, planId, arm, seed],
      );
    }
  }
  return { user, planId, pending: seeds.length * 2 };
}

describe("A31 plan isolation and runner", () => {
  it("a non-owner gets 404 on run and analyze; the owner can run the frozen protocol", async () => {
    const { user: owner, planId, pending } = await fixturePlan(`a31-owner-${randomBytes(3).toString("hex")}`);
    const attacker = await authedUser(env, `a31-attacker-${randomBytes(3).toString("hex")}`);

    const peek = await attacker.post(`/v1/plans/${planId}/run`, {});
    expect(peek.statusCode).toBe(404);
    const peekAnalyze = await attacker.post(`/v1/plans/${planId}/analyze`, {});
    expect(peekAnalyze.statusCode).toBe(404);

    // owner executes the real deterministic runner (6 pending runs)
    const res = await owner.post(`/v1/plans/${planId}/run`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().executed).toBe(pending);
    expect(res.json().done_total).toBe(pending);

    // re-run: nothing pending -> 409
    const again = await owner.post(`/v1/plans/${planId}/run`, {});
    expect(again.statusCode).toBe(409);

    // analyze works for the owner
    const analysis = await owner.post(`/v1/plans/${planId}/analyze`, {});
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().verdict).toBeTruthy();
  });
});

describe("A31 planner throttle", () => {
  it("the 6th planning dispatch within the window is refused with 429", async () => {
    const user = await authedUser(env, `a31-planner-${randomBytes(3).toString("hex")}`);
    const me = (await user.get("/v1/me")).json();
    const f = fixture(env);
    const first = await f.createProjectSession(me.user.id);
    const projectId = first.projectId;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ses = await user.post("/v1/sessions", { project_id: projectId, title: `throttle-${i}` });
      const res = await user.post(`/v1/sessions/${ses.json().id}/messages`, { content: `规划目标 ${i}: 计算 1..${i + 10} 的和` });
      statuses.push(res.statusCode);
    }
    // each first message dispatches planning; slot 6 must be refused
    expect(statuses.slice(0, 5).every((c) => c !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
