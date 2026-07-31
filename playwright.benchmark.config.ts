import { defineConfig } from "@playwright/test";

import { WEBGPU_CHROMIUM_CHANNEL, WEBGPU_CHROMIUM_LAUNCH_ARGS } from "./e2e/webgpu-launch";

/**
 * Dedicated benchmark lane: the production build served by an owned static
 * `vite preview` process on a unique, configurable port.
 *
 * This deliberately does NOT reuse the dev-server smoke lane: HMR transforms
 * and dev-client reload behavior would contaminate cold-start and
 * reproducibility evidence. `reuseExistingServer: false` plus `--strictPort`
 * means a conflicting port fails loudly instead of silently adopting (or
 * interfering with) a server this session does not own; Playwright terminates
 * only the preview process it spawned itself.
 */
const rawPort = process.env.POIETRA_BENCHMARK_PORT ?? "4175";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`POIETRA_BENCHMARK_PORT must be an integer port from 1024 through 65535, received ${rawPort}.`);
}

// The run-specific benchmark build directory is provided by the canonical
// runner (scripts/run-engine-webgpu-benchmark.mjs). Refusing to default to a
// shared dist/ prevents a direct Playwright invocation from silently
// measuring a stale or concurrently-replaced build.
const distDir = process.env.POIETRA_BENCHMARK_DIST;
if (!distDir) {
  throw new Error(
    "POIETRA_BENCHMARK_DIST is not set; run benchmarks through `pnpm benchmark:engine:webgpu`, which builds a run-specific benchmark bundle and its manifest.",
  );
}
const safeDistPath = process.platform === "win32" ? /^[a-z0-9._/\\:-]+$/i : /^[a-z0-9._/-]+$/i;
if (!safeDistPath.test(distDir)) {
  throw new Error(
    "POIETRA_BENCHMARK_DIST must not contain whitespace or shell metacharacters because Playwright starts its owned preview server through a command string.",
  );
}

export default defineConfig({
  forbidOnly: true,
  fullyParallel: false,
  grep: /records (retained Worker latency|the 1080p WebGPU stress matrix|the 1080p WebGPU stage telemetry matrix)/,
  outputDir: "test-results-benchmark",
  projects: [
    {
      name: WEBGPU_CHROMIUM_CHANNEL === "msedge" ? "edge-d3d12-webgpu-benchmark" : "chromium-webgpu-benchmark",
      testMatch: ["engine-canvas.webgpu.ts", "engine-stress.webgpu.ts", "engine-stage-telemetry.webgpu.ts"],
      use: {
        browserName: "chromium",
        channel: WEBGPU_CHROMIUM_CHANNEL,
        launchOptions: {
          args: [...WEBGPU_CHROMIUM_LAUNCH_ARGS],
        },
      },
    },
  ],
  reporter: "line",
  retries: 0,
  testDir: "./e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite preview --outDir ${distDir} --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 60_000,
    url: `http://127.0.0.1:${port}/benchmark.html`,
  },
  workers: 1,
});
