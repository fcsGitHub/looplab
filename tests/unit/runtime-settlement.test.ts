// Problem ledger #1: settlement parity across BOTH runtimes, deterministic
// (scripted LLM, no network). A model that does the work but ends without a
// parseable RESULT commits SUCCEEDED with an honest result_format signal
// (passed=false); no text at all -> FAILED. The last budgeted turn forces a
// tool-free wrap-up in both runtimes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunSpecSchema } from "@looplab/contracts";
import { AgentLoop } from "../../workers/agent-worker/src/agent-loop.js";
import { PiAttemptExecutor } from "../../workers/agent-worker/src/pi-executor.js";
import { FORCED_WRAPUP_INSTRUCTION } from "../../workers/agent-worker/src/result-synthesis.js";

function makeSpec(workspace: string, over: Record<string, unknown> = {}) {
  return RunSpecSchema.parse({
    spec_version: "1",
    attempt_id: "att_test",
    task_id: "task_test",
    task_key: "t1",
    goal_id: "goal_test",
    goal_version: 1,
    graph_version: "graph_test",
    role: "Builder",
    objective: "obj",
    task_title: "t",
    task_instruction: "do it",
    input_refs: [],
    parent_asset_digests: [],
    model: { provider: "deepseek", model: "test-model", credential_ref: "server://x", max_tokens: 64, temperature: 0.2 },
    allowed_tools: [{
      name: "workspace_write",
      description: "write",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    }],
    resource_limits: {
      max_steps: 2, max_tool_calls: 4, wall_clock_ms: 60_000,
      tool_timeout_ms: 5_000, max_output_bytes: 4096, max_child_processes: 1,
    },
    budget: { budget_id: "b", max_model_calls: 8, max_cost_usd: 1, cost_per_call_reserve_usd: 0.01 },
    lease: { epoch: 1, heartbeat_interval_ms: 10_000, ttl_ms: 30_000 },
    sandbox: { workspace_dir: workspace, python_executable: "python" },
    steering_mode: "next_turn",
    ...over,
  });
}

/** Scripted ControlClient: llm pops scripted OpenAI-shape responses. */
function fakeClient(script: any[]) {
  const captured: any[] = [];
  return {
    captured,
    async llm(_a: string, _w: string, _e: number, payload: any) {
      captured.push(payload);
      const next = script.shift();
      return next ?? { status: 200, json: { message: { role: "assistant", content: "" }, usage: { prompt_tokens: 1, completion_tokens: 1 } } };
    },
    async start() { return { status: 200, json: {} }; },
    async heartbeat() { return { status: 200, json: { action: "continue", pending_steers: [] } }; },
    async authorizeTool() { return { status: 200, json: { allowed: true } }; },
    async reportTool() { return { status: 200, json: {} }; },
    async confirmSteer() { return { status: 200, json: {} }; },
    async checkpoint() { return { status: 200, json: {} }; },
    async uploadArtifact(_a: string, _g: string, name: string, mt: string, body: Buffer) {
      return { status: 200, json: { digest: `d_${name}`, size_bytes: body.byteLength } };
    },
    async downloadPropagated() { return { status: 404, json: null }; },
  } as any;
}

const toolCallMsg = {
  role: "assistant", content: "",
  tool_calls: [{ id: "c1", function: { name: "workspace_write", arguments: JSON.stringify({ path: "out.txt", content: "deliverable" }) } }],
};

describe("AgentLoop settlement (loop runtime)", () => {
  it("work without parseable RESULT -> SUCCEEDED with result_format passed=false; last turn is tool-free wrap-up", async () => {
    const ws = mkdtempSync(join(tmpdir(), "loop-settle-"));
    const client = fakeClient([
      { status: 200, json: { message: toolCallMsg, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
      // turn 2 IS the forced wrap-up; model replies without RESULT
      { status: 200, json: { message: { role: "assistant", content: "做完了，但没按格式。" }, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
      // re-ask also fails to produce RESULT
      { status: 200, json: { message: { role: "assistant", content: "真的做完了。" }, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
    ]);
    const out = await new AgentLoop(client, makeSpec(ws), "w1").run();

    expect(out.outcome).toBe("SUCCEEDED");
    expect(out.verification?.kind).toBe("result_format");
    expect(out.verification?.passed).toBe(false);
    expect(out.artifacts.some((a) => a.name === "out.txt")).toBe(true); // snapshot, not self-report
    // the final budgeted turn carried the wrap-up instruction and NO tools
    const lastTurn = client.captured[1];
    expect(lastTurn.tools).toBeUndefined();
    expect(lastTurn.messages.at(-1).content).toBe(FORCED_WRAPUP_INSTRUCTION);
  });

  it("no text at all -> FAILED (retry justified)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "loop-settle-"));
    const client = fakeClient([
      { status: 200, json: { message: { role: "assistant", content: "" }, usage: { prompt_tokens: 1, completion_tokens: 0 } } },
    ]);
    const out = await new AgentLoop(client, makeSpec(ws), "w1").run();
    expect(out.outcome).toBe("FAILED");
    expect(out.verification?.kind).toBe("result_format");
  });
});

describe("PiAttemptExecutor settlement (pi runtime)", () => {
  it("work without parseable RESULT -> same settlement; forced wrap-up turns tools off", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-settle-"));
    const client = fakeClient([
      { status: 200, json: { message: toolCallMsg, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
      { status: 200, json: { message: { role: "assistant", content: "做完了，但没按格式。" }, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
      { status: 200, json: { message: { role: "assistant", content: "真的做完了。" }, usage: { prompt_tokens: 5, completion_tokens: 5 } } },
    ]);
    const out = await new PiAttemptExecutor(client, makeSpec(ws), "w1").run();

    expect(out.outcome).toBe("SUCCEEDED");
    expect(out.verification?.kind).toBe("result_format");
    expect(out.verification?.passed).toBe(false);
    expect(out.artifacts.some((a) => a.name === "out.txt")).toBe(true);
    const lastTurn = client.captured[1];
    expect(lastTurn.tools).toBeUndefined();
    expect(lastTurn.messages.at(-1).content).toBe(FORCED_WRAPUP_INSTRUCTION);
  });

  it("no text at all -> FAILED; no wasted re-ask without text", async () => {
    const ws = mkdtempSync(join(tmpdir(), "pi-settle-"));
    const client = fakeClient([
      { status: 200, json: { message: { role: "assistant", content: "" }, usage: { prompt_tokens: 1, completion_tokens: 0 } } },
    ]);
    const out = await new PiAttemptExecutor(client, makeSpec(ws), "w1").run();
    expect(out.outcome).toBe("FAILED");
    expect(out.verification?.kind).toBe("result_format");
    expect(client.captured).toHaveLength(1); // re-ask only fires when there is text
  });
});
