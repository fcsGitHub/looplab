// Evidence reference verification (A14): a report/claim may only cite
// entities that actually exist. Dangling references block completion.
import type { Db } from "./db.js";
import { EventStore } from "./eventstore.js";

export interface ReferenceReport {
  ok: boolean;
  checked: number;
  dangling: { source: string; ref: string; kind: string }[];
}

export class EvidenceService {
  constructor(private db: Db) {}

  async verifyReferences(goalId: string): Promise<ReferenceReport> {
    const dangling: ReferenceReport["dangling"] = [];
    let checked = 0;

    const claims = (await this.db.query("SELECT id, text, evidence_refs FROM claims WHERE goal_id=$1", [goalId])).rows;
    for (const c of claims) {
      for (const ref of c.evidence_refs ?? []) {
        checked++;
        if (!(await this.refExists(goalId, String(ref)))) {
          dangling.push({ source: `claim:${c.id}`, ref: String(ref), kind: "claim_evidence" });
        }
      }
    }

    const hyps = (await this.db.query("SELECT id, evidence_refs FROM hypotheses WHERE goal_id=$1", [goalId])).rows;
    for (const h of hyps) {
      for (const ref of h.evidence_refs ?? []) {
        checked++;
        if (!(await this.refExists(goalId, String(ref)))) {
          dangling.push({ source: `hypothesis:${h.id}`, ref: String(ref), kind: "hypothesis_evidence" });
        }
      }
    }

    const memories = (await this.db.query("SELECT id, refs FROM memories WHERE goal_id=$1", [goalId])).rows;
    for (const m of memories) {
      for (const ref of m.refs ?? []) {
        checked++;
        if (!(await this.refExists(goalId, String(ref)))) {
          dangling.push({ source: `memory:${m.id}`, ref: String(ref), kind: "memory_ref" });
        }
      }
    }

    const report = { ok: dangling.length === 0, checked, dangling };
    if (!report.ok) {
      await this.db.tx(async (client) => {
        await EventStore.append(client, {
          aggregateType: "goal", aggregateId: goalId, eventType: "evidence.reference_check_failed",
          goalId, actor: { kind: "system", id: "evidence-service" },
          payload: { dangling: dangling.slice(0, 20) },
        });
      });
    }
    return report;
  }

  /** refs understood: artifact://sha256/<digest> | plan:<id> | run:<id> | source:<id> | attempt:<id> */
  private async refExists(goalId: string, ref: string): Promise<boolean> {
    if (ref.startsWith("artifact://sha256/")) {
      const digest = ref.slice("artifact://sha256/".length);
      const r = await this.db.query("SELECT 1 FROM artifacts WHERE digest=$1", [digest]);
      return r.rows.length > 0;
    }
    const m = ref.match(/^(plan|run|source|attempt|hyp):(.+)$/);
    if (!m || !m[1] || !m[2]) return false;
    const kind = m[1];
    const id = m[2];
    const tableMap: Record<string, string> = {
      plan: "experiment_plans", run: "experiment_runs",
      source: "sources", attempt: "attempts", hyp: "hypotheses",
    };
    const table = tableMap[kind];
    if (!table) return false;
    const r = await this.db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
    return r.rows.length > 0;
  }
}
