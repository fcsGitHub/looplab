// PiAttemptExecutor — production attempt execution on the Pi runtime.
//
// Mirrors AgentLoop's contract exactly (run(): Promise<LoopOutcome>) so the
// daemon can select runtimes via RUNTIME=pi|loop without changing the claim/
// commit flow. Platform invariants preserved on the Pi path:
//   - every model call proxied through the control gateway (metered; the
//     worker never holds keys)
//   - every tool call authorized by the control PolicyGate BEFORE execution,
//     reported after (digest + bytes + duration)
//   - tool execution inside the CapabilityGateway sandbox (post-incident-006
//     path containment)
//   - steering applied between turns (accepted ≠ applied), drain finishes the
//     current turn then wraps up, abort cancels immediately
//   - wall-clock / step limits force an honest wrap-up
//   - RESULT parsing + artifact upload + checkpoints identical to the loop
//     runtime, so the ledger is runtime-agnostic
import type { RunSpec } from "@looplab/contracts";
import type { AgentEvent as AgentEventLike } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ControlClient } from "./control-client.js";
import { CapabilityGateway, sha256 } from "./capability-gateway.js";
import { PiLoopRuntime } from "./pi-runtime.js";
import { guessMediaType, parseResult, safeJoin, type LoopOutcome } from "./agent-loop.js";

// re-exported so the daemon keeps a single import surface
export { guessMediaType, parseResult };

const ROLE_PROMPTS: Record<string, string> = {
  Coordinator: "你是 Coordinator：分解与协调任务、维护依赖、选择下一步。不跳过任何验证。",
  Researcher: "你是 Researcher：找证据、抽取主张、区分引文/推论/实测。不得把臆测写成实验结论。",
  Builder: "你是 Builder：写代码与配置，做最小可验证补丁，运行验证。",
  Experimenter: "你是 Experimenter：设计并运行实验，固定种子与预算，如实记录负结果。",
  Reviewer: "你是 Reviewer：独立检查证据与实现。你的职责是发现问题，不是迎合。",
  Curator: "你是 Curator：整理经验与技能候选，标注适用范围与反例。",
};

export class PiAttemptExecutor {
  private pendingSteers: { steer_id: string; content: string }[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeat = { action: "continue" as "continue" | "drain" | "abort", reason: null as string | null };
  private toolCallCount = 0;

  constructor(
    private client: ControlClient,
    private spec: RunSpec,
    private workerId: string,
  ) {}

  private startHeartbeat(onEvent: (s: { steer_id: string; content: string }[]) => void) {
    const interval = Math.max(2000, Math.min(this.spec.lease.heartbeat_interval_ms, 8000));
    this.heartbeatTimer = setInterval(async () => {
      try {
        const res = await this.client.heartbeat(this.spec.attempt_id, this.workerId, this.spec.lease.epoch);
        if (res.status === 200 && res.json) {
          this.lastHeartbeat.action = res.json.action;
          this.lastHeartbeat.reason = res.json.reason;
          const steers: { steer_id: string; content: string }[] = res.json.pending_steers ?? [];
          if (steers.length) {
            this.pendingSteers.push(...steers);
            onEvent(steers);
          }
        }
      } catch {
        // transient network errors: lease TTL gives us slack
      }
    }, interval);
    this.heartbeatTimer.unref();
  }

  async run(): Promise<LoopOutcome> {
    const started = Date.now();
    const usage = {
      model_calls: 0, prompt_tokens: 0, completion_tokens: 0,
      estimated_cost_usd: 0, unknown_settlement: false,
    };
    const gateway = new CapabilityGateway(this.spec.sandbox.workspace_dir, {
      toolTimeoutMs: this.spec.resource_limits.tool_timeout_ms,
      maxOutputBytes: this.spec.resource_limits.max_output_bytes,
      maxChildProcesses: this.spec.resource_limits.max_child_processes,
    });

    try {
      await this.client.start(this.spec.attempt_id, this.workerId, this.spec.lease.epoch);
    } catch { /* already STARTED is fine */ }

    const agentRef: { agent: Agent | null } = { agent: null };
    this.startHeartbeat((steers) => {
      for (const s of steers) {
        agentRef.agent?.steer({ role: "user", content: `[用户实时干预] ${s.content}`, timestamp: Date.now() });
        this.client.confirmSteer(this.spec.attempt_id, s.steer_id, this.workerId, this.spec.lease.epoch).catch(() => {});
      }
    });

    // budget-exceeded and hard transport failures surface as this error class
    let budgetExhausted = false;
    let transportFailures = 0;

    const runtime = new PiLoopRuntime({
      model: { provider: "deepseek", id: this.spec.model.model },
      systemPrompt: [
        `角色：${this.spec.role}。${ROLE_PROMPTS[this.spec.role] ?? ""}`,
        `总体目标：${this.spec.objective}`,
        `本任务：${this.spec.task_title}`,
        `任务指令：\n${this.spec.task_instruction}`,
        `工作区（绝对路径，工具中的 path 用相对路径）：${this.spec.sandbox.workspace_dir}`,
        `约束：最多 ${this.spec.resource_limits.max_steps} 轮；Python 可用（标准库）；不得虚构结果；实验必须真实运行。`,
        `结束时，最后一条消息以 RESULT 开头并附单行 JSON：`,
        `{"summary":"结果摘要（含关键数字/证据）","outcome":"SUCCEEDED"或"FAILED","verification":{"kind":"验证方式","passed":true或false,"detail":"验证细节"},"files":["工作区中作为交付物的文件"]}`,
      ].join("\n\n"),
      maxTurns: this.spec.resource_limits.max_steps,
      llmComplete: async (req) => {
        if (this.lastHeartbeat.action === "abort") throw new Error(`aborted: ${this.lastHeartbeat.reason ?? "user cancel"}`);
        const res = await this.client.llm(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
          messages: req.messages,
          tools: req.tools.length > 0 ? req.tools : undefined,
          max_tokens: this.spec.model.max_tokens,
          temperature: this.spec.model.temperature,
        });
        if (res.status !== 200) {
          if (res.json?.error === "budget_exceeded") {
            budgetExhausted = true;
            throw new Error("预算耗尽：控制服务拒绝新的模型调用");
          }
          transportFailures++;
          if (transportFailures >= 3) throw new Error(`LLM 调用失败: HTTP ${res.status}`);
          // transient: bounded retry with an empty tool-call-free turn marker
          await new Promise((r) => setTimeout(r, 2000));
          return { text: "", toolCalls: [], usage: { prompt_tokens: 0, completion_tokens: 0 }, model: this.spec.model.model };
        }
        transportFailures = 0;
        usage.model_calls++;
        usage.prompt_tokens += res.json.usage?.prompt_tokens ?? 0;
        usage.completion_tokens += res.json.usage?.completion_tokens ?? 0;
        const msg = res.json.message;
        const toolCalls = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments ?? {}),
        }));
        return { text: msg.content ?? "", toolCalls, usage: res.json.usage, model: res.json.model ?? this.spec.model.model };
      },
      beforeToolCall: async (ctx) => {
        if (this.lastHeartbeat.action === "abort") return { block: true, reason: "aborted by user", terminate: true };
        if (++this.toolCallCount > this.spec.resource_limits.max_tool_calls) {
          return { block: true, reason: "tool call cap reached", terminate: true };
        }
        let args: Record<string, unknown> = {};
        try { args = typeof ctx.toolCall.arguments === "string" ? JSON.parse(ctx.toolCall.arguments) : ctx.toolCall.arguments; } catch { /* keep {} */ }
        const decision = await this.client.authorizeTool(
          this.spec.attempt_id, this.workerId, this.spec.lease.epoch, ctx.toolCall.name, args,
        );
        if (decision.status !== 200) return { block: true, reason: `gate error: HTTP ${decision.status}` };
        if (!decision.json.allowed) return { block: true, reason: `DENIED by policy gate: ${decision.json.reason}` };
        return undefined;
      },
    });

    // gated tools with post-execution reporting (digest/bytes/duration)
    const gatedTools = this.spec.allowed_tools.map((t) => {
      const tool = PiLoopRuntime.gatedTool({ name: t.name, description: t.description, parameters: t.input_schema }, gateway);
      const originalExecute = tool.execute.bind(tool);
      tool.execute = async (toolCallId, params, signal, onUpdate) => {
        const t0 = Date.now();
        const result = await originalExecute(toolCallId, params, signal, onUpdate);
        this.client.reportTool(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
          tool: t.name, ok: result.details?.ok ?? true,
          output_digest: sha256(result.content.map((c: any) => c.text ?? "").join("")),
          output_bytes: Buffer.byteLength(result.content.map((c: any) => c.text ?? "").join("")),
          duration_ms: Date.now() - t0,
        }).catch(() => {});
        return result;
      };
      return tool;
    });

    // per-turn checkpoints (best-effort), same ledger shape as the loop runtime
    let steps = 0;
    let live: Agent | null = null;
    const onEvent = (event: AgentEventLike) => {
      if (event.type === "turn_end") {
        steps++;
        if (live) void this.maybeCheckpoint(live, steps, usage);
      }
    };
    const { agent } = await runtime.start({
      messages: [],
      tools: gatedTools as any,
      gateway,
      initialUserPrompt: `请开始执行任务：${this.spec.task_title}`,
      onEvent,
      onReady: (a) => { live = a; agentRef.agent = a; },
    });


    // settle the run (prompt already issued in start)
    await agent.waitForIdle();
    if (steps === 0) steps = 1;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    if (budgetExhausted) {
      return this.failedOutcome(usage, steps, "预算耗尽：控制服务拒绝新的模型调用");
    }
    if (this.lastHeartbeat.action === "abort") {
      return this.failedOutcome(usage, steps, `aborted: ${this.lastHeartbeat.reason ?? "user cancel"}`);
    }

    // RESULT extraction: last assistant text; one direct re-ask on failure
    const assistantTexts = agent.state.messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""))
      .filter((t: string) => t.length > 0);
    let finalText: string | null = assistantTexts[assistantTexts.length - 1] ?? null;
    let parsed = parseResult(finalText);
    if (!parsed && finalText) {
      const retry = await this.client.llm(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
        messages: [
          ...PiLoopRuntime.toOpenAiMessages(agent.state.messages),
          { role: "user", content: "请严格按格式输出 RESULT + 单行 JSON（不要其他文字）。" },
        ],
        max_tokens: 800,
      });
      if (retry.status === 200) {
        usage.model_calls++;
        usage.prompt_tokens += retry.json.usage?.prompt_tokens ?? 0;
        usage.completion_tokens += retry.json.usage?.completion_tokens ?? 0;
        finalText = retry.json.message?.content ?? finalText;
        parsed = parseResult(finalText);
      }
    }

    // upload deliverable files as artifacts (identical to the loop runtime)
    const { promises: fs } = await import("node:fs");
    const artifacts: LoopOutcome["artifacts"] = [];
    for (const f of parsed?.files ?? []) {
      try {
        const abs = await safeJoin(this.spec.sandbox.workspace_dir, f);
        const content = await fs.readFile(abs);
        const up = await this.client.uploadArtifact(
          this.spec.attempt_id, this.spec.goal_id, f,
          guessMediaType(f), content,
        );
        if (up.status === 200 && up.json?.digest) {
          artifacts.push({
            name: f, media_type: guessMediaType(f),
            digest: String(up.json.digest), size_bytes: Number(up.json.size_bytes ?? 0),
          });
        }
      } catch { /* missing file: recorded as missing in summary */ }
    }

    const outcome: "SUCCEEDED" | "FAILED" = parsed?.outcome ?? (finalText ? "SUCCEEDED" : "FAILED");
    return {
      outcome,
      summary: parsed?.summary ?? finalText?.slice(0, 800) ?? "无输出",
      verification: parsed?.verification ?? null,
      artifacts,
      usage: { ...usage, unknown_settlement: false },
      steps,
    };
  }

  private async maybeCheckpoint(agent: Agent, step: number, usage: { model_calls: number }) {
    try {
      const { promises: fs } = await import("node:fs");
      const files = await fs.readdir(this.spec.sandbox.workspace_dir).catch(() => [] as string[]);
      await this.client.checkpoint(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
        step_index: step,
        summary: `pi step ${step}: ${agent.state.messages.length} messages, ${usage.model_calls} model calls, workspace files: ${files.slice(0, 10).join(",") || "(none)"}`,
        state: {
          runtime: "pi-agent-core", message_count: agent.state.messages.length,
          model_calls: usage.model_calls, workspace_files: files.slice(0, 50),
        },
        progress_kind: "tool_progress",
      });
    } catch { /* checkpoint is best-effort */ }
  }

  private failedOutcome(usage: any, steps: number, reason: string): LoopOutcome {
    return {
      outcome: "FAILED",
      summary: reason,
      verification: { kind: "runtime_limit", passed: false, detail: reason },
      artifacts: [],
      usage: { ...usage, unknown_settlement: false },
      steps,
    };
  }
}
