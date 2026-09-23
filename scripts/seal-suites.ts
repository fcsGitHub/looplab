// Provisions runtime suites for the TaskPacks:
//   data/taskpacks/<id>/            evaluator.py, baseline.py, dev/selection suites (public)
//   sealed/<id>/                    release suite (sealed labels; resolvable only by the evaluator)
// Suites are generated from distinct seed ranges (dev ≠ selection ≠ release).
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const dataTaskpacks = path.join(ROOT, "data", "taskpacks");
const sealedDir = path.join(ROOT, "sealed");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binPackingProblems(prefix, seedStart, count, nItems) {
  const problems = [];
  for (let i = 0; i < count; i++) {
    const seed = seedStart + i;
    const rng = mulberry32(seed);
    const items = Array.from({ length: nItems }, () => 10 + Math.floor(rng() * 81));
    problems.push({ id: `${prefix}-${seed}`, seed, items, capacity: 100 });
  }
  return problems;
}

const binPackBase = {
  taskpack_id: "algorithm-search.bin-packing",
  metric: "bins_avg",
  minimize: true,
  min_effect_delta: 0.05,
  max_regression_epsilon: 0.02,
  time_limit_ms_per_problem: 500,
  contract_version: "bin-packing/v1",
};

function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 1));
  console.log("wrote", path.relative(ROOT, file));
}

export function provisionInto(rootDataDir = dataTaskpacks, rootSealedDir = sealedDir) {
  // ---- algorithm-search.bin-packing --------------------------------------
  const src = path.join(ROOT, "taskpacks", "algorithm-search");
  const dst = path.join(rootDataDir, "algorithm-search.bin-packing");
  mkdirSync(dst, { recursive: true });
  for (const f of ["evaluator.py", "baseline.py", "candidate_runner.py", "taskpack.json"]) {
    copyFileSync(path.join(src, f), path.join(dst, f));
    console.log("copied", f);
  }

  writeJson(path.join(dst, "dev-suite.json"), {
    ...binPackBase, layer: "dev",
    problems: binPackingProblems("dev", 1000, 12, 60),
  });
  writeJson(path.join(dst, "selection-suite.json"), {
    ...binPackBase, layer: "selection",
    problems: binPackingProblems("sel", 2000, 12, 60),
  });
  writeJson(path.join(rootSealedDir, "algorithm-search.bin-packing", "release-suite.json"), {
    ...binPackBase, layer: "release",
    problems: binPackingProblems("rel", 3000, 12, 60),
  });

  // ---- harness-improvement ------------------------------------------------
  const hsrc = path.join(ROOT, "taskpacks", "harness-improvement");
  const hdst = path.join(rootDataDir, "harness-improvement.tool-failures");
  mkdirSync(hdst, { recursive: true });
  for (const f of ["evaluator.py", "baseline_config.json", "harness.py"]) {
    copyFileSync(path.join(hsrc, f), path.join(hdst, f));
    console.log("copied", f);
  }
  writeJson(path.join(hdst, "dev-suite.json"), harnessSuite("dev", 100));
  writeJson(path.join(hdst, "selection-suite.json"), harnessSuite("selection", 200));
  writeJson(path.join(rootSealedDir, "harness-improvement.tool-failures", "release-suite.json"), harnessSuite("release", 300));

  function harnessSuite(layer, seedBase) {
    const rng = mulberry32(seedBase);
    const scenarios = [];
    for (let i = 0; i < 20; i++) {
      scenarios.push({
        id: `${layer}-${seedBase + i}`,
        seed: seedBase + i,
        tool_fail_mode: ["timeout", "huge_output", "transient_5xx", "empty"][Math.floor(rng() * 4)],
        fail_probability: 0.2 + rng() * 0.5,
        n_tool_calls: 3 + Math.floor(rng() * 6),
        context_budget_chars: 2000 + Math.floor(rng() * 6000),
      });
    }
    return {
      taskpack_id: "harness-improvement.tool-failures",
      layer,
      contract_version: "harness/v1",
      metric: "success_rate",
      minimize: false,
      min_effect_delta: 0.08,
      max_regression_epsilon: 0.03,
      time_limit_ms_per_problem: 1000,
      scenarios,
    };
  }

  console.log("provisioning complete.");
}

export function provision() {
  provisionInto(dataTaskpacks, sealedDir);
}

const isMain = process.argv[1] && (process.argv[1].endsWith("seal-suites.ts") || process.argv[1].endsWith("seal-suites.js"));
if (isMain) {
  provision();
}
