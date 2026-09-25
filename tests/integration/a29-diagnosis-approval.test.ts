// A29 (P20): the diagnosis→approval→auto-revise loop.
// A task that fails 3× is parked WAITING and a diagnosis task is dispatched;
// historically the goal then stalled silently in ACTIVE until a human happened
// to issue a revise. Now a SUCCEEDED diagnosis task raises an approval
// (goal_revise); approving it enqueues an ACCEPTED revise command that the
// orchestrator applies through the existing revision pipeline.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
});
afterAll(async () => { await env.close(); });

async function fixtureDiagnosedGoal() {
  const user = await authedUser(env, `a29-${randomBytes(3).toString("hex")}`);
  const me = (await user.get("/v1/me")).json();
  const f = fixture(env);
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const { goalId, graphId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [
    { key: "t1", title: "实现交付" },
    { key: "t2", title: "独立审查" },
  ]);
  // mark t2 as the parked (3× failed) task and create its diagnosis task
  const db = env.app.services.db;
  const t2 = (await db.query("SELECT id FROM tasks WHERE goal_id=$1 AND node_key='t2'", [goalId])).rows[0];
  await db.query("UPDATE tasks SET state='WAITING', failure_count=3 WHERE id=$1", [t2.id]);
  const diagId = `task_${randomBytes(4).toString("hex")}`;
  await db.query(
    `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction, risk_class, state)
     VALUES ($1,$2,$3,$4,'Coordinator','integration','诊断重复失败: 独立审查','分析根因','low','READY')`,
    [diagId, graphId, goalId, `diagnose_t2_${Date.now()}`],
  );
  // the real path reaches commit via checkpoint (READY->RUNNING)
  await db.query("UPDATE tasks SET state='RUNNING' WHERE id=$1", [diagId]);
  const attId = `att_${randomBytes(6).toString("hex")}`;
  await db.query(
    `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch)
     VALUES ($1,1,$2,$3,1,$4,'fixture','dev-01','RUNNING',1)`,
    [attId, goalId, diagId, graphId],
  );
  return { user, goalId, diagId, attId };
}

describe("A29 diagnosis approval gate", () => {
  it("a SUCCEEDED diagnosis task raises a PENDING goal_revise approval with the summary", async () => {
    const { goalId, attId } = await fixtureDiagnosedGoal();
    const summary = "根因：审查清单格式与实现输出不匹配；建议改写审查任务为直接读取源码逐条核对。";
    await env.app.services.db.tx(async (client: any) => {
      await env.app.services.goals.onAttemptCommitted(client,
        { task_id: (await env.app.services.db.query(
            "SELECT id FROM tasks WHERE goal_id=$1 AND node_key LIKE 'diagnose_%'", [goalId])).rows[0].id,
          goal_id: goalId, lease_epoch: 1 },
        "SUCCEEDED", summary, null);
    });
    void attId;

    const row = (await env.app.services.db.query(
      "SELECT id, kind, status, detail FROM approvals WHERE goal_id=$1 AND kind='goal_revise'", [goalId])).rows[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("PENDING");
    const detail = typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail;
    expect(detail.summary).toContain("根因");
  });

  it("approving the approval enqueues an ACCEPTED revise command; double decision is 409", async () => {
    const { user, goalId } = await fixtureDiagnosedGoal();
    const summary = "诊断：第三方库不可用；建议改为标准库实现并重跑验证。";
    await env.app.services.db.tx(async (client: any) => {
      await env.app.services.goals.onAttemptCommitted(client,
        { task_id: (await env.app.services.db.query(
            "SELECT id FROM tasks WHERE goal_id=$1 AND node_key LIKE 'diagnose_%'", [goalId])).rows[0].id,
          goal_id: goalId, lease_epoch: 1 },
        "SUCCEEDED", summary, null);
    });
    const appr = (await env.app.services.db.query(
      "SELECT id FROM approvals WHERE goal_id=$1 AND kind='goal_revise' AND status='PENDING'", [goalId])).rows[0];

    const res = await user.post(`/v1/approvals/${appr.id}/decision`, { decision: "approve" });
    expect(res.statusCode).toBe(200);

    const cmd = (await env.app.services.db.query(
      "SELECT payload->>'content' AS content, status FROM commands WHERE goal_id=$1 AND kind='revise'", [goalId])).rows[0];
    expect(cmd).toBeDefined();
    expect(cmd.status).toBe("ACCEPTED");
    expect(cmd.content).toContain("第三方库不可用");

    // double decision must be refused
    const again = await user.post(`/v1/approvals/${appr.id}/decision`, { decision: "approve" });
    expect(again.statusCode).toBe(409);
  });

  it("a FAILED diagnosis does NOT raise an approval", async () => {
    const { goalId } = await fixtureDiagnosedGoal();
    await env.app.services.db.tx(async (client: any) => {
      await env.app.services.goals.onAttemptCommitted(client,
        { task_id: (await env.app.services.db.query(
            "SELECT id FROM tasks WHERE goal_id=$1 AND node_key LIKE 'diagnose_%'", [goalId])).rows[0].id,
          goal_id: goalId, lease_epoch: 1 },
        "FAILED", "diagnosis itself failed", { passed: false, detail: "x" });
    });
    const rows = (await env.app.services.db.query(
      "SELECT id FROM approvals WHERE goal_id=$1 AND kind='goal_revise'", [goalId])).rows;
    expect(rows.length).toBe(0);
  });
});
