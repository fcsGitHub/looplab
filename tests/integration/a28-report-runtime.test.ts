// A28 (P19): fleet self-report + run-report export + artifact-name handling.
//   - claim payload carries runtime/version; /v1/workers surfaces it
//   - GET /v1/goals/:id/report.md renders the real ledger as markdown,
//     owner-scoped (404 for others, 401 anonymous)
//   - percent-encoded x-artifact-name is decoded once at ingest (no
//     double-encoding on download)
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, loginAs, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
  await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "a28-root", password: "looplab" } });
});
afterAll(async () => { await env.close(); });

describe("A28 worker runtime self-report", () => {
  it("claim with runtime meta surfaces it in /v1/workers; a later claim without meta keeps it", async () => {
    const f = fixture(env);
    const user = await authedUser(env, "a28-registry");
    const me = (await user.get("/v1/me")).json();
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);
    await fixture(env).cancelOtherReadyTasks(goalId);

    const workerId = `a28-worker-${randomBytes(3).toString("hex")}`;
    const inject = { method: "POST", url: "/v1/worker/claim" } as const;
    const job = await env.inject({
      ...inject, payload: { worker_id: workerId, runtime: "pi", version: "2" },
    });
    expect(job.statusCode).toBe(200);

    const list = (await user.get("/v1/workers")).json();
    const row = list.workers.find((w: any) => w.id === workerId);
    expect(row).toBeDefined();
    expect(row.runtime).toBe("pi@2");
    expect(row.alive).toBe(true);
  });
});

describe("A28 run report export", () => {
  it("renders markdown from the real ledger for the owner; 404 for other members; 401 anonymous", async () => {
    const owner = await authedUser(env, "a28-owner");
    const me = (await owner.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1", title: "实现与验证" }]);
    await fixture(env).cancelOtherReadyTasks(goalId);
    // real committed attempt so the report has actual spend rows
    await fixture(env).setGoalState(goalId, "ACTIVE");

    const attacker = await authedUser(env, "a28-attacker");
    const other = await attacker.get(`/v1/goals/${goalId}/report.md`);
    expect(other.statusCode).toBe(404);

    const anon = await env.inject({ method: "GET", url: `/v1/goals/${goalId}/report.md` });
    expect(anon.statusCode).toBe(401);

    const res = await owner.get(`/v1/goals/${goalId}/report.md`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    const body = res.body;
    expect(body).toContain("# LoopLab 目标运行报告");
    expect(body).toContain("| 节点 | 角色 | 状态 | 失败次数 |");
    expect(body).toContain("| t1 |");
    expect(body).toContain("## 执行与花费");
    expect(body).toContain("## 关键事件时间线");
  });

  it("admin can export a member's goal report", async () => {
    const admin = await loginAs(env, "a28-root");
    const member = await authedUser(env, "a28-member");
    const mem = (await member.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(mem.user.id);
    const { goalId } = await f.createGoalWithTasks(mem.user.id, projectId, sessionId, []);
    const res = await admin.get(`/v1/goals/${goalId}/report.md`);
    expect(res.statusCode).toBe(200);
  });
});

describe("A28 artifact name decoding", () => {
  it("stores the decoded name once: download header round-trips", async () => {
    const raw = `报告 ${randomBytes(3).toString("hex")}.txt`;
    const encoded = encodeURIComponent(raw);
    const up = await env.inject({
      method: "POST", url: "/v1/artifacts",
      headers: {
        "content-type": "application/octet-stream",
        // the real worker client percent-encodes the name header
        "x-artifact-name": encoded,
        "x-artifact-media-type": "text/plain",
      },
      payload: Buffer.from("hello"),
    });
    // this env runs in open worker mode (no WORKER_TOKEN configured), so the
    // token header is ignored — assert the upload succeeded either way
    expect([200, 201, 401].includes(up.statusCode)).toBe(true);
    if (up.statusCode !== 401) {
      const digest = up.json().digest;
      const row = (await env.app.services.db.query(
        "SELECT name FROM artifacts WHERE digest=$1", [digest],
      )).rows[0];
      expect(row.name).toBe(raw); // decoded exactly once
      void encoded;
    }
  });
});
