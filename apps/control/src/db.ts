import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Db {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      // a stuck query must not squat a connection forever — the pool is shared
      // by SSE polls, the orchestrator tick and all workers (P25)
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 60_000,
    });
    // pg REQUIRES the pool 'error' event to be handled: an idle client dying
    // underneath us (server restart, admin pg_terminate_backend, network
    // blip) emits it, and unhandled 'error' kills the whole control process —
    // exactly what must never happen to a long-running daemon. Log it; the
    // pool discards the dead client and opens a fresh one on the next query.
    this.pool.on("error", (err) => {
      console.error(`[db] idle client error (pool will recycle it): ${err.message}`);
    });
  }

  async migrate(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      // two control processes booting against one DB must not interleave
      // migration application — serialize on an advisory lock (P25)
      await client.query("SELECT pg_advisory_lock(918273650)");
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const done = new Set(
        (await client.query("SELECT name FROM schema_migrations")).rows.map((r: any) => r.name),
      );
      const dir = path.join(__dirname, "migrations");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      const applied: string[] = [];
      for (const f of files) {
        if (done.has(f)) continue;
        await client.query("BEGIN");
        try {
          await client.query(readFileSync(path.join(dir, f), "utf8"));
          await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
          await client.query("COMMIT");
          applied.push(f);
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
      return applied;
    } finally {
      await client.query("SELECT pg_advisory_unlock(918273650)").catch(() => {});
      client.release();
    }
  }

  /** Run fn in a transaction; on error roll back and rethrow. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    return this.pool.query<T>(text, values as any[]);
  }

  async close() {
    await this.pool.end();
  }
}
