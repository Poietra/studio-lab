import { defineConfig } from "@playwright/test";

const port = Number(process.env.POIETRA_ACCOUNT_E2E_PORT ?? 4_175);
const baseURL = `https://127.0.0.1:${port}`;

// The one-step account runner owns the preview process and its shutdown boundary.
export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [{ name: "account-production-chromium", use: { browserName: "chromium" } }],
  reporter: "line",
  testDir: "./e2e",
  testMatch: [
    "account-invitation.production.ts",
    "account-organization.production.ts",
    "account-session.production.ts",
    "editor-cloud-session.production.ts",
  ],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1_440 },
  },
  workers: 1,
});
