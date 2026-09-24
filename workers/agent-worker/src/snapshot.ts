// Deterministic workspace snapshot at commit time (problem ledger #5, part 2):
// artifact registration must NOT depend on the model honestly listing files in
// RESULT.files. The worker scans the attempt workspace and uploads everything
// (capped), so propagation at the next claim always sees predecessor outputs.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ControlClient } from "./control-client.js";
import { guessMediaType } from "./agent-loop.js";

export const SNAPSHOT_MAX_FILES = 20;
export const SNAPSHOT_MAX_FILE_BYTES = 256 * 1024;

export interface SnapshotEntry {
  name: string;
  media_type: string;
  digest: string;
  size_bytes: number;
}

/** Upload every workspace file (capped) and return commit-ready descriptors. */
export async function snapshotWorkspaceArtifacts(
  client: ControlClient,
  spec: { attempt_id: string; goal_id: string },
  workspaceDir: string,
): Promise<SnapshotEntry[]> {
  let root: string;
  try {
    root = (await fs.stat(workspaceDir)).isDirectory() ? workspaceDir : path.dirname(workspaceDir);
  } catch {
    return [];
  }

  let names: string[] = [];
  try {
    names = await walkFlat(root);
  } catch {
    return [];
  }
  names = names.sort().slice(0, SNAPSHOT_MAX_FILES);

  const out: SnapshotEntry[] = [];
  for (const name of names) {
    try {
      const abs = path.join(root, name);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > SNAPSHOT_MAX_FILE_BYTES) continue;
      const content = await fs.readFile(abs);
      const media = guessMediaType(name);
      const up = await client.uploadArtifact(spec.attempt_id, spec.goal_id, name, media, content);
      if (up.status === 200 && up.json?.digest) {
        out.push({
          name, media_type: media,
          digest: String(up.json.digest), size_bytes: Number(up.json.size_bytes ?? content.byteLength),
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}

async function walkFlat(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile()) files.push(e.name);
    else if (e.isDirectory() && e.name === "probe") {
      // one nested level (probe/) is included for layered outputs
      const nested = await fs.readdir(path.join(root, e.name), { withFileTypes: true });
      for (const n of nested) if (n.isFile()) files.push(path.join(e.name, n.name));
    }
  }
  return files;
}
