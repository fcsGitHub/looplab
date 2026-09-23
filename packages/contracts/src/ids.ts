// LoopLab contracts: identifiers, ids and digests.
import { randomUUID, createHash } from "node:crypto";

export type IdPrefix =
  | "usr" | "ses" | "prj" | "goal" | "graph" | "task" | "att" | "evt"
  | "cmd" | "chk" | "appr" | "prob" | "prop" | "cand" | "eval" | "rev"
  | "rel" | "hyp" | "exp" | "msg" | "budget" | "run" | "worker" | "token";

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function shortDigest(digest: string, len = 8): string {
  return digest.slice(0, len);
}

export function artifactUri(digest: string): string {
  return `artifact://sha256/${digest}`;
}
