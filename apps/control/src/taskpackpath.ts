// TaskPack path safety (P23 fix — V18). TaskPack ids and per-TaskPack file
// paths arrive over HTTP (evolution routes, EvalBroker). Path.join with an
// unchecked id let ".." segments escape the taskpacks directory:
//   - proposeChange could read ANY file into an LLM prompt (and prompt-inject
//     the content into a stored proposal)
//   - EvalBroker would resolve evaluator.py at an attacker-chosen path —
//     executing attacker-written code (workspace sandbox escape) in the
//     TRUSTED evaluator tier
import path from "node:path";

/** ids look like `algorithm-search.bin-packing` — letters/digits/dot/dash only. */
export function assertSafeTaskpackId(id: string): string {
  if (typeof id !== "string" || id.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(id)) {
    throw new Error(`unsafe taskpack id: ${JSON.stringify(id).slice(0, 80)}`);
  }
  return id;
}

/** Relative file inside a TaskPack dir — no traversal, no absolute paths. */
export function assertSafeTaskpackRelPath(p: string): string {
  if (typeof p !== "string" || !p
    || path.isAbsolute(p)
    || p.split(/[\\/]/).includes("..")
    || /[\0]/.test(p)) {
    throw new Error(`unsafe taskpack file path: ${JSON.stringify(p).slice(0, 80)}`);
  }
  return p;
}

/** Contained join: <root>/<taskpackId>/<rel>, verified to stay under root. */
export function taskpackPath(root: string, taskpackId: string, rel: string): string {
  assertSafeTaskpackId(taskpackId);
  assertSafeTaskpackRelPath(rel);
  const abs = path.resolve(root, "taskpacks", taskpackId, rel);
  const base = path.resolve(root, "taskpacks");
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`taskpack path escapes root: ${taskpackId}/${rel}`);
  }
  return abs;
}
