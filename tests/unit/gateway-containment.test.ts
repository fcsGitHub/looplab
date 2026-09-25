// Incident-006 regression: the capability gateway MUST resolve tool-supplied
// paths against the attempt workspace (matching the server-side PolicyGate's
// resolution) — a relative path previously resolved against the worker's
// process CWD, littering the repository root.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityGateway } from "../../workers/agent-worker/src/capability-gateway.js";

function makeGateway() {
  const ws = mkdtempSync(path.join(tmpdir(), "gw-contain-"));
  return {
    ws,
    gw: new CapabilityGateway(ws, { toolTimeoutMs: 5000, maxOutputBytes: 100_000, maxChildProcesses: 2 }),
  };
}

describe("capability gateway path containment", () => {
  it("workspace_write with a RELATIVE path lands inside the workspace, not the process CWD", async () => {
    const { ws, gw } = makeGateway();
    const r = await gw.execute("workspace_write", { path: "probe/incident-006.py", content: "x = 1\n" });
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(ws, "probe", "incident-006.py"))).toBe(true);
    // and NOT in the process cwd (the old failure mode)
    expect(existsSync(path.join(process.cwd(), "probe", "incident-006.py"))).toBe(false);
  });

  it("parent traversal escapes are denied", async () => {
    const { gw } = makeGateway();
    const r = await gw.execute("workspace_write", { path: "../escaped.py", content: "nope" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes workspace/);
    expect(existsSync(path.resolve(process.cwd(), "escaped.py"))).toBe(false);
  });

  it("absolute paths outside the workspace are denied for write/read/list", async () => {
    const { gw } = makeGateway();
    const outside = path.join(tmpdir(), "definitely-outside-gw.py");
    const w = await gw.execute("workspace_write", { path: outside, content: "nope" });
    expect(w.ok).toBe(false);
    const r = await gw.execute("workspace_read", { path: outside });
    expect(r.ok).toBe(false);
    const l = await gw.execute("workspace_list", { path: tmpdir() });
    expect(l.ok).toBe(false);
  });

  it("the workspace root itself is addressable for reads/lists", async () => {
    const { ws, gw } = makeGateway();
    await gw.execute("workspace_write", { path: "a.txt", content: "hi" });
    const l = await gw.execute("workspace_list", { path: ws });
    expect(l.ok).toBe(true);
    expect(l.output).toContain("a.txt");
  });
});
