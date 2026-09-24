// A23 (problem ledger #2): SSE reconnect ACROSS a control-service restart.
// The old instance is killed while a client is streaming (server-side socket
// teardown — what a process kill does); a fresh instance opens against the
// same DB. The client reconnects with its old cursor and must receive every
// event committed after that cursor EXACTLY ONCE and in seq order —
// including events the old instance committed but never flushed (the
// in-flight window a restart creates) and events written after the new
// instance is up. The standard Last-Event-ID header resume path is covered
// too, so any native EventSource client survives restarts, not just our hook.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/control/src/app.js";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
});
afterAll(async () => { await env.close(); });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Inst = Awaited<ReturnType<typeof buildApp>>;

async function startInstance(): Promise<{ inst: Inst; port: number }> {
  const inst = await buildApp({
    databaseUrl: env.dbUrl,
    dataDir: env.dataDir,
    sealedDir: `${env.dataDir}/sealed`,
    port: 0,
    deepseek: env.app.config.deepseek,
  });
  await inst.app.listen({ port: 0 });
  const addr = inst.app.server?.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { inst, port };
}

/** Force-kill every open socket, then shut the instance down (process-kill analog). */
async function killInstance(inst: Inst) {
  await inst.services.orchestrator.stop();
  (inst.app.server as any)?.closeAllConnections?.();
  await inst.app.close();
  await inst.services.db.close();
}

/** Minimal SSE consumer: collects raw lines until server or client closes. */
function sseClient(port: number, url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const buffer: string[] = [];
  let done = false;
  let serverClosed = false;
  const ready = (async () => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      signal: controller.signal, headers,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        while (!done) {
          const { value, done: d } = await reader.read();
          if (d) { serverClosed = true; break; }
          buffer.push(decoder.decode(value, { stream: true }));
        }
      } catch { serverClosed = true; }
    })();
    return res;
  })();
  return {
    ready,
    serverClosed: () => serverClosed,
    lines: async () => { await wait(50); return buffer.join("").split("\n"); },
    close: () => { done = true; controller.abort(); },
  };
}

function receivedIds(lines: string[]): number[] {
  const ids: number[] = [];
  for (const l of lines) {
    const m = l.match(/^id: (\d+)$/);
    if (m) ids.push(Number(m[1]));
  }
  return ids;
}

async function maxSeq(): Promise<bigint> {
  return BigInt(String((await env.app.services.db.query(
    "SELECT COALESCE(MAX(seq),0) AS s FROM events",
  )).rows[0].s));
}

async function waitForServerClose(c: ReturnType<typeof sseClient>) {
  // best-effort: when the client runtime surfaces the dead socket varies
  // (undici vs browser EventSource); the platform contract is cursor
  // correctness, asserted against the DB below, not transport telemetry.
  for (let i = 0; i < 20 && !c.serverClosed(); i++) await wait(100);
  return c.serverClosed();
}

describe("A23 SSE reconnect across control restart", () => {
  it("old instance dies mid-stream: cursor replay on the new instance has no gaps and no duplicates", async () => {
    const { inst: inst1, port: port1 } = await startInstance();
    const user = await authedUser(env, "sse-restart");
    const f = fixture(env);
    const me = (await user.get("/v1/me")).json();
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const { goalId } = await f.createGoalWithTasks(
      me.user.id, projectId, sessionId, [{ key: "t1" }],
    );

    // client connects to instance #1 with an EXPLICIT known watermark
    const watermark = await maxSeq();
    const c1 = sseClient(port1, `/v1/events?after=${watermark}&goal_id=${goalId}`, { cookie: user.cookie });
    const res1 = await c1.ready;
    expect(res1.status).toBe(200);

    // instance #1 commits events, then DIES before we know what was flushed
    for (let i = 0; i < 2; i++) {
      const r = await inst1.app.inject({
        method: "POST", url: `/v1/goals/${goalId}/commands`,
        headers: { cookie: user.cookie },
        payload: { kind: "steer", payload: { content: `pre-kill-${i}` }, command_id: `pre-${i}` },
      });
      expect(r.statusCode).toBe(202);
    }
    await killInstance(inst1); // in-flight window: client cursor is now stale
    await waitForServerClose(c1);
    c1.close();
    const seen = receivedIds(await c1.lines());
    const cursor = seen.length ? seen[seen.length - 1] : watermark; // what the client actually has

    // fresh instance against the same DB; user keeps working
    const { inst: inst2, port: port2 } = await startInstance();
    try {
      for (let i = 0; i < 2; i++) {
        const r = await inst2.app.inject({
          method: "POST", url: `/v1/goals/${goalId}/commands`,
          headers: { cookie: user.cookie },
          payload: { kind: "steer", payload: { content: `post-restart-${i}` }, command_id: `post-${i}` },
        });
        expect(r.statusCode).toBe(202);
      }

      // reconnect with the OLD cursor (?after= form, as our frontend hook does)
      const c2 = sseClient(port2, `/v1/events?after=${cursor}&goal_id=${goalId}`, { cookie: user.cookie });
      expect((await c2.ready).status).toBe(200);
      await wait(2500); // catch-up poll + at least one live poll
      const got = receivedIds(await c2.lines());
      c2.close();

      // DB is the only truth: exactly the events after the cursor, in order
      const expected = (await env.app.services.db.query(
        "SELECT seq FROM events WHERE goal_id=$1 AND seq > $2 ORDER BY seq",
        [goalId, cursor],
      )).rows.map((r: any) => Number(r.seq));
      expect(expected.length).toBeGreaterThanOrEqual(4); // pre-kill + post-restart steers
      expect(got).toEqual(expected); // no gap, no duplicate, ordered

      // standard Last-Event-ID resume: same tail without ?after
      const c3 = sseClient(port2, `/v1/events?goal_id=${goalId}`, {
        cookie: user.cookie, "last-event-id": String(cursor),
      });
      expect((await c3.ready).status).toBe(200);
      await wait(2500);
      const got3 = receivedIds(await c3.lines());
      c3.close();
      expect(got3).toEqual(expected);
    } finally {
      await killInstance(inst2);
    }
  });
});
