// Cross-attempt artifact materialization (problem ledger #5 fix).
// The claim response's spec.propagated_artifacts lists predecessor
// deliverables resolved by the scheduler; the worker downloads each through
// the attempt-fenced endpoint and writes it into the attempt workspace
// BEFORE the agent loop starts, so successors see their inputs.
import path from "node:path";
import { promises as fs } from "node:fs";
import type { RunSpec } from "@looplab/contracts";
import type { ControlClient } from "./control-client.js";

export async function materializePropagated(client: ControlClient, spec: RunSpec, workerId: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of spec.propagated_artifacts ?? []) {
    try {
      // name is reduced to a bare filename inside the workspace
      const safeName = entry.name.replace(/\\/g, "/").split("/").pop() ?? "input";
      if (!safeName) continue;
      const abs = path.resolve(spec.sandbox.workspace_dir, safeName);
      const root = path.resolve(spec.sandbox.workspace_dir);
      if (abs !== root && !abs.startsWith(root + path.sep)) continue;
      const buf = await client.downloadPropagated(spec.attempt_id, workerId, spec.lease.epoch, entry.digest);
      if (!buf) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      out.push(safeName);
    } catch {
      // a missing input is visible to the agent (file absent) and recorded
      continue;
    }
  }
  return out;
}
