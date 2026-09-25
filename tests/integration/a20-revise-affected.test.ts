// A20 (§六.3): graph revision re-runs ONLY the affected subgraph and keeps the
// valid prefix — unaffected succeeded nodes are never re-run, unaffected live
// tasks keep their frozen spec, and the scheduler's dependency check works
// across graph versions via (goal, node_key) scoping.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 5000 });
});
afterAll(async () => { await env.close(); });

const chain = (instruction2: string, version: string) => ({
  version,
  nodes: [
    { key: "t1", role: "Builder", kind: "model", title: "build", instruction: "build the thing", depends_on: [] },
    { key: "t2", role: "Experimenter", kind: "model", title: "experiment", instruction: instruction2, depends_on: ["t1"] },
    { key: "t3", role: "Reviewer", kind: "review", title: "review", instruction: "review results", depends_on: ["t2"] },
  ],
  loops: [],
});

/** Fixture: goal with a committed t1 (valid prefix) + live t2/t3 chain. */
async function makeChainGoal(prefix: string) {
  const user = await authedUser(env, `${prefix}-${randomBytes(3).toString("hex")}`);
  const f = fixture(env);
  const me = (await user.get("/v1/me")).json();
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const { goalId, graphId } = await f.createGoalWithTasks(
    me.user.id, projectId, sessionId,
    [{ key: "t1" }, { key: "t2", depends_on: ["t1"] }, { key: "t3", depends_on: ["t2"] }],
  );
  // overwrite the fixture's empty graph JSON with the real chain (v1)
  await env.app.services.db.query(`UPDATE graph_versions SET nodes=$2 WHERE id=$1`, [graphId, JSON.stringify(chain("measure v1", `${goalId}@1`).nodes)]);
  // valid prefix: t1 succeeded; t2 live; t3 waiting on t2
  await env.app.services.db.query(`UPDATE tasks SET state='SUCCEEDED' WHERE goal_id=$1 AND node_key='t1'`, [goalId]);
  await env.app.services.db.query(`UPDATE tasks SET state='WAITING' WHERE goal_id=$1 AND node_key='t3'`, [goalId]);
  await f.cancelOtherReadyTasks(goalId);
  return { goalId, user };
}

async function tasksOf(goalId: string) {
  return (await env.app.services.db.query(
    `SELECT node_key, state, graph_version_id FROM tasks WHERE goal_id=$1 ORDER BY created_at`,
    [goalId],
  )).rows;
}

async function postRevise(goalId: string, user: any, graph: unknown, content = "revised objective") {
  return user.post(`/v1/goals/${goalId}/commands`, {
    kind: "revise", command_id: `cmd_${randomBytes(6).toString("hex")}`,
    payload: { content, graph },
  });
}

describe("A20 revise: affected-subgraph recompute", () => {
  it("re-runs only changed node + successors; keeps the valid prefix", async () => {
    const { goalId, user } = await makeChainGoal("diff");
    const res = await postRevise(goalId, user, chain("measure v2 with tighter tolerance", `${goalId}@2`));
    expect(res.statusCode).toBe(202); // accepted
    await env.app.services.orchestrator.tick(); // applied asynchronously

    const rows = await tasksOf(goalId);
    const t1 = rows.filter((r: any) => r.node_key === "t1");
    expect(t1).toHaveLength(1); // valid prefix: NOT re-created
    expect(t1[0].state).toBe("SUCCEEDED");

    const byKey = (k: string) => rows.filter((r: any) => r.node_key === k);
    expect(byKey("t2").map((r: any) => r.state).sort()).toEqual(["CANCELLED", "READY"]); // old cancelled + new live
    expect(byKey("t3").map((r: any) => r.state).sort()).toEqual(["CANCELLED", "READY"]); // successor affected

    // events record the recomputation honestly
    const rev = await env.app.services.db.query(
      `SELECT payload FROM events WHERE event_type='goal.revised' AND goal_id=$1 ORDER BY seq DESC LIMIT 1`, [goalId],
    );
    expect(rev.rows[0].payload.changed_roots).toEqual(["t2"]);
    expect([...rev.rows[0].payload.affected_nodes].sort()).toEqual(["t2", "t3"]);
    const planned = await env.app.services.db.query(
      `SELECT payload FROM events WHERE event_type='goal.graph_planned' AND goal_id=$1 ORDER BY seq DESC LIMIT 1`, [goalId],
    );
    expect(planned.rows[0].payload.valid_prefix).toEqual(["t1"]);
    expect(planned.rows[0].payload.created_tasks).toBe(2);
  });

  it("identical graph revision computes an EMPTY affected set (no churn)", async () => {
    const { goalId, user } = await makeChainGoal("nodiff");
    const res = await postRevise(goalId, user, chain("measure v1", `${goalId}@2`), "same spec, new objective text");
    expect(res.statusCode).toBe(202);
    await env.app.services.orchestrator.tick();

    const rows = await tasksOf(goalId);
    expect(rows.filter((r: any) => r.state === "CANCELLED")).toHaveLength(0);
    const planned = await env.app.services.db.query(
      `SELECT payload FROM events WHERE event_type='goal.graph_planned' AND goal_id=$1 ORDER BY seq DESC LIMIT 1`, [goalId],
    );
    expect(planned.rows[0].payload.affected_nodes).toEqual([]);
    expect(planned.rows[0].payload.created_tasks).toBe(0);
    // the live t2 task row survives untouched
    expect(rows.filter((r: any) => r.node_key === "t2" && r.state === "READY")).toHaveLength(1);
  });

  it("scheduler resolves dependencies across graph versions (goal+node_key scope)", async () => {
    const { goalId, user } = await makeChainGoal("sched");
    await postRevise(goalId, user, chain("measure v2", `${goalId}@2`));
    await env.app.services.orchestrator.tick();
    // isolation AFTER the tick: the revise re-created live rows, and the
    // scheduler is FIFO across all goals in this shared test database
    await fixture(env).cancelOtherReadyTasks(goalId);

    // first claim must get the NEW t2 (its dep t1 succeeded in the old version;
    // t3's dep t2 is still live), NOT t3 and NOT the cancelled rows
    const wid = `w-${randomBytes(2).toString("hex")}`;
    const c1 = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: wid } });
    expect(c1.statusCode).toBe(200);
    expect(c1.json().spec.task_key).toBe("t2");
    const a = c1.json().attempt;
    await env.inject({ method: "POST", url: `/v1/attempts/${a.id}/start`, payload: { worker_id: wid, lease_epoch: 1 } });
    await env.inject({
      method: "POST", url: `/v1/attempts/${a.id}/checkpoint`,
      payload: { worker_id: wid, lease_epoch: 1, step_index: 1, summary: "progress", state: {}, progress_kind: "tool_progress" },
    });
    const c = await env.inject({
      method: "POST", url: `/v1/attempts/${a.id}/commit`,
      payload: {
        worker_id: wid, lease_epoch: 1, expected_status: "RUNNING",
        attempt_id: a.id, outcome: "SUCCEEDED", summary: "ok", artifacts: [],
        usage: { model_calls: 0, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
        verification: { kind: "self", passed: true, detail: "fixture" },
      },
    });
    expect(c.statusCode).toBe(200);

    // only now does t3 (new row) become claimable
    const c2 = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: `w-${randomBytes(2).toString("hex")}` } });
    expect(c2.statusCode).toBe(200);
    expect(c2.json().spec.task_key).toBe("t3");
  });

  it("invalid explicit graph is rejected without wedging the goal", async () => {
    const { goalId, user } = await makeChainGoal("badgraph");
    // t3 depends on t9 which does not exist -> compile error
    const bad = chain("x", `${goalId}@2`);
    (bad.nodes[2] as any).depends_on = ["t9"];
    const res = await postRevise(goalId, user, bad);
    expect(res.statusCode).toBe(202); // accepted...
    await env.app.services.orchestrator.tick(); // ...then honestly failed

    const cmd = await env.app.services.db.query(
      `SELECT status, reject_reason FROM commands WHERE goal_id=$1 AND kind='revise' ORDER BY created_at DESC LIMIT 1`, [goalId],
    );
    expect(cmd.rows[0].status).toBe("FAILED");
    expect(cmd.rows[0].reject_reason).toMatch(/unknown_node|invalid/);
    const ev = await env.app.services.db.query(
      `SELECT count(*)::int AS n FROM events WHERE event_type='goal.revise_failed' AND goal_id=$1`, [goalId],
    );
    expect(ev.rows[0].n).toBe(1);
    // goal untouched: still version 1, old tasks intact
    const g = await env.app.services.db.query(`SELECT current_version FROM goals WHERE id=$1`, [goalId]);
    expect(Number(g.rows[0].current_version)).toBe(1);
    expect((await tasksOf(goalId)).filter((r: any) => r.state === "CANCELLED")).toHaveLength(0);
  });
});
