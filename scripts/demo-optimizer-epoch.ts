// §6.8 meta-evolution epoch trial against a RUNNING control service with the
// REAL model: incumbent (simple-baseline@1) vs challenger (gepa@0.1.4) get
// comparable budgets; the challenger's best proposal goes through the SAME
// independent dev/selection/release evaluation; the epoch switches only on a
// strict margin, and a switch takes effect for the NEXT epoch.
//
// Honest accounting: reflection calls are metered by the control proxy
// (optimizer_runs.spent_usd + budget ledger events); metric calls are capped
// by MaxMetricCallsStopper inside the backend. Evidence lands in
// docs/evidence/optimizer-epoch-trial/.
//
// Prereqs: control on :8080 with DEEPSEEK_API_KEY; .venv-gepa installed;
// suites provisioned (npx tsx scripts/seal-suites.ts).
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.CONTROL_URL ?? "http://localhost:8080";
const MARGIN = Number(process.env.EPOCH_MARGIN ?? 0.05);
let cookie = "";

async function req(method: string, url: string, body?: unknown) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && !cookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function selectionDelta(evalJson: any): { delta: number | null; verdict: string } {
  // minimize metric: positive delta = improvement over the frozen baseline
  const layerResults = evalJson?.final?.results ?? evalJson?.final ?? null;
  const verdict = String(evalJson?.verdict ?? "UNKNOWN");
  const primary = Number(layerResults?.primary_value);
  const baseline = Number(layerResults?.baseline_value);
  if (!Number.isFinite(primary) || !Number.isFinite(baseline)) return { delta: null, verdict };
  return { delta: Number((baseline - primary).toFixed(4)), verdict };
}

async function main() {
  const login = await req("POST", "/v1/auth/login", { username: "researcher", password: "looplab" });
  if (login.status !== 200) throw new Error("login failed; register the researcher user first");
  const startedAt = new Date().toISOString();

  // 1) goal container for the trial; paused immediately — the USER's pause is
  //    authoritative while the optimizer trial runs its own budgeted process.
  const projects = (await req("GET", "/v1/projects")).json.projects;
  const proj = projects.find((p: any) => p.slug === "algorithm-search");
  const ses = (await req("POST", "/v1/sessions", { project_id: proj.id, title: "元演进 epoch 试炼" })).json;
  const msg = (await req("POST", `/v1/sessions/${ses.id}/messages`, {
    content: "epoch 试炼：等预算比较 simple-baseline 与 gepa 在装箱任务族上的改进能力",
  })).json;
  const goalId = msg.goal_id;
  const pause = await req("POST", `/v1/goals/${goalId}/commands`, { kind: "pause" });
  console.log("goal:", goalId, "| pause accepted:", pause.status === 202 || pause.status === 200);

  // 2) challenger round: real GEPA with REAL reflection calls through the
  //    metered proxy (epoch-trial mode; active mode would be refused — epoch 0
  //    belongs to simple-baseline@1).
  console.log("running gepa epoch-trial round (real reflection via metered proxy)…");
  const t0 = Date.now();
  const round = await req("POST", `/v1/goals/${goalId}/optimizer/run-round`, {
    backend: "gepa@0.1.4", mode: "epoch_trial",
    max_metric_calls: Number(process.env.MAX_METRIC_CALLS ?? 80),
    max_llm_cost_usd: Number(process.env.MAX_LLM_USD ?? 0.4),
    reflection: "gateway",
    timeout_ms: 25 * 60_000,
  });
  if (round.status !== 202) throw new Error(`optimizer round failed: ${JSON.stringify(round.json).slice(0, 600)}`);
  const { runId, proposalIds, usage } = round.json;
  console.log(`gepa round ${runId}: ${proposalIds.length} proposals in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log("  usage:", JSON.stringify(usage));

  const writeEvidence = (extra: Record<string, unknown>, name: string) => {
    const outDir = "docs/evidence/optimizer-epoch-trial";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/${name}-${goalId}.json`, JSON.stringify(extra, null, 1));
  };
  if (proposalIds.length === 0) {
    // honest empty result: no mutation beat the seed inside the budget
    console.log("challenger produced no usable proposal → epoch stays with the incumbent");
    writeEvidence({
      kind: "meta_evolution_epoch_trial", started_at: startedAt, finished_at: new Date().toISOString(),
      goal_id: goalId, optimizer_run: runId, challenger: "gepa@0.1.4", incumbent: "simple-baseline@1",
      margin: MARGIN, challenger_internal_usage: usage, proposals: [],
      outcome: "no_accepted_mutation: 优化器内部严格改进验收未通过任何变体（证据不足，保留现任）",
    }, "trial");
    await req("POST", `/v1/goals/${goalId}/commands`, { kind: "cancel" });
    return;
  }

  // 3) best challenger proposal (by internal val score from the event payload)
  // build the challenger's best proposal (proposalIds[0] = GEPA best) and let
  // the independent evaluator judge it; remaining proposals stay in the
  // lineage as PROPOSED for later rounds.
  const built = await req("POST", `/v1/goals/${goalId}/evolution/build`, { proposal_id: proposalIds[0] });
  if (built.status !== 202) throw new Error(`build failed: ${JSON.stringify(built.json)}`);
  const candId = built.json.candidate_id;
  console.log("challenger candidate built:", candId);

  const ev = await req("POST", `/v1/goals/${goalId}/evolution/evaluate`, {
    candidate_id: candId, taskpack_id: "algorithm-search.bin-packing", contract_version: "bin-packing/v1",
  });
  console.log("independent evaluation:", JSON.stringify(ev.json).slice(0, 400));
  const { delta, verdict } = selectionDelta(ev.json);

  // 4) settle the epoch: incumbent's historical improvement is 0 by definition
  //    (it produced the frozen baseline); challenger must win by > MARGIN.
  const settle = await req("POST", "/v1/meta/epoch/settle", {
    incumbent: "simple-baseline@1", challenger: "gepa@0.1.4",
    incumbent_improvement: 0, challenger_improvement: delta ?? 0, min_margin: MARGIN,
  });
  console.log("epoch settlement:", settle.status, JSON.stringify(settle.json));

  // 5) optional operator-driven canary promotion if the pipeline said ELIGIBLE
  let promotion: any = null;
  if (verdict === "ELIGIBLE") {
    const promo = await req("POST", `/v1/goals/${goalId}/evolution/promote`, {
      candidate_id: candId, scope: "algorithm:bin-packing", kind: "canary",
    });
    promotion = promo.json ?? { status: promo.status };
    console.log("canary promotion (operator decision, not the optimizer's):", JSON.stringify(promotion));
  }

  const evidence = {
    kind: "meta_evolution_epoch_trial", started_at: startedAt, finished_at: new Date().toISOString(),
    goal_id: goalId, optimizer_run: runId, challenger: "gepa@0.1.4", incumbent: "simple-baseline@1",
    margin: MARGIN, challenger_internal_usage: usage, proposals: proposalIds,
    candidate: candId, independent_verdict: verdict, selection_delta: delta,
    settlement: settle.json, promotion,
    note: "reflection calls metered via control proxy (see optimizer_runs + budget events); scripted fixtures were NOT used in this run",
  };
  const outDir = "docs/evidence/optimizer-epoch-trial";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/trial-${goalId}.json`, JSON.stringify(evidence, null, 1));
  console.log("evidence written:", `${outDir}/trial-${goalId}.json`);
  console.log("resume the goal:", `POST /v1/goals/${goalId}/commands {"kind":"resume"}`);
}

main().catch((err) => {
  console.error("epoch trial failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
