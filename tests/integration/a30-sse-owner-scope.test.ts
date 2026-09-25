// A30 (P21): the SSE stream is owner-scoped.
// Events carry other users' work summaries, so a member's /v1/events replay
// must only contain goal-less system events and events for goals they own.
// Before this fix, any authenticated member could replay the ENTIRE global
// ledger (other users' summaries, steer contents, revised objectives).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, loginAs, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
let baseURL = "";

beforeAll(async () => {
  env = await createTestEnv({});
  await env.inject({ method: "POST", url: "/v1/auth/register", payload: { username: "a30-root", password: "looplab" } });
  await env.app.app.listen({ port: 0 });
  const addr = env.app.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await env.close(); });

/** Collect SSE events for a cookie for `ms` milliseconds. */
async function collectStream(cookie: string, ms: number, query = ""): Promise<any[]> {
  const controller = new AbortController();
  const events: any[] = [];
  const done = (async () => {
    const res = await fetch(`${baseURL}/v1/events${query}`, { signal: controller.signal, headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const tick = setTimeout(() => controller.abort(), ms);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const block of buf.split("\n\n").slice(0, -1)) {
          buf = buf.slice(block.length + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* aborted */ }
    clearTimeout(tick);
  })();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  await done.catch(() => {});
  return events;
}

describe("A30 SSE owner scoping", () => {
  it("a member's stream excludes other users' goal events but includes their own and system events", async () => {
    // two members, one goal each, with real ledger events (commands)
    const a = await authedUser(env, "a30-alice");
    const ma = (await a.get("/v1/me")).json();
    const b = await authedUser(env, "a30-bob");
    const mb = (await b.get("/v1/me")).json();
    const f = fixture(env);
    const pa = await f.createProjectSession(ma.user.id);
    const ga = await f.createGoalWithTasks(ma.user.id, pa.projectId, pa.sessionId, [{ key: "t1" }]);
    const pb = await f.createProjectSession(mb.user.id);
    const gb = await f.createGoalWithTasks(mb.user.id, pb.projectId, pb.sessionId, [{ key: "t1" }]);

    // generate a visible ledger event on each goal (priority change is evented)
    await a.post(`/v1/goals/${ga.goalId}/commands`, { kind: "set_priority", command_id: `c-${randomBytes(4).toString("hex")}`, payload: { priority: 7 } });
    await b.post(`/v1/goals/${gb.goalId}/commands`, { kind: "set_priority", command_id: `c-${randomBytes(4).toString("hex")}`, payload: { priority: 8 } });

    // replay from 0: alice must not see bob's goal events
    const seen = await collectStream(a.cookie, 2500, "?after=0");
    expect(seen.length).toBeGreaterThan(0);
    const goalIds = new Set(seen.map((e) => e.goal_id).filter(Boolean));
    expect(goalIds.has(gb.goalId)).toBe(false);
    expect(goalIds.has(ga.goalId)).toBe(true);

    // admin sees both
    const admin = await loginAs(env, "a30-root");
    const adminSeen = await collectStream(admin.cookie, 2500, "?after=0");
    const adminGoals = new Set(adminSeen.map((e) => e.goal_id).filter(Boolean));
    expect(adminGoals.has(ga.goalId)).toBe(true);
    expect(adminGoals.has(gb.goalId)).toBe(true);
  });

  it("the live tail (no ?after) is scoped the same way", async () => {
    const a = await authedUser(env, "a30-alice2");
    const ma = (await a.get("/v1/me")).json();
    const b = await authedUser(env, "a30-bob2");
    const mb = (await b.get("/v1/me")).json();
    const f = fixture(env);
    const pb = await f.createProjectSession(mb.user.id);
    const gb = await f.createGoalWithTasks(mb.user.id, pb.projectId, pb.sessionId, [{ key: "t1" }]);

    const [seen] = await Promise.all([
      collectStream(a.cookie, 2500),
      (async () => {
        await new Promise((r) => setTimeout(r, 800));
        await b.post(`/v1/goals/${gb.goalId}/commands`, { kind: "set_priority", command_id: `c-${randomBytes(4).toString("hex")}`, payload: { priority: 6 } });
      })(),
    ]);
    expect(seen.every((e: any) => e.goal_id !== gb.goalId)).toBe(true);
  });
});
