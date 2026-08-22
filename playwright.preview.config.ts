import { join } from "node:path";

import { defineConfig } from "@playwright/test";

// Dedicated harness for the retained WebGPU preview E2E (pnpm test:e2e:preview).
// Its server carries the extra "Preview Harness" workspace, which must never
// leak into the ordinary E2E server's workspace catalog; Studio Lab is also
// listed so the workspace-switch tests can prove preview authority never
// crosses a workspace/project switch.
const previewHarnessDataRoot = join(process.cwd(), "test-results", `workspace-store-${process.pid}-preview-harness`);
const previewHarnessPort = Number(process.env.POIETRA_E2E_PREVIEW_PORT ?? 4183);
const gestureBenchmarkEnabled = process.env.POIETRA_STUDIO_GESTURE_BENCHMARK === "1";

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  projects: [
    {
      name: "preview-chromium",
      testMatch: "**/preview-renderer.e2e.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "preview-webgpu",
      testMatch: [
        "**/preview-renderer.e2e.ts",
        "**/preview-renderer.webgpu.ts",
        ...(gestureBenchmarkEnabled ? ["**/studio-gesture-performance.e2e.ts"] : []),
      ],
      use: {
        browserName: "chromium",
        channel: "chromium",
        launchOptions: {
          args: [
            "--disable-vulkan-surface",
            "--enable-features=Vulkan",
            "--enable-unsafe-webgpu",
            "--use-angle=vulkan",
          ],
        },
      },
    },
  ],
  reporter: "line",
  testDir: "./e2e",
  use: {
    baseURL: `http://127.0.0.1:${previewHarnessPort}`,
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1440 },
  },
  webServer: {
    command: `pnpm dev:web --port ${previewHarnessPort}`,
    env: {
      POIETRA_AI_DEBUG_LOG: "off",
      POIETRA_STUDIO_DATA_ROOT: previewHarnessDataRoot,
      POIETRA_MANIM_PROJECTS: JSON.stringify([
        { id: "preview-harness", name: "Preview Harness", root: "./fixtures/preview-harness" },
        { id: "studio-lab", name: "Studio Lab", root: "." },
      ]),
      VITE_POIETRA_AI_ENDPOINT: "/api/ai/edit-suggestions",
    },
    stdout: "pipe",
    timeout: 120_000,
    wait: { stdout: new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${previewHarnessPort}/`) },
  },
  workers: 1,
});
