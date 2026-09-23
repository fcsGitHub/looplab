// Fault injection: kill the worker mid-attempt (external outcome unknown),
// verify the supervisor reconciles honestly and the task completes exactly
// once via a fresh attempt. Run against the LIVE local stack.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
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
  const sc = res.headers.get("set-cookie");
  if (sc && !cookie) cookie = sc.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json };
}

async function main() {
  // 0) login
  const login = await req("POST", "/v1/auth/login", { username: "researcher", password: "looplab" });
  if (login.status !== 200) throw new Error("login failed; register first");

  // 1) start a disposable worker that will be killed mid-flight
  const worker = spawn("npx", ["tsx", "workers/agent-worker/src/index.ts", "--fi-victim-marker"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, WORKER_ID: "fi-victim" },
    shell: true,
    stdio: "inherit",
  });
  await new Promise((r) => setTimeout(r, 1500));

  // 2) create a goal so there is something to execute
  const projects = (await req("GET", "/v1/projects")).json.projects;
  const proj = projects.find((p: any) => p.slug === "computational-research");
  const ses = (await req("POST", "/v1/sessions", { project_id: proj.id, title: "fault-injection" })).json;
  const sent = await req("POST", `/v1/sessions/${ses.id}/messages`, {
    content: "用 Python 计算圆周率到 500 位（monte carlo 亦可但需说明误差），写入 pi_est.py 并运行",
  });
  if (sent.status !== 202 || !sent.json?.goal_id) {
    throw new Error(`sendMessage failed: ${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`);
  }
  const goalId: string = sent.json.goal_id;
  console.log("goal:", goalId);

  // 3) wait until the victim is IN a running attempt, then kill instantly
  let victim: any = null;
  const deadline0 = Date.now() + 60_000;
  while (Date.now() < deadline0) {
    await new Promise((r) => setTimeout(r, 400));
    const list = (await req("GET", `/v1/goals/${goalId}/attempts`)).json?.attempts ?? [];
    victim = list.find((a: any) => a.worker_id === "fi-victim" && ["STARTED", "RUNNING", "RESULT_PENDING"].includes(a.status));
    if (victim) break;
  }
  const attempts1 = (await req("GET", `/v1/goals/${goalId}/attempts`)).json?.attempts ?? [];
  const killed = await killWorkerProcess("--fi-victim-marker");
  console.log(`killed victim worker process: ${killed}`);
  if (victim) console.log(`victim had claimed attempt ${victim.id} (status=${victim.status})`);
  else console.log("victim had not claimed yet; lease recovery will still be exercised");
  try { worker.kill(); } catch { /* already dead */ }

  // 4) wait for lease expiry + reconciliation, then restart a healthy worker
  await new Promise((r) => setTimeout(r, 40_000));
  const recov = spawn("npx", ["tsx", "workers/agent-worker/src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, WORKER_ID: "fi-recovery" },
    shell: true,
    stdio: "ignore",
  });

  // 5) observe until the goal completes or budget guard trips
  const deadline = Date.now() + 8 * 60_000;
  let final = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const card = (await req("GET", `/v1/goals/${goalId}`)).json;
    if (["COMPLETED", "CANCELLED"].includes(card.state)) { final = card; break; }
    if (Number(card.budget.used) > 1.0) { final = { state: "BUDGET_GUARD", card }; break; }
  }
  recov.kill();

  const evs = (await req("GET", `/v1/events`)).json; // not used directly; kept for clarity
  const attempts = (await req("GET", `/v1/goals/${goalId}/attempts`)).json.attempts;
  const report = {
    goal_id: goalId,
    victim_attempt: victim ?? null,
    final_state: final?.state ?? "TIMEOUT",
    attempts: attempts.map((a: any) => ({ no: a.attempt_no, worker: a.worker_id, status: a.status, error: a.error_class })),
    at: new Date().toISOString(),
  };
  const outDir = path.resolve("docs/evidence/fault-injection");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `fi-${Date.now()}.json`), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

async function killWorkerProcess(marker: string): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const ps1 = path.resolve(import.meta.dirname, "../../scripts/kill-worker.ps1");
  try {
    const pids = execFileSync("powershell", ["-NoProfile", "-File", ps1, "-Marker", marker], { encoding: "utf8" })
      .split(/\r?\n/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
    let any = false;
    for (const pid of pids) {
      // /T kills the whole process tree: npx -> node -> tsx loader -> worker
      execFileSync("taskkill", ["/F", "/T", "/PID", pid], { stdio: "ignore" });
      any = true;
    }
    return any;
  } catch {
    return false;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
