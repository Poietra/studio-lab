import { join } from "node:path";

import { defineConfig } from "@playwright/test";

import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./e2e/webgpu-launch";

const producerCommand = process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND?.trim();
if (!producerCommand) {
  throw new Error(
    "POIETRA_FAST_MANIM_SNAPSHOT_COMMAND must name the real fast-manim snapshot producer as a command or JSON argv array.",
  );
}

const dataRoot = join(process.cwd(), "test-results", `workspace-store-${process.pid}-real-preview`);
const port = Number(process.env.POIETRA_E2E_REAL_PREVIEW_PORT ?? 4184);

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name: "real-preview-webgpu",
      testMatch: "**/real-scene-preview.webgpu.ts",
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
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: `pnpm dev:web --port ${port}`,
    env: {
      POIETRA_AI_DEBUG_LOG: "off",
      POIETRA_FAST_MANIM_SNAPSHOT_COMMAND: producerCommand,
      POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN: "1",
      POIETRA_FAST_MANIM_SNAPSHOT_VERSION: "2",
      POIETRA_MANIM_PROJECTS: JSON.stringify([
        {
          id: "real-preview-harness",
          name: "Real Preview Harness",
          root: "./fixtures/real-preview-harness",
        },
      ]),
      POIETRA_STUDIO_DATA_ROOT: dataRoot,
      VITE_POIETRA_AI_ENDPOINT: "/api/ai/edit-suggestions",
    },
    stdout: "pipe",
    timeout: 120_000,
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${port}/`) },
  },
  workers: 1,
});
