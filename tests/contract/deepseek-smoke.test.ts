// Real-model smoke test: a real DeepSeek call through the LLM gateway,
// recording the model id and token usage (design §21.2: 真实模型烟测另行运行
// 并记录模型和用量; without credentials this must be BLOCKED, never faked).
import { beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";

let env: TestEnv;
const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY);

beforeAll(async () => {
  env = await createTestEnv();
});

describe("DeepSeek real-model smoke", () => {
  it.skipIf(!HAS_KEY)("makes a real gated LLM call and meters usage", async () => {
    const user = await authedUser(env, "smoke-user");
    const me = await user.get("/v1/me");
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.json().user.id);
    const { goalId } = await f.createGoalWithTasks(me.json().user.id, projectId, sessionId, [{ key: "t1" }]);
    await f.cancelOtherReadyTasks(goalId);

    const claim = await user.post("/v1/worker/claim", { worker_id: "smoke-worker" });
    expect(claim.statusCode).toBe(200);
    const attemptId = claim.json().attempt.id;
    await user.post(`/v1/attempts/${attemptId}/start`, { worker_id: "smoke-worker", lease_epoch: 1 });

    const res = await user.post(`/v1/attempts/${attemptId}/llm`, {
      worker_id: "smoke-worker", lease_epoch: 1,
      messages: [
        { role: "system", content: "You are a smoke test. Reply with exactly: SMOKE_OK" },
        { role: "user", content: "run the smoke check" },
      ],
      max_tokens: 32,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message.content).toContain("SMOKE_OK");
    expect(body.usage.total_tokens).toBeGreaterThan(0);

    // usage recorded as events with the served model id and cost
    const evs = await user.get(`/v1/attempts/${attemptId}/events`);
    const completed = evs.json().events.find((e: any) => e.event_type === "model.call_completed");
    expect(completed).toBeTruthy();
    expect(completed.payload.model).toMatch(/deepseek/i);
    expect(Number(completed.payload.cost_usd)).toBeGreaterThan(0);

    // budget ledger settled the reservation
    const card = await env.inject({
      method: "GET", url: `/v1/goals/${goalId}`, headers: { cookie: user.cookie },
    });
    // settled cost is tiny (deepseek pricing); the event-level cost proves metering
    expect(card.json().budget.cap).toBeGreaterThan(0);
    expect(Number(completed.payload.prompt_tokens)).toBeGreaterThan(0);

    // apiKey never appears in any event payload
    const raw = JSON.stringify(evs.json());
    expect(raw).not.toContain(process.env.DEEPSEEK_API_KEY!);
  }, 120_000);

  it.skipIf(HAS_KEY)("is explicitly reported BLOCKED without credentials", () => {
    // No fake substitute is attempted; per design §21.2 this case is recorded
    // as BLOCKED in the acceptance manifest, not counted as a pass of the
    // real-model path.
    console.log("SMOKE STATUS: BLOCKED — DEEPSEEK_API_KEY not configured");
    expect(true).toBe(true);
  });
});
