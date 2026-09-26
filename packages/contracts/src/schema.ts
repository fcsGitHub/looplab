// LoopLab contracts: zod schemas for the event envelope (design §17.2),
// commands (§17.3) and core run specifications.
import { z } from "zod";

export const ActorSchema = z.object({
  kind: z.enum(["user", "system", "worker", "agent", "evaluator", "optimizer"]),
  id: z.string(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const AGGREGATE_TYPES = [
  "goal", "session", "task", "attempt", "candidate", "release",
  "budget", "hypothesis", "approval",
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export const EventEnvelopeSchema = z.object({
  schema_version: z.literal("1"),
  event_id: z.string(),
  aggregate_type: z.string(),
  aggregate_id: z.string(),
  sequence: z.number().int().nonnegative(),
  event_type: z.string(),
  goal_id: z.string().nullable().optional(),
  goal_version: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  causation_id: z.string().nullable().optional(),
  actor: ActorSchema.nullable().optional(),
  lease_epoch: z.number().int().nullable().optional(),
  payload_ref: z.string().nullable().optional(),
  payload: z.unknown().nullable().optional(),
  occurred_at: z.string(),
  /** server receive time; ordering/leases never trust worker clocks */
  ingested_at: z.string(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ---- commands (design §17.3) --------------------------------------------
export const CommandKindSchema = z.enum([
  "pause", "resume", "cancel", "steer", "revise", "approve", "reject",
  "promote", "rollback",
]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const CommandReceiptSchema = z.object({
  status: z.enum(["ACCEPTED", "REJECTED"]),
  command_id: z.string(),
  reason: z.string().optional(),
  applied: z.boolean(),
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

// ---- RunSpec: frozen execution contract handed to a worker --------------
export const ToolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  /** risk class drives gate policy; high-risk tools need explicit authorization */
  risk: z.enum(["low", "medium", "high"]).default("low"),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const ModelConfigRefSchema = z.object({
  provider: z.literal("deepseek"),
  model: z.string(),
  /** reference into server-protected config; the key itself never leaves it */
  credential_ref: z.string(),
  max_tokens: z.number().int().positive().default(2048),
  temperature: z.number().min(0).max(2).default(0.7),
});
export type ModelConfigRef = z.infer<typeof ModelConfigRefSchema>;

export const RunSpecSchema = z.object({
  spec_version: z.literal("1"),
  attempt_id: z.string(),
  task_id: z.string(),
  task_key: z.string(),
  goal_id: z.string(),
  goal_version: z.number().int(),
  graph_version: z.string(),
  role: z.string(),
  objective: z.string(),
  task_title: z.string(),
  task_instruction: z.string(),
  input_refs: z.array(z.string()).default([]),
  parent_asset_digests: z.array(z.string()).default([]),
  model: ModelConfigRefSchema,
  allowed_tools: z.array(ToolSpecSchema),
  resource_limits: z.object({
    max_steps: z.number().int().positive().default(12),
    max_tool_calls: z.number().int().positive().default(24),
    wall_clock_ms: z.number().int().positive().default(10 * 60_000),
    tool_timeout_ms: z.number().int().positive().default(60_000),
    max_output_bytes: z.number().int().positive().default(256 * 1024),
    max_child_processes: z.number().int().positive().default(4),
  }),
  budget: z.object({
    budget_id: z.string(),
    max_model_calls: z.number().int().positive().default(64),
    max_cost_usd: z.number().positive(),
    cost_per_call_reserve_usd: z.number().nonnegative(),
  }),
  lease: z.object({
    epoch: z.number().int().positive(),
    heartbeat_interval_ms: z.number().int().positive().default(15_000),
    ttl_ms: z.number().int().positive().default(90_000),
  }),
  sandbox: z.object({
    workspace_dir: z.string(),
    python_executable: z.string().nullable(),
  }),
  steering_mode: z.enum(["next_turn", "disabled"]).default("next_turn"),
  /**
   * Cross-attempt artifact propagation (problem ledger #5): predecessor
   * deliverables resolved by the SCHEDULER at claim time, materialized into
   * the attempt workspace by the worker before the loop starts. Resolved
   * from SUCCEEDED predecessor tasks' latest committed task-scope artifacts;
   * capped by the scheduler. Empty unless predecessors produced files.
   */
  propagated_artifacts: z.array(z.object({
    name: z.string(),
    digest: z.string(),
    from_task_key: z.string(),
  })).default([]),
  /**
   * A2A handoff (P25): structured predecessor context resolved by the
   * SCHEDULER at claim time — the RESULT summary (and honest outcome) of each
   * direct SUCCEEDED predecessor's latest committed attempt. The worker
   * injects these as system notes so the successor agent knows WHAT the
   * predecessor delivered and claimed, not just which files exist. This is the
   * anti-hallucination half of handoff: successors build on recorded claims,
   * not on guesses about file contents.
   */
  handoff_notes: z.array(z.object({
    from_task_key: z.string(),
    from_role: z.string(),
    outcome: z.string(),
    summary: z.string(),
  })).default([]),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

// ---- worker -> control reports ------------------------------------------
export const HeartbeatResponseSchema = z.object({
  action: z.enum(["continue", "drain", "abort"]),
  reason: z.string().nullable(),
  pending_steers: z.array(z.object({
    steer_id: z.string(),
    content: z.string(),
  })).default([]),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const StepCheckpointSchema = z.object({
  attempt_id: z.string(),
  lease_epoch: z.number().int().positive(),
  step_index: z.number().int().nonnegative(),
  summary: z.string(),
  state: z.record(z.unknown()),
  artifact_refs: z.array(z.string()).default([]),
  progress_kind: z.enum(["model_call", "tool_progress", "useful_progress", "rewrite_only"]),
});

export const CommitPayloadSchema = z.object({
  attempt_id: z.string(),
  lease_epoch: z.number().int().positive(),
  expected_status: z.enum(["RUNNING", "RESULT_PENDING"]),
  outcome: z.enum(["SUCCEEDED", "FAILED"]),
  error_class: z.string().nullable().default(null),
  summary: z.string(),
  artifacts: z.array(z.object({
    name: z.string(),
    media_type: z.string(),
    digest: z.string(),
    size_bytes: z.number().int().nonnegative(),
    scope: z.string().default("task"),
  })).default([]),
  usage: z.object({
    model_calls: z.number().int().nonnegative(),
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    unknown_settlement: z.boolean().default(false),
  }),
  verification: z.object({
    kind: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  }).nullable().default(null),
});
export type CommitPayload = z.infer<typeof CommitPayloadSchema>;

// ---- budget --------------------------------------------------------------
export const BudgetScopeSchema = z.enum([
  "task_execution", "evolution_search", "evaluation_repro", "meta_evolution",
]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

// ---- graph ---------------------------------------------------------------
export const TaskNodeSchema = z.object({
  key: z.string(),
  role: z.enum(["Coordinator", "Researcher", "Builder", "Experimenter", "Reviewer", "Curator"]),
  kind: z.enum(["model", "experiment", "integration", "review"]),
  title: z.string(),
  instruction: z.string(),
  depends_on: z.array(z.string()).default([]),
  input_refs: z.array(z.string()).default([]),
  expected_output: z.string().nullable().default(null),
  risk_class: z.enum(["low", "medium", "high"]).default("low"),
  max_steps: z.number().int().positive().optional(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const GraphContractSchema = z.object({
  version: z.string(),
  nodes: z.array(TaskNodeSchema).min(1),
  /** agent-graph loops are allowed but must declare bounded revisit limits */
  loops: z.array(z.object({
    back_edge: z.object({ from: z.string(), to: z.string() }),
    // boundedness is enforced by the graph compiler (not here) so that the
    // "unbounded_loop" error class stays meaningful
    max_visits: z.number().int(),
    exit_condition: z.string(),
  })).default([]),
});
export type GraphContract = z.infer<typeof GraphContractSchema>;
