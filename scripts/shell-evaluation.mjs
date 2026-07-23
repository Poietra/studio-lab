#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const videoPath = join(repositoryRoot, "shell-evaluation", "fixture.mp4");

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function run(executable, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stderr, stdout });
      else rejectRun(new Error(`${executable} exited with ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

async function prepareVideo() {
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-t", "12", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
    "-movflags", "+faststart", "-y", videoPath,
  ]);
  process.stderr.write(`Generated ${videoPath}\n`);
}

async function findPython() {
  for (const executable of ["python3", "python"]) {
    try {
      const version = await run(executable, ["--version"]);
      return { executable, version: (version.stdout || version.stderr).trim() };
    } catch {
      // Try the next conventional executable name.
    }
  }
  return null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

function waitForReady(child, timeoutMs = 5_000) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("Python fixture did not report READY.")), timeoutMs);
    function finish(error, pid = null) {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady(pid);
    }
    function onData(chunk) {
      output += chunk.toString("utf8");
      const match = output.match(/READY(?:\s+(\d+))?/);
      if (match) finish(null, match[1] ? Number(match[1]) : null);
    }
    function onError(error) { finish(error); }
    function onExit(code, signal) {
      finish(new Error(`Python fixture exited before READY (${code ?? signal}).`));
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function stopFixture(child) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return "process-group-sigterm";
    } catch {
      // Fall through if this platform did not create a process group.
    }
  }
  child.kill("SIGTERM");
  return "direct-child-sigterm";
}

async function cleanupPids(pids) {
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // A concurrent exit is already clean.
    }
  }
}

async function measurePythonLifecycle(python) {
  const fixture = [
    "import subprocess, sys, time",
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])",
    "print(f'READY {child.pid}', flush=True)",
    "time.sleep(60)",
  ].join("\n");
  const startedAt = performance.now();
  const child = spawn(python.executable, ["-u", "-c", fixture], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let grandchildPid = null;
  try {
    grandchildPid = await waitForReady(child);
    const readyLatencyMs = performance.now() - startedAt;
    const stoppedAt = performance.now();
    const stopMethod = stopFixture(child);
    const clean = await waitUntil(
      () => !isAlive(child.pid) && !isAlive(grandchildPid),
      2_500,
    );
    const stopLatencyMs = performance.now() - stoppedAt;
    const restartStartedAt = performance.now();
    const restarted = spawn(python.executable, [
      "-u", "-c", "import time; print('READY', flush=True); time.sleep(0.05)",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForReady(restarted);
    const restartReadyLatencyMs = performance.now() - restartStartedAt;
    return {
      childAndGrandchildStopped: clean,
      pythonVersion: python.version,
      readyLatencyMs: rounded(readyLatencyMs),
      restartExit: await waitForExit(restarted),
      restartReadyLatencyMs: rounded(restartReadyLatencyMs),
      stopLatencyMs: rounded(stopLatencyMs),
      stopMethod,
    };
  } finally {
    await cleanupPids([child.pid, grandchildPid]);
  }
}

async function measureFileWatch(directory) {
  const sourcePath = join(directory, "Scene.py");
  await writeFile(sourcePath, "# fixture 0\n", "utf8");
  let generation = 0;
  const watcher = watch(directory, (_event, filename) => {
    if (filename?.toString() === "Scene.py") generation += 1;
  });
  const latencies = [];
  let observedWrites = 0;
  try {
    await delay(30);
    for (let index = 1; index <= 20; index += 1) {
      const previousGeneration = generation;
      const startedAt = performance.now();
      await writeFile(sourcePath, `# fixture ${index}\n`, "utf8");
      if (await waitUntil(() => generation > previousGeneration, 1_000)) {
        observedWrites += 1;
        latencies.push(performance.now() - startedAt);
      }
      await delay(10);
    }
  } finally {
    watcher.close();
  }
  return {
    attemptedWrites: 20,
    observedWrites,
    p50LatencyMs: rounded(percentile(latencies, 0.5) ?? 0),
    p95LatencyMs: rounded(percentile(latencies, 0.95) ?? 0),
  };
}

async function directoryBytes(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return 0;
    if (metadata.isFile()) return metadata.size;
    if (!metadata.isDirectory()) return 0;
    const children = await readdir(path);
    const sizes = await Promise.all(children.map((child) => directoryBytes(join(path, child))));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function runNativeWorkload() {
  const root = await mkdtemp(join(tmpdir(), "poietra-shell-native-"));
  const python = await findPython();
  const rssBeforeBytes = process.memoryUsage().rss;
  try {
    const result = {
      artifacts: {
        electronDownloadedRuntimeBytes: await directoryBytes(join(repositoryRoot, "node_modules/electron/dist")),
        sharedWebDistBytes: await directoryBytes(join(repositoryRoot, "dist")),
        tauriUnbundledBinaryBytes: await directoryBytes(join(
          repositoryRoot,
          `src-tauri/target/release/studio-lab${process.platform === "win32" ? ".exe" : ""}`,
        )),
      },
      completedAt: new Date().toISOString(),
      environment: {
        arch: process.arch,
        electronVersion: process.versions.electron ?? null,
        nodeVersion: process.version,
        platform: process.platform,
        release: process.release.name,
      },
      fileWatch: await measureFileWatch(root),
      memory: null,
      pythonLifecycle: python
        ? await measurePythonLifecycle(python)
        : { unavailable: "Neither python3 nor python was found on PATH." },
      schemaVersion: 1,
    };
    result.memory = {
      maxRssKilobytes: process.resourceUsage().maxRSS,
      rssAfterBytes: process.memoryUsage().rss,
      rssBeforeBytes,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/shell-evaluation.mjs prepare
  node scripts/shell-evaluation.mjs native

prepare  Generates the ignored deterministic MP4 used by the Vite-served renderer workload.
native   Measures the shared Node process/file-watch workload and artifact boundaries.
`);
}

async function main() {
  const [command = "help"] = process.argv.slice(2);
  if (command === "prepare") await prepareVideo();
  else if (command === "native") await runNativeWorkload();
  else if (["help", "--help", "-h"].includes(command)) printHelp();
  else throw new Error(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
