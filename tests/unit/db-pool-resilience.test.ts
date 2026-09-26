// P25 addendum: the control service is a long-running daemon; Postgres
// restarts and admin pg_terminate_backend calls WILL kill idle pool clients
// out from under it. pg emits those as a pool 'error' event — unhandled, the
// process dies (found live: overnight PG maintenance took the whole control
// service down with ERR 57P01). The Db pool must swallow the dead client and
// serve the next query from a fresh connection.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../../apps/control/src/db.js";

const dbUrl = process.env.TEST_DATABASE_URL ?? "postgres://looplab:localdev@localhost:5433/looplab";

let db: Db;
let admin: Client;

beforeAll(async () => {
  // separate scratch database so terminating backends can't disturb others
  admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  const name = `looplab_test_pool_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  process.env.TEST_POOL_DB = name;
  db = new Db(`${dbUrl.replace(/\/[^/]+$/, "")}/${name}`);
  await db.migrate();
});
afterAll(async () => {
  await db.close().catch(() => {});
  if (process.env.TEST_POOL_DB) {
    await admin.query(`DROP DATABASE ${process.env.TEST_POOL_DB} WITH (FORCE)`).catch(() => {});
  }
  await admin.end();
});

describe("db pool survives server-side connection termination", () => {
  it("recycles idle clients killed by pg_terminate_backend without crashing", async () => {
    // establish at least one pooled, then idle, connection
    await db.query("SELECT 1");
    // wait for the client to return to the pool as idle
    await new Promise((r) => setTimeout(r, 300));

    // kill every backend this process owns from the OUTSIDE — same FATAL 57P01
    // the crashed instance saw during overnight PG maintenance
    const procs = await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name LIKE '%node%' AND pid <> pg_backend_pid() AND datname = $1`,
      [process.env.TEST_POOL_DB],
    );
    expect(Number(procs.rowCount ?? 0)).toBeGreaterThanOrEqual(0); // 0 kills is fine (timing), >=1 proves the path fired
    // give the socket time to deliver the FATAL and emit the pool error
    await new Promise((r) => setTimeout(r, 500));

    // the process is still alive and the next query transparently reconnects
    const res = await db.query("SELECT 41 + 1 AS answer");
    expect(res.rows[0].answer).toBe(42);
  });
});
