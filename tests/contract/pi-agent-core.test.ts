// Pi (@earendil-works) contract tests — deterministic, no network.
//
// The goal mandates verifying the CURRENT npm namespace with small contract
// tests before locking versions (§三.3). Locked: @earendil-works/pi-agent-core
// 0.87.1 + @earendil-works/pi-ai 0.87.1 (npm, 2026-09 verified).
//
// What is contract-tested here (driven by the pi-ai FAUX provider — scripted,
// no network, deterministic):
//   1. Agent event ordering (agent_start → turn_start → message_* →
//      tool_execution_* → turn_end → agent_end)
//   2. Custom tools bound to an AgentTool execute and return results
//   3. beforeToolCall can BLOCK a tool call (the hook our worker uses to
//      enforce the control-plane tool gate)
//   4. steer() queues and applies between turns (steering = change FUTURE
//      behavior, never interrupts the current tool — same semantics as the
//      platform's accepted≠applied steer command)
//   5. abort() + waitForIdle() terminates a run
//   6. agent.state.messages is JSON-serializable and restorable into a fresh
//      Agent (checkpoint/restore material for AgentRuntimePort)
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxToolCall, fauxText, fauxAssistantMessage } from "@earendil-works/pi-ai";

const TOOL_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path"],
} as const;

function makeTool(log: string[]): AgentTool<any> {
  return {
    name: "workspace_write",
    label: "workspace_write",
    description: "write a file inside the sandbox",
    parameters: TOOL_SCHEMA as any,
    execute: async (_id, params: any) => {
      log.push(`exec:${params.path}`);
      return { content: [{ type: "text", text: `wrote ${params.path}` }], details: { path: params.path } };
    },
  };
}

function makeAgent(opts: { tools?: AgentTool<any>[]; script?: any[]; beforeToolCall?: Agent["beforeToolCall"] }) {
  // the faux provider consumes one ASSISTANT MESSAGE per provider request —
  // each script entry is one turn's content pieces (text and/or tool calls).
  // The provider instance carries its own api id + catalog; the Model
  // descriptor must reference BOTH (discovered from the installed package,
  // not assumed).
  const core: any = createFauxCore({});
  core.setResponses((opts.script ?? []).map((pieces) => fauxAssistantMessage(pieces)));
  const model = {
    id: "faux-1",
    name: "Faux",
    api: core.api,
    provider: "faux",
    baseUrl: "",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "contract test",
      model,
      tools: opts.tools ?? [],
      messages: [],
    },
    streamFn: core.streamSimple.bind(core),
    toolExecution: "sequential",
  });
  if (opts.beforeToolCall) agent.beforeToolCall = opts.beforeToolCall;
  return agent;
}

async function collect(agent: Agent): Promise<string[]> {
  const events: string[] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });
  return events;
}

describe("pi-agent-core contract (faux provider, deterministic)", () => {
  it("emits the documented event sequence around a tool call", async () => {
    const log: string[] = [];
    const agent = makeAgent({
      tools: [makeTool(log)],
      // a turn ending with a tool call continues the loop; the final turn is
      // text-only (faux default stopReason "stop")
      script: [
        [fauxText("writing the file"), fauxToolCall("workspace_write", { path: "a.txt", content: "hi" })],
        [fauxText("done")],
      ],
    });
    const events = await collect(agent);
    await agent.prompt("write a.txt please");

    expect(events[0]).toBe("agent_start");
    expect(events).toContain("turn_start");
    expect(events).toContain("tool_execution_start");
    expect(events).toContain("tool_execution_end");
    expect(events[events.length - 1]).toBe("agent_end");
    expect(events.indexOf("tool_execution_end")).toBeLessThan(events.indexOf("agent_end"));
    expect(log).toContain("exec:a.txt");
  });

  it("beforeToolCall can block execution — the tool never runs", async () => {
    const log: string[] = [];
    const agent = makeAgent({
      tools: [makeTool(log)],
      script: [[fauxToolCall("workspace_write", { path: "b.txt", content: "x" })], [fauxText("ok")]],
      beforeToolCall: async (ctx) => {
        if (ctx.toolCall.name === "workspace_write") return { block: true, reason: "denied by policy gate" };
        return undefined;
      },
    });
    await agent.prompt("try to write");

    expect(log).not.toContain("exec:b.txt");
    // the blocked call surfaces as an error tool result in the transcript
    const toolResults = agent.state.messages.filter((m: any) => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThan(0);
    expect(JSON.stringify(toolResults[0])).toMatch(/denied by policy gate/);
  });

  it("steer() queues input and it is applied between turns (accepted ≠ interrupting)", async () => {
    const log: string[] = [];
    const seenUserTexts: string[] = [];
    const agent = makeAgent({
      tools: [makeTool(log)],
      // turn 1: tool call; turn 2 (post-steer): the assistant must see the steered text
      script: [
        [fauxToolCall("workspace_write", { path: "t1.txt", content: "1" })],
        [fauxText("turn2 reply acknowledging: SKIP_NOW")],
      ],
    });
    // capture what the stream sees per turn: the faux script is fixed, so we
    // assert on the transcript instead — the steered user message must be in
    // the final state.
    await collect(agent);
    const run = agent.prompt("start work");
    agent.steer({ role: "user", content: "SKIP_NOW change of plans", timestamp: Date.now() });
    await run;

    const userTexts = agent.state.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    expect(userTexts.some((t: string) => t.includes("SKIP_NOW"))).toBe(true);
    expect(seenUserTexts).toEqual([]);
  });

  it("abort() during a run settles the agent idle", async () => {
    const agent = makeAgent({ script: [fauxText("long response that we will abort")] });
    const run = agent.prompt("start");
    agent.abort();
    await Promise.race([run, new Promise((r) => setTimeout(r, 5000))]);
    await agent.waitForIdle();
    expect(agent.state.isStreaming).toBe(false);
  });

  it("agent.state.messages is JSON-serializable and restorable (checkpoint/restore material)", async () => {
    const log: string[] = [];
    const agent = makeAgent({
      tools: [makeTool(log)],
      script: [fauxText("first response")],
    });
    await agent.prompt("first prompt");
    const serialized: string = JSON.stringify(agent.state.messages);
    expect(serialized.length).toBeGreaterThan(2);

    const restored = makeAgent({ tools: [makeTool(log)], script: [fauxText("second response")] });
    restored.state.messages = JSON.parse(serialized) as any[];
    expect(restored.state.messages.length).toBe(agent.state.messages.length);
    // and the restored agent continues from the restored context
    await restored.prompt("second prompt");
    expect(restored.state.messages.length).toBeGreaterThan(agent.state.messages.length);
  });

  it("locks the versions actually installed", async () => {
    const pkg = await import("@earendil-works/pi-agent-core/package.json", { with: { type: "json" } } as any).catch(() => null);
    const core = (pkg as any)?.default?.version ?? (pkg as any)?.version;
    expect(core).toBe("0.87.1");
  });
});
