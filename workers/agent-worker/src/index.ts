// Worker daemon: claims attempts, runs bounded agent loops, commits results.
// Multiple workers can run concurrently; the control service is the single
// scheduling authority (leases + fencing make duplicate claims harmless).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { RunSpec } from "@looplab/contracts";
import { ControlClient } from "./control-client.js";
import { AgentLoop } from "./agent-loop.js";
import { PiAttemptExecutor } from "./pi-executor.js";

// runtime selection: the port contract (contracts/runtime.ts) makes the
// adapter swappable. Pi (@earendil-works) is the production default since
// P15 — it passed the contract tests first (P9), a real-model smoke, and
// live production verification (P10); settlement parity landed in P14.
// RUNTIME=loop explicitly selects the built-in loop runtime (rollback path).
// The worker plane shares WORKER_TOKEN with the control service. The worker
// keeps no config of its own — it reads the same gitignored
// apps/control/config/.env.local, discovered by walking up from the CWD, so
// an operator maintains exactly one secret file. Process env always wins.
function loadSharedEnvFile(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, "apps", "control", "config", ".env.local");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m?.[1] && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadSharedEnvFile();

const RUNTIME = process.env.RUNTIME ?? "pi";
const WORKER_VERSION = "2"; // claim-payload schema for runtime self-report

const CONTROL_URL = process.env.CONTROL_URL ?? "http://localhost:8080";
const WORKER_ID = process.env.WORKER_ID ?? `sandbox-${randomBytes(3).toString("hex")}`;
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "../../data");
const POLL_IDLE_MS = Number(process.env.WORKER_POLL_IDLE_MS ?? 3000);

async function main() {
  const client = new ControlClient(CONTROL_URL, process.env.WORKER_TOKEN ?? "");
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[worker ${WORKER_ID}] connecting to ${CONTROL_URL}${process.env.WORKER_TOKEN ? " (token auth)" : ""}`);

  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });

  while (!stopped) {
    let job: { attempt: any; spec: RunSpec } | null = null;
    try {
      const res = await client.claim(WORKER_ID, { runtime: RUNTIME, version: WORKER_VERSION });
      if (res.status === 401 || res.status === 403) {
        // A token mismatch will never heal on its own; spinning silently here
        // makes the worker look alive while it does nothing. Stop loudly.
        console.error(`[worker ${WORKER_ID}] claim rejected (${res.status}): worker-plane token missing or wrong. Fix WORKER_TOKEN (apps/control/config/.env.local) and restart.`);
        process.exit(1);
      }
      if (res.status === 200 && res.json) job = res.json;
    } catch (err) {
      console.error(`[worker ${WORKER_ID}] claim failed: ${err instanceof Error ? err.message : err}`);
      await sleep(POLL_IDLE_MS);
      continue;
    }
    if (!job) {
      await sleep(POLL_IDLE_MS);
      continue;
    }
    const spec = job.spec;
    console.log(`[worker ${WORKER_ID}] attempt ${spec.attempt_id} task=${spec.task_key} role=${spec.role}`);
    mkdirSync(spec.sandbox.workspace_dir, { recursive: true });
    try {
      const outcome = RUNTIME === "pi"
        ? await new PiAttemptExecutor(client, spec, WORKER_ID).run()
        : await new AgentLoop(client, spec, WORKER_ID).run();
      const commitRes = await client.commit(spec.attempt_id, WORKER_ID, {
        attempt_id: spec.attempt_id,
        lease_epoch: spec.lease.epoch,
        expected_status: "RUNNING",
        outcome: outcome.outcome,
        error_class: outcome.outcome === "FAILED" ? "task_failed" : null,
        summary: outcome.summary,
        artifacts: outcome.artifacts,
        usage: outcome.usage,
        verification: outcome.verification,
      });
      if (commitRes.status === 200) {
        console.log(`[worker ${WORKER_ID}] attempt ${spec.attempt_id} committed: ${outcome.outcome} (steps=${outcome.steps}, model_calls=${outcome.usage.model_calls})`);
      } else {
        console.error(`[worker ${WORKER_ID}] commit rejected (${commitRes.status}): ${JSON.stringify(commitRes.json).slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[worker ${WORKER_ID}] attempt ${spec.attempt_id} crashed: ${err instanceof Error ? err.stack : err}`);
      // crash: leave the lease; the control supervisor reaps it after TTL
    }
  }
  console.log(`[worker ${WORKER_ID}] stopped`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
