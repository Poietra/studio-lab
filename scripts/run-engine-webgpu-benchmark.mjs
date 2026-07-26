import { execFileSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

execFileSync(
  pnpm,
  [
    "exec",
    "playwright",
    "test",
    "e2e/engine-canvas.webgpu.ts",
    "--project=chromium-webgpu",
    "--grep",
    "records retained Worker latency",
  ],
  {
    env: { ...process.env, POIETRA_ENGINE_BENCHMARK: "1" },
    stdio: "inherit",
  },
);
