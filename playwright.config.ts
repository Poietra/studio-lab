import { defineConfig } from "@playwright/test";

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  reporter: "line",
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: "pnpm dev:web --port 4173",
    env: { POIETRA_AI_DEBUG_LOG: "off" },
    stdout: "pipe",
    timeout: 120_000,
    wait: { stdout: /Local:\s+http:\/\/127\.0\.0\.1:4173\// },
  },
  workers: 1,
});
