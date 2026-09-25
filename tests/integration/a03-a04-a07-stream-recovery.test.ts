// A03: 浏览器断线并重连 → 从游标恢复，消息和任务不重复。
// A04: 工具完成、结果提交前杀 Worker → 对账后只提交一次有效结果。
// A07: 用户暂停后服务重启 → 目标仍为暂停，不自动复活。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 400 });
});
afterAll(async () => { await env.close(); });

async function startSse(port: number, url: string, cookie?: string): Promise<{ res: Response; lines: () => Promise<string[]>; close: () => void; buffer: string[] }> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { signal: controller.signal, headers: cookie ? { cookie } : {} });
  const buffer: string[] = [];
  let done = false;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buffer.push(decoder.decode(value, { stream: true }));
      }
    } catch { /* aborted */ }
  })();
  const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    res,
    lines: async () => { await waitMs(50); return buffer.join("").split("\n"); },
    close: () => { done = true; controller.abort(); },
    buffer,
  };
}

function parseSseEvents(lines: string[]): { event_id: string; seq: number }[] {
  const events: { event_id: string; seq: number }[] = [];
  for (const line of lines) {
    const m = line.match(/^id: (\d+)$/);
    if (m) events.push({ event_id: m[1], seq: Number(m[1]) });
  }
  return events;
}

describe("A03 SSE cursor replay", () => {
  it("replays from cursor without duplicates after reconnect", async () => {
    await env.app.app.listen({ port: 0 });
    const addr = env.app.app.server?.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const user = await authedUser(env, "sse-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [{ key: "t1" }]);

    // connection 1: read from head
    const s1 = await startSse(port, `/v1/events?goal_id=${goalId}`, user.cookie);
    await new Promise((r) => setTimeout(r, 1200));
    // generate 3 events while connected
    for (let i = 0; i < 3; i++) {
      await user.post(`/v1/goals/${goalId}/commands`, { kind: "steer", payload: { content: `x${i}` }, command_id: `c${i}` });
    }
    await new Promise((r) => setTimeout(r, 1800));
    const lines1 = await s1.lines();
    s1.close();

    const head = parseSseEvents(lines1);
    expect(head.length).toBeGreaterThanOrEqual(3);
    const lastSeq = head[head.length - 1].seq;

    // generate 2 more events while "disconnected"
    const pauseRes = await user.post(`/v1/goals/${goalId}/commands`, { kind: "pause", command_id: "pause-1" });
    const resumeRes = await user.post(`/v1/goals/${goalId}/commands`, { kind: "resume", command_id: "resume-1" });
    if (pauseRes.statusCode !== 202 || resumeRes.statusCode !== 202) {
      throw new Error(`commands failed: ${pauseRes.statusCode}/${resumeRes.statusCode} ${pauseRes.body}`);
    }
    await new Promise((r) => setTimeout(r, 1200));

    // connection 2: reconnect from last cursor
    const s2 = await startSse(port, `/v1/events?after=${lastSeq}&goal_id=${goalId}`, user.cookie);
    await new Promise((r) => setTimeout(r, 2500));
    const lines2 = await s2.lines();
    s2.close();

    const tail = parseSseEvents(lines2);
    // no duplicates: every tail seq > lastSeq
    for (const e of tail) expect(e.seq).toBeGreaterThan(lastSeq);
    // and the pause+resume events were recovered
    const bodies = lines2.filter((l) => l.startsWith("data: "));
    const joined = bodies.join("\n");
    expect(joined).toContain("goal.paused");
    expect(joined).toContain("goal.resumed");
    // cancel this goal's tasks so later tests in this file claim their own goals
    await env.app.services.db.query(
      "UPDATE tasks SET state='CANCELLED' WHERE goal_id=$1 AND state IN ('READY','WAITING')", [goalId],
    );
  });
});

describe("A04 late worker after artifact upload", () => {
  it("commits the result exactly once; late commit is quarantined", async () => {
    const user = await authedUser(env, "late-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [{ key: "t1" }]);

    await f.cancelOtherReadyTasks(goalId);
    // worker A claims, starts, uploads an artifact (external effect), no commit
    const claimA = await user.post("/v1/worker/claim", { worker_id: "worker-a" });
    expect(claimA.statusCode).toBe(200);
    expect(claimA.json().spec.goal_id).toBe(goalId);
    const attemptA = claimA.json().attempt.id;
    await user.post(`/v1/attempts/${attemptA}/start`, { worker_id: "worker-a", lease_epoch: 1 });

    // upload artifact via inject (binary; worker-facing endpoint, no cookie needed)
    const artifactBody = Buffer.from("experiment-result: 42");
    const upRes = await env.inject({
      method: "POST", url: "/v1/artifacts",
      headers: {
        "content-type": "application/octet-stream",
        "x-artifact-name": "result.txt",
        "x-artifact-media-type": "text/plain",
        "x-attempt-id": attemptA,
        "x-goal-id": goalId,
      },
      payload: artifactBody,
    });
    expect(upRes.statusCode).toBe(200);
    const digest = upRes.json().digest;

    // worker A dies before commit: lease expires -> LOST -> task rescheduled
    await f.expireLease(attemptA);
    const rec = await env.app.services.scheduler.reconcileExpiredLeases();
    expect(rec.lost).toBeGreaterThanOrEqual(1);

    // worker B retries and commits with the same artifact
    const claimB = await user.post("/v1/worker/claim", { worker_id: "worker-b" });
    expect(claimB.statusCode).toBe(200);
    const attemptB = claimB.json().attempt.id;
    await user.post(`/v1/attempts/${attemptB}/start`, { worker_id: "worker-b", lease_epoch: 1 });
    await user.post(`/v1/attempts/${attemptB}/checkpoint`, { worker_id: "worker-b", lease_epoch: 1, step_index: 1, summary: "progress", state: {}, progress_kind: "tool_progress" });
    const commitB = await user.post(`/v1/attempts/${attemptB}/commit`, {
      worker_id: "worker-b", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptB, outcome: "SUCCEEDED",
      summary: "redelivered result", artifacts: [{ name: "result.txt", media_type: "text/plain", digest, size_bytes: artifactBody.byteLength }],
      usage: { model_calls: 2, prompt_tokens: 10, completion_tokens: 5, estimated_cost_usd: 0.001, unknown_settlement: false },
      verification: { kind: "rerun", passed: true, detail: "verified artifact" },
    });
    expect(commitB.statusCode).toBe(200);

    // NOW the late worker A (old epoch) tries to commit the same result
    const lateA = await user.post(`/v1/attempts/${attemptA}/commit`, {
      worker_id: "worker-a", lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: attemptA, outcome: "SUCCEEDED", summary: "duplicate from dead worker",
      artifacts: [{ name: "result.txt", media_type: "text/plain", digest, size_bytes: artifactBody.byteLength }],
      usage: { model_calls: 0, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: null,
    });
    expect(lateA.statusCode).toBe(409);
    expect(lateA.json().quarantined).toBe(true);

    // exactly one effective commit advanced the task
    const tasks = await user.get(`/v1/goals/${goalId}/tasks`);
    const succeeded = tasks.json().tasks.filter((t: any) => t.state === "SUCCEEDED").length;
    expect(succeeded).toBe(1);
    // quarantine event recorded
    const evs = await env.app.services.db.query(
      "SELECT count(*)::int AS n FROM events WHERE event_type='attempt.late_commit_quarantined'",
    );
    expect(evs.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe("A07 user pause survives restart", () => {
  it("keeps PAUSED_USER after a full control-service restart; no auto resume", async () => {
    const user = await authedUser(env, "pause-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [{ key: "t1" }]);

    await f.cancelOtherReadyTasks(goalId);
    // a task is claimed before pausing
    const claim = await user.post("/v1/worker/claim", { worker_id: "worker-p" });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().spec.goal_id).toBe(goalId);
    const attemptId = claim.json().attempt.id;

    const pause = await user.post(`/v1/goals/${goalId}/commands`, { kind: "pause", command_id: "p-1" });
    expect(pause.statusCode).toBe(202);
    expect(pause.json().applied).toBe(true);

    // "restart": recreate the whole app against the same DB
    const { buildApp } = await import("../../apps/control/src/app.js");
    const fresh = await buildApp({
      databaseUrl: env.dbUrl,
      dataDir: env.dataDir,
      sealedDir: `${env.dataDir}/sealed`,
      port: 0,
      deepseek: env.app.config.deepseek,
    });

    // goal is still PAUSED_USER
    const g = await fresh.services.db.query("SELECT state FROM goals WHERE id=$1", [goalId]);
    expect(g.rows[0].state).toBe("PAUSED_USER");

    // the scheduler of the fresh instance does NOT claim tasks of the paused goal
    const job = await fresh.services.scheduler.claim("fresh-worker");
    // claim may return another goal's task or null; ensure it never returns OUR goal's task
    if (job) expect(job.spec.goal_id).not.toBe(goalId);

    // heartbeat of the pre-pause attempt asks for drain (finish, don't start new work)
    const hb = await env.inject({
      method: "POST", url: `/v1/attempts/${attemptId}/heartbeat`,
      payload: { worker_id: "worker-p", lease_epoch: 1 },
    });
    expect(hb.json().action).toBe("drain");

    // resume works only by explicit command
    const resume = await user.post(`/v1/goals/${goalId}/commands`, { kind: "resume", command_id: "r-1" });
    expect(resume.statusCode).toBe(202);
    const after = await fresh.services.db.query("SELECT state FROM goals WHERE id=$1", [goalId]);
    expect(after.rows[0].state).toBe("ACTIVE");

    await fresh.services.orchestrator.stop();
    await fresh.app.close();
    await fresh.services.db.close();
    // clean up our goal so no later test claims its tasks
    await env.app.services.db.query(
      "UPDATE tasks SET state='CANCELLED' WHERE goal_id=$1 AND state IN ('READY','WAITING')", [goalId],
    );
  });
});
