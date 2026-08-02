import { defineConfig } from "@playwright/test";

const port = Number(process.env.POIETRA_ACCOUNT_E2E_PORT ?? 4_175);
const baseURL = `https://127.0.0.1:${port}`;

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [{ name: "account-production-chromium", use: { browserName: "chromium" } }],
  reporter: "line",
  testDir: "./e2e",
  testMatch: ["account-session.production.ts", "editor-cloud-session.production.ts"],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1_440 },
  },
  webServer: {
    command: "pnpm exec vite preview --config e2e/account-production-vite.config.ts --configLoader runner",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 120_000,
    url: baseURL,
  },
  workers: 1,
});
