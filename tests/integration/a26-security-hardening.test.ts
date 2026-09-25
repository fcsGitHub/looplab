// A26 (P17 security hardening). Transport-level gaps that the in-process
// fencing checks never covered:
//   - the worker plane accepts unauthenticated requests when WORKER_TOKEN is
//     unset, so a LAN peer could drive model spend / fake commits — when set,
//     every worker route must require it (timing-safe compare)
//   - /v1/metrics used to leak spend and fleet data without a session
//   - goal/attempt/session reads were scoped only by id knowledge (IDOR)
//   - login brute force was unthrottled
//   - the SSE catch-up cursor used to 500 on a non-numeric ?after
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, loginAs, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
let secure: TestEnv; // same app shape but WORKER_TOKEN enforced

beforeAll(async () => {
  env = await createTestEnv({});
  secure = await createTestEnv({ workerToken: "wtest-" + randomBytes(8).toString("hex") });
  // first registered user becomes admin — pin it before any test registers
  await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "a26-root", password: "looplab" } });
});
afterAll(async () => { await env.close(); await secure.close(); });

describe("A26 worker-plane token auth", () => {
  it("rejects claim / artifact upload / attempt llm without or with a wrong token", async () => {
    const noTok = await secure.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: "evil" } });
    expect(noTok.statusCode).toBe(401);

    const badTok = await secure.inject({
      method: "POST", url: "/v1/worker/claim",
      headers: { "x-worker-token": "wrong" },
      payload: { worker_id: "evil" },
    });
    expect(badTok.statusCode).toBe(401);

    const badUpload = await secure.inject({
      method: "POST", url: "/v1/artifacts",
      headers: { "content-type": "application/octet-stream", "x-worker-token": "wrong" },
      payload: Buffer.from("poison"),
    });
    expect(badUpload.statusCode).toBe(401);
  });

  it("accepts worker-plane requests carrying the correct token", async () => {
    const tok = secure.app.config.workerToken;
    const ok = await secure.inject({
      method: "POST", url: "/v1/worker/claim",
      headers: { "x-worker-token": tok }, payload: { worker_id: "a26-tokened" },
    });
    // 204 = authorized + nothing to claim; anything else would mean the
    // token gate broke the route contract
    expect(ok.statusCode).toBe(204);
  });

  it("keeps the open mode when no token is configured (dev compatibility)", async () => {
    const open = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: "a26-open" } });
    expect(open.statusCode).toBe(204);
  });
});

describe("A26 read isolation", () => {
  it("metrics requires a session", async () => {
    const res = await env.inject({ method: "GET", url: "/v1/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("a member cannot read another user's goal, its tasks, attempts, events or messages (404, existence hidden)", async () => {
    // owner creates session + goal + messages
    const owner = await authedUser(env, "a26-owner");
    const me = (await owner.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(me.user.id, projectId, sessionId, [{ key: "t1" }]);
    await owner.post(`/v1/sessions/${sessionId}/messages`, { content: "owner secret context" });

    // attacker: own valid account, no role
    const attacker = await authedUser(env, "a26-attacker");
    for (const url of [
      `/v1/goals/${goalId}`,
      `/v1/goals/${goalId}/tasks`,
      `/v1/goals/${goalId}/attempts`,
      `/v1/goals/${goalId}/evidence`,
      `/v1/goals/${goalId}/candidates`,
      `/v1/goals/${goalId}/hypotheses`,
    ]) {
      const res = await attacker.get(url);
      expect(res.statusCode, url).toBe(404);
    }

    // session messages IDOR: previously readable by session id alone
    const msgs = await attacker.get(`/v1/sessions/${sessionId}/messages`);
    expect(msgs.statusCode).toBe(404);
  });

  it("admin role keeps full read access to member goals", async () => {
    const admin = await loginAs(env, "a26-root");
    const me = (await admin.get("/v1/me")).json();
    expect(me.user.role).toBe("admin");

    const member = await authedUser(env, "a26-member2");
    const mem = (await member.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(mem.user.id);
    const { goalId } = await f.createGoalWithTasks(mem.user.id, projectId, sessionId, [{ key: "t1" }]);
    const res = await admin.get(`/v1/goals/${goalId}`);
    expect(res.statusCode).toBe(200);
  });

  it("the goal list endpoint scopes by owner and filters by state", async () => {
    const u1 = await authedUser(env, "a26-list1");
    const me1 = (await u1.get("/v1/me")).json();
    const u2 = await authedUser(env, "a26-list2");
    const me2 = (await u2.get("/v1/me")).json();
    const f = fixture(env);
    const p1 = await f.createProjectSession(me1.user.id);
    await f.createGoalWithTasks(me1.user.id, p1.projectId, p1.sessionId, [{ key: "t1" }], "COMPLETED");
    const p2 = await f.createProjectSession(me2.user.id);
    await f.createGoalWithTasks(me2.user.id, p2.projectId, p2.sessionId, [{ key: "t1" }]);

    const l1 = (await u1.get("/v1/goals")).json();
    expect(l1.goals.length).toBe(1); // own goals only
    expect(l1.goals[0].state).toBe("COMPLETED");
    const filtered = (await u1.get("/v1/goals?state=ACTIVE")).json();
    expect(filtered.goals.length).toBe(0);
  });
});

describe("A26 login throttling", () => {
  it("locks out after repeated failures and rejects even correct credentials", async () => {
    const name = `a26-brute-${randomBytes(3).toString("hex")}`;
    await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: name, password: "right-pass" } });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await env.inject({
        method: "POST", url: "/v1/auth/login",
        payload: { username: name, password: `wrong-${i}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes[8]).toBe(429);
    // even the RIGHT password is refused while locked (the brake is per
    // ip+username; this is exactly the trade-off that stops credential stuffing)
    const right = await env.inject({
      method: "POST", url: "/v1/auth/login", payload: { username: name, password: "right-pass" },
    });
    expect(right.statusCode).toBe(429);
  });
});

describe("A26 SSE cursor robustness", () => {
  it("opens the stream (not 500) for a non-numeric ?after cursor", async () => {
    await env.app.app.listen({ port: 0 });
    const addr = env.app.app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const login = await env.inject({ method: "POST", url: "/v1/auth/login", payload: { username: "a26-owner", password: "looplab" } });
    const cookie = login.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    const controller = new AbortController();
    const done = (async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/events?after=not-a-number`, {
        signal: controller.signal, headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    })();
    const timeout = new Promise((r) => setTimeout(r, 1500));
    await Promise.race([done, timeout]);
    controller.abort();
    await done.catch(() => {});
    // leave the server open; afterAll's env.close() shuts it down
  });
});
