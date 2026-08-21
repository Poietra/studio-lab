import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { build } from "vite";

const execFile = promisify(execFileCallback);
const { Client } = pg;
const POSTGRES_IMAGE = "postgres@sha256:23e88eb049fd5d54894d70100df61d38a49ed97909263f79d4ff4c30a5d5fca2";
const runId = randomBytes(6).toString("hex");
const postgresContainer = `poietra-account-e2e-${runId}-postgres`;
const ownedProcesses = new Set();
let interruptedSignal = null;

function validateContainerName(value) {
  if (value !== postgresContainer) throw new Error("Refusing to operate on an unexpected account E2E container.");
  return value;
}

function throwIfInterrupted() {
  if (interruptedSignal) throw new Error(`Account E2E interrupted by ${interruptedSignal}.`);
}

function killOwnedProcess(child, signal) {
  try {
    if (process.platform === "win32" || child.pid === undefined) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function startOwnedProcess(command, args, options = {}) {
  throwIfInterrupted();
  const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "inherit", ...options });
  let settled = false;
  let settle;
  const exit = new Promise((resolveExit) => {
    settle = (result) => {
      if (settled) return;
      settled = true;
      ownedProcesses.delete(child);
      resolveExit(result);
    };
    child.once("error", (error) => {
      settle({ error, kind: "error" });
    });
    child.once("exit", (code, signal) => {
      let cleanupError;
      try {
        killOwnedProcess(child, "SIGTERM");
      } catch (error) {
        cleanupError = error;
      }
      settle({ cleanupError, code, command, kind: "exit", signal });
    });
  });
  ownedProcesses.add(child);
  return {
    child,
    exit,
    get settled() {
      return settled;
    },
  };
}

function processExitError(result) {
  if (result.kind === "error") return result.error;
  if (result.cleanupError) return result.cleanupError;
  return new Error(`${result.command} exited with ${result.signal ?? result.code ?? "unknown status"}.`);
}

async function run(command, args, options = {}) {
  const processHandle = startOwnedProcess(command, args, options);
  const result = await processHandle.exit;
  if (result.kind === "error" || result.cleanupError || result.code !== 0) throw processExitError(result);
}

async function stopOwnedProcess(processHandle) {
  if (processHandle.settled) return;
  killOwnedProcess(processHandle.child, "SIGTERM");
  const timeout = Symbol("timeout");
  let timeoutHandle;
  const result = await Promise.race([
    processHandle.exit,
    new Promise((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout(timeout), 5_000);
    }),
  ]);
  clearTimeout(timeoutHandle);
  if (result === timeout) {
    killOwnedProcess(processHandle.child, "SIGKILL");
    await processHandle.exit;
  }
}

function previewResponds(url, expectedRunId) {
  return new Promise((resolveResponse) => {
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      resolveResponse(ready);
    };
    const request = httpsGet(url, { rejectUnauthorized: false, timeout: 1_000 }, (response) => {
      response.resume();
      finish(
        response.statusCode !== undefined &&
          response.statusCode < 500 &&
          response.headers["x-poietra-account-e2e-run"] === expectedRunId,
      );
    });
    request.once("error", () => finish(false));
    request.once("timeout", () => request.destroy());
  });
}

async function waitForPreview(url, processHandle, expectedRunId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    throwIfInterrupted();
    if (processHandle.settled) throw processExitError(await processHandle.exit);
    if (await previewResponds(url, expectedRunId)) {
      if (processHandle.settled) throw processExitError(await processHandle.exit);
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Account E2E preview did not become ready.");
}

async function availablePreviewPort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Account E2E could not reserve a preview port.");
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

async function docker(...args) {
  return execFile("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

async function publishedPort() {
  const { stdout } = await docker("port", validateContainerName(postgresContainer), "5432/tcp");
  const match = stdout.trim().match(/:(\d+)$/u);
  if (!match) throw new Error("Docker did not publish the account E2E PostgreSQL port.");
  return Number(match[1]);
}

async function assertEphemeralPostgresStorage() {
  const { stdout } = await docker("inspect", validateContainerName(postgresContainer), "--format", "{{json .Mounts}}");
  const mounts = JSON.parse(stdout);
  if (
    !Array.isArray(mounts) ||
    mounts.some((mount) => mount?.Type === "volume") ||
    !mounts.some((mount) => mount?.Type === "tmpfs" && mount?.Destination === "/var/lib/postgresql/data")
  ) {
    throw new Error("Account E2E PostgreSQL must use only ephemeral data storage.");
  }
}

async function waitForPostgres(databaseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    throwIfInterrupted();
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Account E2E PostgreSQL did not become ready.", { cause: lastError });
}

async function cleanupDocker() {
  const { stdout } = await docker("ps", "--all", "--quiet", "--filter", `label=poietra.account-e2e.run=${runId}`);
  const containerIds = stdout.trim().split(/\s+/u).filter(Boolean);
  for (const containerId of containerIds) await docker("rm", "--force", containerId);
  const remaining = await docker("ps", "--all", "--quiet", "--filter", `label=poietra.account-e2e.run=${runId}`);
  if (remaining.stdout.trim()) throw new Error("Account E2E left its PostgreSQL container behind.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    for (const child of ownedProcesses) killOwnedProcess(child, signal);
  });
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "poietra-account-e2e-"));
const certificatePath = join(temporaryDirectory, "certificate.pem");
const keyPath = join(temporaryDirectory, "key.pem");
const postgresPassword = randomBytes(24).toString("hex");
let failure = null;
let previewProcess = null;

try {
  await docker(
    "run",
    "--detach",
    "--name",
    validateContainerName(postgresContainer),
    "--label",
    `poietra.account-e2e.run=${runId}`,
    "--publish",
    "127.0.0.1::5432",
    "--mount",
    "type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912",
    "--env",
    "POSTGRES_DB=poietra",
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env",
    "POSTGRES_USER=poietra",
    POSTGRES_IMAGE,
  );
  await assertEphemeralPostgresStorage();
  const postgresPort = await publishedPort();
  const databaseUrl = `postgresql://poietra:${postgresPassword}@127.0.0.1:${postgresPort}/poietra`;
  await waitForPostgres(databaseUrl);
  const previewPort = await availablePreviewPort();

  const environment = {
    ...process.env,
    POIETRA_ACCOUNT_E2E_CERT: certificatePath,
    POIETRA_ACCOUNT_E2E_DATABASE_URL: databaseUrl,
    POIETRA_ACCOUNT_E2E_KEY: keyPath,
    POIETRA_ACCOUNT_E2E_PORT: String(previewPort),
    POIETRA_ACCOUNT_E2E_RUN_ID: runId,
    POIETRA_AI_DEBUG_LOG: "off",
  };
  Object.assign(process.env, environment);

  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { env: environment, stdio: "ignore" },
  );
  await build({ configFile: resolve("e2e/account-production-vite.config.ts"), configLoader: "runner" });
  throwIfInterrupted();
  const previewUrl = `https://127.0.0.1:${previewPort}`;
  previewProcess = startOwnedProcess(
    "pnpm",
    ["exec", "vite", "preview", "--config", "e2e/account-production-vite.config.ts", "--configLoader", "runner"],
    { env: environment },
  );
  await waitForPreview(previewUrl, previewProcess, runId);
  const playwrightArguments = ["exec", "playwright", "test", "--config", "playwright.account.config.ts"];
  if (process.env.POIETRA_ACCOUNT_E2E_GREP) {
    playwrightArguments.push("--grep", process.env.POIETRA_ACCOUNT_E2E_GREP);
  }
  if (process.env.POIETRA_ACCOUNT_E2E_MAX_FAILURES) {
    playwrightArguments.push("--max-failures", process.env.POIETRA_ACCOUNT_E2E_MAX_FAILURES);
  }
  await run("pnpm", playwrightArguments, {
    env: environment,
  });
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  if (previewProcess) await stopOwnedProcess(previewProcess).catch((error) => cleanupErrors.push(error));
  await cleanupDocker().catch((error) => cleanupErrors.push(error));
  await rm(temporaryDirectory, { force: true, recursive: true }).catch((error) => cleanupErrors.push(error));
  if (cleanupErrors.length > 0) {
    failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "Account E2E cleanup failed.");
  }
}

if (interruptedSignal) {
  if (failure instanceof AggregateError) throw failure;
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
} else if (failure) {
  throw failure;
}
