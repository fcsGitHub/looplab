// LoopLab contracts: AgentRuntimePort (design §14.2).
// This port is OUR system's contract — not a claim that any SDK natively
// exposes it. Adapters: DeepSeekLoopRuntime (built-in, real HTTP), and the Pi
// adapter (@earendil-works/pi-agent-core) behind the same interface.

export interface RuntimeHandle {
  attemptId: string;
  workerId: string;
}

export interface UserInstruction {
  content: string;
  steerId?: string;
}

export interface RuntimeEvent {
  kind: "model_call_start" | "model_call_end" | "tool_call" | "tool_result"
      | "tool_denied" | "steer_applied" | "checkpoint" | "step" | "end";
  at: string;
  data: Record<string, unknown>;
}

export interface StartOptions {
  signal?: AbortSignal;
}

export interface AgentRuntimePort {
  readonly name: string;
  start(spec: unknown, options?: StartOptions): Promise<RuntimeHandle>;
  events(handle: RuntimeHandle, after?: string): AsyncIterable<RuntimeEvent>;
  steer(handle: RuntimeHandle, input: UserInstruction): Promise<{ accepted: boolean; reason?: string }>;
  requestDrain(handle: RuntimeHandle): Promise<{ accepted: boolean; reason?: string }>;
  abort(handle: RuntimeHandle): Promise<{ accepted: boolean; reason?: string }>;
  checkpoint(handle: RuntimeHandle): Promise<{ checkpointId: string }>;
  restore(ref: { checkpointId: string }, spec: unknown): Promise<RuntimeHandle>;
}
