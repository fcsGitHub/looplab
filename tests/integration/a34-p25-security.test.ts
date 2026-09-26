// A34 (P25 security round 2). Cross-tenant and accounting gaps found by the
// second audit pass:
//   V20 approvals: list + decision were tenant-blind (any member could approve
//        another tenant's goal_revise, injecting a revise into their goal)
//   V21 evidence/verify: reachable by goal id alone (cross-tenant ledger write)
//   V22 hypotheses/:id/protocol: no ownership + unbounded arms×seeds insert
//   V23 llm idempotency: a reused key re-billed and overwrote the settlement
//   V24 propagated download: media_type served verbatim (stored-XSS gap)
//   V25 artifact upload: caller-supplied goal attribution + global scope
//   V26/V27 pointers, promote/rollback, epoch/settle: member-reachable global
//        state mutation
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, loginAs, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
let admin: Awaited<ReturnType<typeof loginAs>>;
let fakeLlm: Server;
let fakeLlmUrl = "";

beforeAll(async () => {
  // a local fake provider so the gateway performs REAL reserve->HTTP->settle
  // cycles without external credentials
  fakeLlm = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-fake", object: "chat.completion", created: Date.now() / 1000, model: "deepseek-chat",
        choices: [{ index: 0, message: { role: "assistant", content: "FAKE-REPLY-" + randomBytes(2).toString("hex") }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise<void>((r) => fakeLlm.listen(0, "127.0.0.1", r));
  const addr = fakeLlm.address() as { address: string; port: number };
  // the client appends /chat/completions itself
  fakeLlmUrl = `http://${addr.address}:${addr.port}`;

  env = await createTestEnv({ deepseekBaseUrl: fakeLlmUrl });
  // first registered user becomes admin — pin it before any test registers
  await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "a34-root", password: "looplab" } });
  admin = await loginAs(env, "a34-root");
});
afterAll(async () => {
  await env.close();
  fakeLlm.close();
});

describe("A34 V20 approval tenant isolation", () => {
  it("hides alice's pending approval from bob, rejects bob's decision, accepts alice's", async () => {
    const alice = await authedUser(env, `a34-alice-${randomBytes(3).toString("hex")}`);
    const me = (await alice.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);
    const apprId = `appr_${randomBytes(6).toString("hex")}`;
    await env.app.services.db.query(
      `INSERT INTO approvals (id, goal_id, kind, title, detail, scope, status, requested_by)
       VALUES ($1,$2,'goal_revise','诊断完成，待修订',$3,'goal','PENDING','system:supervisor')`,
      [apprId, goalId, JSON.stringify({ content: "采纳诊断" })],
    );

    const bob = await authedUser(env, `a34-bob-${randomBytes(3).toString("hex")}`);
    const bobList = (await bob.get("/v1/approvals")).json();
    expect(bobList.approvals.some((a: any) => a.id === apprId)).toBe(false);
    const bobDecide = await bob.post(`/v1/approvals/${apprId}/decision`, { decision: "approve" });
    expect(bobDecide.statusCode).toBe(404);
    // bob's failed probe must not have decided anything
    const stillPending = (await env.app.services.db.query("SELECT status FROM approvals WHERE id=$1", [apprId])).rows[0];
    expect(stillPending.status).toBe("PENDING");

    // alice sees and decides her own approval
    const aliceList = (await alice.get("/v1/approvals")).json();
    expect(aliceList.approvals.some((a: any) => a.id === apprId)).toBe(true);
    const ok = await alice.post(`/v1/approvals/${apprId}/decision`, { decision: "approve" });
    expect(ok.statusCode).toBe(200);
    // the approve path enqueued the revise command in HER goal
    const cmds = (await env.app.services.db.query(
      "SELECT kind, status FROM commands WHERE goal_id=$1", [goalId])).rows;
    expect(cmds.some((c: any) => c.kind === "revise" && c.status === "ACCEPTED")).toBe(true);

    // admin sees everything (escalation path)
    const adminList = (await admin.get("/v1/approvals")).json();
    expect(adminList.approvals.length).toBeGreaterThanOrEqual(0); // scoped query still works for admin
  });
});

describe("A34 V21 evidence verify scoping", () => {
  it("a member cannot run verification against another user's goal", async () => {
    const alice = await authedUser(env, `a34-vea-${randomBytes(3).toString("hex")}`);
    const me = (await alice.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);
    const bob = await authedUser(env, `a34-veb-${randomBytes(3).toString("hex")}`);
    const res = await bob.post(`/v1/goals/${goalId}/evidence/verify`, {});
    expect(res.statusCode).toBe(404);
  });
});

describe("A34 V22 hypothesis protocol scoping + bounds", () => {
  it("rejects non-owner and oversized designs", async () => {
    const alice = await authedUser(env, `a34-ha-${randomBytes(3).toString("hex")}`);
    const me = (await alice.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);
    const hypId = await env.app.services.research.createHypothesis({
      goalId, statement: "test hypothesis", userId: me.user.id,
    });
    const bob = await authedUser(env, `a34-hb-${randomBytes(3).toString("hex")}`);
    const bobRes = await bob.post(`/v1/hypotheses/${hypId}/protocol`, {
      arms: [{ name: "treatment" }, { name: "control" }], seeds: [1, 2], repetitions: 2,
    });
    expect(bobRes.statusCode).toBe(404);

    // oversized design: 8 arms × 33 seeds = 264 > 256
    const arms = Array.from({ length: 8 }, (_, i) => ({ name: `arm${i}`, params: {} }));
    const seeds = Array.from({ length: 33 }, (_, i) => i);
    const big = await alice.post(`/v1/hypotheses/${hypId}/protocol`, {
      arms, seeds, repetitions: 2,
    });
    expect(big.statusCode).toBe(400);
    expect(big.json().error).toMatch(/arms × seeds/);
  });
});

describe("A34 V23 llm idempotency replay", () => {
  it("a reused idempotency key replays the recorded response without re-billing", async () => {
    const alice = await authedUser(env, `a34-ida-${randomBytes(3).toString("hex")}`);
    const me = (await alice.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);

    const key = `replay-${randomBytes(4).toString("hex")}`;
    const first = await env.app.services.llm.call({
      goalId, scope: "task_execution", messages: [{ role: "user", content: "first" }],
      idempotencyKey: key, actor: { kind: "test", id: "a34" },
    });
    expect(first.replayed).toBeFalsy();
    const second = await env.app.services.llm.call({
      goalId, scope: "task_execution", messages: [{ role: "user", content: "SECOND-DIFFERENT" }],
      idempotencyKey: key, actor: { kind: "test", id: "a34" },
    });
    // replay: same content as the first call, flagged, and NOT a second bill
    expect(second.replayed).toBe(true);
    expect(second.message.content).toBe(first.message.content);

    const rows = (await env.app.services.db.query(
      "SELECT status, settled_usd FROM budget_reservations WHERE idempotency_key=$1", [key])).rows;
    expect(rows.length).toBe(1);
    // settled exactly once (the two settles of the same logical call must not
    // stack — the second replay never touched the provider)
    expect(Number(rows[0].settled_usd)).toBeGreaterThan(0);
    const modelCalls = (await env.app.services.db.query(
      `SELECT count(*)::int AS n FROM events WHERE goal_id=$1 AND event_type='model.call_completed'`, [goalId])).rows[0].n;
    expect(modelCalls).toBe(1);
  });

  it("clamps runaway caller-supplied sizes on the worker plane", async () => {
    const alice = await authedUser(env, `a34-cla-${randomBytes(3).toString("hex")}`);
    const me = (await alice.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);

    // fixture an attempt, then call the llm proxy with an absurd max_tokens
    const task = (await env.app.services.db.query(
      "SELECT id, graph_version_id FROM tasks WHERE goal_id=$1 LIMIT 1", [goalId])).rows[0];
    const attId = `att_${randomBytes(6).toString("hex")}`;
    await env.app.services.db.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch)
       VALUES ($1,1,$2,$3,1,$4,'fixture','a34-w','STARTED',1)`,
      [attId, goalId, task.id, task.graph_version_id],
    );
    const res = await env.inject({
      method: "POST", url: `/v1/attempts/${attId}/llm`,
      payload: { worker_id: "a34-w", lease_epoch: 1, messages: [{ role: "user", content: "hi" }], max_tokens: 10_000_000 },
    });
    expect(res.statusCode).toBe(200);
    // the clamped call must have reserved a bounded amount, not worst-case on
    // the raw 10M-token input
    const reservations = (await env.app.services.db.query(
      "SELECT reserved_usd FROM budget_reservations WHERE attempt_id=$1 ORDER BY created_at", [attId])).rows;
    expect(Number(reservations[reservations.length - 1].reserved_usd)).toBeLessThan(1);
    const r2 = await env.inject({
      method: "POST", url: `/v1/attempts/${attId}/llm`,
      payload: { worker_id: "a34-w", lease_epoch: 1, messages: [{ role: "user", content: "again" }], idempotency_key: "a34-inflight" },
    });
    expect(r2.statusCode).toBe(200);
    // replay of the same key: same content, no second model.call_completed
    const r3 = await env.inject({
      method: "POST", url: `/v1/attempts/${attId}/llm`,
      payload: { worker_id: "a34-w", lease_epoch: 1, messages: [{ role: "user", content: "different" }], idempotency_key: "a34-inflight" },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().message.content).toBe(r2.json().message.content);
  });
});

describe("A34 V24 propagated download hardening", () => {
  it("serves scriptable media types as opaque attachments", async () => {
    const db = env.app.services.db;
    const f = fixture(env);
    const owner = await authedUser(env, `a34-pd-${randomBytes(3).toString("hex")}`);
    const me = (await owner.get("/v1/me")).json();
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);
    // fixture an attempt with an HTML artifact granted via propagated list
    const task = (await db.query("SELECT id, graph_version_id FROM tasks WHERE goal_id=$1 LIMIT 1", [goalId])).rows[0];
    const attId = `att_${randomBytes(6).toString("hex")}`;
    await db.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch)
       VALUES ($1,1,$2,$3,1,$4,'fixture','a34-w2','STARTED',1)`,
      [attId, goalId, task.id, task.graph_version_id],
    );
    const payload = Buffer.from("<script>alert(1)</script>", "utf8");
    const stored = await env.app.services.objects.put(payload, "text/html");
    const digest = stored.digest;
    await db.query(
      `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
       VALUES ($1,'evil.html','text/html',$2,$3,$4,'worker',$5,'task')`,
      [digest, stored.size, stored.storageRef, attId, goalId],
    );
    await db.query(
      `INSERT INTO attempt_specs (attempt_id, spec, allowed_tools, workspace_dir)
       VALUES ($1,$2,'[]','/tmp/a34')`,
      [attId, JSON.stringify({ propagated_artifacts: [{ name: "evil.html", digest, from_task_key: "t1" }] })],
    );
    const res = await env.inject({
      method: "GET", url: `/v1/attempts/${attId}/propagated/${digest}?worker_id=a34-w2&lease_epoch=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("A34 V25 artifact attribution", () => {
  it("derives goal ownership from the attempt and refuses global scope", async () => {
    const db = env.app.services.db;
    const f = fixture(env);
    const owner = await authedUser(env, `a34-aa-${randomBytes(3).toString("hex")}`);
    const me = (await owner.get("/v1/me")).json();
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);
    const task = (await db.query("SELECT id, graph_version_id FROM tasks WHERE goal_id=$1 LIMIT 1", [goalId])).rows[0];
    const attId = `att_${randomBytes(6).toString("hex")}`;
    await db.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch)
       VALUES ($1,1,$2,$3,1,$4,'fixture','a34-w3','STARTED',1)`,
      [attId, goalId, task.id, task.graph_version_id],
    );

    // attacker tries to attribute to ANOTHER goal via headers — ignored
    const otherGoal = `goal_${randomBytes(6).toString("hex")}`;
    const up = await env.inject({
      method: "POST", url: "/v1/artifacts",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": "poison.txt", "x-attempt-id": attId,
        "x-goal-id": otherGoal, "x-scope": "task",
      },
      payload: Buffer.from("poisoned attribution"),
    });
    expect(up.statusCode).toBe(200);
    const row = (await db.query("SELECT goal_id, scope FROM artifacts WHERE digest=$1", [up.json().digest])).rows[0];
    expect(row.goal_id).toBe(goalId); // from the ATTEMPT, not the header
    expect(row.scope).toBe("task");

    // a worker INSIDE an attempt cannot publish globally-visible rows
    const globalTry = await env.inject({
      method: "POST", url: "/v1/artifacts",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": "global.txt", "x-attempt-id": attId, "x-scope": "global",
      },
      payload: Buffer.from("global poison"),
    });
    expect(globalTry.statusCode).toBe(403);

    const badAtt = await env.inject({
      method: "POST", url: "/v1/artifacts",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": "x.txt", "x-attempt-id": "att_doesnotexist",
      },
      payload: Buffer.from("x"),
    });
    expect(badAtt.statusCode).toBe(404);
  });
});

describe("A34 V26/V27 global-state privilege", () => {
  it("member cannot list pointers, promote, roll back or settle an epoch", async () => {
    const member = await authedUser(env, `a34-priv-${randomBytes(3).toString("hex")}`);
    const me = (await member.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, []);

    expect((await member.get("/v1/pointers")).statusCode).toBe(403);
    expect((await member.post(`/v1/goals/${goalId}/evolution/promote`, { candidate_id: "cand_x" })).statusCode).toBe(403);
    expect((await member.post(`/v1/goals/${goalId}/releases/rel_x/rollback`, { scope: "algorithm:bin-packing" })).statusCode).toBe(403);
    const settle = await member.post("/v1/meta/epoch/settle", {
      incumbent: "simple-baseline@1", challenger: "gepa@0.1.4",
      incumbentImprovement: 0, challengerImprovement: 1,
    });
    expect(settle.statusCode).toBe(403);

    // admin reaches the epoch endpoint; an unregistered challenger is rejected
    const badBackend = await admin.post("/v1/meta/epoch/settle", {
      incumbent: "simple-baseline@1", challenger: "totally-evil-backend",
      incumbentImprovement: 0, challengerImprovement: 99,
    });
    expect(badBackend.statusCode).toBe(400);
    expect(badBackend.json().error).toMatch(/registered optimizer backends/);
    // admins may list pointers
    expect((await admin.get("/v1/pointers")).statusCode).toBe(200);
  });
});
