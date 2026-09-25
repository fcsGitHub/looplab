// LoopLab control service entrypoint.
import { buildApp } from "./app.js";

async function main() {
  const { app, services, config, appliedMigrations } = await buildApp();
  console.log(`[control] migrations applied: ${appliedMigrations.length ? appliedMigrations.join(", ") : "(none pending)"}`);

  services.orchestrator.start(3000);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[control] listening on http://localhost:${config.port} (data: ${config.dataDir})`);
  if (!config.workerToken) {
    console.warn(
      `[control] WARNING: WORKER_TOKEN is not set — the worker plane (/v1/worker/*, /v1/attempts/*, ` +
      `artifact upload) accepts unauthenticated requests. This service binds 0.0.0.0; anyone on the ` +
      `network can drive model spend. Set WORKER_TOKEN in apps/control/config/.env.local and the same ` +
      `value in each worker's environment for any non-loopback deployment.`,
    );
  }
  if (config.dailyBudgetUsd > 0) {
    console.log(`[control] daily model-spend fuse active: $${config.dailyBudgetUsd}/24h`);
  }

  const shutdown = async () => {
    services.orchestrator.stop();
    await app.close();
    await services.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[control] fatal:", err);
  process.exit(1);
});
