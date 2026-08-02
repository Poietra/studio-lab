import { readFileSync } from "node:fs";

import { defineConfig, mergeConfig } from "vite";

import { createStudioViteConfig } from "../vite.config";
import { accountProductionHarnessPlugin } from "./account-production-harness";

const port = Number(process.env.POIETRA_ACCOUNT_E2E_PORT ?? 4_175);
const publicOrigin = `https://127.0.0.1:${port}`;
const certificatePath = process.env.POIETRA_ACCOUNT_E2E_CERT;
const databaseUrl = process.env.POIETRA_ACCOUNT_E2E_DATABASE_URL;
const keyPath = process.env.POIETRA_ACCOUNT_E2E_KEY;
const runId = process.env.POIETRA_ACCOUNT_E2E_RUN_ID ?? "standalone";

if (!certificatePath || !databaseUrl || !keyPath) {
  throw new Error("The account production E2E requires PostgreSQL and its temporary HTTPS certificate.");
}

export default defineConfig(() =>
  mergeConfig(createStudioViteConfig("production"), {
    plugins: [accountProductionHarnessPlugin(publicOrigin, databaseUrl)],
    preview: {
      headers: { "x-poietra-account-e2e-run": runId },
      host: "127.0.0.1",
      https: { cert: readFileSync(certificatePath), key: readFileSync(keyPath) },
      port,
      strictPort: true,
    },
  }),
);
