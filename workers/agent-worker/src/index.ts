// Worker daemon: claims attempts, runs bounded agent loops, commits results.
// Multiple workers can run concurrently; the control service is the single
// scheduling authority (leases + fencing make duplicate claims harmless).
import { mkdirSync } from "node:fs";
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
const RUNTIME = process.env.RUNTIME ?? "pi";

const CONTROL_URL = process.env.CONTROL_URL ?? "http://localhost:8080";
const WORKER_ID = process.env.WORKER_ID ?? `sandbox-${randomBytes(3).toString("hex")}`;
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), "../../data");
const POLL_IDLE_MS = Number(process.env.WORKER_POLL_IDLE_MS ?? 3000);

async function main() {
  const client = new ControlClient(CONTROL_URL);
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[worker ${WORKER_ID}] connecting to ${CONTROL_URL}`);

  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });

  while (!stopped) {
    let job: { attempt: any; spec: RunSpec } | null = null;
    try {
      const res = await client.claim(WORKER_ID);
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
