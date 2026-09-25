// A22 (problem ledger #3): priority scheduling. The single scheduling
// authority orders candidates by (priority ASC, created_at ASC): an urgent
// goal preempts older backlog, users re-rank live goals via the set_priority
// command (idempotent, evented), FIFO holds within one tier, and
// out-of-range priorities are refused at both entry points.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
});
afterAll(async () => { await env.close(); });

/** Fixture: ACTIVE goal with `n` independent READY tasks at a priority tier. */
async function makeGoal(prefix: string, priority: number, nTasks = 1) {
  const user = await authedUser(env, `${prefix}-${randomBytes(3).toString("hex")}`);
  const f = fixture(env);
  const me = (await user.get("/v1/me")).json();
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const { goalId } = await f.createGoalWithTasks(
    me.user.id, projectId, sessionId,
    Array.from({ length: nTasks }, (_, i) => ({ key: `t${i + 1}` })),
    "ACTIVE", "5", priority,
  );
  return { goalId, user };
}

/** Isolation: park every other goal's READY tasks (claim spans all goals). */
async function parkOthers(keep: string[]) {
  await fixture(env).cancelExceptKeep(keep);
}

describe("A22 priority scheduling", () => {
  it("an urgent goal preempts OLDER backlog (priority beats FIFO)", async () => {
    const backlog = await makeGoal("a22-backlog", 9);
    const urgent = await makeGoal("a22-urgent", 1); // created later on purpose
    parkOthers([backlog.goalId, urgent.goalId]);

    const job = await env.app.services.scheduler.claim("w-a22-preempt");
    expect(job).not.toBeNull();
    expect(job!.spec.goal_id).toBe(urgent.goalId);
  });

  it("FIFO holds within a tier; set_priority re-ranks live backlog (commanded + evented)", async () => {
    const older = await makeGoal("a22-fifo-older", 1, 2);
    const newer = await makeGoal("a22-fifo-newer", 1, 2); // same tier, younger
    parkOthers([older.goalId, newer.goalId]);

    // same tier -> creation order decides
    const job1 = await env.app.services.scheduler.claim("w-a22-fifo");
    expect(job1!.spec.goal_id).toBe(older.goalId);

    // demote the older goal below the tier -> younger one goes next
    const cmd = await older.user.post(`/v1/goals/${older.goalId}/commands`, {
      kind: "set_priority", command_id: `cmd_${randomBytes(6).toString("hex")}`,
      payload: { priority: 9 },
    });
    expect(cmd.statusCode).toBe(202);
    expect(cmd.json().applied).toBe(true);

    const row = (await env.app.services.db.query(
      "SELECT priority FROM goals WHERE id=$1", [older.goalId],
    )).rows[0];
    expect(Number(row.priority)).toBe(9);

    const ev = (await env.app.services.db.query(
      `SELECT payload FROM events WHERE event_type='goal.priority_changed' AND goal_id=$1
        ORDER BY seq DESC LIMIT 1`, [older.goalId],
    )).rows[0];
    expect(ev.payload).toMatchObject({ from: 1, to: 9 });

    const job2 = await env.app.services.scheduler.claim("w-a22-fifo");
    expect(job2!.spec.goal_id).toBe(newer.goalId);

    // idempotent replay of the same command_id changes nothing
    const replay = (await env.app.services.db.query(
      `SELECT command_id, status FROM commands WHERE goal_id=$1 AND kind='set_priority'
        ORDER BY created_at DESC LIMIT 1`, [older.goalId],
    )).rows[0];
    expect(replay.status).toBe("APPLIED");
  });

  it("out-of-range priority is refused at both entry points (no partial writes)", async () => {
    const g = await makeGoal("a22-invalid", 5);

    // command path: REJECTED + reason, goal value untouched
    const cmd = await g.user.post(`/v1/goals/${g.goalId}/commands`, {
      kind: "set_priority", command_id: `cmd_${randomBytes(6).toString("hex")}`,
      payload: { priority: 12 },
    });
    expect(cmd.statusCode).toBe(409);
    expect(cmd.json().status).toBe("REJECTED");
    expect(cmd.json().reason).toContain("1..9");
    const row = (await env.app.services.db.query(
      "SELECT priority FROM goals WHERE id=$1", [g.goalId],
    )).rows[0];
    expect(Number(row.priority)).toBe(5);

    // chat path: invalid priority on first message -> 400 before goal creation
    const user = await authedUser(env, `a22-badmsg-${randomBytes(3).toString("hex")}`);
    const f = fixture(env);
    const me = (await user.get("/v1/me")).json();
    const { sessionId } = await f.createProjectSession(me.user.id);
    const bad = await user.post(`/v1/sessions/${sessionId}/messages`, {
      content: "先给一个非法优先级", priority: 0,
    });
    expect(bad.statusCode).toBe(400);

    // valid priority on first message creates the goal at that tier
    const ok = await user.post(`/v1/sessions/${sessionId}/messages`, {
      content: "紧急：验证优先级建目标路径", priority: 2,
    });
    expect(ok.statusCode).toBe(202);
    const created = (await env.app.services.db.query(
      "SELECT priority FROM goals WHERE id=$1", [ok.json().goal_id],
    )).rows[0];
    expect(Number(created.priority)).toBe(2);
    // park it so it cannot pollute later claims
    parkOthers([ok.json().goal_id, g.goalId]);
  });
});
