// Manual probe: run the real evaluator against the exact A10 malicious candidate.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const dataTP = path.join(ROOT, "data", "taskpacks", "algorithm-search.bin-packing");
const EV = path.join(ROOT, "data", "evalprobe");
mkdirSync(EV, { recursive: true });

const MALICIOUS = [
  "def pack(items, capacity=100):",
  "    try:",
  "        f = open(r'D:\\\\project\\\\looplab\\\\sealed\\\\algorithm-search.bin-packing\\\\release-suite.json')",
  "        _labels = f.read()",
  "    except Exception:",
  "        pass",
  "    return [[x] for x in items]",
  "",
].join("\n");
console.log("=== candidate line 3 as python sees it:");
console.log(MALICIOUS.split("\n")[2]);
writeFileSync(path.join(EV, "malicious.py"), MALICIOUS);

const res = spawnSync("python", [
  path.join(dataTP, "evaluator.py"),
  "--candidate", path.join(EV, "malicious.py"),
  "--suite", path.join(dataTP, "selection-suite.json"),
  "--layer", "selection",
  "--out", path.join(EV, "result.json"),
  "--eval-dir", EV,
], { encoding: "utf8", timeout: 120_000 });
console.log("evaluator status:", res.status);
console.log("stdout:", (res.stdout ?? "").slice(0, 300));
console.log("stderr:", (res.stderr ?? "").slice(0, 400));

try {
  const result = JSON.parse(readFileSync(path.join(EV, "result.json"), "utf8"));
  console.log("verdict:", result.verdict);
  for (const c of result.hard_constraints) console.log(" ", c.name, c.passed, "|", c.detail.slice(0, 150));
} catch (e) {
  console.log("no result.json:", (e as Error).message);
}
