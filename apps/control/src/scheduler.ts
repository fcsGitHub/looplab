// Scheduler: the ONE scheduling authority (design §三.2).
// Claim = transactional: SKIP LOCKED on READY tasks + budget headroom check +
// lease epoch + outbox entry, all in one tx. Recovery = fencing-token bump;
// late workers are rejected by epoch mismatch (A05), lost RESULT_PENDING
// attempts force RECONCILE_REQUIRED instead of blind retry (A04).
import { createHash } from "node:crypto";
import path from "node:path";
import {
  RunSpecSchema, newId, canTransition, InvalidTransitionError,
  type RunSpec, type TaskNode, type ToolSpec,
} from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import { BudgetService } from "./budget.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

export interface ClaimedJob {
  attempt: {
    id: string; task_id: string; attempt_no: number; lease_epoch: number;
    goal_id: string; status: string;
  };
  spec: RunSpec;
}

const ROLE_TOOLSETS: Record<string, { name: string; description: string; input_schema: Record<string, unknown>; risk: "low" | "medium" | "high" }[]> = {
  // All roles get workspace + python. Network/file-outside-workspace tools do
  // not exist in the default allowlist; adding one requires a goal contract.
  default: [
    {
      name: "workspace_write",
      description: "Write a text file into the attempt workspace (relative path).",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      risk: "low",
    },
    {
      name: "workspace_read",
      description: "Read a text file from the attempt workspace (relative path).",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      risk: "low",
    },
    {
      name: "workspace_list",
      description: "List files in the attempt workspace.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      risk: "low",
    },
    {
      name: "run_python",
      description: "Execute a Python 3 script in a sandboxed child process with time/output limits. stdout+stderr returned.",
      input_schema: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
      risk: "medium",
    },
  ],
};

export class Scheduler {
  private budget: BudgetService;

  constructor(private db: Db, private config: Config) {
    this.budget = new BudgetService(db as any);
  }

  /**
   * Claim the next executable task for a worker. Returns null when nothing is
   * claimable (no busy-wait model calls: the worker just sleeps and re-polls).
   */
  async claim(workerId: string): Promise<ClaimedJob | null> {
    return this.db.tx(async (client) => {
      // Candidate rows: READY tasks on ACTIVE goals with deps satisfied.
      const rows = await client.query(
        `SELECT t.*, g.state AS goal_state, g.current_version AS goal_version
           FROM tasks t
           JOIN goals g ON g.id = t.goal_id
          WHERE (t.state = 'READY' OR (t.state = 'FAILED' AND t.failure_count < 3))
            AND g.state = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1 FROM tasks d
               WHERE d.graph_version_id = t.graph_version_id
                 AND d.node_key = ANY (t.depends_on)
                 AND d.state <> 'SUCCEEDED')
          ORDER BY t.created_at ASC
          LIMIT 10
          FOR UPDATE OF t SKIP LOCKED`,
      );
      for (const task of rows.rows) {
        // budget headroom: refuse claim when goal budget is exhausted (A08)
        const snap = await this.budget.snapshot(client, task.goal_id);
        if (snap.available < 0.001) {
          await this.maybeWaitForResource(client, task.goal_id);
          continue;
        }
        const attempt = await this.createAttempt(client, task, workerId);
        return attempt;
      }
      return null;
    });
  }

  private async maybeWaitForResource(client: any, goalId: string) {
    // flip ACTIVE -> WAITING_RESOURCE once; reversible when budget frees up
    await client.query(
      `UPDATE goals SET state='WAITING_RESOURCE', paused_reason='budget_exhausted',
              updated_at=now(), row_version=row_version+1
        WHERE id=$1 AND state='ACTIVE'`,
      [goalId],
    );
    await EventStore.append(client, {
      aggregateType: "goal", aggregateId: goalId, eventType: "goal.waiting_resource",
      goalId, payload: { reason: "budget_exhausted" }, actor: { kind: "system", id: "scheduler" },
    });
  }

  private async createAttempt(client: any, task: any, workerId: string): Promise<ClaimedJob> {
    const attemptId = newId("att");
    const attemptNo = await client.query(
      "SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM attempts WHERE task_id=$1",
      [task.id],
    ).then((r: any) => r.rows[0].n);

    const tools: ToolSpec[] = ROLE_TOOLSETS[task.role] ?? ROLE_TOOLSETS.default!;
    const workspaceDir = path.join(this.config.dataDir, "workspaces", attemptId);
    const spec: RunSpec = RunSpecSchema.parse({
      spec_version: "1",
      attempt_id: attemptId,
      task_id: task.id,
      task_key: task.node_key,
      goal_id: task.goal_id,
      goal_version: task.goal_version,
      graph_version: task.graph_version_id,
      role: task.role,
      objective: task.title,
      task_title: task.title,
      task_instruction: task.instruction,
      input_refs: task.input_refs ?? [],
      parent_asset_digests: [],
      model: {
        provider: "deepseek",
        model: this.config.deepseek.chatModel,
        credential_ref: "server://deepseek/default",
        max_tokens: 2048,
        temperature: 0.4,
      },
      allowed_tools: tools,
      resource_limits: {
        max_steps: 16,
        max_tool_calls: 24,
        wall_clock_ms: 10 * 60_000,
        tool_timeout_ms: 60_000,
        max_output_bytes: 256 * 1024,
        max_child_processes: 4,
      },
      budget: {
        budget_id: `budget_${attemptId}`,
        max_model_calls: 64,
        max_cost_usd: 1.0,
        cost_per_call_reserve_usd: 0.02,
      },
      lease: {
        epoch: 1,
        heartbeat_interval_ms: this.config.workerHeartbeatMs,
        ttl_ms: this.config.leaseTtlMs,
      },
      sandbox: { workspace_dir: workspaceDir, python_executable: "python" },
      steering_mode: "next_turn",
    });
    const specDigest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");

    await client.query(
      `INSERT INTO attempts (id, run_no, goal_id, task_id, attempt_no, graph_version_id,
         spec_digest, worker_id, status, lease_epoch, lease_expires_at, heartbeat_at, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'LEASED',1, now() + make_interval(secs => $9), now(), now())`,
      [attemptId, 1, task.goal_id, task.id, attemptNo, task.graph_version_id, specDigest, workerId, this.config.leaseTtlMs / 1000],
    );
    // frozen spec snapshot: the authority for tool gating after claim
    await client.query(
      `INSERT INTO attempt_specs (attempt_id, spec, allowed_tools, workspace_dir)
       VALUES ($1,$2,$3,$4)`,
      [attemptId, JSON.stringify(spec), JSON.stringify(spec.allowed_tools), workspaceDir],
    );
    await client.query(
      `UPDATE tasks SET state='RUNNING', visit_count=visit_count+1, updated_at=now() WHERE id=$1`,
      [task.id],
    );
    await EventStore.append(client, {
      aggregateType: "attempt", aggregateId: attemptId, eventType: "attempt.leased",
      goalId: task.goal_id, goalVersion: task.goal_version, leaseEpoch: 1,
      actor: { kind: "system", id: "scheduler" },
      payload: { task_id: task.id, task_key: task.node_key, worker_id: workerId, attempt_no: attemptNo, spec_digest: specDigest },
      causationId: attemptId,
    });
    return {
      attempt: { id: attemptId, task_id: task.id, attempt_no: attemptNo, lease_epoch: 1, goal_id: task.goal_id, status: "LEASED" },
      spec,
    };
  }

  // ---- heartbeats & lease extension ---------------------------------------
  async heartbeat(attemptId: string, workerId: string, leaseEpoch: number) {
    return this.db.tx(async (client) => {
      const res = await client.query(
        "SELECT * FROM attempts WHERE id=$1 FOR UPDATE",
        [attemptId],
      );
      const att = res.rows[0];
      if (!att) return { action: "abort" as const, reason: "unknown attempt", pending_steers: [] };
      if (att.worker_id !== workerId || att.lease_epoch !== leaseEpoch) {
        return { action: "abort" as const, reason: "fencing token stale (superseded)", pending_steers: [] };
      }
      if (["COMMITTED", "LOST", "RECONCILE_REQUIRED", "ABORTED"].includes(att.status)) {
        return { action: "abort" as const, reason: `attempt ${att.status}`, pending_steers: [] };
      }
      await client.query(
        `UPDATE attempts SET heartbeat_at=now(),
           lease_expires_at = now() + make_interval(secs => $2)
         WHERE id=$1`,
        [attemptId, this.config.leaseTtlMs / 1000],
      );
      const goal = await client.query("SELECT state FROM goals WHERE id=$1", [att.goal_id]);
      const goalState = goal.rows[0]?.state;
      if (goalState === "PAUSED_USER") {
        return { action: "drain" as const, reason: "PAUSED_USER", pending_steers: [] };
      }
      if (goalState === "CANCELLED") {
        return { action: "abort" as const, reason: "CANCELLED", pending_steers: [] };
      }
      const steers = await client.query(
        `UPDATE steers SET status='PENDING' WHERE goal_id=$1 AND attempt_id=$2 AND status='PENDING' RETURNING id, content`,
        // note: we don't mark delivered here; worker confirms delivery
        [att.goal_id, attemptId],
      ).then(async (r: any) => {
        void r;
        return (await client.query(
          "SELECT id, content FROM steers WHERE goal_id=$1 AND attempt_id=$2 AND status='PENDING' ORDER BY created_at",
          [att.goal_id, attemptId],
        )).rows;
      });
      return { action: "continue" as const, reason: null as string | null, pending_steers: steers };
    });
  }

  async confirmSteerDelivered(attemptId: string, steerId: string, workerId: string, leaseEpoch: number) {
    return this.db.tx(async (client) => {
      const att = (await client.query("SELECT * FROM attempts WHERE id=$1", [attemptId])).rows[0];
      if (!att || att.worker_id !== workerId || att.lease_epoch !== leaseEpoch) {
        return { ok: false, reason: "fencing mismatch" };
      }
      const st = (await client.query("SELECT * FROM steers WHERE id=$1 FOR UPDATE", [steerId])).rows[0];
      if (!st || st.status === "DELIVERED") return { ok: false, reason: "already delivered or unknown" };
      await client.query("UPDATE steers SET status='DELIVERED', delivered_at=now() WHERE id=$1", [steerId]);
      await EventStore.append(client, {
        aggregateType: "attempt", aggregateId: attemptId, eventType: "steer.applied",
        goalId: att.goal_id, leaseEpoch, actor: { kind: "worker", id: workerId },
        payload: { steer_id: steerId }, causationId: steerId,
      });
      return { ok: true };
    });
  }

  // ---- recovery: expired leases (design §15.2) ------------------------------
  async reconcileExpiredLeases(): Promise<{ lost: number; reconcileRequired: number }> {
    return this.db.tx(async (client) => {
      const expired = await client.query(
        `SELECT * FROM attempts
          WHERE status IN ('LEASED','STARTED','RUNNING','RESULT_PENDING')
            AND lease_expires_at < now()
          FOR UPDATE SKIP LOCKED`,
      );
      let lost = 0, reconcileRequired = 0;
      for (const att of expired.rows) {
        const nextStatus = att.status === "RESULT_PENDING" ? "RECONCILE_REQUIRED" : "LOST";
        await client.query(
          `UPDATE attempts SET status=$2, lease_epoch=lease_epoch+1, ended_at=now(),
             error_class=$3 WHERE id=$1`,
          [att.id, nextStatus, nextStatus === "LOST" ? "worker_lost" : "external_outcome_unknown"],
        );
        if (nextStatus === "LOST") {
          await this.rescheduleOrDiagnose(client, att.task_id, "worker_lost");
          lost++;
        } else {
          reconcileRequired++;
          // create reconciliation task instead of blind retry
          await client.query(
            `UPDATE tasks SET state='WAITING', updated_at=now() WHERE id=$1`,
            [att.task_id],
          );
          await EventStore.append(client, {
            aggregateType: "attempt", aggregateId: att.id, eventType: "attempt.reconcile_required",
            goalId: att.goal_id, leaseEpoch: att.lease_epoch + 1,
            actor: { kind: "system", id: "supervisor" },
            payload: { reason: "worker lost while external outcome unknown; manual/agent reconciliation required" },
          });
        }
        await EventStore.append(client, {
          aggregateType: "attempt", aggregateId: att.id, eventType: "attempt.lost",
          goalId: att.goal_id, leaseEpoch: att.lease_epoch + 1,
          actor: { kind: "system", id: "supervisor" },
          payload: { previous_status: att.status, worker_id: att.worker_id },
        });
      }
      return { lost, reconcileRequired };
    });
  }

  /** Same-error retry limiting (A13): 3 identical fingerprints -> diagnosis. */
  private async rescheduleOrDiagnose(client: any, taskId: string, errorClass: string) {
    const task = (await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId])).rows[0];
    if (!task) return;
    const fingerprint = `${errorClass}:${task.node_key}`;
    const failCount = task.failure_count + 1;
    await client.query(
      `UPDATE tasks SET failure_count=$2, error_fingerprint=$3, state=$4, updated_at=now() WHERE id=$1`,
      [taskId, failCount, fingerprint, failCount >= 3 ? "WAITING" : "READY"],
    );
    if (failCount >= 3) {
      // create a diagnosis task (role Coordinator) instead of retrying blind
      const diagId = newId("task");
      await client.query(
        `INSERT INTO tasks (id, graph_version_id, goal_id, node_key, role, kind, title, instruction, risk_class, state)
         VALUES ($1,$2,$3,$4,'Coordinator','integration',$5,$6,'low','READY')`,
        [
          diagId, task.graph_version_id, task.goal_id,
          `diagnose_${task.node_key}_${Date.now()}`,
          `诊断重复失败: ${task.title}`,
          `任务「${task.title}」已经以相同错误失败 ${failCount} 次（错误类别 ${errorClass}）。请分析根因并产出：1) 根因假设 2) 修复建议（最小补丁或改路线）3) 是否应放弃该分支。禁止原样重试。`,
        ],
      );
      await EventStore.append(client, {
        aggregateType: "task", aggregateId: taskId, eventType: "task.retry_loop_diagnosed",
        goalId: task.goal_id, actor: { kind: "system", id: "supervisor" },
        payload: { failure_count: failCount, error_fingerprint: fingerprint, diagnosis_task: diagId },
      });
    } else {
      await EventStore.append(client, {
        aggregateType: "task", aggregateId: taskId, eventType: "task.rescheduled",
        goalId: task.goal_id, actor: { kind: "system", id: "supervisor" },
        payload: { failure_count: failCount, error_class: errorClass, next_attempt: "READY" },
      });
    }
  }
}
