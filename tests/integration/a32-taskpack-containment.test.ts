// A32 (P23): TaskPack path containment.
// taskpackId / baselinePath arrive over HTTP. Before this fix:
//   - proposeChange joined them unchecked -> arbitrary file read into an LLM
//     prompt (config/.env.local included)
//   - EvalBroker resolved evaluator.py from the id -> a workspace-sandboxed
//     agent could execute its own python in the TRUSTED evaluator tier
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, authedUser, fixture, type TestEnv } from "../helpers/spawn-control.js";
import { taskpackPath } from "../../apps/control/src/taskpackpath.js";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({});
});
afterAll(async () => { await env.close(); });

describe("A32 taskpack path containment", () => {
  it("taskpackPath helper refuses traversal, absolute paths and unsafe ids", () => {
    const root = env.dataDir;
    expect(taskpackPath(root, "algorithm-search.bin-packing", "baseline.py")).toBeTruthy();
    for (const [id, rel] of([
      ["../../config", ".env.local"],
      ["algorithm-search.bin-packing", "../../config/.env.local"],
      ["algorithm-search.bin-packing", "/etc/passwd"],
      ["..", "baseline.py"],
      ["a/b/../../../c", "baseline.py"],
      ["", "baseline.py"],
    ] as [string, string][])) {
      expect(() => taskpackPath(root, id, rel), `${id}:${rel}`).toThrow();
    }
  });

  it("evolution propose rejects traversal taskpack ids and file paths with 400/502 (no file content anywhere)", async () => {
    const user = await authedUser(env, "a32-user");
    const me = (await user.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const goalId = `goal_${randomBytes(4).toString("hex")}`;
    await fixture(env).createGoalWithTasks(me.user.id, projectId, sessionId, []);

    for (const body of [
      { problem_id: `prob_${randomBytes(3).toString("hex")}`, taskpack_id: "../../config", baseline_path: ".env.local", allowed_path: "x.py" },
      { problem_id: `prob_${randomBytes(3).toString("hex")}`, taskpack_id: "algorithm-search.bin-packing", baseline_path: "../../config/.env.local", allowed_path: "x.py" },
      { problem_id: `prob_${randomBytes(3).toString("hex")}`, taskpack_id: "..", allowed_path: "x.py" },
    ]) {
      const res = await user.post(`/v1/goals/${goalId}/evolution/propose`, body);
      // the route maps proposer errors to 502 ("produced no usable proposal")
      // and the containment throw surfaces as an internal 500 — either way the
      // attempt must NOT succeed (200/202) and must not echo file content
      expect([400, 404, 500, 502]).toContain(res.statusCode);
      expect(JSON.stringify(res.json() ?? {})).not.toContain("DEEPSEEK_API_KEY");
      expect(JSON.stringify(res.json() ?? {})).not.toContain("WORKER_TOKEN");
    }
  });

  it("evaluate with a traversal taskpack id never executes an outside evaluator.py", async () => {
    const user = await authedUser(env, "a32-eval");
    const me = (await user.get("/v1/me")).json();
    const f = fixture(env);
    const { projectId, sessionId } = await f.createProjectSession(me.user.id);
    const goalId = `goal_${randomBytes(4).toString("hex")}`;
    await fixture(env).createGoalWithTasks(me.user.id, projectId, sessionId, []);

    const res = await user.post(`/v1/goals/${goalId}/evolution/evaluate`, {
      candidate_id: `cand_${randomBytes(3).toString("hex")}`,
      taskpack_id: "../../workspaces",
      contract_version: "bin-packing/v1",
    });
    expect([400, 404, 500]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });
});
