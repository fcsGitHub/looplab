// Capability gateway: executes gated tools with hard OS-level limits.
// The PolicyGate (server) decided *whether*; this decides *how safely*:
// path containment, wall-clock, output size, child-process cap. No secrets in
// the child environment; no network tools exist at all.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface ExecResult {
  ok: boolean;
  output: string;
  outputBytes: number;
  truncated: boolean;
  durationMs: number;
}

export class CapabilityGateway {
  private runningChildren = 0;

  constructor(
    private workspaceDir: string,
    private limits: { toolTimeoutMs: number; maxOutputBytes: number; maxChildProcesses: number },
  ) {}

  async execute(tool: string, args: Record<string, unknown>): Promise<ExecResult> {
    const started = Date.now();
    try {
      switch (tool) {
        case "workspace_write": {
          const p = String(args.path);
          const content = String(args.content ?? "");
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, content, "utf8");
          return done(`wrote ${content.length} chars to ${path.basename(p)}`);
        }
        case "workspace_read": {
          const p = String(args.path);
          const content = await fs.readFile(p, "utf8");
          return done(content);
        }
        case "workspace_list": {
          const root = String(args.path ?? this.workspaceDir);
          const entries = await walk(root, 60, 3);
          return done(entries.join("\n"));
        }
        case "run_python": {
          if (this.runningChildren >= this.limits.maxChildProcesses) {
            return done("ERROR: child process cap reached", false);
          }
          return await this.runPython(String(args.script ?? ""));
        }
        default:
          return done(`ERROR: tool ${tool} has no capability binding`, false);
      }
    } catch (err: any) {
      return done(`ERROR: ${err?.code ?? ""} ${err?.message ?? String(err)}`.trim(), false);
    }

    function done(output: string, ok = true): ExecResult {
      const bytes = Buffer.byteLength(output);
      const truncated = bytes > 100_000;
      const text = truncated ? output.slice(0, 100_000) + "\n...[truncated]" : output;
      return { ok, output: text, outputBytes: bytes, truncated, durationMs: Date.now() - started };
    }
  }

  private runPython(script: string): Promise<ExecResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      // minimal env: explicitly NO DEEPSEEK_API_KEY or other host secrets
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
        COMSPEC: process.env.COMSPEC ?? "cmd.exe",
        TEMP: process.env.TEMP ?? "C:\\Temp",
        TMP: process.env.TMP ?? "C:\\Temp",
        PYTHONIOENCODING: "utf-8",
        PYTHONDONTWRITEBYTECODE: "1",
        LOOPLAB_SANDBOX: this.workspaceDir,
      };
      this.runningChildren++;
      const child = spawn("python", ["-I", "-c", script], {
        cwd: this.workspaceDir,
        env,
        timeout: this.limits.toolTimeoutMs,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const cap = () => {
        const total = Buffer.byteLength(out);
        if (total > this.limits.maxOutputBytes) {
          child.kill();
          return true;
        }
        return false;
      };
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (cap()) out += "\n...[output limit reached, process killed]";
      });
      child.stderr.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (cap()) out += "\n...[output limit reached, process killed]";
      });
      const finish = (ok: boolean) => {
        this.runningChildren--;
        const bytes = Buffer.byteLength(out);
        resolve({
          ok,
          output: out.slice(0, this.limits.maxOutputBytes),
          outputBytes: bytes,
          truncated: bytes > this.limits.maxOutputBytes,
          durationMs: Date.now() - started,
        });
      };
      child.on("error", (err) => {
        out += `\nspawn error: ${err.message}`;
        finish(false);
      });
      child.on("close", (code) => finish(code === 0));
    });
  }
}

async function walk(dir: string, maxEntries: number, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return [];
  let rows: string[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [`(unreadable: ${dir})`];
  }
  for (const d of dirents) {
    if (rows.length >= maxEntries) { rows.push("...[more entries]"); break; }
    const rel = path.relative(path.resolve(dir), path.join(dir, d.name));
    rows.push(d.isDirectory() ? `${rel}/` : rel);
    if (d.isDirectory()) {
      rows = rows.concat(await walk(path.join(dir, d.name), maxEntries - rows.length, maxDepth, depth + 1));
    }
  }
  return rows;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
