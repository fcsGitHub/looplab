// Deterministic supervisor loop (design §15): lease reconciliation, budget
// wake-ups, async command application, stall watchdog. NO LLM here —
// supervision is rule-based.
import { Scheduler } from "./scheduler.js";
import { GoalService } from "./goals.js";
import { EventStore } from "./eventstore.js";
import type { Db } from "./db.js";

/** A goal may not loop diagnose→approve→revise forever (P25 anti-loop brake). */
const MAX_APPLIED_REVISIONS_PER_GOAL = 8;

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  lastReconcileAt: Date | null = null;
  lastError: string | null = null;
  reconcileCounts = { lost: 0, reconcileRequired: 0 };
  stallCounts = { flagged: 0 };
  /** goals seen stalled on the previous tick — two consecutive ticks confirm */
  private stallCandidates = new Map<string, number>();
  private tickCount = 0;
  private stallDwellMs: number;

  constructor(private db: Db, private scheduler: Scheduler, private goals: GoalService, stallDwellMs = 15_000) {
    this.stallDwellMs = stallDwellMs;
  }

  start(intervalMs = 3000) {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    this.tickCount++;
    // 1) expired leases -> LOST / RECONCILE_REQUIRED (A04/A05)
    const rec = await this.scheduler.reconcileExpiredLeases();
    this.reconcileCounts.lost += rec.lost;
    this.reconcileCounts.reconcileRequired += rec.reconcileRequired;
    this.lastReconcileAt = new Date();

    // 2) WAITING_RESOURCE goals auto-resume only within the same authorization
    const waiting = await this.db.query("SELECT id FROM goals WHERE state='WAITING_RESOURCE' LIMIT 20");
    for (const row of waiting.rows) {
      await this.goals.autoResumeFromWaiting(row.id);
    }

    // 3) accepted-but-not-applied revise commands (planning happens async)
    const revisions = await this.db.query(
      `SELECT c.id AS command_row_id, c.goal_id, c.payload->>'content' AS content,
              c.payload->'graph' AS provided_graph, c.actor->>'id' AS user_id
         FROM commands c WHERE c.kind='revise' AND c.status='ACCEPTED'
        ORDER BY c.created_at LIMIT 5`,
    );
    for (const r of revisions.rows) {
      if (!r.content) continue;
      // anti-loop brake: cap applied revisions per goal, then demand a human
      // who has actually looked at the loop (BLOCKED_INPUT with the reason)
      const applied = Number((await this.db.query(
        `SELECT count(*)::int AS n FROM commands WHERE goal_id=$1 AND kind='revise' AND status='APPLIED'`,
        [r.goal_id],
      )).rows[0]?.n ?? 0);
      if (applied >= MAX_APPLIED_REVISIONS_PER_GOAL) {
        const reason = `revise cap reached (${applied} applied revisions); goal parked for human review`;
        await this.db.tx(async (client) => {
          await client.query(
            `UPDATE commands SET status='FAILED', reject_reason=$2 WHERE id=$1`,
            [r.command_row_id, reason],
          );
          await client.query(
            `UPDATE goals SET state='BLOCKED_INPUT', paused_reason='revise_cap', updated_at=now(), row_version=row_version+1
              WHERE id=$1 AND state IN ('ACTIVE','WAITING_RESOURCE')`,
            [r.goal_id],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: r.goal_id, eventType: "goal.revise_capped",
            goalId: r.goal_id, actor: { kind: "system", id: "orchestrator" },
            payload: { reason, applied_revisions: applied },
          });
        });
        continue;
      }
      try {
        // payload.graph (explicit user/agent edit) takes precedence over
        // re-planning; applyRevision validates it via compileGraph
        await this.goals.applyRevision(r.goal_id, r.content, r.user_id ?? "system", r.provided_graph ?? undefined, r.command_row_id);
      } catch (err) {
        // an invalid explicit graph must not wedge the orchestrator: record
        // the failure on THIS command (by row id — the old goal-wide sweep
        // also killed unrelated pending revises) and keep ticking
        const reason = err instanceof Error ? err.message.slice(0, 300) : String(err);
        await this.db.tx(async (client) => {
          await client.query(
            `UPDATE commands SET status='FAILED', reject_reason=$2 WHERE id=$1`,
            [r.command_row_id, reason],
          );
          await EventStore.append(client, {
            aggregateType: "goal", aggregateId: r.goal_id, eventType: "goal.revise_failed",
            goalId: r.goal_id, actor: { kind: "system", id: "orchestrator" },
            payload: { reason },
          });
        });
      }
    }

    // 4) stall watchdog (P25): an ACTIVE goal with nothing claimable, nothing
    //    live and no pending approval is silently parked — it used to stay
    //    ACTIVE forever. Two consecutive ticks confirm, then the goal flips to
    //    BLOCKED_INPUT with a ledger event explaining why. The user answers
    //    with revise/resume; the loop never spins on it silently again.
    await this.runStallWatchdog();

    // 5) housekeeping: purge long-expired sessions (bounded, every ~3 min)
    if (this.tickCount % 60 === 0) {
      await this.db.query(
        `DELETE FROM auth_sessions WHERE id IN (
           SELECT id FROM auth_sessions WHERE expires_at < now() - interval '7 days' LIMIT 500)`,
      );
    }
    this.lastError = null;
  }

  private async runStallWatchdog(): Promise<void> {
    const stalled = await this.db.query(
      `SELECT g.id, g.title,
              (SELECT count(*)::int FROM tasks t WHERE t.goal_id=g.id AND t.state='WAITING') AS waiting_tasks,
              (SELECT count(*)::int FROM tasks t WHERE t.goal_id=g.id AND t.state='FAILED') AS failed_tasks,
              (SELECT count(*)::int FROM tasks t WHERE t.goal_id=g.id) AS total_tasks
         FROM goals g
        WHERE g.state='ACTIVE'
          AND NOT EXISTS (
            SELECT 1 FROM tasks t WHERE t.goal_id=g.id
              AND (t.state IN ('READY','RUNNING') OR (t.state='FAILED' AND t.failure_count < 3)))
          AND NOT EXISTS (
            SELECT 1 FROM attempts a WHERE a.goal_id=g.id
              AND a.status IN ('LEASED','STARTED','RUNNING','RESULT_PENDING'))
          AND NOT EXISTS (
            SELECT 1 FROM approvals p WHERE p.goal_id=g.id AND p.status='PENDING')
        LIMIT 50`,
    );
    const seen = new Set<string>();
    for (const row of stalled.rows) {
      seen.add(row.id);
      const first = this.stallCandidates.get(row.id);
      if (first == null) {
        this.stallCandidates.set(row.id, Date.now());
        continue;
      }
      // confirmed on a later tick (and beyond the dwell window — larger than
      // any single transactional gap between task state and its successor)
      if (Date.now() - first < this.stallDwellMs) continue;
      const detail = {
        waiting_tasks: row.waiting_tasks,
        failed_tasks: row.failed_tasks,
        total_tasks: row.total_tasks,
        note: "nothing claimable, no live attempts, no pending approval — user input needed (revise, resume or cancel)",
      };
      await this.db.tx(async (client) => {
        const updated = await client.query(
          `UPDATE goals SET state='BLOCKED_INPUT', paused_reason='stalled_no_progress',
                  updated_at=now(), row_version=row_version+1
            WHERE id=$1 AND state='ACTIVE' RETURNING id`,
          [row.id],
        );
        if (!updated.rows.length) return;
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: row.id, eventType: "goal.stalled",
          goalId: row.id, actor: { kind: "system", id: "stall-watchdog" },
          payload: detail,
        });
      });
      this.stallCounts.flagged++;
      this.stallCandidates.delete(row.id);
    }
    // forget goals that recovered on their own
    for (const id of this.stallCandidates.keys()) {
      if (!seen.has(id)) this.stallCandidates.delete(id);
    }
  }
}
