// ReleaseService: CAS promotions, canary and rollback (design §8.3, §17.4).
// Two concurrent promotions of the same parent pointer: exactly one wins (A09).
// Program evaluation evidence blocks release even when the LLM reviewer is
// enthusiastic (A11). Pointer rollback does NOT undo external side effects.
import { newId } from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import type { Db } from "./db.js";

export interface PromotionInput {
  goalId: string;
  candidateId: string;
  scope: string;                 // e.g. "algorithm:routing-heuristic"
  parentRelease: string | null;  // CAS: current release id the requester saw
  kind: "canary" | "full";
  evidenceManifest: { evaluation_id: string; layer: string; verdict: string }[];
  authorization: string;         // "approval:<id>" | "policy:auto-canary"
}

export class ReleaseConflictError extends Error {
  constructor(public current: { release_id: string; candidate_id: string; pointer_version: number } | null) {
    super("release conflict: parent pointer moved (CAS)");
    this.name = "ReleaseConflictError";
  }
}

export class ReleaseBlockedError extends Error {
  constructor(reason: string) { super(reason); this.name = "ReleaseBlockedError"; }
}

export class ReleaseService {
  constructor(private db: Db) {}

  async currentPointer(scope: string) {
    const row = (await this.db.query(
      `SELECT p.*, c.digest AS candidate_digest, c.title FROM version_pointers p
         JOIN candidates c ON c.id = p.candidate_id WHERE p.scope=$1`, [scope],
    )).rows[0];
    return row ?? null;
  }

  async promote(input: PromotionInput): Promise<{ releaseId: string; pointerVersion: number }> {
    // 1) hard gates: the release-layer evaluation must be ELIGIBLE with all
    //    hard constraints passed — an LLM review score can never override this.
    const releaseEvals = (await this.db.query(
      `SELECT * FROM evaluations WHERE candidate_id=$1 AND layer='release' ORDER BY created_at DESC`,
      [input.candidateId],
    )).rows;
    const passing = releaseEvals.find((e: any) => {
      const r = e.results;
      return e.verdict === "ELIGIBLE" && Array.isArray(r?.hard_constraints) && r.hard_constraints.every((h: any) => h.passed);
    });
    if (!passing) {
      throw new ReleaseBlockedError(
        `no passing release-layer evaluation for ${input.candidateId}; program evidence gates promotion regardless of review opinion`,
      );
    }

    return this.db.tx(async (client) => {
      const cand = (await client.query("SELECT * FROM candidates WHERE id=$1 FOR UPDATE", [input.candidateId])).rows[0];
      if (!cand) throw new ReleaseBlockedError("candidate not found");
      if (!["ELIGIBLE", "CANARY", "RELEASED"].includes(cand.status) && input.kind === "full") {
        throw new ReleaseBlockedError(`candidate status ${cand.status} is not promotable`);
      }

      // 2) CAS on the pointer (single writer wins per parent)
      const cur = (await client.query("SELECT * FROM version_pointers WHERE scope=$1 FOR UPDATE", [input.scope])).rows[0];
      if (input.parentRelease !== (cur?.release_id ?? null)) {
        throw new ReleaseConflictError(cur ? {
          release_id: cur.release_id, candidate_id: cur.candidate_id, pointer_version: Number(cur.pointer_version),
        } : null);
      }

      const releaseId = newId("rel");
      await client.query(
        `INSERT INTO releases (id, goal_id, candidate_id, parent_release, kind, evidence_manifest, authorization_ref, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE')`,
        [releaseId, input.goalId, input.candidateId, input.parentRelease, input.kind,
          JSON.stringify(input.evidenceManifest), input.authorization],
      );
      if (cur) {
        await client.query(
          `UPDATE version_pointers SET candidate_id=$2, release_id=$3, pointer_version=pointer_version+1, updated_at=now()
            WHERE scope=$1`, [input.scope, input.candidateId, releaseId],
        );
      } else {
        await client.query(
          `INSERT INTO version_pointers (scope, candidate_id, release_id, pointer_version) VALUES ($1,$2,$3,1)`,
          [input.scope, input.candidateId, releaseId],
        );
      }

      const newStatus = input.kind === "canary" ? "CANARY" : "RELEASED";
      await client.query("UPDATE candidates SET status=$2, updated_at=now() WHERE id=$1", [input.candidateId, newStatus]);
      await client.query(
        `INSERT INTO candidate_status_history (candidate_id, status, reason) VALUES ($1,$2,$3)`,
        [input.candidateId, newStatus, `release ${releaseId} (${input.kind})`],
      );
      await EventStore.append(client, {
        aggregateType: "release", aggregateId: releaseId, eventType: "release.promoted",
        goalId: input.goalId, actor: { kind: "system", id: "release-service" },
        payload: {
          candidate_id: input.candidateId, scope: input.scope, kind: input.kind,
          pointer_version: (cur?.pointer_version ?? 0) + 1, authorization_ref: input.authorization,
          parent_release: input.parentRelease,
        },
      });
      return { releaseId, pointerVersion: (cur?.pointer_version ?? 0) + 1 };
    });
  }

  /** Auto/manual rollback: flips the pointer back, keeps all evidence. */
  async rollback(input: { scope: string; releaseId: string; reason: string; actor: string }) {
    return this.db.tx(async (client) => {
      const rel = (await client.query("SELECT * FROM releases WHERE id=$1 FOR UPDATE", [input.releaseId])).rows[0];
      if (!rel) throw new Error("release not found");
      const cur = (await client.query("SELECT * FROM version_pointers WHERE scope=$1 FOR UPDATE", [input.scope])).rows[0];
      if (!cur || cur.release_id !== input.releaseId) {
        throw new Error("pointer already moved; nothing to roll back");
      }
      await client.query("UPDATE releases SET status='ROLLED_BACK' WHERE id=$1", [input.releaseId]);
      await client.query(
        `UPDATE candidates SET status='ROLLED_BACK', updated_at=now() WHERE id=$1`, [rel.candidate_id],
      );
      await client.query(
        `INSERT INTO candidate_status_history (candidate_id, status, reason) VALUES ($1,'ROLLED_BACK',$2)`,
        [rel.candidate_id, input.reason],
      );
      // restore parent release pointer if recorded; else clear pointer
      if (rel.parent_release) {
        const parentRel = (await client.query("SELECT * FROM releases WHERE id=$1", [rel.parent_release])).rows[0];
        if (parentRel) {
          await client.query(
            `UPDATE version_pointers SET candidate_id=$2, release_id=$3, pointer_version=pointer_version+1, updated_at=now() WHERE scope=$1`,
            [input.scope, parentRel.candidate_id, rel.parent_release],
          );
          await EventStore.append(client, {
            aggregateType: "release", aggregateId: rel.parent_release, eventType: "release.rolled_back_to",
            goalId: rel.goal_id, actor: { kind: "system", id: input.actor },
            payload: { rolled_back_release: input.releaseId, reason: input.reason },
          });
        }
      } else {
        await client.query("DELETE FROM version_pointers WHERE scope=$1", [input.scope]);
      }
      await EventStore.append(client, {
        aggregateType: "release", aggregateId: input.releaseId, eventType: "release.rolled_back",
        goalId: rel.goal_id, actor: { kind: "system", id: input.actor },
        payload: { reason: input.reason, note: "pointer rollback does not undo external side effects already performed" },
      });
      return { rolledBack: true };
    });
  }
}
