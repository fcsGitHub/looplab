// The bounded agent loop: this IS the DeepSeekLoopRuntime adapter behind
// AgentRuntimePort (design §14.2). Every model call is proxied through the
// control service (budget metered); every tool call passes the server-side
// PolicyGate before local execution. Pause = drain at a bounded boundary;
// steering is injected at the next turn, never mid-tool.
import type { RunSpec } from "@looplab/contracts";
import type { ControlClient } from "./control-client.js";
import { CapabilityGateway, sha256 } from "./capability-gateway.js";
import { FORCED_WRAPUP_INSTRUCTION, isForcedWrapUpTurn, settleRunResult, type Settlement } from "./result-synthesis.js";
import { materializePropagated } from "./propagate.js";
import { snapshotWorkspaceArtifacts } from "./snapshot.js";

export interface LoopOutcome {
  outcome: "SUCCEEDED" | "FAILED";
  summary: string;
  verification: { kind: string; passed: boolean; detail: string } | null;
  artifacts: { name: string; media_type: string; digest: string; size_bytes: number }[];
  usage: {
    model_calls: number; prompt_tokens: number; completion_tokens: number;
    estimated_cost_usd: number; unknown_settlement: boolean;
  };
  steps: number;
}

const ROLE_PROMPTS: Record<string, string> = {
  Coordinator: "你是 Coordinator：分解与协调任务、维护依赖、选择下一步。不跳过任何验证。",
  Researcher: "你是 Researcher：找证据、抽取主张、区分引文/推论/实测。不得把臆测写成实验结论。",
  Builder: "你是 Builder：写代码与配置，做最小可验证补丁，运行验证。",
  Experimenter: "你是 Experimenter：设计并运行实验，固定种子与预算，如实记录负结果。",
  Reviewer: "你是 Reviewer：独立检查证据与实现。你的职责是发现问题，不是迎合。",
  Curator: "你是 Curator：整理经验与技能候选，标注适用范围与反例。",
};

export class AgentLoop {
  private gateway: CapabilityGateway;
  private pendingSteers: { steer_id: string; content: string }[] = [];
  private drainRequested = false;
  private abortRequested = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeat = { action: "continue" as "continue" | "drain" | "abort", reason: null as string | null };

  constructor(
    private client: ControlClient,
    private spec: RunSpec,
    private workerId: string,
  ) {
    this.gateway = new CapabilityGateway(spec.sandbox.workspace_dir, {
      toolTimeoutMs: spec.resource_limits.tool_timeout_ms,
      maxOutputBytes: spec.resource_limits.max_output_bytes,
      maxChildProcesses: spec.resource_limits.max_child_processes,
    });
  }

  private startHeartbeat() {
    const interval = Math.max(2000, Math.min(this.spec.lease.heartbeat_interval_ms, 8000));
    this.heartbeatTimer = setInterval(async () => {
      try {
        const res = await this.client.heartbeat(this.spec.attempt_id, this.workerId, this.spec.lease.epoch);
        if (res.status === 200 && res.json) {
          this.lastHeartbeat.action = res.json.action;
          this.lastHeartbeat.reason = res.json.reason;
          if (res.json.action === "drain") this.drainRequested = true;
          if (res.json.action === "abort") this.abortRequested = true;
          for (const s of res.json.pending_steers ?? []) {
            this.pendingSteers.push(s);
          }
        }
      } catch {
        // transient network errors: lease TTL gives us slack
      }
    }, interval);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  async run(): Promise<LoopOutcome> {
    const started = Date.now();
    this.startHeartbeat();
    const usage = {
      model_calls: 0, prompt_tokens: 0, completion_tokens: 0,
      estimated_cost_usd: 0, unknown_settlement: false,
    };
    const messages: any[] = [];
    try {
      await this.client.start(this.spec.attempt_id, this.workerId, this.spec.lease.epoch);
    } catch { /* already STARTED is fine */ }

    // cross-attempt propagation: predecessor deliverables into this workspace
    const propagated = await materializePropagated(this.client, this.spec, this.workerId).catch(() => [] as string[]);
    if (propagated.length) {
      messages.push({ role: "user", content: `[系统] 前序任务交付物已放入工作区：${propagated.join(", ")}` });
    }
    // A2A handoff notes: what each predecessor CLAIMS it delivered — successors
    // must build on these recorded claims instead of guessing file contents
    for (const note of this.spec.handoff_notes ?? []) {
      messages.push({
        role: "user",
        content: `[交接·来自前序任务 ${note.from_task_key}（${note.from_role}，${note.outcome}）] ${note.summary}`,
      });
    }

    const toolDefs = this.spec.allowed_tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    messages.push({
      role: "system",
      content: [
        `角色：${this.spec.role}。${ROLE_PROMPTS[this.spec.role] ?? ""}`,
        `总体目标：${this.spec.objective}`,
        `本任务：${this.spec.task_title}`,
        `任务指令：\n${this.spec.task_instruction}`,
        `工作区（绝对路径，工具中的 path 用相对路径）：${this.spec.sandbox.workspace_dir}`,
        `约束：最多 ${this.spec.resource_limits.max_steps} 轮；Python 可用（标准库）；不得虚构结果；实验必须真实运行。`,
        `结束时，最后一条消息以 RESULT 开头并附单行 JSON：`,
        `{"summary":"结果摘要（含关键数字/证据）","outcome":"SUCCEEDED"或"FAILED","verification":{"kind":"验证方式","passed":true或false,"detail":"验证细节"},"files":["工作区中作为交付物的文件"]}`,
      ].join("\n\n"),
    });
    messages.push({ role: "user", content: `请开始执行任务：${this.spec.task_title}` });

    let steps = 0;
    let toolCalls = 0;
    let finalText: string | null = null;

    while (steps < this.spec.resource_limits.max_steps) {
      if (this.abortRequested) {
        this.stopHeartbeat();
        return this.failedOutcome(usage, steps, `aborted: ${this.lastHeartbeat.reason ?? "user cancel"}`, true);
      }
      if (Date.now() - started > this.spec.resource_limits.wall_clock_ms) {
        this.stopHeartbeat();
        return this.failedOutcome(usage, steps, "wall clock limit reached", true);
      }

      // deliver pending steering at the turn boundary (steer ≠ interrupt)
      for (const s of this.pendingSteers.splice(0)) {
        messages.push({ role: "user", content: `[用户实时干预] ${s.content}` });
        this.client.confirmSteer(this.spec.attempt_id, s.steer_id, this.workerId, this.spec.lease.epoch).catch(() => {});
      }

      // near the step limit: force an honest wrap-up instead of "no output"
      const forceWrapUp = isForcedWrapUpTurn(steps, this.spec.resource_limits.max_steps);
      const res = await this.client.llm(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
        messages: forceWrapUp
          ? [...messages, { role: "user" as const, content: FORCED_WRAPUP_INSTRUCTION }]
          : messages,
        tools: forceWrapUp ? undefined : toolDefs,
        max_tokens: this.spec.model.max_tokens,
        temperature: this.spec.model.temperature,
      });
      if (res.status !== 200) {
        if (res.json?.error === "budget_exceeded") {
          this.stopHeartbeat();
          return this.failedOutcome(usage, steps, "预算耗尽：控制服务拒绝新的模型调用", true);
        }
        // transient LLM error: bounded retry
        if (usage.model_calls < this.spec.budget.max_model_calls && steps < this.spec.resource_limits.max_steps - 1) {
          await sleep(2000);
          continue;
        }
        this.stopHeartbeat();
        return this.failedOutcome(usage, steps, `LLM 调用失败: HTTP ${res.status}`, true);
      }

      usage.model_calls++;
      usage.prompt_tokens += res.json.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += res.json.usage?.completion_tokens ?? 0;
      steps++;

      const msg = res.json.message;
      messages.push(msg);

      if (msg.tool_calls?.length) {
        for (const call of msg.tool_calls) {
          if (this.abortRequested) break;
          if (++toolCalls > this.spec.resource_limits.max_tool_calls) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "ERROR: tool call cap reached" });
            continue;
          }
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* keep {} */ }

          const decision = await this.client.authorizeTool(
            this.spec.attempt_id, this.workerId, this.spec.lease.epoch, call.function.name, args,
          );
          if (decision.status !== 200) {
            messages.push({ role: "tool", tool_call_id: call.id, content: `GATE ERROR: HTTP ${decision.status}` });
            continue;
          }
          if (!decision.json.allowed) {
            messages.push({
              role: "tool", tool_call_id: call.id,
              content: `DENIED by policy gate: ${decision.json.reason}`,
            });
            continue;
          }
          const normalizedArgs = decision.json.normalized_args ?? args;
          const result = await this.gateway.execute(call.function.name, normalizedArgs);
          this.client.reportTool(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
            tool: call.function.name, ok: result.ok,
            output_digest: sha256(result.output),
            output_bytes: result.outputBytes,
            duration_ms: result.durationMs,
          }).catch(() => {});
          messages.push({ role: "tool", tool_call_id: call.id, content: result.output || "(no output)" });
        }
        await this.maybeCheckpoint(messages, steps, usage, "tool_progress");
        // drain: finish this bounded batch, then wrap up honestly
        if (this.drainRequested) {
          messages.push({ role: "user", content: "[系统] 用户已暂停目标：请立即停止新动作，总结当前真实进展，并按格式输出 RESULT。" });
          const wrap = await this.client.llm(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
            messages, max_tokens: 800,
          });
          if (wrap.status === 200) {
            usage.model_calls++;
            usage.prompt_tokens += wrap.json.usage?.prompt_tokens ?? 0;
            usage.completion_tokens += wrap.json.usage?.completion_tokens ?? 0;
            finalText = wrap.json.message?.content ?? finalText;
          }
          break;
        }
        continue;
      }

      // no tool calls: final answer expected
      finalText = msg.content ?? "";
      break;
    }

    this.stopHeartbeat();

    // parse RESULT (with one re-ask on failure)
    let parsed = parseResult(finalText);
    if (!parsed && finalText && !this.abortRequested) {
      const retry = await this.client.llm(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
        messages: [...messages, { role: "user", content: "请严格按格式输出 RESULT + 单行 JSON（不要其他文字）。" }],
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

    // upload deliverable files as artifacts
    const artifacts: LoopOutcome["artifacts"] = [];
    for (const f of parsed?.files ?? []) {
      try {
        const abs = await safeJoin(this.spec.sandbox.workspace_dir, f);
        const { promises: fs } = await import("node:fs");
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

    // deterministic snapshot: deliverables are registered even when the model
    // omits them from RESULT.files (ledger #5 part 2)
    const snapshot = await snapshotWorkspaceArtifacts(this.client, this.spec, this.spec.sandbox.workspace_dir);
    const byName = new Map(artifacts.map((a) => [a.name, a]));
    for (const snap of snapshot) {
      if (!byName.has(snap.name)) {
        byName.set(snap.name, { name: snap.name, media_type: snap.media_type, digest: snap.digest, size_bytes: snap.size_bytes });
      }
    }

    const aborted = this.abortRequested;
    const settlement: Settlement = aborted
      ? {
          outcome: "FAILED",
          summary: `已中止：${this.lastHeartbeat.reason ?? "user cancel"}`,
          verification: { kind: "runtime_limit", passed: false, detail: "attempt aborted by user command" },
        }
      : settleRunResult({ parsed, finalText });
    return {
      outcome: settlement.outcome,
      summary: settlement.summary,
      verification: settlement.verification,
      artifacts: [...byName.values()],
      usage: { ...usage, unknown_settlement: false },
      steps,
    };
  }

  private async maybeCheckpoint(messages: any[], step: number, usage: any, kind: string) {
    try {
      const { promises: fs } = await import("node:fs");
      const files = await fs.readdir(this.spec.sandbox.workspace_dir).catch(() => [] as string[]);
      await this.client.checkpoint(this.spec.attempt_id, this.workerId, this.spec.lease.epoch, {
        step_index: step,
        summary: `step ${step}: ${messages.length} messages, ${usage.model_calls} model calls, workspace files: ${files.slice(0, 10).join(",") || "(none)"}`,
        state: {
          message_count: messages.length, model_calls: usage.model_calls,
          workspace_files: files.slice(0, 50),
          visible_messages: messages.slice(-4).map((m: any) => ({ role: m.role, len: (m.content ?? "").length })),
        },
        progress_kind: kind,
      });
    } catch { /* checkpoint is best-effort */ }
  }

  private failedOutcome(usage: any, steps: number, reason: string, abortedLike: boolean): LoopOutcome {
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseResult(text: string | null): { summary: string; outcome: "SUCCEEDED" | "FAILED"; verification: { kind: string; passed: boolean; detail: string } | null; files: string[] } | null {
  if (!text) return null;
  const idx = text.indexOf("RESULT");
  if (idx === -1) return null;
  const tail = text.slice(idx + 6).trim();
  const m = tail.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      summary: String(j.summary ?? "").slice(0, 2000),
      outcome: j.outcome === "FAILED" ? "FAILED" : "SUCCEEDED",
      verification: j.verification ? {
        kind: String(j.verification.kind ?? "self_report"),
        passed: Boolean(j.verification.passed),
        detail: String(j.verification.detail ?? ""),
      } : null,
      files: Array.isArray(j.files) ? j.files.map(String).slice(0, 20) : [],
    };
  } catch {
    return null;
  }
}

export async function safeJoin(workspace: string, rel: string): Promise<string> {
  const path = await import("node:path");
  const root = path.resolve(workspace);
  const abs = path.resolve(workspace, rel);
  // separator-aware containment: the bare startsWith check accepted
  // ../<sibling-attempt-id-prefix>/file — a real cross-attempt read on a
  // shared worker (P25; every other containment site already used root+sep)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("path escapes workspace");
  return abs;
}

export function guessMediaType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const table: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    py: "text/x-python", csv: "text/csv", html: "text/html", png: "image/png",
    js: "text/javascript", ts: "text/typescript", yaml: "text/yaml", yml: "text/yaml",
  };
  return table[ext] ?? "application/octet-stream";
}
