// Pi runtime real-model smoke: the FULL PiLoopRuntime — @earendil-works
// agent loop + gated tool + metered gateway path — against the real
// DeepSeek API. Separate from deterministic contract tests per §21.2; must
// be BLOCKED (never faked) without credentials. Records model + usage.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "@looplab/llm";
import { PiLoopRuntime } from "../../workers/agent-worker/src/pi-runtime.js";
import { CapabilityGateway } from "../../workers/agent-worker/src/capability-gateway.js";

const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY);

describe("PiLoopRuntime real-model smoke", () => {
  it.skipIf(!HAS_KEY)("drives the pi agent loop through the metered gateway with a gated tool", { timeout: 180_000 }, async () => {
    const client = new DeepSeekClient({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    });

    // sandboxed workspace for the gated tool
    const ws = mkdtempSync(path.join(tmpdir(), "pi-smoke-ws-"));
    const gateway = new CapabilityGateway(ws, { toolTimeoutMs: 30_000, maxOutputBytes: 100_000, maxChildProcesses: 2 });

    const toolDefs = [{
      name: "workspace_write",
      description: "Write a text file inside the workspace. args: {path: string, content: string}",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    }];

    let usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
    const runtime = new PiLoopRuntime({
      model: { provider: "deepseek", id: process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat" },
      systemPrompt: "你是 LoopLab 的执行器。完成目标后，最后一行输出 RESULT: ok 或 RESULT: failed。",
      maxTurns: 6,
      llmComplete: async (req) => {
        const result = await client.chat({
          model: process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat",
          messages: req.messages as any,
          tools: req.tools as any,
          max_tokens: 1024,
        });
        usageTotal.prompt_tokens += result.usage.prompt_tokens;
        usageTotal.completion_tokens += result.usage.completion_tokens;
        const toolCalls = (result.message.tool_calls ?? []).map((tc: any, i: number) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        }));
        return { text: result.message.content ?? "", toolCalls, usage: result.usage, model: result.model };
      },
    });

    const { agent } = await runtime.start({
      messages: [],
      tools: toolDefs,
      gateway,
      initialUserPrompt: "在工作区创建 probe_pi_smoke.txt，内容为 PI_SMOKE_OK，然后验证文件写入成功并输出 RESULT: ok",
    });

    // the pi transcript must show a real assistant turn + tool result
    const roles = agent.state.messages.map((m: any) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("toolResult");
    expect(usageTotal.prompt_tokens).toBeGreaterThan(0);
    expect(usageTotal.completion_tokens).toBeGreaterThan(0);

    // the gated tool actually wrote INSIDE the sandbox
    const written = path.join(ws, "probe_pi_smoke.txt");
    expect(readFileSync(written, "utf8")).toContain("PI_SMOKE_OK");
  });
});
