import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { writeBenchmarkBuildManifest } from "./benchmark-build-manifest.mjs";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// Canonical benchmark runner: a dedicated benchmark production build in a
// run-specific output directory (never the shared dist/ or the HMR dev
// server), stamped with a build manifest the harness verifies over HTTP
// before and after measurement. Concurrent builds cannot swap files under a
// running measurement because each run owns its directory.
execFileSync(pnpm, ["build:engine:wasm"], { env: process.env, stdio: "inherit" });

const runDir = process.env.POIETRA_BENCHMARK_DIST ?? join("dist-benchmark", `run-${Date.now()}-${process.pid}`);
execFileSync(pnpm, ["exec", "vite", "build", "--outDir", runDir], {
  env: { ...process.env, POIETRA_BENCHMARK_BUILD: "1" },
  stdio: "inherit",
});
writeBenchmarkBuildManifest(runDir);

execFileSync(pnpm, ["exec", "playwright", "test", "--config", "playwright.benchmark.config.ts"], {
  env: { ...process.env, POIETRA_BENCHMARK_DIST: runDir, POIETRA_ENGINE_BENCHMARK: "1" },
  stdio: "inherit",
});
