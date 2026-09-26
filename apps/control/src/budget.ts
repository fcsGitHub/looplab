// Budget kernel (design §17.1 BudgetReservation, §18.4).
// Rules: reserve BEFORE any billable action; settle after usage is known;
// unknown settlement keeps a conservative reservation (never zero, A08);
// overspending the goal cap is refused, not guessed around.
import type { PoolClient } from "pg";
import { newId } from "@looplab/contracts";

export class BudgetExceededError extends Error {
  constructor(public readonly detail: { required: number; available: number; cap: number }) {
    super(`budget exceeded: need $${detail.required.toFixed(4)}, available $${detail.available.toFixed(4)} of $${detail.cap}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetSnapshot {
  reserved: number;
  settled: number;
  unknown: number;
  cap: number;
  available: number;
  outstanding: number; // reserved + unknown - settled (what we still might owe)
}

export class BudgetService {
  constructor(private db: { query: any; tx: any }) {}

  static outstandingRows(rows: { reserved_usd: string; settled_usd: string; unknown_usd: string }[]): BudgetSnapshot["outstanding"] {
    return rows.reduce(
      (acc, r) => acc + Number(r.reserved_usd) + Number(r.unknown_usd) - Number(r.settled_usd),
      0,
    );
  }

  async snapshot(client: PoolClient, goalId: string): Promise<BudgetSnapshot> {
    const goal = await client.query("SELECT budget_cap_usd FROM goals WHERE id=$1", [goalId]);
    const cap = Number(goal.rows[0]?.budget_cap_usd ?? 0);
    const rows = await client.query(
      `SELECT reserved_usd, settled_usd, unknown_usd FROM budget_reservations
        WHERE goal_id=$1 AND status <> 'released'`,
      [goalId],
    );
    const reserved = rows.rows.reduce((a: number, r: any) => a + Number(r.reserved_usd), 0);
    const settled = rows.rows.reduce((a: number, r: any) => a + Number(r.settled_usd), 0);
    const unknown = rows.rows.reduce((a: number, r: any) => a + Number(r.unknown_usd), 0);
    // outstanding = what we might still owe: open reservations + unknown costs
    const outstanding = reserved + unknown;
    return { reserved, settled, unknown, cap, available: cap - outstanding, outstanding };
  }

  /** Reserve `amount` or throw BudgetExceededError. Idempotent by key. */
  async reserve(
    client: PoolClient,
    input: {
      goalId: string; attemptId?: string | null; scope: string; kind: string;
      amount: number; idempotencyKey: string;
    },
  ): Promise<{ id: string; reused: boolean }> {
    const existing = await client.query(
      "SELECT id FROM budget_reservations WHERE idempotency_key=$1",
      [input.idempotencyKey],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, reused: true };

    const snap = await this.snapshot(client, input.goalId);
    if (input.amount > snap.available + 1e-9) {
      throw new BudgetExceededError({ required: input.amount, available: snap.available, cap: snap.cap });
    }
    const id = newId("budget");
    await client.query(
      `INSERT INTO budget_reservations (id, goal_id, attempt_id, scope, kind, reserved_usd, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.goalId, input.attemptId ?? null, input.scope, input.kind, input.amount, input.idempotencyKey],
    );
    return { id, reused: false };
  }

  /** Settle actual usage against a reservation; releases over-reservation. */
  async settle(
    client: PoolClient,
    reservationId: string,
    actualUsd: number,
    response?: unknown,
  ): Promise<void> {
    await client.query(
      `UPDATE budget_reservations
          SET settled_usd = $2, reserved_usd = 0, unknown_usd = 0,
              status = 'settled', updated_at = now(),
              response = COALESCE($3::jsonb, response)
        WHERE id = $1`,
      [reservationId, actualUsd, response === undefined ? null : JSON.stringify(response)],
    );
  }

  /**
   * V23: a caller reusing an idempotency key must get the RECORDED outcome,
   * never a second billable call whose settlement would overwrite the first.
   * Returns the stored response when the original call settled; null while the
   * original is still in flight (caller refuses with a conflict).
   */
  async recordedResponse(reservationId: string): Promise<
    { state: "settled"; response: unknown } | { state: "in_flight" } | { state: "missing" }
  > {
    const row = (await this.db.query(
      "SELECT status, response FROM budget_reservations WHERE id=$1", [reservationId],
    )).rows[0] as { status: string; response: unknown } | undefined;
    if (!row) return { state: "missing" };
    if (row.status === "settled" && row.response != null) return { state: "settled", response: row.response };
    if (row.status === "released") return { state: "missing" };
    return { state: "in_flight" };
  }

  /**
   * Model call finished but settlement info is unavailable (e.g. request died
   * mid-flight): keep the reservation as unknown cost (A08: never record zero).
   */
  async markUnknown(client: PoolClient, reservationId: string): Promise<void> {
    await client.query(
      `UPDATE budget_reservations
          SET reserved_usd = 0,
              unknown_usd = GREATEST(unknown_usd, reserved_usd),
              status = 'settled', updated_at = now()
        WHERE id = $1 AND unknown_usd = 0`,
      [reservationId],
    );
    // fallback if the guard above didn't hit (reserved already zeroed)
    await client.query(
      `UPDATE budget_reservations
          SET unknown_usd = GREATEST(unknown_usd, 0.0001)
        WHERE id = $1 AND unknown_usd = 0 AND settled_usd = 0`,
      [reservationId],
    );
  }

  async release(client: PoolClient, reservationId: string): Promise<void> {
    await client.query(
      `UPDATE budget_reservations SET status='released', reserved_usd=0, updated_at=now()
        WHERE id=$1`,
      [reservationId],
    );
  }
}

/** Reused idempotency key whose original call has not settled yet. */
export class IdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`idempotency key ${key} is still in flight; use a new key`);
    this.name = "IdempotencyConflictError";
  }
}
