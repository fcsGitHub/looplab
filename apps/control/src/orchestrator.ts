// Deterministic supervisor loop (design §15): lease reconciliation, budget
// wake-ups, async command application. NO LLM here — supervision is rule-based.
import { Scheduler } from "./scheduler.js";
import { GoalService } from "./goals.js";
import type { Db } from "./db.js";

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  lastReconcileAt: Date | null = null;
  lastError: string | null = null;
  reconcileCounts = { lost: 0, reconcileRequired: 0 };

  constructor(private db: Db, private scheduler: Scheduler, private goals: GoalService) {}

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
      `SELECT c.goal_id, c.payload->>'content' AS content, c.actor->>'id' AS user_id
         FROM commands c WHERE c.kind='revise' AND c.status='ACCEPTED'
         AND NOT EXISTS (
           SELECT 1 FROM goal_versions gv
            WHERE gv.goal_id=c.goal_id AND gv.objective = c.payload->>'content')
        ORDER BY c.created_at LIMIT 5`,
    );
    for (const r of revisions.rows) {
      if (r.content) {
        await this.goals.applyRevision(r.goal_id, r.content, r.user_id ?? "system");
      }
    }
    this.lastError = null;
  }
}
