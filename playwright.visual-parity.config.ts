import { join } from "node:path";

import { defineConfig } from "@playwright/test";

import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./e2e/webgpu-launch";

const dataRoot = join(process.cwd(), "test-results", `workspace-store-${process.pid}-visual-parity`);
const port = Number(process.env.POIETRA_VISUAL_PARITY_PORT ?? 4186);

if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`POIETRA_VISUAL_PARITY_PORT must be an integer from 1024 through 65535, received ${port}.`);
}

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "test-results/visual-parity/playwright",
  projects: [
    {
      name: "visual-parity-webgpu",
      testMatch: "visual-parity.webgpu.ts",
      use: {
        browserName: "chromium",
        channel: WEBGPU_CHROMIUM_CHANNEL,
        launchOptions: { args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS] },
      },
    },
  ],
  reporter: "line",
  testDir: "./e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm dev:web --port ${port}`,
    env: {
      POIETRA_AI_DEBUG_LOG: "off",
      POIETRA_STUDIO_DATA_ROOT: dataRoot,
      POIETRA_MANIM_PROJECTS: JSON.stringify([{ id: "studio-lab", name: "Studio Lab", root: "." }]),
      VITE_POIETRA_AI_ENDPOINT: "/api/ai/edit-suggestions",
    },
    stdout: "pipe",
    timeout: 120_000,
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${port}/`) },
  },
  workers: 1,
});
