// §六.8 meta-evolution epoch trial against a RUNNING control service with the
// REAL model — equal protocol for both backends on the SAME frozen task
// family:
//   incumbent (simple-baseline@1, active mode)  -> proposal -> independent eval
//   challenger (gepa@0.1.4, epoch_trial mode)   -> proposals -> independent eval
//   settleEpochTrial(deltas from the selection suite, strict margin)
//
// Environment:
//   TASKPACK          task family (default algorithm-search.bin-packing-large)
//   MAX_METRIC_CALLS  challenger's internal eval budget (default 80)
//   MAX_LLM_USD       challenger's reflection LLM cost cap (default 0.6)
//   EPOCH_MARGIN      selection-suite improvement margin for a switch (0.05)
//
// Prereqs: control on :8080 with DEEPSEEK_API_KEY; .venv-gepa installed;
// suites provisioned (npx tsx scripts/seal-suites.ts).
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.CONTROL_URL ?? "http://localhost:8080";
const TASKPACK = process.env.TASKPACK ?? "algorithm-search.bin-packing-large";
const MARGIN = Number(process.env.EPOCH_MARGIN ?? 0.05);
// any backend registered on the OptimizerPort can challenge as the challenger
const CHALLENGER = process.env.CHALLENGER ?? "gepa@0.1.4";
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

/** Independent selection-suite delta for one candidate (positive = better). */
async function evaluateAndDelta(goalId: string, candidateId: string) {
  const ev = await req("POST", `/v1/goals/${goalId}/evolution/evaluate`, {
    candidate_id: candidateId, taskpack_id: TASKPACK,
    contract_version: TASKPACK.includes("large") ? "bin-packing-large/v1" : "bin-packing/v1",
  });
  const verdict = String(ev.json?.verdict ?? "UNKNOWN");
  const layer = ev.json?.final ?? null;
  const primary = Number(layer?.primary_value);
  const baseline = Number(layer?.baseline_value);
  const delta = Number.isFinite(primary) && Number.isFinite(baseline)
    ? Number((baseline - primary).toFixed(4)) : null; // minimize metric
  return { verdict, primary, baseline, delta };
}

async function main() {
  const login = await req("POST", "/v1/auth/login", { username: "researcher", password: "looplab" });
  if (login.status !== 200) throw new Error("login failed; register the researcher user first");
  const startedAt = new Date().toISOString();

  // 1) goal container, paused immediately (user pause is authoritative)
  const projects = (await req("GET", "/v1/projects")).json.projects;
  const proj = projects.find((p: any) => p.slug === "algorithm-search");
  const ses = (await req("POST", "/v1/sessions", { project_id: proj.id, title: `元演进试炼 ${TASKPACK}` })).json;
  const msg = (await req("POST", `/v1/sessions/${ses.id}/messages`, {
    content: `epoch 试炼：等预算比较 simple-baseline 与 ${CHALLENGER} 在 ${TASKPACK} 上的改进能力`,
  })).json;
  const goalId = msg.goal_id;
  await req("POST", `/v1/goals/${goalId}/commands`, { kind: "pause" });
  console.log("goal:", goalId, "| task family:", TASKPACK);

  const maxMetricCalls = Number(process.env.MAX_METRIC_CALLS ?? 80);
  const maxLlmUsd = Number(process.env.MAX_LLM_USD ?? 0.6);

  // ---- incumbent round (active mode; ONE proposal; same port) -------------
  const tInc = Date.now();
  const inc = await req("POST", `/v1/goals/${goalId}/optimizer/run-round`, {
    backend: "simple-baseline@1", mode: "active",
    max_metric_calls: maxMetricCalls, max_llm_cost_usd: 0.1,
    reflection: "gateway", taskpack_id: TASKPACK, timeout_ms: 5 * 60_000,
  });
  if (inc.status !== 202) throw new Error(`incumbent round failed: ${JSON.stringify(inc.json).slice(0, 400)}`);
  console.log(`incumbent round ${inc.json.runId}: ${inc.json.proposalIds.length} proposal(s) in ${((Date.now() - tInc) / 1000).toFixed(0)}s | usage:`, JSON.stringify(inc.json.usage));

  let incumbentImprovement: number | null = null;
  let incumbentVerdict = "NO_PROPOSAL";
  if (inc.json.proposalIds.length > 0) {
    const built = await req("POST", `/v1/goals/${goalId}/evolution/build`, { proposal_id: inc.json.proposalIds[0] });
    if (built.status !== 202) throw new Error(`incumbent build failed: ${JSON.stringify(built.json)}`);
    const r = await evaluateAndDelta(goalId, built.json.candidate_id);
    incumbentImprovement = r.delta;
    incumbentVerdict = r.verdict;
    console.log(`incumbent independent eval: ${r.verdict} primary=${r.primary} baseline=${r.baseline} delta=${r.delta}`);
  }

  // ---- challenger round (epoch-trial mode; real reflection via proxy) ------
  const tCh = Date.now();
  const cha = await req("POST", `/v1/goals/${goalId}/optimizer/run-round`, {
    backend: CHALLENGER, mode: "epoch_trial",
    max_metric_calls: maxMetricCalls, max_llm_cost_usd: maxLlmUsd,
    reflection: "gateway", taskpack_id: TASKPACK, timeout_ms: 30 * 60_000,
  });
  if (cha.status !== 202) throw new Error(`challenger round failed: ${JSON.stringify(cha.json).slice(0, 400)}`);
  console.log(`challenger round ${cha.json.runId}: ${cha.json.proposalIds.length} proposal(s) in ${((Date.now() - tCh) / 1000).toFixed(0)}s | usage:`, JSON.stringify(cha.json.usage));

  let challengerImprovement: number | null = null;
  let challengerVerdict = "NO_PROPOSAL";
  let challengerCandidate: string | null = null;
  if (cha.json.proposalIds.length > 0) {
    const built = await req("POST", `/v1/goals/${goalId}/evolution/build`, { proposal_id: cha.json.proposalIds[0] });
    if (built.status !== 202) throw new Error(`challenger build failed: ${JSON.stringify(built.json)}`);
    challengerCandidate = built.json.candidate_id;
    const r = await evaluateAndDelta(goalId, challengerCandidate);
    challengerImprovement = r.delta;
    challengerVerdict = r.verdict;
    console.log(`challenger independent eval: ${r.verdict} primary=${r.primary} baseline=${r.baseline} delta=${r.delta}`);
  }

  // ---- settlement ----------------------------------------------------------
  const settle = await req("POST", "/v1/meta/epoch/settle", {
    incumbent: "simple-baseline@1", challenger: CHALLENGER,
    incumbent_improvement: incumbentImprovement ?? 0,
    challenger_improvement: challengerImprovement ?? 0,
    min_margin: MARGIN,
  });
  console.log("epoch settlement:", settle.status, JSON.stringify(settle.json));

  // ---- operator decision on release (independent of the epoch switch) ------
  let promotion: any = null;
  if (challengerVerdict === "ELIGIBLE" && challengerCandidate) {
    const promo = await req("POST", `/v1/goals/${goalId}/evolution/promote`, {
      candidate_id: challengerCandidate,
      scope: TASKPACK === "algorithm-search.bin-packing" ? "algorithm:bin-packing"
        : TASKPACK === "algorithm-search.bin-packing-large" ? "algorithm:bin-packing-large"
        : "algorithm:bin-packing-gap",
      kind: "canary",
    });
    promotion = promo.json ?? { status: promo.status };
    console.log("canary promotion (operator decision):", JSON.stringify(promotion));
  }

  // ---- evidence ------------------------------------------------------------
  const evidence = {
    kind: "meta_evolution_epoch_trial_v2", started_at: startedAt, finished_at: new Date().toISOString(),
    goal_id: goalId, task_family: TASKPACK, margin: MARGIN,
    incumbent: {
      backend: "simple-baseline@1", run: inc.json.runId, usage: inc.json.usage,
      proposals: inc.json.proposalIds.length, verdict: incumbentVerdict, delta: incumbentImprovement,
    },
    challenger: {
      backend: CHALLENGER, run: cha.json.runId, usage: cha.json.usage,
      proposals: cha.json.proposalIds.length, verdict: challengerVerdict, delta: challengerImprovement,
      candidate: challengerCandidate,
    },
    settlement: settle.json, promotion,
    protocol: "equal metric-call budget grant; independent dev/selection/release evaluation for both backends; strict-margin switch, ties = 证据不足保留现任",
    note: "all reflection/proposal LLM calls metered via the control proxy; scripted fixtures were NOT used in this run",
  };
  const outDir = "docs/evidence/optimizer-epoch-trial";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/trial-${TASKPACK}-${goalId}.json`, JSON.stringify(evidence, null, 1));
  console.log("evidence written:", `${outDir}/trial-${TASKPACK}-${goalId}.json`);
}

main().catch((err) => {
  console.error("epoch trial failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
