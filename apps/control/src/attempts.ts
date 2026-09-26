// Attempts service: worker-facing operations with fencing enforcement.
import { createHash } from "node:crypto";
import { mkdirSync, writeFile } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  CommitPayloadSchema, sha256Hex, artifactUri,
} from "@looplab/contracts";
import { evaluateToolCall } from "@looplab/policy";
import { EventStore } from "./eventstore.js";
import { ObjectStore } from "./objectstore.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";
import type { GoalService } from "./goals.js";

export class FencingError extends Error {
  constructor(public reason: string) { super(reason); this.name = "FencingError"; }
}

const writeFileAsync = promisify(writeFile);

interface AttemptRow {
  id: string; goal_id: string; task_id: string; attempt_no: number;
  worker_id: string | null; status: string; lease_epoch: number;
  spec_digest: string;
}

export class AttemptsService {
  private objects: ObjectStore;

  constructor(private db: Db, private config: Config, private goals: GoalService) {
    this.objects = new ObjectStore(path.join(config.dataDir, "objects"));
  }

  private async requireAttempt(client: any, attemptId: string, workerId: string, leaseEpoch: number, allowedStatuses: string[]): Promise<AttemptRow> {
    const att = (await client.query("SELECT * FROM attempts WHERE id=$1 FOR UPDATE", [attemptId])).rows[0];
    if (!att) throw new FencingError("unknown attempt");
    if (att.worker_id !== workerId) throw new FencingError("worker mismatch");
    if (Number(att.lease_epoch) !== leaseEpoch) throw new FencingError(`stale fencing token (current epoch ${att.lease_epoch})`);
    if (!allowedStatuses.includes(att.status)) throw new FencingError(`attempt status ${att.status}; expected one of ${allowedStatuses.join(",")}`);
    return att;
  }

  async reportStarted(attemptId: string, workerId: string, leaseEpoch: number) {
    return this.db.tx(async (client) => {
      const att = await this.requireAttempt(client, attemptId, workerId, leaseEpoch, ["LEASED"]);
      await client.query("UPDATE attempts SET status='STARTED', heartbeat_at=now() WHERE id=$1", [attemptId]);
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: attemptId, eventType: "attempt.started",
        goalId: att.goal_id, leaseEpoch, actor: { kind: "worker", id: workerId },
      });
    });
  }

  /** Tool execution gate: decision happens BEFORE execution (design §三.5). */
  async authorizeTool(input: { attemptId: string; workerId: string; leaseEpoch: number; tool: string; args: Record<string, unknown> }) {
    return this.db.tx(async (client) => {
      const att = await this.requireAttempt(client, input.attemptId, input.workerId, input.leaseEpoch, ["STARTED", "RUNNING"]);
      // authoritative tool set comes from the frozen spec snapshot stored at claim time
      const spec = (await client.query("SELECT allowed_tools, workspace_dir FROM attempt_specs WHERE attempt_id=$1", [input.attemptId])).rows[0];
      const decision = evaluateToolCall(
        { tool: input.tool, args: input.args },
        { allowedTools: spec?.allowed_tools ?? [], workspaceDir: spec?.workspace_dir ?? path.join(this.config.dataDir, "workspaces", input.attemptId) },
      );
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: input.attemptId,
        eventType: decision.allowed ? "tool.call_authorized" : "tool.call_denied",
        goalId: att.goal_id, leaseEpoch: input.leaseEpoch,
        actor: { kind: "worker", id: input.workerId },
        payload: { tool: input.tool, args_size: JSON.stringify(input.args ?? {}).length, reason: decision.reason },
      });
      return decision;
    });
  }

  async reportToolResult(input: { attemptId: string; workerId: string; leaseEpoch: number; tool: string; ok: boolean; outputDigest: string; outputBytes: number; durationMs: number }) {
    return this.db.tx(async (client) => {
      const att = (await client.query("SELECT * FROM attempts WHERE id=$1", [input.attemptId])).rows[0];
      if (!att) throw new FencingError("unknown attempt");
      if (att.worker_id !== input.workerId || Number(att.lease_epoch) !== input.leaseEpoch) {
        throw new FencingError("stale fencing token");
      }
      // serialize seq assignment per attempt: two concurrent reports would both
      // read MAX(seq)+1 and one would die on the (attempt_id, seq) unique
      // constraint, losing the tool result (P25; same pattern as EventStore)
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tool_results:${input.attemptId}`]);
      await client.query(
        `INSERT INTO tool_results (attempt_id, seq, tool, ok, output_digest, output_bytes, duration_ms, lease_epoch)
         VALUES ($1, (SELECT COALESCE(MAX(seq),0)+1 FROM tool_results WHERE attempt_id=$1), $2,$3,$4,$5,$6,$7)`,
        [input.attemptId, input.tool, input.ok, input.outputDigest, input.outputBytes, input.durationMs, input.leaseEpoch],
      );
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: input.attemptId, eventType: "tool.call_completed",
        goalId: att.goal_id, leaseEpoch: input.leaseEpoch,
        actor: { kind: "worker", id: input.workerId },
        payloadRef: artifactUri(input.outputDigest),
        payload: { tool: input.tool, ok: input.ok, output_bytes: input.outputBytes, duration_ms: input.durationMs },
      });
    });
  }

  async checkpoint(input: {
    attemptId: string; workerId: string; leaseEpoch: number; stepIndex: number;
    summary: string; state: Record<string, unknown>; artifactRefs: string[];
    progressKind: string;
  }) {
    return this.db.tx(async (client) => {
      const att = await this.requireAttempt(client, input.attemptId, input.workerId, input.leaseEpoch, ["STARTED", "RUNNING"]);
      await client.query("UPDATE attempts SET status='RUNNING', heartbeat_at=now() WHERE id=$1", [input.attemptId]);
      const id = `chk_${sha256Hex(input.attemptId + ":" + input.stepIndex + ":" + input.summary).slice(0, 16)}`;
      await client.query(
        `INSERT INTO checkpoints (id, attempt_id, goal_id, task_id, step_index, summary, state, artifact_refs, lease_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [id, input.attemptId, att.goal_id, att.task_id, input.stepIndex, input.summary,
          JSON.stringify(input.state), JSON.stringify(input.artifactRefs), input.leaseEpoch],
      );
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: input.attemptId, eventType: "checkpoint.saved",
        goalId: att.goal_id, leaseEpoch: input.leaseEpoch,
        actor: { kind: "worker", id: input.workerId },
        payload: { step_index: input.stepIndex, summary: input.summary.slice(0, 400), progress_kind: input.progressKind },
      });
      return { checkpointId: id };
    });
  }

  /** Upload an artifact: content-addressed, immutable. Object first, then row. */
  async putArtifact(input: {
    body: Buffer; name: string; mediaType: string; producerRun: string;
    producerRole: string; goalId: string | null; scope: string;
  }) {
    const { digest, size, storageRef } = await this.objects.put(input.body, input.mediaType);
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (digest) DO NOTHING`,
        [digest, input.name, input.mediaType, size, storageRef, input.producerRun, input.producerRole, input.goalId, input.scope],
      );
    });
    return { digest, size_bytes: size };
  }

  /** Commit with fencing + idempotency (A04/A05: only current epoch wins). */
  async commit(input: { workerId: string; payload: unknown }) {
    const body = CommitPayloadSchema.parse(input.payload);
    return this.db.tx(async (client) => {
      // STARTED is a valid commit origin: text-only runs never execute tools
      // and therefore never transition STARTED->RUNNING via a checkpoint
      const att = await this.requireAttempt(client, body.attempt_id, input.workerId, body.lease_epoch,
        ["STARTED", "RUNNING"].includes(body.expected_status) ? [body.expected_status] : ["RUNNING"]);
      // verify artifacts exist in the object store before accepting results
      for (const a of body.artifacts) {
        if (!this.objects.has(a.digest)) throw new FencingError(`artifact ${a.digest} missing from object store`);
      }
      await client.query(
        `UPDATE attempts SET status='COMMITTED', ended_at=now(),
           error_class=$2, heartbeat_at=now(), summary=$3 WHERE id=$1`,
        [body.attempt_id, body.outcome === "FAILED" ? (body.error_class ?? "task_failed") : null,
          // persisted for A2A handoff: successors receive this recorded summary
          body.summary.slice(0, 1000)],
      );
      for (const a of body.artifacts) {
        await client.query(
          `INSERT INTO artifacts (digest, name, media_type, size_bytes, storage_ref, producer_run, producer_role, goal_id, scope)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'task')
           ON CONFLICT (digest) DO NOTHING`,
          [a.digest, a.name, a.media_type, a.size_bytes, `file://${a.digest}`, body.attempt_id, att.worker_id, att.goal_id],
        );
      }
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: body.attempt_id, eventType: "attempt.committed",
        goalId: att.goal_id, leaseEpoch: body.lease_epoch,
        actor: { kind: "worker", id: att.worker_id ?? "" },
        payload: {
          outcome: body.outcome, summary: body.summary.slice(0, 1000),
          artifacts: body.artifacts, usage: body.usage,
          verification: body.verification,
        },
      });
      await this.goals.onAttemptCommitted(client, att, body.outcome, body.summary, body.verification);
      return { committed: true, outcome: body.outcome };
    });
  }

  /** Late/invalid commit: quarantine the payload, never advance state (A04). */
  async quarantineCommit(rawInput: unknown, reason: string) {
    const body = CommitPayloadSchema.safeParse(rawInput);
    await this.db.tx(async (client) => {
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: body.success ? body.data.attempt_id : "unknown",
        eventType: "attempt.late_commit_quarantined",
        actor: { kind: "system", id: "attempts" },
        payload: { reason, summary: body.success ? body.data.summary.slice(0, 200) : "unparseable" },
      });
    });
    return { quarantined: true, reason };
  }

  /** Register artifact rows for files already in the object store (worker upload path). */
  digestOf(data: Buffer) { return sha256Hex(data); }
}
