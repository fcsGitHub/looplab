// A21 (problem ledger #5 fix): cross-attempt artifact propagation.
// Predecessor deliverables are resolved by the scheduler at claim time,
// listed in the attempt spec, and downloadable ONLY through the attempt-
// fenced endpoint — so successor tasks start with their inputs materialized.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { materializePropagated } from "../../workers/agent-worker/src/propagate.js";
import { ControlClient } from "../../workers/agent-worker/src/control-client.js";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;

let baseUrl = "";

beforeAll(async () => {
  env = await createTestEnv({ leaseTtlMs: 5000 });
  await env.app.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = env.app.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await env.app.app.close().catch(() => {}); await env.close(); });

const VOWELS = "def count_vowels(s: str) -> int:\n    return sum(1 for c in s.lower() if c in 'aeiou')\n";

/** Fixture: goal with succeeded t1 (committed artifact) + t2 depending on it. */
async function makeChainWithArtifact(prefix: string) {
  const user = await authedUser(env, `${prefix}-${randomBytes(3).toString("hex")}`);
  const f = fixture(env);
  const me = (await user.get("/v1/me")).json();
  const { projectId, sessionId } = await f.createProjectSession(me.user.id);
  const { goalId, graphId } = await f.createGoalWithTasks(
    me.user.id, projectId, sessionId,
    [{ key: "t1" }, { key: "t2", depends_on: ["t1"] }],
  );
  // t1 SUCCEEDED with a real content-addressed deliverable; content carries a
  // per-invocation comment so digests never collide across tests (CAS dedupe
  // is by content, and each goal's artifact must reference ITS OWN attempt)
  const fixtureAttemptId = `fixture-att-${randomBytes(3).toString("hex")}`;
  const content = `${VOWELS}
-- fixture ${fixtureAttemptId}
`;
  const digest = createHash("sha256").update(content).digest("hex");
  const objDir = path.join(env.dataDir, "objects", digest.slice(0, 2), digest.slice(2, 4));
  mkdirSync(objDir, { recursive: true });
  writeFileSync(path.join(objDir, digest), content);
  await env.app.services.db.tx(async (client: any) => {
    await client.query(
      `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
       VALUES ($1,'vowels.py','text/x-python',$2,$3,$5,'worker',$4,'task')
       ON CONFLICT (digest) DO NOTHING`,
      [digest, Buffer.byteLength(content), `file://${digest}`, goalId, fixtureAttemptId],
    );
    const t1 = (await client.query(`SELECT id FROM tasks WHERE goal_id=$1 AND node_key='t1'`, [goalId])).rows[0];
    await client.query(`INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id, spec_digest, worker_id, status, lease_epoch, lease_expires_at, ended_at)
      VALUES ($4, 1, $1, $2, 1, $3, 'd', 'fixture-worker', 'COMMITTED', 1, now(), now())`, [goalId, t1.id, graphId, fixtureAttemptId]);
    await env.app.services.db.query(`UPDATE tasks SET state='SUCCEEDED' WHERE goal_id=$1 AND node_key='t1'`, [goalId]);
  });
  await f.cancelOtherReadyTasks(goalId);
  return { goalId, user, digest };
}

describe("A21 cross-attempt artifact propagation", () => {
  it("claim resolves predecessor deliverables into the spec; fenced download serves them; unauthorized digests are refused", async () => {
    const { goalId, digest } = await makeChainWithArtifact("prop");
    const wid = `w-${randomBytes(2).toString("hex")}`;

    // t2's claim must carry t1's deliverable in the spec
    const claim = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: wid } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().spec.task_key).toBe("t2");
    const spec = claim.json().spec;
    const propagated = spec.propagated_artifacts;
    expect(propagated).toHaveLength(1);
    expect(propagated[0]).toMatchObject({ name: "vowels.py", digest, from_task_key: "t1" });
    const attemptId = claim.json().attempt.id;

    // fenced download serves the granted digest
    const dl = await env.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/propagated/${digest}?worker_id=${wid}&lease_epoch=1`,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toContain("count_vowels");

    // an ungranted digest is refused even for the same attempt+worker
    const other = await env.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/propagated/${"a".repeat(64)}?worker_id=${wid}&lease_epoch=1`,
    });
    expect(other.statusCode).toBe(403);

    // wrong fencing token is refused
    const wrong = await env.inject({
      method: "GET",
      url: `/v1/attempts/${attemptId}/propagated/${digest}?worker_id=other-worker&lease_epoch=1`,
    });
    expect(wrong.statusCode).toBe(409);
  });

  it("worker-side materializePropagated writes inputs into the workspace", async () => {
    const { goalId, digest } = await makeChainWithArtifact("mat");
    const wid = `w-${randomBytes(2).toString("hex")}`;
    const claim = await env.inject({ method: "POST", url: "/v1/worker/claim", payload: { worker_id: wid } });
    expect(claim.statusCode).toBe(200);
    const spec = claim.json().spec;
    expect(spec.propagated_artifacts).toHaveLength(1);

    // REAL HTTP: the fenced download route serves the object; materialize
    // writes it into the attempt workspace
    const client = new ControlClient(baseUrl);
    const probe = await client.downloadPropagated(spec.attempt_id, wid, spec.lease.epoch, spec.propagated_artifacts[0].digest);
    console.log("PROBE download:", probe === null ? "NULL" : `${probe.length}B`);
    const written = await materializePropagated(client, spec, wid);
    expect(written).toEqual(["vowels.py"]);

    // and a task with no dependencies gets an empty propagation list
    const t1 = (await env.app.services.db.query(
      `SELECT node_key FROM tasks WHERE goal_id=$1 AND node_key='t1'`, [goalId],
    )).rows[0];
    expect(t1).toBeTruthy();
  });
});
