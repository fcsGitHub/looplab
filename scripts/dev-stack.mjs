// dev-stack.mjs — self-healing local stack supervisor (P25, host reliability).
//
// This dev host has twice torn the stack down overnight (Docker Desktop/WSL
// stops on its own; the control service then lost Postgres and any node
// process parked in a shell got reaped). A long-running agent platform needs
// the stack back without a human. This supervisor:
//   1. ensures the Docker daemon (launches Docker Desktop on Windows if down)
//   2. ensures the looplab-pg container is running (it carries
//      restart=unless-stopped, so this matters mostly after daemon swaps)
//   3. runs the control service and one agent worker as supervised children,
//      restarting any that exit with capped exponential backoff
//
// Usage:  node scripts/dev-stack.mjs          (npm run dev:stack)
// Logs:   data/stack-supervisor.log (+ children inherit it)
// Stop:   kill this process, or Ctrl+C if attached.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOG = path.join(ROOT, "data", "stack-supervisor.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logFd = fs.openSync(LOG, "a");
const ts = () => new Date().toISOString().slice(11, 19);
const say = (msg) => fs.writeSync(logFd, `[${ts()}] ${msg}\n`);

const PG_CONTAINER = process.env.PG_CONTAINER ?? "looplab-pg";
const PG_PORT = Number(process.env.PG_PORT ?? 5433);
const CONTROL = process.env.STACK_CONTROL ?? "apps/control/src/index.ts";
const WORKER = process.env.STACK_WORKER ?? "workers/agent-worker/src/index.ts";
const WORKERS = Number(process.env.STACK_WORKERS ?? 1);

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "ignore", shell: process.platform === "win32" });
  return r.status === 0;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// single-instance mutex: the task scheduler relaunches this script on a
// repeating schedule; a live instance holds the port, later ones exit quietly
const MUTEX_PORT = Number(process.env.STACK_MUTEX_PORT ?? 47613);
const mutex = net.createServer(() => {});
const singleInstance = await new Promise((resolve) => {
  mutex.once("error", () => resolve(false));
  mutex.listen(MUTEX_PORT, "127.0.0.1", () => resolve(true));
});
if (!singleInstance) {
  process.exit(0); // another supervisor is already watching the stack
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => { s.end(); resolve(true); });
    s.on("error", () => resolve(false));
  });

async function ensureDocker() {
  for (;;) {
    if (run("docker", ["info"])) return;
    say("docker daemon down");
    if (process.platform === "win32") {
      const dd = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
      if (fs.existsSync(dd)) {
        say("launching Docker Desktop...");
        spawn("cmd", ["/c", "start", '""', dd], { detached: true, stdio: "ignore" }).unref();
      }
    }
    for (let i = 0; i < 60; i++) {
      await sleep(5_000);
      if (run("docker", ["info"])) { say("docker daemon up"); return; }
    }
    say("docker still down after 5min, retrying launch");
  }
}

async function ensurePg() {
  for (;;) {
    if (await portOpen(PG_PORT)) return;
    say(`postgres port ${PG_PORT} not listening — starting ${PG_CONTAINER}`);
    run("docker", ["start", PG_CONTAINER]);
    for (let i = 0; i < 24; i++) {
      await sleep(2_500);
      if (await portOpen(PG_PORT)) { say("postgres up"); return; }
    }
    say("postgres not up after 60s — looping");
    await ensureDocker();
  }
}

/** Supervised child: restart with capped backoff; uptime >5min resets it. */
function supervise(name, script) {
  let attempt = 0;
  const start = () => {
    const t0 = Date.now();
    const child = spawn("npx", ["tsx", script], {
      cwd: ROOT,
      stdio: ["ignore", logFd, logFd],
      shell: process.platform === "win32",
    });
    say(`${name} started (pid ${child.pid}, attempt ${attempt + 1})`);
    child.on("exit", (code) => {
      const upMs = Date.now() - t0;
      if (upMs > 5 * 60_000) attempt = 0; else attempt++;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      say(`${name} exited code=${code} after ${(upMs / 1000).toFixed(0)}s — restart in ${wait / 1000}s`);
      setTimeout(start, wait);
    });
  };
  start();
}

say("=== stack supervisor starting ===");
await ensureDocker();
await ensurePg();
supervise("control", CONTROL);
await sleep(3_000); // let migrations run before workers poll
for (let i = 0; i < WORKERS; i++) supervise(`worker-${i + 1}`, WORKER);
say(`supervising: control + ${WORKERS} worker(s)`);

setInterval(() => {}, 1 << 30); // keep alive; children hold the event loop anyway
