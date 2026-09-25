// LLM gateway: the ONLY path by which any component (planner, worker, eval)
// reaches a model. Guarantees: budget reserved before the call, usage settled
// after, unknown settlement stays conservative (A08), model+tokens recorded
// as events, and the API key never leaves this process.
//
// NOTE: the HTTP call intentionally happens OUTSIDE any DB transaction. The
// reservation stays open while the request is in flight; if this process dies
// mid-call the reservation remains as unknown cost — exactly the A08 rule.
import { DeepSeekClient, estimateCostUsd, LlmHttpError, type ChatMessage, type ToolDefinition, type ChatResult } from "@looplab/llm";
import { EventStore } from "./eventstore.js";
import { BudgetService, BudgetExceededError } from "./budget.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

export interface GatewayCallInput {
  goalId: string;
  attemptId?: string | null;
  scope: "task_execution" | "evolution_search" | "evaluation_repro" | "meta_evolution";
  kind?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  model?: "chat" | "reasoner";
  idempotencyKey: string;
  actor: { kind: string; id: string };
  traceId?: string;
  /** expected worst-case cost used for the reservation */
  reserveUsd?: number;
  signal?: AbortSignal;
}

export class LlmGateway {
  private client: DeepSeekClient;
  private budget: BudgetService;

  constructor(private db: Db, private config: Config) {
    this.client = new DeepSeekClient({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
    });
    this.budget = new BudgetService(db as any);
  }

  private redact(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => ({
      ...m,
      content: m.content?.replaceAll(this.config.deepseek.apiKey, "[REDACTED]") ?? m.content,
    }));
  }

  async call(input: GatewayCallInput): Promise<ChatResult> {
    const model = input.model === "reasoner" ? this.config.deepseek.reasonerModel : this.config.deepseek.chatModel;
    const maxTokens = input.maxTokens ?? 2048;
    const promptChars = input.messages.reduce((a, m) => a + (m.content?.length ?? 0), 0);
    const promptTokens = Math.ceil(promptChars / 3);
    const worstCaseUsd =
      input.reserveUsd ??
      (promptTokens / 1000) * this.config.costPer1kPromptUsd +
        (maxTokens / 1000) * this.config.costPer1kCompletionUsd;

    // global 24h spend fuse (P18): per-goal caps cannot see cross-goal
    // aggregate burn; DAILY_BUDGET_USD>0 turns the whole gateway off once
    // the rolling day's reserved+settled+unknown reaches the cap. Checked
    // outside the reservation tx so the refusal is not silently rolled back.
    if (this.config.dailyBudgetUsd > 0) {
      const day = await this.db.query(
        `SELECT COALESCE(sum(settled_usd + reserved_usd + unknown_usd),0)::float AS usd
           FROM budget_reservations WHERE updated_at > now() - interval '24 hours'`,
      );
      const spent = Number(day.rows[0]?.usd ?? 0);
      if (spent + worstCaseUsd > this.config.dailyBudgetUsd + 1e-9) {
        throw new BudgetExceededError({
          required: worstCaseUsd,
          available: Math.max(0, this.config.dailyBudgetUsd - spent),
          cap: this.config.dailyBudgetUsd,
        });
      }
    }

    // tx 1: reserve
    const { id: reservationId } = await this.db.tx(async (client) => {
      const res = await this.budget.reserve(client, {
        goalId: input.goalId,
        attemptId: input.attemptId ?? null,
        scope: input.scope,
        kind: input.kind ?? "model",
        amount: Math.max(worstCaseUsd, 0.0001),
        idempotencyKey: input.idempotencyKey,
      });
      await EventStore.append(client, {
        aggregateType: input.attemptId ? "attempt" : "goal",
        aggregateId: input.attemptId ?? input.goalId,
        eventType: "model.call_started",
        goalId: input.goalId,
        actor: input.actor,
        causationId: input.idempotencyKey,
        payload: {
          model, max_tokens: maxTokens, reserved_usd: worstCaseUsd,
          messages_redacted: this.redact(input.messages).map((m) => ({ role: m.role, len: m.content?.length ?? 0 })),
        },
      });
      return res;
    });

    // HTTP call, no transaction held
    let result: ChatResult;
    try {
      result = await this.client.chat({
        model,
        messages: input.messages,
        tools: input.tools,
        max_tokens: maxTokens,
        temperature: input.temperature,
        signal: input.signal,
      });
    } catch (err) {
      await this.db.tx(async (client) => {
        const retryableConnect = err instanceof LlmHttpError && err.retryable;
        // unknown settlement: the request may have been served & billed
        await this.budget.markUnknown(client, reservationId);
        await EventStore.append(client, {
          aggregateType: input.attemptId ? "attempt" : "goal",
          aggregateId: input.attemptId ?? input.goalId,
          eventType: "model.call_failed",
          goalId: input.goalId,
          actor: input.actor,
          causationId: input.idempotencyKey,
          payload: {
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
            settlement: "unknown_reserved",
          },
        });
      });
      throw err;
    }

    // tx 2: settle actual usage
    const cost = estimateCostUsd(result.usage, this.config.costPer1kPromptUsd, this.config.costPer1kCompletionUsd);
    await this.db.tx(async (client) => {
      await this.budget.settle(client, reservationId, cost);
      if (input.attemptId) {
        await client.query(
          `UPDATE attempts SET model_calls = model_calls + 1, settled_usd = settled_usd + $2
           WHERE id = $1`,
          [input.attemptId, cost],
        );
      }
      await EventStore.append(client, {
        aggregateType: input.attemptId ? "attempt" : "goal",
        aggregateId: input.attemptId ?? input.goalId,
        eventType: "model.call_completed",
        goalId: input.goalId,
        actor: input.actor,
        causationId: input.idempotencyKey,
        payload: {
          model: result.model, finish_reason: result.finish_reason,
          prompt_tokens: result.usage.prompt_tokens,
          completion_tokens: result.usage.completion_tokens,
          cost_usd: Number(cost.toFixed(6)),
        },
      });
    });
    return result;
  }
}
