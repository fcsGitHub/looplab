// Event store: append-only audit log. Every state change is committed in the
// same transaction as its event (design §17.4). Per-aggregate sequences are
// gapless; the global `seq` (bigserial) is the SSE replay cursor.
import type { PoolClient } from "pg";
import { newId } from "@looplab/contracts";

export interface AppendEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  goalId?: string | null;
  goalVersion?: number | null;
  traceId?: string | null;
  causationId?: string | null;
  actor?: { kind: string; id: string } | null;
  leaseEpoch?: number | null;
  payload?: unknown;
  payloadRef?: string | null;
  occurredAt?: Date;
}

export interface StoredEvent {
  seq: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_seq: number;
  event_type: string;
  goal_id: string | null;
  goal_version: number | null;
  trace_id: string | null;
  causation_id: string | null;
  actor: { kind: string; id: string } | null;
  lease_epoch: number | null;
  payload: unknown;
  payload_ref: string | null;
  occurred_at: Date;
  ingested_at: Date;
}

export class EventStore {
  /**
   * Append inside an existing transaction. `causationId` should reference the
   * command that caused this event; `traceId` groups a whole user path.
   */
  static async append(client: PoolClient, input: AppendEventInput): Promise<StoredEvent> {
    const next = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(aggregate_seq), -1) + 1 AS next
         FROM events WHERE aggregate_type = $1 AND aggregate_id = $2`,
      [input.aggregateType, input.aggregateId],
    );
    const aggregateSeq = Number(next.rows[0]?.next ?? 0);
    const eventId = `evt_${newId("evt").slice(4)}`;
    const res = await client.query(
      `INSERT INTO events (event_id, aggregate_type, aggregate_id, aggregate_seq,
         event_type, goal_id, goal_version, trace_id, causation_id, actor,
         lease_epoch, payload, payload_ref, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        eventId,
        input.aggregateType,
        input.aggregateId,
        aggregateSeq,
        input.eventType,
        input.goalId ?? null,
        input.goalVersion ?? null,
        input.traceId ?? null,
        input.causationId ?? null,
        input.actor ? JSON.stringify(input.actor) : null,
        input.leaseEpoch ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        input.payloadRef ?? null,
        input.occurredAt ?? new Date(),
      ],
    );
    return res.rows[0] as StoredEvent;
  }

  /** Replay events after a global cursor, optionally filtered by goal. */
  static async after(
    db: { query: Db["query"] },
    cursor: bigint | 0,
    goalId?: string,
    limit = 500,
  ): Promise<StoredEvent[]> {
    const params: unknown[] = [cursor, limit];
    let filter = "";
    if (goalId) {
      filter = " AND (goal_id = $3 OR $3 IS NULL)";
      params.push(goalId);
    }
    const res = await db.query(
      `SELECT * FROM events WHERE seq > $1 ${filter} ORDER BY seq ASC LIMIT $2`,
      params,
    );
    return res.rows as StoredEvent[];
  }
}

type Db = { query: (text: string, values?: unknown[]) => Promise<any> };
