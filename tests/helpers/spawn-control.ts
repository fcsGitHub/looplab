// Integration test harness: isolated PostgreSQL database + in-process control
// app per test file. Real HTTP via app.listen for SSE; otherwise fastify.inject.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { buildApp, type LoopLabApp } from "../../apps/control/src/app.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://looplab:localdev@localhost:5433/postgres";

export interface TestEnv {
  app: LoopLabApp;
  inject: LoopLabApp["app"]["inject"];
  dbUrl: string;
  dataDir: string;
  db: Pool;
  close: () => Promise<void>;
}

export async function createTestEnv(opts: { leaseTtlMs?: number; deepseekBaseUrl?: string } = {}): Promise<TestEnv> {
  const dbName = `looplab_test_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`CREATE DATABASE ${dbName}`);

  const dataDir = mkdtempSync(path.join(tmpdir(), "looplab-test-"));
  const dbUrl = ADMIN_URL.replace("/postgres", `/${dbName}`);

  const app = await buildApp({
    databaseUrl: dbUrl,
    dataDir,
    sealedDir: path.join(dataDir, "sealed"),
    port: 0,
    leaseTtlMs: opts.leaseTtlMs ?? 60_000,
    workerHeartbeatMs: 100,
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY ?? "sk-test-dummy-key-for-non-llm-tests",
      baseUrl: opts.deepseekBaseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      chatModel: process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat",
      reasonerModel: "deepseek-reasoner",
    },
  });

  // provision TaskPack suites + sealed release suites into the test data dir
  const { provisionInto } = await import("../../scripts/seal-suites.js");
  provisionInto(path.join(dataDir, "taskpacks"), path.join(dataDir, "sealed"));

  return {
    app,
    inject: app.app.inject.bind(app.app),
    dbUrl,
    dataDir,
    db: admin,
    close: async () => {
      await app.services.orchestrator.stop();
      await app.app.close();
      await app.services.db.close();
      await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Register a user and return an authed client helper. */
export async function authedUser(env: TestEnv, username = "tester", password = "looplab") {
  const reg = await env.inject({
    method: "POST", url: "/v1/auth/register",
    payload: { username, password },
  });
  if (reg.statusCode !== 200) throw new Error(`register failed: ${reg.body}`);
  const cookies = reg.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return {
    username,
    cookie: cookies,
    get: (url: string) => env.inject({ method: "GET", url, headers: { cookie: cookies } }),
    post: (url: string, payload?: unknown) => env.inject({ method: "POST", url, headers: { cookie: cookies }, payload }),
  };
}

/** Direct DB fixture helper (sanctioned for deterministic state-machine tests). */
export function fixture(env: TestEnv) {
  const db = env.app.services.db;
  return {
    async createProjectSession(userId: string) {
      const prj = await db.query(
        "INSERT INTO projects (id, owner_id, slug, name) VALUES ($1,$2,$3,$4) RETURNING id",
        [`prj_${randomBytes(4).toString("hex")}`, userId, "test", "Test Project"],
      );
      const ses = await db.query(
        "INSERT INTO chat_sessions (id, project_id, owner_id, title) VALUES ($1,$2,$3,$4) RETURNING id",
        [`ses_${randomBytes(4).toString("hex")}`, prj.rows[0].id, userId, "t"],
      );
      return { projectId: prj.rows[0].id, sessionId: ses.rows[0].id };
    },
    async createGoalWithTasks(userId: string, projectId: string, sessionId: string, tasks: {
      key: string; role?: string; title?: string; depends_on?: string[];
    }[], goalState = "ACTIVE", budgetCapUsd = "5", priority = 5) {
      const goalId = `goal_${randomBytes(4).toString("hex")}`;
      const graphId = `graph_${randomBytes(4).toString("hex")}`;
      await db.query(
        `INSERT INTO goals (id, project_id, session_id, owner_id, title, state, current_version, budget_cap_usd, priority)
         VALUES ($1,$2,$3,$4,'fixture goal',$5,1,$6,$7)`,
        [goalId, projectId, sessionId, userId, goalState, budgetCapUsd, priority],
      );
      await db.query(
        "INSERT INTO goal_versions (goal_id, version, objective, created_by) VALUES ($1,1,'fixture','test')",
        [goalId],
      );
      await db.query(
        `INSERT INTO graph_versions (id, goal_id, version, nodes, loops, digest) VALUES ($1,$2,1,'[]','[]','fixturedigest')`,
        [graphId, goalId],
      );
      for (const t of tasks) {
        await db.query(
          `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction, depends_on, state)
           VALUES ($1,$2,$3,$4,$5,'model',$6,'fixture instruction',$7,'READY')`,
          [`task_${randomBytes(4).toString("hex")}`, graphId, goalId, t.key, t.role ?? "Builder", t.title ?? t.key, t.depends_on ?? []],
        );
      }
      return { goalId, graphId };
    },
    async cancelOtherReadyTasks(goalId: string) {
      // test isolation: the scheduler claims across ALL goals by
      // (priority, created_at) — correct platform behavior — so tests park
      // other goals' READY tasks. Priority-aware variant: cancelExcept(goals[]).
      await db.query("UPDATE tasks SET state='CANCELLED' WHERE goal_id <> $1 AND state IN ('READY','WAITING')", [goalId]);
    },
    async cancelExceptKeep(keepGoalIds: string[]) {
      await db.query(
        "UPDATE tasks SET state='CANCELLED' WHERE goal_id <> ALL($1) AND state IN ('READY','WAITING')",
        [keepGoalIds],
      );
    },
    async setGoalState(goalId: string, state: string) {
      await db.query("UPDATE goals SET state=$2, updated_at=now() WHERE id=$1", [goalId, state]);
    },
    async expireLease(attemptId: string) {
      await db.query("UPDATE attempts SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [attemptId]);
    },
  };
}
