// Evolution loop demo against a RUNNING control service (real LLM proposer,
// real evaluators, real CAS release). Evidence printed to stdout.
// Prereqs: control on :8080, suites provisioned (npm run seal), worker optional.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.CONTROL_URL ?? "http://localhost:8080";
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

async function main() {
  // 0) login (user must exist; runbooks: first user registers via UI/API)
  const login = await req("POST", "/v1/auth/login", { username: "researcher", password: "looplab" });
  if (login.status !== 200) throw new Error("login failed; register first");
  cookie = login.json ? cookie : cookie;

  // 1) a goal that owns the evolution work
  const projects = (await req("GET", "/v1/projects")).json.projects;
  const proj = projects.find((p: any) => p.slug === "algorithm-search");
  const ses = (await req("POST", "/v1/sessions", { project_id: proj.id, title: "演进演示" })).json;
  const goal = (await req("POST", `/v1/sessions/${ses.id}/messages`, {
    content: "改进装箱启发式：在固定预算下降低平均使用箱数（演进闭环演示）",
  })).json;
  const goalId = goal.goal_id;
  console.log("goal:", goalId, "| plan:", goal.plan_note || "(LLM 规划)");

  // 2) archive a real failure: commit the SAME task failed twice with one class
  const ffail = async (workerId: string) => {
    const claim = (await req("POST", "/v1/worker/claim", { worker_id: workerId }));
    if (claim.status !== 200) throw new Error("no task to fail — is the goal ACTIVE?");
    const a = claim.json.attempt;
    await req("POST", `/v1/attempts/${a.id}/start`, { worker_id: workerId, lease_epoch: 1 });
    await req("POST", `/v1/attempts/${a.id}/checkpoint`, {
      worker_id: workerId, lease_epoch: 1, step_index: 1,
      summary: "hit candidate-quality wall", state: {}, progress_kind: "tool_progress",
    });
    const c = await req("POST", `/v1/attempts/${a.id}/commit`, {
      worker_id: workerId, lease_epoch: 1, expected_status: "RUNNING",
      attempt_id: a.id, outcome: "FAILED", error_class: "algorithm:quality_wall",
      summary: "当前启发式在固定预算内无法再降低箱数", artifacts: [],
      usage: { model_calls: 1, prompt_tokens: 0, completion_tokens: 0, estimated_cost_usd: 0, unknown_settlement: false },
      verification: { kind: "self", passed: false, detail: "quality plateau" },
    });
    if (c.status !== 200) throw new Error(`commit failed: ${JSON.stringify(c.json)}`);
  };
  const { randomBytes } = await import("node:crypto");
  // two real failed attempts with the same fingerprint (the scheduler re-queues
  // FAILED tasks with failure_count < 3, so both claims target the same node)
  await ffail(`demo-w-${randomBytes(2).toString("hex")}`);
  await ffail(`demo-w-${randomBytes(2).toString("hex")}`);
  const probs = await req("POST", `/v1/goals/${goalId}/evolution/collect-problems`, {});
  console.log("problems archived:", probs.json.problem_ids?.length ?? 0);
  const problemId = probs.json.problem_ids[0];
  if (!problemId) throw new Error("no problem archived");

  // 3) real LLM proposal (needs DEEPSEEK_API_KEY on the control service)
  const prop = await req("POST", `/v1/goals/${goalId}/evolution/propose`, {
    problem_id: problemId, taskpack_id: "algorithm-search.bin-packing", allowed_path: "heuristic.py",
  });
  if (prop.status !== 202) throw new Error(`propose failed: ${JSON.stringify(prop.json)}`);
  console.log("proposal:", prop.json.id, "mechanism:", prop.json.mechanism?.slice(0, 80));

  // 4) build candidate from the proposal's stored code
  const built = await req("POST", `/v1/goals/${goalId}/evolution/build`, {
    proposal_id: prop.json.id, taskpack_id: "algorithm-search.bin-packing", allowed_path: "heuristic.py",
  });
  if (built.status !== 202) throw new Error(`build failed: ${JSON.stringify(built.json)}`);
  const candId = built.json.candidate_id;
  console.log("candidate built:", candId);

  // 5) three-layer evaluation with the REAL evaluator (dev -> selection -> release)
  const ev = await req("POST", `/v1/goals/${goalId}/evolution/evaluate`, {
    candidate_id: candId, taskpack_id: "algorithm-search.bin-packing", contract_version: "bin-packing/v1",
  });
  console.log("evaluation:", JSON.stringify(ev.json));

  // 6) promote to canary when eligible; watch regression
  if (ev.json.verdict === "ELIGIBLE") {
    const promo = await req("POST", `/v1/goals/${goalId}/evolution/promote`, {
      candidate_id: candId, scope: "algorithm:bin-packing", kind: "canary",
    });
    console.log("promote:", promo.status, JSON.stringify(promo.json));
    const watch = await req("POST", `/v1/goals/${goalId}/evolution/canary-check`, { scope: "algorithm:bin-packing" });
    console.log("canary watch:", JSON.stringify(watch.json));
  }

  // 7) leave an artifact trail: store the lineage summary as an object + print
  const summary = {
    goal_id: goalId, problem: problemId, proposal: prop.json.id, candidate: candId,
    evaluation: ev.json, at: new Date().toISOString(),
  };
  const digest = createHash("sha256").update(JSON.stringify(summary)).digest("hex");
  const outDir = path.resolve("docs/evidence/evolution-demo");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${digest.slice(0, 12)}-summary.json`), JSON.stringify(summary, null, 1));
  console.log("evidence written: docs/evidence/evolution-demo/");
  console.log("resume the goal:", `POST /v1/goals/${goalId}/commands {"kind":"resume"}`);
}

main().catch((err) => {
  console.error("demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
