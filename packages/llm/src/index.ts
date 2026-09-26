// DeepSeek OpenAI-compatible client. Real HTTP only — no mocks anywhere in
// this package. Pricing constants live with the caller (they own the ledger).

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: ChatUsage;
  model: string; // model id actually served (from response body)
  finish_reason: string;
}

export class LlmHttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "LlmHttpError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class DeepSeekClient {
  constructor(
    private opts: { apiKey: string; baseUrl: string },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(input: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    max_tokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    // default 180s ceiling: a hung connection must not stall a single-threaded
    // worker forever (P23). Callers may pass their own signal.
    const timeout = AbortSignal.timeout(180_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}),
        max_tokens: input.max_tokens ?? 2048,
        temperature: input.temperature ?? 0.7,
      }),
      signal,
    });
    if (!res.ok) {
      throw new LlmHttpError(res.status, await res.text());
    }
    const body: any = await res.json();
    const choice = body.choices?.[0];
    if (!choice) throw new LlmHttpError(502, JSON.stringify(body).slice(0, 300));
    return {
      message: choice.message,
      usage: body.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: body.model ?? input.model,
      finish_reason: choice.finish_reason ?? "stop",
    };
  }
}

export function estimateCostUsd(
  usage: ChatUsage,
  per1kPrompt: number,
  per1kCompletion: number,
): number {
  return (
    (usage.prompt_tokens / 1000) * per1kPrompt +
    (usage.completion_tokens / 1000) * per1kCompletion
  );
}
