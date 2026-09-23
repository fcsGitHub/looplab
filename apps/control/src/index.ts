// LoopLab control service entrypoint.
import { buildApp } from "./app.js";

async function main() {
  const { app, services, config, appliedMigrations } = await buildApp();
  console.log(`[control] migrations applied: ${appliedMigrations.length ? appliedMigrations.join(", ") : "(none pending)"}`);

  services.orchestrator.start(3000);
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[control] listening on http://localhost:${config.port} (data: ${config.dataDir})`);

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
