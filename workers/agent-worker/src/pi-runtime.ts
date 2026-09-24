// PiLoopRuntime — AgentRuntimePort adapter on @earendil-works/pi-agent-core
// (locked 0.87.1). The PI AGENT LOOP is the runtime: event stream, steering
// queue, beforeToolCall gating, abort/idle semantics, serializable transcript.
// The LLM TRANSPORT deliberately stays on the platform side: `streamFn`
// converts pi-ai messages to OpenAI chat format and calls the injected
// `llmComplete` callback (the worker's control-gateway path), so the model
// key never reaches this process and every call is budget-metered — the
// kernel invariant survives the adapter swap.
//
// Contract tests: tests/contract/pi-agent-core.test.ts (deterministic, faux
// provider); real-model smoke: tests/contract/pi-runtime-smoke.test.ts.
import { Agent, type AgentTool, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { CapabilityGateway } from "./capability-gateway.js";

type OpenAiMessage = Record<string, unknown>;

export interface PiLoopRuntimeOptions {
  /** model descriptor shown to the loop (provider name + id) */
  model: { provider: string; id: string; contextWindow?: number; maxTokens?: number };
  systemPrompt: string;
  /** max assistant turns before the runtime force-wraps (platform loop limit) */
  maxTurns?: number;
  /**
   * The ONLY model path: OpenAI-format chat completion via the control
   * gateway. Receives OpenAI-format messages + tool declarations, returns the
   * assistant message content/tool calls plus usage.
   */
  llmComplete: (req: {
    messages: OpenAiMessage[];
    tools: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
  }) => Promise<{
    text: string | null;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  }>;
  /** optional policy hook mirroring the control-plane tool gate */
  beforeToolCall?: Agent["beforeToolCall"];
}

interface GatedToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export class PiLoopRuntime {
  private agent: Agent | null = null;
  private gateway: CapabilityGateway | null = null;
  private toolDefs: GatedToolDef[] = [];
  private turns = 0;
  private maxTurns: number;
  private drainRequested = false;
  private eventLog: AgentEvent[] = [];

  constructor(private options: PiLoopRuntimeOptions) {
    this.maxTurns = options.maxTurns ?? 24;
  }

  /** Build a gated AgentTool bound to the worker capability gateway. */
  static gatedTool(def: GatedToolDef, gateway: CapabilityGateway): AgentTool {
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: def.parameters as any,
      execute: async (_toolCallId, params) => {
        const result = await gateway.execute(def.name, params as Record<string, unknown>);
        return {
          content: [{ type: "text", text: result.output }],
          details: { ok: result.ok, truncated: result.truncated },
        };
      },
    };
  }

  /** Start (or resume) an agent over the given transcript + gated tools. */
  async start(input: {
    messages: unknown[];
    tools: GatedToolDef[];
    gateway: CapabilityGateway;
    initialUserPrompt: string;
  }): Promise<{ agent: Agent }> {
    this.gateway = input.gateway;
    this.toolDefs = input.tools;
    this.turns = 0;
    this.drainRequested = false;

    const gatedTools = input.tools.map((t) => PiLoopRuntime.gatedTool(t, input.gateway));

    const agent = new Agent({
      initialState: {
        systemPrompt: this.options.systemPrompt,
        model: {
          id: this.options.model.id,
          name: this.options.model.id,
          api: "openai-completions",
          provider: this.options.model.provider,
          baseUrl: "looplab://gateway", // never contacted directly
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.options.model.contextWindow ?? 128_000,
          maxTokens: this.options.model.maxTokens ?? 8192,
        },
        tools: gatedTools,
        messages: input.messages as any,
      },
      // the metered transport: pi loop -> this streamFn -> control gateway
      streamFn: (model, context) => this.streamThroughGateway(model, context),
      toolExecution: "sequential",
    });

    // platform loop limit: force wrap-up at the cap (mirrors DeepSeekLoopRuntime)
    agent.finishTurn = async () => {
      this.turns++;
      if (this.drainRequested) return { action: "end" };
      if (this.turns >= this.maxTurns) return { action: "end" };
      return undefined;
    };
    if (this.options.beforeToolCall) agent.beforeToolCall = this.options.beforeToolCall;

    this.agent = agent;
    agent.subscribe((event) => {
      this.eventLog.push(event);
    });
    await agent.prompt(input.initialUserPrompt);
    return { agent };
  }

  /**
   * Convert pi-ai transcript context to OpenAI chat format, call the metered
   * gateway, and re-emit the response as an AssistantMessageEventStream.
   */
  private streamThroughGateway(model: any, context: any): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        const messages = PiLoopRuntime.toOpenAiMessages(context.messages);
        const tools = this.toolDefs.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        const result = await this.options.llmComplete({ messages, tools });

        const assistant: any = {
          role: "assistant",
          content: [] as any[],
          api: model?.api ?? "openai-completions",
          provider: model?.provider ?? this.options.model.provider,
          model: result.model || this.options.model.id,
          usage: {
            input: result.usage.prompt_tokens,
            output: result.usage.completion_tokens,
            cacheRead: 0,
            cacheWrite: 0,
          },
          stopReason: result.toolCalls.length > 0 ? "toolUse" : "stop",
        };
        if (result.text) assistant.content.push({ type: "text", text: result.text });
        for (const call of result.toolCalls) {
          assistant.content.push({
            type: "toolCall", id: call.id, name: call.name,
            arguments: JSON.parse(call.arguments || "{}"),
          });
        }

        stream.push({ type: "start", partial: assistant });
        if (result.text) {
          stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
          // emit the completed text as one delta (gateway responses are
          // non-streaming; deltas exist for UI streaming only)
          stream.push({ type: "text_delta", contentIndex: 0, delta: result.text, partial: assistant });
          stream.push({ type: "text_end", contentIndex: 0, content: result.text, partial: assistant });
        }
        for (let i = 0; i < result.toolCalls.length; i++) {
          const call = result.toolCalls[i];
          const contentIndex = result.text ? 1 : i;
          const toolCall = assistant.content[contentIndex];
          stream.push({ type: "toolcall_start", contentIndex, partial: assistant });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: assistant });
        }
        stream.push({ type: "done", reason: assistant.stopReason, message: assistant });
        stream.end(assistant);
      } catch (err) {
        const errorMsg: any = {
          role: "assistant", content: [], api: "openai-completions",
          provider: this.options.model.provider, model: this.options.model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        stream.push({ type: "error", reason: "error", error: errorMsg });
        stream.end(errorMsg);
      }
    })();
    return stream;
  }

  /** pi-ai Message[] -> OpenAI chat messages. */
  static toOpenAiMessages(messages: any[]): OpenAiMessage[] {
    const out: OpenAiMessage[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        out.push({ role: "system", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      } else if (m.role === "user") {
        out.push({ role: "user", content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
      } else if (m.role === "assistant") {
        const toolCalls = (m.content ?? []).filter((c: any) => c.type === "toolCall");
        const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        if (toolCalls.length > 0) {
          out.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.map((c: any) => ({
              id: c.id, type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
            })),
          });
        } else {
          out.push({ role: "assistant", content: text });
        }
      } else if (m.role === "toolResult") {
        const content = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "(no output)";
        out.push({ role: "tool", tool_call_id: m.toolCallId ?? m.id ?? "", content });
      }
    }
    return out;
  }

  get runtimeAgent(): Agent | null {
    return this.agent;
  }

  // ---- AgentRuntimePort method mapping (contracts/runtime.ts) -------------
  // steer: queued by the pi loop, applied between turns — accepted ≠ applied,
  // and never interrupts the current tool (platform steer semantics).
  async steer(handle: { attemptId: string }, input: { content: string }): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.agent) return { accepted: false, reason: "runtime not started" };
    if (this.drainRequested) return { accepted: false, reason: "drain requested" };
    this.agent.steer({ role: "user", content: input.content, timestamp: Date.now() });
    return { accepted: true };
  }

  /** drain: finish the current turn, then stop (no new turns). */
  async requestDrain(): Promise<{ accepted: boolean; reason?: string }> {
    this.drainRequested = true;
    return { accepted: true };
  }

  async abort(): Promise<{ accepted: boolean; reason?: string }> {
    if (!this.agent) return { accepted: false, reason: "runtime not started" };
    this.agent.abort();
    await this.agent.waitForIdle();
    return { accepted: true };
  }

  /** checkpoint: the pi transcript is JSON-serializable state. */
  checkpoint(handle: { attemptId: string }): { checkpointId: string } {
    const snapshot = JSON.stringify({ messages: this.agent?.state.messages ?? [] });
    return { checkpointId: `pic_${handle.attemptId}_${Date.now()}_${snapshot.length}` };
  }

  snapshot(): string {
    return JSON.stringify({ messages: this.agent?.state.messages ?? [] });
  }

  /** restore: start() over a restored transcript (messages carried in input). */
  static restoredMessageCount(snapshot: string): number {
    return (JSON.parse(snapshot).messages as unknown[]).length;
  }
}
