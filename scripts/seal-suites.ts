// Provisions runtime suites for the TaskPacks:
//   data/taskpacks/<id>/            evaluator.py, baseline.py, dev/selection suites (public)
//   sealed/<id>/                    release suite (sealed labels; resolvable only by the evaluator)
// Suites are generated from distinct seed ranges (dev ≠ selection ≠ release).
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
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

// ---- FFD-gap curation helpers ----------------------------------------------
// Reference heuristics used ONLY at provisioning time to select instances
// where the FFD baseline provably has headroom. Candidates never see these.
function ffdPack(items, capacity) {
  const bins = [];
  for (const s of [...items].sort((a, b) => b - a)) {
    let placed = false;
    for (const b of bins) {
      if (b.reduce((x, y) => x + y, 0) + s <= capacity) { b.push(s); placed = true; break; }
    }
    if (!placed) bins.push([s]);
  }
  return bins;
}
function bfdPack(items, capacity) {
  const bins = [];
  for (const s of [...items].sort((a, b) => b - a)) {
    let bestI = -1, bestRem = Infinity;
    for (let i = 0; i < bins.length; i++) {
      const rem = capacity - bins[i].reduce((x, y) => x + y, 0) - s;
      if (rem >= 0 && rem < bestRem) { bestI = i; bestRem = rem; }
    }
    if (bestI >= 0) bins[bestI].push(s);
    else bins.push([s]);
  }
  return bins;
}
function mergeablePair(bins, capacity) {
  for (let i = 0; i < bins.length; i++) {
    for (let j = i + 1; j < bins.length; j++) {
      if (bins[i].reduce((x, y) => x + y, 0) + bins[j].reduce((x, y) => x + y, 0) <= capacity) return true;
    }
  }
  return false;
}

/**
 * Keep only instances where the FFD baseline provably loses at least one bin
 * to a trivially better strategy (BFD, or FFD + any two-bin merge). Graded
 * headroom emerges naturally: some instances only need a merge pass, others
 * need a genuine ordering change.
 */
function binPackingGapProblems(prefix, seedStart, count, nItems) {
  const problems = [];
  let seed = seedStart;
  let tries = 0;
  while (problems.length < count && tries < count * 5000) {
    const rng = mulberry32(seed);
    const items = Array.from({ length: nItems }, () => 10 + Math.floor(rng() * 81));
    const ffdBins = ffdPack(items, 100);
    const betterBins = Math.min(
      bfdPack(items, 100).length,
      mergeablePair(ffdBins, 100) ? ffdBins.length - 1 : ffdBins.length,
    );
    if (ffdBins.length - betterBins >= 1) {
      problems.push({ id: `${prefix}-${seed}`, seed, items, capacity: 100 });
    }
    seed++;
    tries++;
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

  // ---- algorithm-search.bin-packing-large ---------------------------------
  // Independent task family for meta-evolution epoch trials (§六.8): larger
  // instances widen the FFD-vs-OPT gap, giving challengers real room. Seed
  // archive is DISJOINT from the small family (4xxx), so trial results on
  // this family never touch the small-family release pointer.
  const lsrc = path.join(ROOT, "taskpacks", "algorithm-search");
  const ldst = path.join(rootDataDir, "algorithm-search.bin-packing-large");
  mkdirSync(ldst, { recursive: true });
  for (const f of ["evaluator.py", "baseline.py", "candidate_runner.py", "taskpack.json"]) {
    copyFileSync(path.join(lsrc, f), path.join(ldst, f));
    console.log("copied", f);
  }
  const largeBase = {
    ...binPackBase,
    taskpack_id: "algorithm-search.bin-packing-large",
    contract_version: "bin-packing-large/v1",
    time_limit_ms_per_problem: 2000,
  };
  // the copied taskpack.json still names the small family — rewrite identity
  const ltp = JSON.parse(readFileSync(path.join(ldst, "taskpack.json"), "utf8"));
  ltp.id = "algorithm-search.bin-packing-large";
  ltp.baseline.evaluation_ref = "suite://bin-packing-large/dev-v1";
  ltp.validation.dev_suite_ref = "suite://bin-packing-large/dev-v1";
  ltp.validation.selection_suite_ref = "suite://bin-packing-large/selection-v1";
  ltp.validation.release_suite_ref = "sealed://bin-packing-large/release-v1";
  writeJson(path.join(ldst, "taskpack.json"), ltp);
  writeJson(path.join(ldst, "dev-suite.json"), {
    ...largeBase, layer: "dev",
    problems: binPackingProblems("dev", 4000, 10, 220),
  });
  writeJson(path.join(ldst, "selection-suite.json"), {
    ...largeBase, layer: "selection",
    problems: binPackingProblems("sel", 5000, 10, 220),
  });
  writeJson(path.join(rootSealedDir, "algorithm-search.bin-packing-large", "release-suite.json"), {
    ...largeBase, layer: "release",
    problems: binPackingProblems("rel", 6000, 10, 220),
  });

  // ---- algorithm-search.bin-packing-gap -----------------------------------
  // Benchmark curation with KNOWN headroom (§六.8 "有区分度的实验"): instances
  // are filtered so the FFD baseline provably leaves >=1 recoverable bin
  // (a mergeable pair exists, or a best/worst-fit ordering packs tighter).
  // This is instance selection at provisioning time — no labels ship with the
  // suite (problems carry only items/capacity, identical schema to the other
  // families) and the evaluator stays the same honest paired comparison.
  // Seed archive 7xxx/8xxx/9xxx, disjoint from both other families.
  const gsrc = path.join(ROOT, "taskpacks", "algorithm-search");
  const gdst = path.join(rootDataDir, "algorithm-search.bin-packing-gap");
  mkdirSync(gdst, { recursive: true });
  for (const f of ["evaluator.py", "baseline.py", "candidate_runner.py", "taskpack.json"]) {
    copyFileSync(path.join(gsrc, f), path.join(gdst, f));
    console.log("copied", f);
  }
  const gapBase = {
    ...binPackBase,
    taskpack_id: "algorithm-search.bin-packing-gap",
    contract_version: "bin-packing-gap/v1",
    time_limit_ms_per_problem: 1200,
  };
  // 40-item instances with a wide size spread keep the merge/yield rate high
  // enough for provisioning; fewer, smaller instances also make each trial
  // cheap. binPackingGapProblems caps its own search budget per layer.
  const gtp = JSON.parse(readFileSync(path.join(gdst, "taskpack.json"), "utf8"));
  gtp.id = "algorithm-search.bin-packing-gap";
  gtp.baseline.evaluation_ref = "suite://bin-packing-gap/dev-v1";
  gtp.validation.dev_suite_ref = "suite://bin-packing-gap/dev-v1";
  gtp.validation.selection_suite_ref = "suite://bin-packing-gap/selection-v1";
  gtp.validation.release_suite_ref = "sealed://bin-packing-gap/release-v1";
  writeJson(path.join(gdst, "taskpack.json"), gtp);
  writeJson(path.join(gdst, "dev-suite.json"), {
    ...gapBase, layer: "dev", curation: "ffdlag>=1",
    problems: binPackingGapProblems("dev", 7000, 10, 40),
  });
  writeJson(path.join(gdst, "selection-suite.json"), {
    ...gapBase, layer: "selection", curation: "ffdlag>=1",
    problems: binPackingGapProblems("sel", 8000, 10, 40),
  });
  writeJson(path.join(rootSealedDir, "algorithm-search.bin-packing-gap", "release-suite.json"), {
    ...gapBase, layer: "release", curation: "ffdlag>=1",
    problems: binPackingGapProblems("rel", 9000, 10, 40),
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
