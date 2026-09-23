// LoopLab contracts: state machines (design §6.2, §17.1).
// A transition that is not listed here is invalid everywhere in the platform:
// the control service, the workers and the UI all consume these tables.

export const GOAL_STATES = [
  "DRAFT", "ACTIVE", "PAUSED_USER", "WAITING_RESOURCE", "BLOCKED_INPUT",
  "COMPLETED", "CANCELLED",
] as const;
export type GoalState = (typeof GOAL_STATES)[number];

// User pause must never be lifted automatically (A07): only `resume` command.
export const GOAL_TRANSITIONS: Record<GoalState, readonly GoalState[]> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED_USER", "WAITING_RESOURCE", "BLOCKED_INPUT", "COMPLETED", "CANCELLED"],
  PAUSED_USER: ["ACTIVE", "CANCELLED"],
  WAITING_RESOURCE: ["ACTIVE", "PAUSED_USER", "CANCELLED"],
  BLOCKED_INPUT: ["ACTIVE", "PAUSED_USER", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const TASK_STATES = [
  "READY", "RUNNING", "WAITING", "VERIFYING", "SUCCEEDED", "FAILED", "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  READY: ["RUNNING", "WAITING", "CANCELLED"],
  WAITING: ["READY", "CANCELLED"],
  RUNNING: ["VERIFYING", "SUCCEEDED", "FAILED", "CANCELLED"],
  VERIFYING: ["SUCCEEDED", "FAILED", "RUNNING"],
  SUCCEEDED: [],
  FAILED: ["READY"], // re-planning may re-open a failed task with a new attempt
  CANCELLED: [],
};

export const ATTEMPT_STATES = [
  "LEASED", "STARTED", "RUNNING", "RESULT_PENDING", "COMMITTED",
  "LOST", "RECONCILE_REQUIRED", "ABORTED",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

// RESULT_PENDING -> LOST is forbidden to auto-retry blindly: external outcome
// unknown forces RECONCILE_REQUIRED (design §6.4, A04/A05).
export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  LEASED: ["STARTED", "LOST", "ABORTED"],
  STARTED: ["RUNNING", "LOST", "ABORTED"],
  RUNNING: ["RESULT_PENDING", "COMMITTED", "LOST", "ABORTED"],
  RESULT_PENDING: ["COMMITTED", "RECONCILE_REQUIRED"],
  COMMITTED: [],
  LOST: ["RECONCILE_REQUIRED"],
  RECONCILE_REQUIRED: [],
  ABORTED: [],
};

export const CANDIDATE_STATES = [
  "PROPOSED", "BUILT", "EVALUATING", "INCONCLUSIVE", "ELIGIBLE",
  "CANARY", "RELEASED", "REJECTED", "ROLLED_BACK",
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const CANDIDATE_TRANSITIONS: Record<CandidateState, readonly CandidateState[]> = {
  PROPOSED: ["BUILT", "REJECTED"],
  BUILT: ["EVALUATING", "REJECTED"],
  EVALUATING: ["ELIGIBLE", "INCONCLUSIVE", "REJECTED"],
  INCONCLUSIVE: ["EVALUATING"],
  ELIGIBLE: ["CANARY", "RELEASED", "REJECTED"],
  CANARY: ["RELEASED", "ROLLED_BACK"],
  RELEASED: ["ROLLED_BACK"],
  REJECTED: [],
  ROLLED_BACK: [],
};

export const HYPOTHESIS_STAGES = ["S0", "S1", "S2", "S3", "S4"] as const;
export type HypothesisStage = (typeof HYPOTHESIS_STAGES)[number];

export const HYPOTHESIS_STATES = [
  "PROPOSED", "TESTABLE", "UNDERPOWERED", "SUPPORTED_IN_SCOPE",
  "FALSIFIED_IN_SCOPE", "DORMANT",
] as const;
export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

// Research verdicts (design §11.3): small-scale failure is NOT a refutation.
export const RESEARCH_VERDICTS = [
  "implementation_failed", "insufficient_power", "out_of_regime",
  "falsified_in_scope", "supported_in_scope",
] as const;
export type ResearchVerdict = (typeof RESEARCH_VERDICTS)[number];

export const CLAIM_STANCES = [
  "条件内支持", "证据不足", "条件内否定", "已被反证",
] as const;
export type ClaimStance = (typeof CLAIM_STANCES)[number];

export function canTransition(
  table: Record<string, readonly string[]>,
  from: string,
  to: string,
): boolean {
  return (table[from] ?? []).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(aggregate: string, from: string, to: string) {
    super(`invalid ${aggregate} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}
