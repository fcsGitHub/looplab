// EvalBroker: independent evaluation with sealed labels (design §4.3, §12).
// Layered suites: dev (public, reusable) -> selection (restricted) -> release
// (sealed:// resolved ONLY inside the evaluator process; candidates never see
// labels or the sealed directory).
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { EvaluationResultSchema, type EvaluationResult } from "@looplab/contracts";
import { EventStore } from "./eventstore.js";
import type { Db } from "./db.js";
import type { Config } from "./config.js";

export interface EvalRequest {
  candidateId: string;
  candidateArtifactDigest: string;
  goalId: string;
  taskpackId: string;
  layer: "dev" | "selection" | "release";
  contractVersion: string;
  budgetUsd: number;
}

export class EvalBroker {
  constructor(private db: Db, private config: Config) {}

  suitePath(taskpackId: string, layer: "dev" | "selection" | "release"): string {
    if (layer === "release") {
      // sealed:// — resolved only here; candidates/worker sandboxes never get this path
      const p = path.join(this.config.sealedDir, taskpackId, "release-suite.json");
      if (!existsSync(p)) {
        throw new Error(`sealed release suite missing for ${taskpackId}; run scripts/seal-suites.ts to provision`);
      }
      return p;
    }
    const p = path.join(this.config.dataDir, "taskpacks", taskpackId, `${layer}-suite.json`);
    if (!existsSync(p)) {
      throw new Error(`suite missing: ${p}`);
    }
    return p;
  }

  /**
   * Run the evaluator in a SEPARATE process. The child receives the candidate
   * file (extracted from the object store into an eval dir WITHOUT sealed
   * content) and the suite path. Sealed suites are readable only by this child
   * (same OS user, isolated directory, never mounted into worker sandboxes).
   */
  async runEvaluation(req: EvalRequest): Promise<EvaluationResult> {
    const suitePath = this.suitePath(req.taskpackId, req.layer);
    const evalDir = path.join(this.config.dataDir, "evals", `${req.candidateId}_${req.layer}_${Date.now()}`);
    mkdirSync(evalDir, { recursive: true });

    // materialize candidate source from the object store
    const artifactRow = (
      await this.db.query("SELECT name FROM artifacts WHERE digest=$1", [req.candidateArtifactDigest])
    ).rows[0];
    if (!artifactRow) throw new Error(`candidate artifact ${req.candidateArtifactDigest} not registered`);
    const content = await this.readObject(req.candidateArtifactDigest);
    const candidateFile = path.join(evalDir, "candidate", artifactRow.name.replace(/[/\\]/g, "_"));
    mkdirSync(path.dirname(candidateFile), { recursive: true });
    writeFileSync(candidateFile, content);

    const evaluatorScript = path.resolve(this.config.dataDir, "taskpacks", req.taskpackId, "evaluator.py");
    if (!existsSync(evaluatorScript)) throw new Error(`evaluator missing: ${evaluatorScript}`);

    const result = await this.spawnEvaluator({
      python: "python",
      evaluatorScript,
      args: ["--candidate", candidateFile, "--suite", suitePath, "--layer", req.layer, "--out", path.join(evalDir, "result.json")],
      timeoutMs: 120_000,
      evalDir,
    });

    const parsed = EvaluationResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new Error(`evaluator produced invalid result: ${parsed.error.message.slice(0, 300)}`);
    }

    await this.db.tx(async (client) => {
      const evalId = `eval_${req.candidateId.slice(5)}_${req.layer}`;
      await client.query(
        `INSERT INTO evaluations (id, candidate_id, contract_version, suite_ref, layer, results, verdict, cost_usd, evaluated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'eval-broker')`,
        [evalId + "_" + Date.now(), req.candidateId, req.contractVersion, `${req.layer}://${req.taskpackId}`,
          req.layer, JSON.stringify(parsed.data), parsed.data.verdict, req.budgetUsd],
      );
      await EventStore.append(client, {
        aggregateType: "candidate", aggregateId: req.candidateId, eventType: "evaluation.completed",
        goalId: req.goalId, actor: { kind: "evaluator", id: "eval-broker" },
        payload: {
          layer: req.layer, verdict: parsed.data.verdict,
          primary: { metric: parsed.data.primary_metric, value: parsed.data.primary_value },
          hard_constraints_passed: parsed.data.hard_constraints.every((h) => h.passed),
        },
      });
    });
    return parsed.data;
  }

  private readObject(digest: string): Buffer {
    const rel = path.join(digest.slice(0, 2), digest.slice(2, 4), digest);
    const p = path.join(this.config.dataDir, "objects", rel);
    if (!existsSync(p)) throw new Error(`object missing: ${digest}`);
    return readFileSync(p);
  }

  private spawnEvaluator(opts: {
    python: string; evaluatorScript: string; args: string[]; timeoutMs: number; evalDir: string;
  }): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(opts.python, [opts.evaluatorScript, ...opts.args], {
        cwd: opts.evalDir,
        timeout: opts.timeoutMs,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: "1",
          // NOTE: SEALED_DIR is NOT passed to candidates' worker processes;
          // the evaluator child resolves sealed:// refs via the suite file path itself.
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`evaluator exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          const idx = opts.args.indexOf("--out");
          const outFile = idx >= 0 ? opts.args[idx + 1] : undefined;
          if (!outFile) throw new Error("no --out arg");
          resolve(JSON.parse(readFileSync(outFile, "utf8")));
        } catch (err) {
          reject(new Error(`evaluator output unreadable: ${stderr.slice(0, 200)}`));
        }
      });
    });
  }
}
