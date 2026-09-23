// LoopLab contracts: TaskPack contract (design §10.1) and project identifiers.
import { z } from "zod";

export const PROJECT_SLUGS = [
  "harness-improvement",
  "algorithm-search",
  "computational-research",
] as const;
export type ProjectSlug = (typeof PROJECT_SLUGS)[number];
// helper usable as a value-level guard
export function isProjectSlug(v: string): v is ProjectSlug {
  return (PROJECT_SLUGS as readonly string[]).includes(v);
}

export const TaskPackSchema = z.object({
  kind: z.literal("TaskPack"),
  apiVersion: z.literal("looplab/v1"),
  id: z.string(),
  project: z.enum(PROJECT_SLUGS),
  objective: z.string(),
  baseline: z.object({
    entry: z.string(),
    evaluation_ref: z.string(),
  }),
  mutation: z.object({
    allowed_paths: z.array(z.string()).min(1),
    allowed_exports: z.array(z.string()).default([]),
    dependency_changes: z.enum(["forbidden", "approval_required"]).default("approval_required"),
  }),
  validation: z.object({
    build: z.enum(["required", "skip"]).default("required"),
    feasibility: z.enum(["required", "skip"]).default("required"),
    dev_suite_ref: z.string(),
    selection_suite_ref: z.string(),
    release_suite_ref: z.string(), // sealed:// → only the evaluator may resolve
  }),
  resources: z.object({
    worker_class: z.literal("cpu-sandbox"),
    cpu_seconds_per_trial: z.number().positive(),
    memory_mb: z.number().positive(),
    total_trials_cap: z.number().int().positive(),
  }),
  outputs: z.object({
    required: z.array(z.string()).min(1),
  }),
  metrics: z.object({
    primary: z.string(),
    minimize: z.boolean().default(false),
    min_effect_delta: z.number(),
    max_regression_epsilon: z.number(),
  }),
});
export type TaskPack = z.infer<typeof TaskPackSchema>;

// ---- candidate manifest ---------------------------------------------------
export const CandidateManifestSchema = z.object({
  candidate_id: z.string(),
  digest: z.string(),
  kind: z.enum(["harness_plugin", "algorithm", "skill", "prompt", "context", "graph"]),
  title: z.string(),
  parents: z.array(z.string()).default([]),
  taskpack_id: z.string().nullable(),
  changed_paths: z.array(z.string()).default([]),
  mechanism: z.string(),
  provenance: z.object({
    proposal_id: z.string().nullable(),
    problem_id: z.string().nullable(),
    produced_by: z.string(),
    produced_at: z.string(),
  }),
});
export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;

// ---- evaluation result ----------------------------------------------------
export const EvaluationResultSchema = z.object({
  contract_version: z.string(),
  suite_ref: z.string(),
  layer: z.enum(["dev", "selection", "release"]),
  primary_metric: z.string(),
  primary_value: z.number(),
  baseline_value: z.number().nullable(),
  paired_delta: z.number().nullable(),
  hard_constraints: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  })),
  trials: z.array(z.object({
    task_id: z.string(),
    seed: z.number().int(),
    value: z.number(),
    feasible: z.boolean(),
    runtime_ms: z.number().nonnegative(),
  })),
  verdict: z.enum(["ELIGIBLE", "REJECTED", "INCONCLUSIVE"]),
  reason: z.string(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
