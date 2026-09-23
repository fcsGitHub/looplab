import { CapabilityGateway } from "../../workers/agent-worker/src/capability-gateway.js";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const ws = path.resolve("data/workspaces/gw-probe");
mkdirSync(ws, { recursive: true });
const gw = new CapabilityGateway(ws, {
  toolTimeoutMs: 30000,
  maxOutputBytes: 100_000,
  maxChildProcesses: 2,
});

const res = await gw.execute("run_python", { script: "import os\nprint('CWD=', os.getcwd())\nopen('probe_marker.txt','w').write('x')\n" });
console.log(res.output);
console.log("marker in workspace?", existsSync(path.join(ws, "probe_marker.txt")));
console.log("marker in repo root?", existsSync(path.resolve("probe_marker.txt")));
