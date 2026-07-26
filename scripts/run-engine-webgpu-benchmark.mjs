import { execFileSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

execFileSync(pnpm, ["build:engine:wasm"], { env: process.env, stdio: "inherit" });

execFileSync(
  pnpm,
  [
    "exec",
    "playwright",
    "test",
    "e2e/engine-canvas.webgpu.ts",
    "e2e/engine-stress.webgpu.ts",
    "--project=chromium-webgpu",
    "--grep",
    "records (retained Worker latency|the 1080p WebGPU stress matrix)",
  ],
  {
    env: { ...process.env, POIETRA_ENGINE_BENCHMARK: "1" },
    stdio: "inherit",
  },
);
