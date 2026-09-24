import { z } from "zod";

// OptimizerPort contract (design §5.3, §6.8). The control kernel owns this
// file; optimizer backends are replaceable adapters behind it. Two structural
// guarantees live here:
//  1. Authorization: an optimizer may only run when the active epoch says so
//     (or during a sanctioned epoch trial), and unknown backends can never
//     self-register (they cannot approve their own promotion).
//  2. Recursion depth 1: the port only ever carries the DECLARED task-domain
//     component (e.g. heuristic source). There is no channel by which an
//     optimizer proposes changes to evaluators, sealed labels, kernel code or
//     other optimizers — those files are not part of any manifest.

export const OPTIMIZER_BACKENDS = ["simple-baseline@1", "gepa@0.1.4", "openevolve@0.3.2"] as const;
export type OptimizerBackendId = (typeof OPTIMIZER_BACKENDS)[number];

export function isKnownBackend(id: string): id is OptimizerBackendId {
  return (OPTIMIZER_BACKENDS as readonly string[]).includes(id);
}

export const OptimizerComponentSchema = z.object({
  name: z.string().regex(/^[a-z_]{1,64}$/),
  kind: z.literal("python_source"),
  entry_export: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  signature: z.string().min(1),
});
export type OptimizerComponent = z.infer<typeof OptimizerComponentSchema>;

export const OptimizerRunManifestSchema = z.object({
  run_id: z.string().min(1),
  goal_id: z.string().min(1),
  backend: z.string().min(1),
  mode: z.enum(["active", "epoch_trial"]),
  epoch_index: z.number().int().nonnegative(),
  taskpack_id: z.string().min(1),
  component: OptimizerComponentSchema,
  dev_suite_path: z.string().min(1),
  baseline_path: z.string().min(1),
  work_dir: z.string().min(1),
  out_dir: z.string().min(1),
  budget: z.object({
    max_metric_calls: z.number().int().positive(),
    max_llm_cost_usd: z.number().nonnegative(),
  }),
  seed: z.number().int().nonnegative(),
  // "scripted" replaces the reflection LM with a deterministic fixture — for
  // contract/integration tests ONLY, never counted as real-model acceptance.
  reflection: z.enum(["gateway", "scripted"]),
  gateway_url: z.string().optional(),
  train_split: z.number().min(0.1).max(0.9).default(0.5),
});
export type OptimizerRunManifest = z.infer<typeof OptimizerRunManifestSchema>;

export const OptimizerProposalSchema = z.object({
  mechanism: z.string().min(1),
  changed_summary: z.string().default(""),
  candidate_code: z.string().min(1),
  expected_effect: z.string().default(""),
  // per-backend internal validation scores; null = not measured (INCONCLUSIVE
  // at the optimizer layer — the pipeline still evaluates independently).
  train_score: z.number().nullable().default(null),
  val_score: z.number().nullable().default(null),
});
export type OptimizerProposal = z.infer<typeof OptimizerProposalSchema>;

export const OptimizerUsageSchema = z.object({
  metric_calls: z.number().int().nonnegative(),
  llm_calls: z.number().int().nonnegative(),
  prompt_tokens: z.number().int().nonnegative().default(0),
  completion_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  model: z.string().nullable().default(null),
});
export type OptimizerUsage = z.infer<typeof OptimizerUsageSchema>;

export const OptimizerCompletePayloadSchema = z.object({
  proposals: z.array(OptimizerProposalSchema).max(20),
  usage: OptimizerUsageSchema,
  stopped_reason: z.string().default("completed"),
});
export type OptimizerCompletePayload = z.infer<typeof OptimizerCompletePayloadSchema>;

// ---- epoch guard (§6.8) ----------------------------------------------------
export interface OptimizerEpoch {
  index: number;
  active_backend: string;
  frozen: { kernel_version: string; suite_family: string; seed_archive: number };
  status: "OPEN" | "TRIAL_RUNNING" | "CLOSED";
}

export type AuthorizeResult = { ok: true } | { ok: false; reason: string };

export function assertOptimizerAuthorized(input: {
  epoch: OptimizerEpoch | null;
  backend: string;
  mode: "active" | "epoch_trial";
}): AuthorizeResult {
  if (!isKnownBackend(input.backend)) {
    return { ok: false, reason: `unknown optimizer backend ${input.backend}: backends must be registered in the OptimizerPort contract` };
  }
  if (input.mode === "epoch_trial") {
    if (!input.epoch || input.epoch.status !== "OPEN") {
      return { ok: false, reason: "epoch trial requires an OPEN epoch" };
    }
    return { ok: true };
  }
  if (!input.epoch) {
    return { ok: false, reason: "no optimizer epoch is active" };
  }
  if (input.epoch.status === "CLOSED") {
    return { ok: false, reason: `epoch ${input.epoch.index} is closed; the active backend is defined by the newest open epoch` };
  }
  if (input.epoch.active_backend !== input.backend) {
    return {
      ok: false,
      reason: `backend ${input.backend} is not the active optimizer for epoch ${input.epoch.index} (active: ${input.epoch.active_backend}); run a sanctioned epoch trial to change it`,
    };
  }
  return { ok: true };
}

// A backend switch only happens when the challenger improved on the incumbent
// by a strict margin over the SAME frozen comparison protocol. Ties and
// regressions keep the incumbent — INCONCLUSIVE never flips the epoch.
export function nextEpochWinner(input: {
  incumbent: string;
  challenger: string;
  incumbentImprovement: number;
  challengerImprovement: number;
  minMargin: number;
}): { winner: string; switched: boolean; reason: string } {
  const delta = input.challengerImprovement - input.incumbentImprovement;
  if (delta > input.minMargin) {
    return { winner: input.challenger, switched: true, reason: `challenger improved by ${delta.toFixed(4)} > margin ${input.minMargin}` };
  }
  if (delta < -input.minMargin) {
    return { winner: input.incumbent, switched: false, reason: `incumbent leads by ${(-delta).toFixed(4)}` };
  }
  return { winner: input.incumbent, switched: false, reason: `difference ${delta.toFixed(4)} within margin ${input.minMargin}: 证据不足，保留现任` };
}
