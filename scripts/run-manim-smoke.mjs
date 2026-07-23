import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const artifactRoot = resolve(process.env.POIETRA_MANIM_SMOKE_ARTIFACTS ?? "test-results/manim-smoke");
const defaultDockerImage = "manimcommunity/manim@sha256:f18f53f2e4eaf2ea41713437d34363fb3f5cc6008b03fd798676ac0359396c3b";
const outputNames = ["preview.mp4", "runner.json", "summary.json", "vitest.log"];
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
const runIdPattern = /^[A-Za-z0-9_.-]{1,64}$/;

await mkdir(artifactRoot, { recursive: true });
await Promise.all(outputNames.map((name) => rm(join(artifactRoot, name), { force: true })));
const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-manim-smoke-run-"));
const childTemporaryRoot = join(temporaryRoot, "tmp");
const dockerControlRoot = join(temporaryRoot, "docker");
await mkdir(childTemporaryRoot);
await mkdir(dockerControlRoot);

const log = createWriteStream(join(artifactRoot, "vitest.log"), { flags: "wx" });
const startedAt = new Date().toISOString();
const runId = runIdPattern.test(process.env.POIETRA_MANIM_SMOKE_RUN_ID ?? "")
  ? process.env.POIETRA_MANIM_SMOKE_RUN_ID
  : randomUUID();
const child = spawn(process.execPath, [
  resolve("node_modules/vitest/vitest.mjs"),
  "run",
  "server/manim-render-pipeline.real.test.ts",
  "server/manim-smoke-runner.real.test.ts",
  "--maxWorkers=1",
  "--no-file-parallelism",
  "--reporter=verbose",
], {
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    POIETRA_MANIM_DOCKER_IMAGE: process.env.POIETRA_MANIM_DOCKER_IMAGE ?? defaultDockerImage,
    POIETRA_MANIM_SMOKE_CONTROL_ROOT: dockerControlRoot,
    POIETRA_MANIM_SMOKE_ARTIFACTS: artifactRoot,
    POIETRA_MANIM_SMOKE_RUN_ID: runId,
    POIETRA_REAL_MANIM_SMOKE: "1",
    TMPDIR: childTemporaryRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    log.write(chunk);
    (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
}

function processTreeIsAlive() {
  if (!child.pid) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessTree(signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessTree(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsAlive() && Date.now() < deadline) {
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 50));
  }
  return !processTreeIsAlive();
}

async function stopProcessTree(signal) {
  signalProcessTree(signal);
  if (process.platform === "win32" && child.pid) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((resolveClose) => taskkill.once("close", resolveClose));
  }
  if (await waitForProcessTree(8_000)) return true;
  signalProcessTree("SIGKILL");
  return waitForProcessTree(3_000);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function dockerCommand(arguments_) {
  const command = spawn("docker", arguments_, { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  command.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64 * 1024);
  });
  return new Promise((resolveClose) => {
    const timeout = setTimeout(() => command.kill("SIGKILL"), 10_000);
    timeout.unref();
    command.once("error", () => undefined);
    command.once("close", (code) => {
      clearTimeout(timeout);
      resolveClose({ code: code ?? 1, stdout });
    });
  });
}

async function dockerControls() {
  const names = await readdir(dockerControlRoot).catch(() => []);
  const controls = [];
  for (const fileName of names.filter((name) => name.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(join(dockerControlRoot, fileName), "utf8"));
      if (
        typeof value.name === "string"
        && value.name.startsWith(`poietra-manim-${runId.slice(0, 48)}-`)
        && Number.isSafeInteger(value.pid)
        && value.pid > 0
      ) controls.push(value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return controls;
}

async function labeledContainerIds() {
  const listed = await dockerCommand([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=io.poietra.smoke-run=${runId.slice(0, 48)}`,
  ]);
  if (listed.code !== 0) return null;
  return listed.stdout.trim().split(/\s+/).filter(Boolean);
}

async function stopOwnedDocker() {
  const deadline = Date.now() + 8_000;
  let controls = await dockerControls();
  if (process.env.POIETRA_MANIM_COMMAND?.trim() && controls.length === 0) return true;
  const ownedControls = new Map(controls.map((control) => [control.name, control]));
  for (const control of controls) {
    try {
      process.kill(control.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  while (Date.now() < deadline) {
    controls = await dockerControls();
    for (const control of controls) ownedControls.set(control.name, control);
    const ids = await labeledContainerIds();
    if (ids === null) return false;
    await Promise.all([
      ...controls.map((control) => dockerCommand(["container", "rm", "--force", control.name])),
      ...ids.map((id) => dockerCommand(["container", "rm", "--force", id])),
    ]);
    if (
      [...ownedControls.values()].every((control) => !processIsAlive(control.pid))
      && (await labeledContainerIds())?.length === 0
    ) {
      return true;
    }
    await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 50));
  }
  for (const control of ownedControls.values()) {
    try {
      process.kill(process.platform === "win32" ? control.pid : -control.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  for (const id of await labeledContainerIds() ?? []) {
    await dockerCommand(["container", "rm", "--force", id]);
  }
  return (await labeledContainerIds())?.length === 0;
}

let requestedSignal = null;
let stopRequest = null;
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => {
    if (requestedSignal) return;
    requestedSignal = signal;
    stopRequest = stopProcessTree(signal);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

let spawnError = null;
child.once("error", (error) => {
  spawnError = error;
});
const closed = await new Promise((resolveClose) => {
  child.once("close", (exitCode, signal) => resolveClose({ exitCode, signal }));
});
let treeStopped = true;
if (stopRequest) treeStopped = await stopRequest;
else if (processTreeIsAlive()) treeStopped = await stopProcessTree("SIGTERM");
for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
const dockerStopped = await stopOwnedDocker();

await new Promise((resolveClose) => log.end(resolveClose));
let cleanupError = null;
try {
  await rm(temporaryRoot, { force: true, recursive: true });
} catch (error) {
  cleanupError = error;
}
let temporaryRootRemoved = false;
try {
  await access(temporaryRoot);
} catch (error) {
  if (error?.code === "ENOENT") temporaryRootRemoved = true;
  else cleanupError ??= error;
}

const error = spawnError ?? cleanupError ?? (!treeStopped
  ? new Error("The real Manim smoke process tree did not stop after cancellation.")
  : !dockerStopped
    ? new Error("The real Manim smoke Docker containers did not stop after cancellation.")
    : null);
const exitCode = requestedSignal
  ? signalExitCodes[requestedSignal]
  : error
    ? 1
    : closed.exitCode ?? 1;
await writeFile(join(artifactRoot, "runner.json"), `${JSON.stringify({
  cleanup: { temporaryRoot, temporaryRootRemoved },
  dockerStopped,
  error: error?.message ?? null,
  exitCode,
  finishedAt: new Date().toISOString(),
  requestedSignal,
  runId,
  signal: closed.signal,
  startedAt,
  treeStopped,
}, null, 2)}\n`, "utf8");

if (error) process.stderr.write(`${error.message}\n`);
if (closed.signal) process.stderr.write(`Real Manim smoke stopped by ${closed.signal}.\n`);
process.exitCode = exitCode;
