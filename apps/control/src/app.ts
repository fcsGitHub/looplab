// App factory: used by the production entrypoint and by the integration tests
// (in-process boot against an isolated database).
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdirSync } from "node:fs";
import { loadConfig, type Config } from "./config.js";
import { Db } from "./db.js";
import { AuthService } from "./auth.js";
import { GoalService } from "./goals.js";
import { Scheduler } from "./scheduler.js";
import { AttemptsService } from "./attempts.js";
import { LlmGateway } from "./llmgateway.js";
import { EvolutionService } from "./evolution.js";
import { EvalBroker } from "./evalbroker.js";
import { ReleaseService } from "./releases.js";
import { Orchestrator } from "./orchestrator.js";
import { ResearchService } from "./research.js";
import { EvidenceService } from "./evidence.js";
import { ObjectStore } from "./objectstore.js";
import { registerRoutes } from "./routes/index.js";
import type { ControlServices } from "./routes/services.js";

export async function buildApp(configOverride: Partial<Config> = {}) {
  const config = loadConfig(configOverride);
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.sealedDir, { recursive: true });

  const db = new Db(config.databaseUrl);
  const applied = await db.migrate();

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(cookie, { secret: process.env.LL_COOKIE_SECRET ?? "looplab-dev-secret" });

  // raw binary bodies for the artifact upload endpoint
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (req, body, done) => {
    done(null, body);
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", req.headers.origin ?? "*");
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-headers", "content-type,authorization,x-artifact-name,x-artifact-media-type,x-attempt-id,x-producer-role,x-goal-id,x-scope");
    reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      await reply.code(204).send();
    }
  });

  const auth = new AuthService(db, config.sessionTtlMs);
  const goals = new GoalService(db, config);
  const scheduler = new Scheduler(db, config);
  const attempts = new AttemptsService(db, config, goals);
  const llm = new LlmGateway(db, config);
  const evolution = new EvolutionService(db, config);
  const evalBroker = new EvalBroker(db, config);
  const releases = new ReleaseService(db);
  const research = new ResearchService(db);
  const evidence = new EvidenceService(db);
  const orchestrator = new Orchestrator(db, scheduler, goals);

  const services: ControlServices = {
    db, config,
    objects: new ObjectStore(`${config.dataDir}/objects`),
    auth, goals, scheduler, attempts, llm, evolution, evalBroker, releases, research, evidence, orchestrator,
  };

  registerRoutes(app, services);

  app.setErrorHandler((err, req, reply) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[control] ${req.method} ${req.url} -> ${err instanceof Error ? err.stack?.slice(0, 500) : msg}`);
    if (!reply.sent) {
      reply.code(500).send({ error: "internal", message: msg.slice(0, 300) });
    }
  });

  return { app, services, config, appliedMigrations: applied };
}

export type LoopLabApp = Awaited<ReturnType<typeof buildApp>>;
