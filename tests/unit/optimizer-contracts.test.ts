// OptimizerPort contract unit tests (deterministic, no I/O):
// schemas, epoch authorization guard, epoch winner rule (§6.8).
import { describe, expect, it } from "vitest";
import {
  OPTIMIZER_BACKENDS,
  OptimizerRunManifestSchema,
  OptimizerCompletePayloadSchema,
  assertOptimizerAuthorized,
  nextEpochWinner,
  isKnownBackend,
  type OptimizerEpoch,
} from "@looplab/contracts";

const EPOCH: OptimizerEpoch = {
  index: 3,
  active_backend: "simple-baseline@1",
  frozen: { kernel_version: "v1", suite_family: "algorithm-search.bin-packing", seed_archive: 42 },
  status: "OPEN",
};

describe("optimizer manifest schema", () => {
  const valid = {
    run_id: "opt_ab12cd34", goal_id: "goal_x", backend: "gepa@0.1.4", mode: "epoch_trial",
    epoch_index: 0, taskpack_id: "algorithm-search.bin-packing",
    component: { name: "heuristic_source", kind: "python_source", entry_export: "pack", signature: "pack(items, capacity)" },
    dev_suite_path: "C:/x/dev-suite.json", baseline_path: "C:/x/baseline.py",
    work_dir: "C:/w", out_dir: "C:/o",
    budget: { max_metric_calls: 60, max_llm_cost_usd: 0.5 },
    seed: 7, reflection: "gateway",
  };
  it("accepts a well-formed manifest", () => {
    expect(OptimizerRunManifestSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects non-positive metric budgets and bad components", () => {
    expect(OptimizerRunManifestSchema.safeParse({ ...valid, budget: { max_metric_calls: 0, max_llm_cost_usd: 0 } }).success).toBe(false);
    expect(OptimizerRunManifestSchema.safeParse({ ...valid, component: { ...valid.component, entry_export: "1bad" } }).success).toBe(false);
  });
});

describe("complete payload schema", () => {
  it("requires at least one proposal with code", () => {
    const ok = OptimizerCompletePayloadSchema.safeParse({
      proposals: [{ mechanism: "m", candidate_code: "def pack(): ...", changed_summary: "", expected_effect: "", train_score: null, val_score: 0.71 }],
      usage: { metric_calls: 40, llm_calls: 3, prompt_tokens: 100, completion_tokens: 900, cost_usd: 0.01, model: "deepseek-flash" },
      stopped_reason: "completed",
    });
    expect(ok.success).toBe(true);
    const bad = OptimizerCompletePayloadSchema.safeParse({
      proposals: [{ mechanism: "m", candidate_code: "" }], usage: { metric_calls: 0, llm_calls: 0 },
    });
    expect(bad.success).toBe(false);
  });
});

describe("epoch authorization guard (§6.8)", () => {
  it("unknown backends can never run — they cannot self-register", () => {
    expect(isKnownBackend("my-tuned-gepa")).toBe(false);
    const v = assertOptimizerAuthorized({ epoch: EPOCH, backend: "my-tuned-gepa", mode: "epoch_trial" });
    expect(v.ok).toBe(false);
  });
  it("non-active backend cannot run in active mode", () => {
    const v = assertOptimizerAuthorized({ epoch: EPOCH, backend: "gepa@0.1.4", mode: "active" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/not the active optimizer/);
  });
  it("the active backend runs in active mode", () => {
    expect(assertOptimizerAuthorized({ epoch: EPOCH, backend: "simple-baseline@1", mode: "active" }).ok).toBe(true);
  });
  it("any KNOWN backend may enter a sanctioned epoch trial on an OPEN epoch", () => {
    expect(assertOptimizerAuthorized({ epoch: EPOCH, backend: "gepa@0.1.4", mode: "epoch_trial" }).ok).toBe(true);
  });
  it("no epoch / closed epoch blocks both modes", () => {
    expect(assertOptimizerAuthorized({ epoch: null, backend: "gepa@0.1.4", mode: "epoch_trial" }).ok).toBe(false);
    expect(assertOptimizerAuthorized({ epoch: { ...EPOCH, status: "CLOSED" }, backend: "simple-baseline@1", mode: "active" }).ok).toBe(false);
  });
});

describe("optimizer backend registry", () => {
  it("registers exactly the three sanctioned backends; unknown ids can never self-register", () => {
    expect(OPTIMIZER_BACKENDS).toEqual(["simple-baseline@1", "gepa@0.1.4", "openevolve@0.3.2"]);
    expect(isKnownBackend("openevolve@0.3.2")).toBe(true);
    expect(isKnownBackend("shinkaevolve@0.1")).toBe(false);
    expect(isKnownBackend("gepa@0.1.4 ")).toBe(false); // no fuzzy matching
  });

  it("a newly registered backend is epoch-guarded like any other (epoch_trial on OPEN epoch)", () => {
    const ok = assertOptimizerAuthorized({ epoch: EPOCH, backend: "openevolve@0.3.2", mode: "epoch_trial" });
    expect(ok.ok).toBe(true);
    const blocked = assertOptimizerAuthorized({ epoch: EPOCH, backend: "openevolve@0.3.2", mode: "active" });
    expect(blocked.ok).toBe(false); // not the active backend of this epoch
  });
});

describe("epoch winner rule", () => {
  it("switches only on strict margin", () => {
    const win = nextEpochWinner({ incumbent: "a", challenger: "b", incumbentImprovement: 0.02, challengerImprovement: 0.09, minMargin: 0.05 });
    expect(win.switched).toBe(true);
    expect(win.winner).toBe("b");
  });
  it("ties and regressions keep the incumbent (证据不足 ≠ 方向失败)", () => {
    const tie = nextEpochWinner({ incumbent: "a", challenger: "b", incumbentImprovement: 0.03, challengerImprovement: 0.035, minMargin: 0.05 });
    expect(tie.switched).toBe(false);
    expect(tie.winner).toBe("a");
    const worse = nextEpochWinner({ incumbent: "a", challenger: "b", incumbentImprovement: 0.08, challengerImprovement: 0.01, minMargin: 0.05 });
    expect(worse.switched).toBe(false);
  });
});
