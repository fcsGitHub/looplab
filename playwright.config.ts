import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 420_000,
  use: {
    baseURL: process.env.E2E_BASE ?? "http://localhost:8080",
    screenshot: "off",
    trace: "off",
  },
  workers: 1,
  reporter: [["list"]],
});
