// Content-addressed object store (design §17.1 Artifact). Single-machine
// implementation: data/objects/<aa>/<bb>/<digest>. ObjectStore port allows a
// remote implementation later. Write order: object first, then DB row.
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class ObjectStore {
  constructor(private rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  async put(data: Buffer, mediaType: string): Promise<{ digest: string; size: number; storageRef: string }> {
    const digest = createHash("sha256").update(data).digest("hex");
    const rel = path.join(digest.slice(0, 2), digest.slice(2, 4), digest);
    const abs = path.join(this.rootDir, rel);
    if (!existsSync(abs)) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    }
    return { digest, size: data.byteLength, storageRef: `file://${rel}` };
  }

  async get(digest: string): Promise<Buffer | null> {
    const abs = this.pathOf(digest);
    if (!existsSync(abs)) return null;
    return readFileSync(abs);
  }

  has(digest: string): boolean {
    return existsSync(this.pathOf(digest));
  }

  sizeOf(digest: string): number {
    try {
      return statSync(this.pathOf(digest)).size;
    } catch {
      return 0;
    }
  }

  private pathOf(digest: string): string {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`invalid digest: ${digest}`);
    return path.join(this.rootDir, digest.slice(0, 2), digest.slice(2, 4), digest);
  }
}
