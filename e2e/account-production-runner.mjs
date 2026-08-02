import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
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
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function run(command, args, options = {}) {
  throwIfInterrupted();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "inherit", ...options });
    ownedProcesses.add(child);
    child.once("error", (error) => {
      ownedProcesses.delete(child);
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      ownedProcesses.delete(child);
      killOwnedProcess(child, "SIGTERM");
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${signal ?? code ?? "unknown status"}.`));
    });
  });
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

  const environment = {
    ...process.env,
    POIETRA_ACCOUNT_E2E_CERT: certificatePath,
    POIETRA_ACCOUNT_E2E_DATABASE_URL: databaseUrl,
    POIETRA_ACCOUNT_E2E_KEY: keyPath,
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
  await run("pnpm", ["exec", "playwright", "test", "--config", "playwright.account.config.ts"], {
    env: environment,
  });
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  await cleanupDocker().catch((error) => cleanupErrors.push(error));
  await rm(temporaryDirectory, { force: true, recursive: true }).catch((error) => cleanupErrors.push(error));
  if (cleanupErrors.length > 0) {
    failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "Account E2E cleanup failed.");
  }
}

if (interruptedSignal) process.kill(process.pid, interruptedSignal);
if (failure) throw failure;
