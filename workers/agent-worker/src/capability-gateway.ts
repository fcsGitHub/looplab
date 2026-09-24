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

  /**
   * Resolve a tool-supplied path against the workspace and enforce
   * containment. The server-side PolicyGate resolves relative paths against
   * the workspace when it decides "allow" — the executor MUST resolve the
   * same way, or a relative path silently lands in the worker's process CWD
   * (incident-006: repo-root litter from `workspace_write fib.py`).
   */
  private contain(p: string): string {
    const root = path.resolve(this.workspaceDir);
    const abs = path.resolve(root, p);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return abs;
  }

  async execute(tool: string, args: Record<string, unknown>): Promise<ExecResult> {
    const started = Date.now();
    try {
      switch (tool) {
        case "workspace_write": {
          const p = this.contain(String(args.path));
          const content = String(args.content ?? "");
          await fs.mkdir(path.dirname(p), { recursive: true });
          await fs.writeFile(p, content, "utf8");
          return done(`wrote ${content.length} chars to ${path.basename(p)}`);
        }
        case "workspace_read": {
          const p = this.contain(String(args.path));
          const content = await fs.readFile(p, "utf8");
          return done(content);
        }
        case "workspace_list": {
          const root = this.contain(String(args.path ?? this.workspaceDir));
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
      // Sandbox enforcement INSIDE the child (audit hook, PEP 578):
      // - spawn cwd may be silently ignored by the OS layer -> force chdir
      // - relative AND absolute paths outside the workspace are denied
      // - networking, subprocesses are denied outright
      // Denials are reported on fd2 with a marker so the gateway can flag the
      // tool result even when the script swallows the exception.
      const bootstrap =
        `import os as _os, sys as _sys\n` +
        `_WS = _os.path.realpath(${JSON.stringify(this.workspaceDir)})\n` +
        `_STD = _os.path.realpath(_sys.prefix) + _os.sep\n` +
        `_os.chdir(_WS)\n` +
        `if _os.path.realpath(_os.getcwd()) != _WS:\n` +
        `    _sys.stderr.write("LOOPLAB_SANDBOX: chdir failed\\n"); _sys.exit(126)\n` +
        `def _inside(p):\n` +
        `    if isinstance(p, bytes): p = p.decode("utf-8", "replace")\n` +
        `    if not isinstance(p, str) or not p: return True\n` +
        `    rp = _os.path.realpath(p)\n` +
        `    return rp.startswith(_WS + _os.sep) or rp.startswith(_STD)\n` +
        `def _deny(msg):\n` +
        `    try: _os.write(2, msg.encode("utf-8", "replace"))\n` +
        `    except Exception: pass\n` +
        `    raise PermissionError(msg)\n` +
        `def _guard(event, args):\n` +
        `    if event == "open":\n` +
        `        p = args[0] if args else None\n` +
        `        if not _inside(p): _deny("LOOPLAB_SANDBOX: open(%r) denied\\n" % (p,))\n` +
        `    elif event in ("os.remove", "os.rmdir", "os.rename"):\n` +
        `        if not all(_inside(a) for a in args if a is not None):\n` +
        `            _deny("LOOPLAB_SANDBOX: %s %r denied\\n" % (event, args,))\n` +
        `    elif event in ("socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen", "os.system", "os.exec", "os.fork", "os.spawn"):\n` +
        `        _deny("LOOPLAB_SANDBOX: %s denied\\n" % (event,))\n` +
        `_sys.addaudithook(_guard)\n`;
      const wrapped = bootstrap + script + "\n";
      this.runningChildren++;
      const child = spawn("python", ["-I", "-c", wrapped], {
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
        // surface sandbox denials even when the script swallowed them
        const violated = out.includes("LOOPLAB_SANDBOX:");
        const note = violated ? "\n[LOOPLAB_SANDBOX] 本次执行包含越权访问尝试，已阻断并记录。" : "";
        const body = out.slice(0, this.limits.maxOutputBytes) + note;
        const bytes = Buffer.byteLength(body);
        resolve({
          ok: ok && !violated,
          output: body,
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
