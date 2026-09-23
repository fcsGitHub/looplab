// LoopLab control service entrypoint.
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { loadConfig } from "./config.js";
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
import { ObjectStore } from "./objectstore.js";
import { registerRoutes } from "./routes/index.js";
import type { ControlServices } from "./routes/services.js";
import { mkdirSync } from "node:fs";

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.sealedDir, { recursive: true });

  const db = new Db(config.databaseUrl);
  const applied = await db.migrate();
  console.log(`[control] migrations applied: ${applied.length ? applied.join(", ") : "(none pending)"}`);

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(cookie, { secret: process.env.LL_COOKIE_SECRET ?? "looplab-dev-secret" });

  // dev CORS: the Vite dev server proxies /v1, so this is only for direct use
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
  const orchestrator = new Orchestrator(db, scheduler, goals);

  const services: ControlServices = {
    db, config,
    objects: new ObjectStore(`${config.dataDir}/objects`),
    auth, goals, scheduler, attempts, llm, evolution, evalBroker, releases, orchestrator,
  };

  registerRoutes(app, services);

  app.setErrorHandler((err, req, reply) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[control] ${req.method} ${req.url} -> ${msg}`);
    if (!reply.sent) {
      reply.code(500).send({ error: "internal", message: msg.slice(0, 300) });
    }
  });

  orchestrator.start(3000);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[control] listening on http://localhost:${config.port} (data: ${config.dataDir})`);

  const shutdown = async () => {
    orchestrator.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[control] fatal:", err);
  process.exit(1);
});
