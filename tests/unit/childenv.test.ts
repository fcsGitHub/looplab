// Unit: spawned-child environment allowlist. The control process may hold
// secrets in its own environment (exported key, .env.local loaders); the
// builder must forward an allowlist, never the host environment.
import { describe, expect, it } from "vitest";
import { infraEnv } from "../../apps/control/src/childenv.js";

describe("infraEnv", () => {
  it("carries the allowlisted extras and nothing from a poisoned host env", () => {
    process.env.DEEPSEEK_API_KEY = "sk-host-secret";
    process.env.LL_COOKIE_SECRET = "cookie-secret";
    process.env.WORKER_TOKEN = "worker-secret";
    try {
      const env = infraEnv({ LOOPLAB_OPT_TOKEN: "optk_abc" });
      expect(env.LOOPLAB_OPT_TOKEN).toBe("optk_abc");
      expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
      expect(env.PATH).toBeDefined();
      expect(Object.keys(env)).not.toContain("DEEPSEEK_API_KEY");
      expect(Object.keys(env)).not.toContain("LL_COOKIE_SECRET");
      expect(Object.keys(env)).not.toContain("WORKER_TOKEN");
      expect(JSON.stringify(env)).not.toContain("sk-host-secret");
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.LL_COOKIE_SECRET;
      delete process.env.WORKER_TOKEN;
    }
  });
});
