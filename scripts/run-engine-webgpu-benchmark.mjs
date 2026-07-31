import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, posix, win32 } from "node:path";

import { writeBenchmarkBuildManifest } from "./benchmark-build-manifest.mjs";

const PNPM_JS_ENTRY_NAMES = new Set(["pnpm.cjs", "pnpm.js", "pnpm.mjs"]);
const PNPM_EXECUTABLE_NAME = "pnpm";
const PNPM_WINDOWS_EXECUTABLE_NAME = "pnpm.exe";

function resolvePnpmLifecycleEntry(environment = process.env, platform = process.platform) {
  const entry = environment.npm_execpath;
  const path = platform === "win32" ? win32 : posix;
  const basename = typeof entry === "string" ? path.basename(entry).toLowerCase() : "";
  if (typeof entry !== "string" || !path.isAbsolute(entry)) {
    throw new Error("A supported absolute pnpm lifecycle entry was not provided; run `pnpm benchmark:engine:webgpu`.");
  }
  if (PNPM_JS_ENTRY_NAMES.has(basename)) return { entry, kind: "javascript" };
  if (
    (platform === "win32" && basename === PNPM_WINDOWS_EXECUTABLE_NAME) ||
    (platform !== "win32" && basename === PNPM_EXECUTABLE_NAME)
  ) {
    return { entry, kind: "executable" };
  }
  throw new Error("The pnpm lifecycle entry must be pnpm JavaScript or a standalone pnpm executable.");
}

export function resolvePnpmJsEntry(environment = process.env, platform = process.platform) {
  const resolved = resolvePnpmLifecycleEntry(environment, platform);
  if (resolved.kind !== "javascript") throw new Error("The pnpm lifecycle entry is not a JavaScript entry.");
  return resolved.entry;
}

export function makePnpmInvocation(args, options = {}) {
  const environment = options.environment ?? process.env;
  const resolved = resolvePnpmLifecycleEntry(environment, options.platform ?? process.platform);
  if (resolved.kind === "executable") return { args: [...args], executable: resolved.entry };
  return {
    args: [resolved.entry, ...args],
    executable: options.nodeExecutable ?? process.execPath,
  };
}

function runPnpm(args, environment) {
  const invocation = makePnpmInvocation(args, { environment });
  execFileSync(invocation.executable, invocation.args, {
    env: environment,
    shell: false,
    stdio: "inherit",
  });
}

export function runEngineWebgpuBenchmark() {
  const benchmarkRunId = randomUUID();

  // Canonical benchmark runner: a dedicated benchmark production build in a
  // run-specific output directory (never the shared dist/ or the HMR dev
  // server), stamped with a build manifest the harness verifies over HTTP
  // before and after measurement. Concurrent builds cannot swap files under a
  // running measurement because each run owns its directory.
  runPnpm(["build:canvas:wasm"], process.env);

  const runDir = process.env.POIETRA_BENCHMARK_DIST ?? join("dist-benchmark", `run-${Date.now()}-${process.pid}`);
  runPnpm(["exec", "vite", "build", "--outDir", runDir], {
    ...process.env,
    POIETRA_BENCHMARK_BUILD: "1",
  });
  writeBenchmarkBuildManifest(runDir);

  runPnpm(["exec", "playwright", "test", "--config", "playwright.benchmark.config.ts"], {
    ...process.env,
    POIETRA_BENCHMARK_DIST: runDir,
    POIETRA_BENCHMARK_RUN_ID: benchmarkRunId,
    POIETRA_ENGINE_BENCHMARK: "1",
  });
}

if (import.meta.main) {
  runEngineWebgpuBenchmark();
}
