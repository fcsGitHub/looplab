import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  databaseUrl: string;
  dataDir: string;
  sealedDir: string;
  deepseek: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
    reasonerModel: string;
  };
  workerHeartbeatMs: number;
  leaseTtlMs: number;
  /** per-goal default budget cap in USD */
  defaultGoalBudgetUsd: number;
  sessionTtlMs: number;
  costPer1kPromptUsd: number;
  costPer1kCompletionUsd: number;
}

function loadEnvFile(): Record<string, string> {
  const candidates = [
    path.resolve(__dirname, "../config/.env.local"), // apps/control/config/.env.local
    path.resolve(process.cwd(), "apps/control/config/.env.local"),
    path.resolve(process.cwd(), "config/.env.local"),
    path.resolve(__dirname, "../../../.env"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const out: Record<string, string> = {};
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].trim();
      }
      return out;
    }
  }
  return {};
}

const fileEnv = loadEnvFile();
function env(name: string, fallback?: string): string {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined) return fromProcess;
  const fromFile = fileEnv[name];
  if (fromFile !== undefined) return fromFile;
  return fallback ?? "";
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const apiKey = env("DEEPSEEK_API_KEY");
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY missing. Put it in apps/control/config/.env.local (gitignored) or the environment.",
    );
  }
  const root = path.resolve(__dirname, "../../..");
  return {
    port: Number(env("PORT", "8080")),
    databaseUrl: env("DATABASE_URL", "postgres://looplab:localdev@localhost:5433/looplab"),
    dataDir: env("DATA_DIR", path.join(root, "data")),
    sealedDir: env("SEALED_DIR", path.join(root, "sealed")),
    deepseek: {
      apiKey,
      baseUrl: env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
      chatModel: env("DEEPSEEK_CHAT_MODEL", "deepseek-chat"),
      reasonerModel: env("DEEPSEEK_REASONER_MODEL", "deepseek-reasoner"),
    },
    workerHeartbeatMs: Number(env("WORKER_HEARTBEAT_MS", "5000")),
    leaseTtlMs: Number(env("LEASE_TTL_MS", "30000")),
    defaultGoalBudgetUsd: Number(env("DEFAULT_GOAL_BUDGET_USD", "5")),
    sessionTtlMs: Number(env("SESSION_TTL_MS", String(7 * 24 * 3600_000))),
    // DeepSeek official pricing (per 1M tokens): chat $0.27 in / $1.10 out.
    // Per 1k: 0.00027 / 0.0011.
    costPer1kPromptUsd: Number(env("COST_PER_1K_PROMPT_USD", "0.00027")),
    costPer1kCompletionUsd: Number(env("COST_PER_1K_COMPLETION_USD", "0.0011")),
    ...overrides,
  };
}
