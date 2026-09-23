import { CapabilityGateway } from "../../workers/agent-worker/src/capability-gateway.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
const ws = path.resolve("data/workspaces/gw-harden");
mkdirSync(ws, { recursive: true });
const gw = new CapabilityGateway(ws, { toolTimeoutMs: 20000, maxOutputBytes: 50_000, maxChildProcesses: 2 });
// 1: relative write is fine
const a = await gw.execute("run_python", { script: "open('ok.txt','w').write('x'); print('relative ok')" });
console.log("A ok:", a.ok, a.output.trim());
// 2: absolute read outside workspace must be denied
const b = await gw.execute("run_python", { script: "print(open(r'D:\\project\\looplab\\package.json').read()[:20])" });
console.log("B blocked:", !b.ok, "marker:", b.output.includes("LOOPLAB_SANDBOX"));
// 3: socket denied
const c = await gw.execute("run_python", { script: "import socket; socket.create_connection(('example.com',80))" });
console.log("C blocked:", !c.ok, "marker:", c.output.includes("LOOPLAB_SANDBOX"));
