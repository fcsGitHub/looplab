// A35 (P25): long-run reliability.
//   - stall watchdog: an ACTIVE goal with nothing claimable, nothing live and
//     no pending approval used to sit ACTIVE forever; it must be flagged
//     (event) and parked BLOCKED_INPUT with a machine-readable reason
//   - A2A handoff: the successor's RunSpec carries the predecessor's recorded
//     RESULT summary as a structured handoff note
//   - revise cap: diagnose→approve→revise cannot loop forever — past the cap
//     the command FAILS and the goal parks for a human
//   - per-role fleet metrics on /v1/metrics
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";
import { Orchestrator } from "../../apps/control/src/orchestrator.js";

let env: TestEnv;
// dwell=0 so tests confirm stalls across consecutive ticks without real time
let watchdog: Orchestrator;

beforeAll(async () => {
  env = await createTestEnv({});
  await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "a35-root", password: "looplab" } });
  watchdog = new Orchestrator(env.app.services.db, env.app.services.scheduler, env.app.services.goals, 0);
});
afterAll(async () => { await env.close(); });

async function makeGoal(username: string, tasks: { key: string; depends_on?: string[]; role?: string }[], priority = 5) {
  const user = await authedUser(env, username);
  const me = (await user.get("/v1/me")).json();
  const f = fixture(env);
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  return { user, ...await f.createGoalWithTasks(me.user.id, projectId, sessionId, tasks, "ACTIVE", "5", priority) };
}

describe("A35 stall watchdog", () => {
  it("flags a silently parked ACTIVE goal as BLOCKED_INPUT with a goal.stalled event", async () => {
    const { goalId } = await makeGoal(`a35-stall-${randomBytes(3).toString("hex")}`, [{ key: "t1" }]);
    // park everything: t1 WAITING after 3 identical failures, diagnosis task
    // also terminal — nothing claimable, nothing live, no approval
    const db = env.app.services.db;
    await db.query(`UPDATE tasks SET state='WAITING', failure_count=3 WHERE goal_id=$1`, [goalId]);

    // tick 1: records the candidate; nothing flips yet (confirmation window)
    await watchdog.tick();
    let goal = (await db.query("SELECT state FROM goals WHERE id=$1", [goalId])).rows[0];
    expect(goal.state).toBe("ACTIVE");

    // tick 2: confirmed — flips + event
    await watchdog.tick();
    goal = (await db.query("SELECT state, paused_reason FROM goals WHERE id=$1", [goalId])).rows[0];
    expect(goal.state).toBe("BLOCKED_INPUT");
    expect(goal.paused_reason).toBe("stalled_no_progress");
    const evt = (await db.query(
      `SELECT payload FROM events WHERE goal_id=$1 AND event_type='goal.stalled'`, [goalId])).rows[0];
    expect(evt).toBeTruthy();
    expect(evt.payload.total_tasks).toBe(1);
    expect(evt.payload.waiting_tasks).toBe(1);

    // the work card surfaces the reason (monitoring path)
    const card = await env.app.services.goals.workCard(goalId);
    expect(card!.waiting_reason).toBe("stalled_no_progress");

    // a goal with a PENDING approval is NOT stalled — it waits for a human
    const { goalId: goal2 } = await makeGoal(`a35-appr-${randomBytes(3).toString("hex")}`, [{ key: "t1" }]);
    await db.query(`UPDATE tasks SET state='WAITING', failure_count=3 WHERE goal_id=$1`, [goal2]);
    await db.query(
      `INSERT INTO approvals (id, goal_id, kind, title, detail, scope, status, requested_by)
       VALUES ($1,$2,'goal_revise','t','{}','goal','PENDING','system:supervisor')`,
      [`appr_${randomBytes(6).toString("hex")}`, goal2],
    );
    await watchdog.tick();
    await watchdog.tick();
    goal = (await db.query("SELECT state FROM goals WHERE id=$1", [goal2])).rows[0];
    expect(goal.state).toBe("ACTIVE");
    const card2 = await env.app.services.goals.workCard(goal2);
    expect(card2!.waiting_reason).toBe("awaiting_approval");

    // a goal with a READY task never trips the watchdog
    const { goalId: goal3 } = await makeGoal(`a35-live-${randomBytes(3).toString("hex")}`, [{ key: "t1" }]);
    await watchdog.tick();
    await watchdog.tick();
    goal = (await db.query("SELECT state FROM goals WHERE id=$1", [goal3])).rows[0];
    expect(goal.state).toBe("ACTIVE");

    // dependency deadlock: t2 is READY but parked behind a WAITING predecessor
    // with no diagnosis task anywhere — state says "ready", the scheduler can
    // never claim it. This was the invisible stall shape before the predicate
    // learned about dependencies.
    const { goalId: goal4 } = await makeGoal(`a35-dead-${randomBytes(3).toString("hex")}`, [
      { key: "t1" }, { key: "t2", depends_on: ["t1"] },
    ]);
    await db.query(`UPDATE tasks SET state='WAITING', failure_count=3 WHERE goal_id=$1 AND node_key='t1'`, [goal4]);
    await watchdog.tick();
    await watchdog.tick();
    goal = (await db.query("SELECT state, paused_reason FROM goals WHERE id=$1", [goal4])).rows[0];
    expect(goal.state).toBe("BLOCKED_INPUT");
    expect(goal.paused_reason).toBe("stalled_no_progress");
  });
});

describe("A35 A2A handoff notes", () => {
  it("carries the predecessor's recorded RESULT summary into the successor's RunSpec", async () => {
    // priority 1: earlier tests left an ACTIVE goal with a READY task — the
    // single claim below must pick THIS goal's t2, not the backlog
    const { goalId } = await makeGoal(
      `a35-handoff-${randomBytes(3).toString("hex")}`,
      [{ key: "t1", role: "Builder" }, { key: "t2", depends_on: ["t1"], role: "Experimenter" }],
      1,
    );
    const db = env.app.services.db;
    // t1 SUCCEEDED with a COMMITTED attempt carrying a summary
    const t1 = (await db.query("SELECT id, graph_version_id FROM tasks WHERE goal_id=$1 AND node_key='t1'", [goalId])).rows[0];
    const fixtureAttempt = `att_${randomBytes(6).toString("hex")}`;
    await db.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch, ended_at, summary)
       VALUES ($1,1,$2,$3,1,$4,'d','a35-fixture','COMMITTED',1, now(), $5)`,
      [fixtureAttempt, goalId, t1.id, t1.graph_version_id,
        "count_vowels.py 已完成并通过 12/12 用例；入口函数 count_vowels(s)->int；无外部依赖。"],
    );
    await db.query(`UPDATE tasks SET state='SUCCEEDED' WHERE id=$1`, [t1.id]);
    // silence THIS goal's other READY tasks (none besides t2 here, but keep the
    // claim deterministic) without touching the SUCCEEDED predecessor
    await db.query(`UPDATE tasks SET state='CANCELLED' WHERE goal_id=$1 AND state='READY' AND node_key <> 't2'`, [goalId]);

    const claim = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: `a35-w-${randomBytes(2).toString("hex")}` } });
    expect(claim.statusCode).toBe(200);
    const spec = claim.json().spec;
    expect(spec.task_key).toBe("t2");
    expect(Array.isArray(spec.handoff_notes)).toBe(true);
    expect(spec.handoff_notes.length).toBe(1);
    const note = spec.handoff_notes[0];
    expect(note.from_task_key).toBe("t1");
    expect(note.from_role).toBe("Builder");
    expect(note.outcome).toBe("SUCCEEDED");
    expect(note.summary).toContain("count_vowels");
  });
});

describe("A35 revise cap (anti-loop brake)", () => {
  it("fails further revises and parks the goal once the cap is hit", async () => {
    const { goalId } = await makeGoal(`a35-cap-${randomBytes(3).toString("hex")}`, [{ key: "t1" }]);
    const db = env.app.services.db;
    // simulate 8 already-applied revises
    for (let i = 0; i < 8; i++) {
      await db.query(
        `INSERT INTO commands (id, command_id, goal_id, kind, payload, status, actor)
         VALUES ($1,$2,$3,'revise',$4,'APPLIED','{}')`,
        [`cmd_${randomBytes(6).toString("hex")}`, `cmdcap${i}${randomBytes(3).toString("hex")}`, goalId,
          JSON.stringify({ content: `历史修订 #${i}` })],
      );
    }
    // one more ACCEPTED revise arrives (e.g. via a fresh approval)
    const pending = `cmd_${randomBytes(6).toString("hex")}`;
    await db.query(
      `INSERT INTO commands (id, command_id, goal_id, kind, payload, status, actor)
       VALUES ($1,$2,$3,'revise',$4,'ACCEPTED','{}')`,
      [pending, `cmdp${randomBytes(3).toString("hex")}`, goalId, JSON.stringify({ content: "再来一轮修订" })],
    );
    await watchdog.tick();
    const cmd = (await db.query("SELECT status, reject_reason FROM commands WHERE id=$1", [pending])).rows[0];
    expect(cmd.status).toBe("FAILED");
    expect(cmd.reject_reason).toMatch(/revise cap/);
    const goal = (await db.query("SELECT state, paused_reason FROM goals WHERE id=$1", [goalId])).rows[0];
    expect(goal.state).toBe("BLOCKED_INPUT");
    expect(goal.paused_reason).toBe("revise_cap");
    const evt = (await db.query(
      "SELECT event_type FROM events WHERE goal_id=$1 AND event_type='goal.revise_capped'", [goalId])).rows;
    expect(evt.length).toBe(1);
  });
});

describe("A35 role metrics", () => {
  it("reports per-role attempt stats on /v1/metrics", async () => {
    const user = await authedUser(env, `a35-metrics-${randomBytes(3).toString("hex")}`);
    const me = (await user.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [
      { key: "t1", role: "Builder" }, { key: "t2", role: "Reviewer" },
    ]);
    const db = env.app.services.db;
    const task = (await db.query("SELECT id, graph_version_id FROM tasks WHERE goal_id=$1 AND node_key='t1'", [goalId])).rows[0];
    await db.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch, model_calls, settled_usd)
       VALUES ($1,1,$2,$3,1,$4,'d','a35-m','COMMITTED',1,3,0.05)`,
      [`att_${randomBytes(6).toString("hex")}`, goalId, task.id, task.graph_version_id],
    );
    const res = await user.get("/v1/metrics");
    expect(res.statusCode).toBe(200);
    const roles = res.json().roles as any[];
    const builder = roles.find((r) => r.role === "Builder");
    expect(builder).toBeTruthy();
    expect(Number(builder.attempts)).toBeGreaterThanOrEqual(1);
    expect(Number(builder.model_calls)).toBeGreaterThanOrEqual(3);
    expect(res.json().orchestrator.stall_totals).toBeDefined();
  });
});
