import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Replicate CapabilityGateway.runPython EXACTLY (real Windows backslash paths).
const ws = path.join("D:", "project", "looplab", "data", "workspaces", "cwdprobe");
mkdirSync(ws, { recursive: true });
console.log("workspace exists:", existsSync(ws), "->", ws);

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin",
  SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
  COMSPEC: process.env.COMSPEC ?? "cmd.exe",
  TEMP: process.env.TEMP ?? "C:\\Temp",
  TMP: process.env.TMP ?? "C:\\Temp",
  PYTHONIOENCODING: "utf-8",
  PYTHONDONTWRITEBYTECODE: "1",
  LOOPLAB_SANDBOX: ws,
};

const script = "import os\nprint('CWD=', os.getcwd())\n";
const child = spawn("python", ["-I", "-c", script], {
  cwd: ws,
  env,
  timeout: 15000,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(String(d)));
child.stderr.on("data", (d) => process.stdout.write("ERR " + String(d)));
child.on("error", (e) => console.log("spawn error:", e.message));
child.on("close", (c) => console.log("exit", c));
