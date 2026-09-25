// ResearchService: hypothesis cards, frozen experiment protocols, paired-seed
// runs with control groups, and five-level verdicts (design §11).
// Verdicts: implementation_failed / insufficient_power / out_of_regime /
// falsified_in_scope / supported_in_scope — a small-sample null is
// UNDERPOWERED (证据不足), never a refutation.
import { newId, type ResearchVerdict } from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import type { Db } from "./db.js";

export interface HypothesisInput {
  goalId: string;
  statement: string;
  mechanism?: string;
  applicability?: string;      // 适用条件
  keyVariable?: string;
  falsifier?: string;
  primaryMetric?: string;
  minEffect?: number;
  nextStep?: string;
  userId: string;
}

export interface PlanInput {
  hypothesisId: string;
  arms: { name: string; params: Record<string, unknown> }[]; // treatment + control
  repetitions: number;
  seeds: number[];
  analysisPlan: { metric: string; minEffect: number; alpha: number; minRepetitions: number };
  runnerRef: string;           // python entry under taskpacks/computational-research/
}

export interface RunOutcomeRow {
  arm: string; seed: number; metric: number; runtimeMs: number;
}

export class ResearchService {
  constructor(private db: Db) {}

  async createHypothesis(input: HypothesisInput): Promise<string> {
    const id = newId("hyp");
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO hypotheses (id, goal_id, statement, mechanism, applicability, key_variable,
           falsifier, primary_metric, min_effect, next_step, stage, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S0','TESTABLE')`,
        [id, input.goalId, input.statement, input.mechanism ?? "", input.applicability ?? "",
          input.keyVariable ?? "", input.falsifier ?? "", input.primaryMetric ?? "",
          input.minEffect ?? null, input.nextStep ?? ""],
      );
      await EventStore.append(client, {
        aggregateType: "hypothesis", aggregateId: id, eventType: "hypothesis.proposed",
        goalId: input.goalId, actor: { kind: "agent", id: input.userId },
        payload: { statement: input.statement.slice(0, 300) },
      });
    });
    return id;
  }

  /** The analysis protocol is FROZEN before any result exists. */
  async freezeProtocol(input: PlanInput): Promise<string> {
    const hyp = (await this.db.query("SELECT * FROM hypotheses WHERE id=$1", [input.hypothesisId])).rows[0];
    if (!hyp) throw new Error("hypothesis not found");
    if (input.arms.length < 2) throw new Error("research experiments need treatment AND control arms");
    if (input.seeds.length < 1) throw new Error("at least one seed required");
    const id = newId("exp");
    await this.db.tx(async (client) => {
      await client.query(
        `INSERT INTO experiment_plans (id, hypothesis_id, protocol, analysis_plan, control_group, repetitions, seeds, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'FROZEN')`,
        [id, input.hypothesisId,
          JSON.stringify({ runner_ref: input.runnerRef, arms: input.arms }),
          JSON.stringify(input.analysisPlan),
          JSON.stringify(input.arms.find((a) => a.name === "control") ?? input.arms[1]),
          input.repetitions, JSON.stringify(input.seeds)],
      );
      await client.query("UPDATE hypotheses SET stage='S2', state='TESTABLE' WHERE id=$1", [input.hypothesisId]);
      await EventStore.append(client, {
        aggregateType: "hypothesis", aggregateId: input.hypothesisId,
        eventType: "experiment.protocol_frozen", goalId: hyp.goal_id,
        actor: { kind: "agent", id: "experimenter" },
        payload: { plan_id: id, arms: input.arms.map((a) => a.name), seeds: input.seeds.length },
      });
      for (const arm of input.arms) {
        for (const seed of input.seeds) {
          await client.query(
            `INSERT INTO experiment_runs (id, plan_id, arm, seed, params, status) VALUES ($1,$2,$3,$4,$5,'PENDING')`,
            [newId("run"), id, arm.name, seed, JSON.stringify(arm.params)],
          );
        }
      }
    });
    return id;
  }

  /**
   * Analyze completed runs against the FROZEN analysis plan.
   * Paired by seed between treatment and control; simple t-style statistic on
   * seed-level means. With fewer repetitions than minRepetitions the verdict
   * is insufficient_power (A12 semantics for research).
   */
  async analyze(planId: string, outcomes: RunOutcomeRow[] | null = null): Promise<{
    verdict: ResearchVerdict; detail: string; stats: Record<string, number>;
  }> {
    const plan = (await this.db.query("SELECT * FROM experiment_plans WHERE id=$1", [planId])).rows[0];
    if (!plan) throw new Error("plan not found");
    const analysis = plan.analysis_plan as { metric?: string; min_effect?: number; min_repetitions?: number };
    const metric = analysis.metric ?? "cost_ms";
    const minEffect = Number(analysis.min_effect ?? 0);
    const minReps = Number(analysis.min_repetitions ?? 5);

    let rows: any[];
    if (outcomes) {
      rows = outcomes.map((o) => ({ arm: o.arm, seed: o.seed, metrics: { [metric]: o.metric }, runtime_ms: o.runtimeMs }));
    } else {
      rows = (await this.db.query(
        "SELECT arm, seed, metrics, runtime_ms FROM experiment_runs WHERE plan_id=$1 AND status='DONE'", [planId],
      )).rows;
    }

    const byArm = new Map<string, Map<number, number>>();
    for (const r of rows) {
      const v = Number(r.metrics?.[metric]);
      if (!Number.isFinite(v)) continue;
      if (!byArm.has(r.arm)) byArm.set(r.arm, new Map());
      byArm.get(r.arm)!.set(Number(r.seed), v);
    }
    const armNames = [...byArm.keys()];
    const controlName: string = armNames.find((a) => a === "control") ?? armNames[1] ?? armNames[0] ?? "control";
    const treatmentName = armNames.find((a) => a !== controlName);
    if (!treatmentName) {
      return { verdict: "implementation_failed", detail: "no treatment runs completed", stats: {} };
    }

    const controlRuns = byArm.get(controlName) ?? new Map<number, number>();
    const paired: { seed: number; diff: number }[] = [];
    for (const [seed, tv] of byArm.get(treatmentName)!) {
      const cv = controlRuns.get(seed);
      if (cv !== undefined) paired.push({ seed, diff: tv - cv });
    }

    const n = paired.length;
    // pg hands jsonb back as already-parsed objects; tolerate strings too
    // (double-parsing an object used to throw and 500 the analyze route)
    const asValue = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
    const seedsArr = asValue(plan.seeds) as number[];
    const protocol = asValue(plan.protocol) as { arms: { name: string }[] };
    const planSeeds = seedsArr.length * (protocol.arms.length - 1 || 1);
    if (n < Math.max(2, Math.min(minReps, planSeeds))) {
      return {
        verdict: "insufficient_power",
        detail: `only ${n} paired observations; pre-registered plan requires ${minReps}. 证据不足：不判定方向，保留假设并记录复试条件。`,
        stats: { n },
      };
    }
    const mean = paired.reduce((a, p) => a + p.diff, 0) / n;
    const variance = paired.reduce((a, p) => a + (p.diff - mean) ** 2, 0) / Math.max(1, n - 1);
    const sd = Math.sqrt(variance);
    const se = sd / Math.sqrt(n);
    const tStat = se > 0 ? mean / se : 0;
    // two-sided |t| > ~2.0 approximates alpha=0.05 for these small n; the
    // pre-registered effect size also has to hold (design §12.2)
    const significant = Math.abs(tStat) > 2.0 && Math.abs(mean) >= minEffect;

    const stats = { n, mean_diff: mean, sd, se, t_stat: tStat, min_effect: minEffect };

    let verdict: ResearchVerdict;
    let detail: string;
    if (significant && mean < 0) {
      verdict = "supported_in_scope";
      detail = `treatment improves ${metric} by ${Math.abs(mean).toFixed(4)} on average (t=${tStat.toFixed(2)}, n=${n}) within the registered regime; 局部支持，非普遍结论。`;
    } else if (significant && mean > 0) {
      verdict = "falsified_in_scope";
      detail = `treatment worsens ${metric} by ${mean.toFixed(4)} (t=${tStat.toFixed(2)}, n=${n}) within the registered regime; 条件内否定。`;
    } else if (Math.abs(mean) >= minEffect) {
      verdict = "insufficient_power";
      detail = `effect ${mean.toFixed(4)} reaches min_effect but t=${tStat.toFixed(2)} is not significant at n=${n}; 证据不足，需提高重复数。`;
    } else {
      verdict = "out_of_regime";
      detail = `observed ${mean.toFixed(4)} below pre-registered effect ${minEffect}; the mechanism is not observable in this regime; 记录适用区间与下一次有区分度的实验。`;
    }
    return { verdict, detail, stats };
  }

  /** Persist analysis outcome onto the hypothesis + freeze a Claim. */
  async recordOutcome(planId: string, verdict: ResearchVerdict, detail: string, stats: Record<string, number>): Promise<void> {
    const plan = (await this.db.query("SELECT * FROM experiment_plans WHERE id=$1", [planId])).rows[0];
    if (!plan) throw new Error("plan not found");
    const hyp = (await this.db.query("SELECT * FROM hypotheses WHERE id=$1", [plan.hypothesis_id])).rows[0];
    if (!hyp) throw new Error("hypothesis not found");
    const stateMap: Record<string, string> = {
      supported_in_scope: "SUPPORTED_IN_SCOPE",
      falsified_in_scope: "FALSIFIED_IN_SCOPE",
      insufficient_power: "UNDERPOWERED",
      out_of_regime: "DORMANT",
      implementation_failed: "TESTABLE",
    };
    await this.db.tx(async (client) => {
      await client.query(
        `UPDATE hypotheses SET verdict=$2, state=$3, updated_at=now(),
           revive_condition = CASE WHEN $2::text IN ('out_of_regime','insufficient_power')
             THEN '更高规模/新工具/方差降低后复试（登记复活条件）' ELSE revive_condition END
         WHERE id=$1`,
        [hyp.id, verdict, stateMap[verdict] ?? "TESTABLE"],
      );
      const stance = verdict === "supported_in_scope" ? "条件内支持"
        : verdict === "falsified_in_scope" ? "条件内否定"
        : "证据不足";
      await client.query(
        `INSERT INTO claims (id, goal_id, text, stance, scope, kind, evidence_refs)
         VALUES ($1,$2,$3,$4,$5,'measured',$6)`,
        [newId("token"), hyp.goal_id,
          `${hyp.statement} → ${verdict}: ${detail}`.slice(0, 900),
          stance, `plan:${planId}`, JSON.stringify([`plan:${planId}`])],
      );
      await EventStore.append(client, {
        aggregateType: "hypothesis", aggregateId: hyp.id, eventType: "experiment.analyzed",
        goalId: hyp.goal_id, actor: { kind: "system", id: "research-service" },
        payload: { plan_id: planId, verdict, stats },
      });
    });
  }
}
