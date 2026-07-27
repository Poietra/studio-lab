import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const execFile = promisify(execFileCallback);
const { Client } = pg;
const POSTGRES_IMAGE = "postgres@sha256:23e88eb049fd5d54894d70100df61d38a49ed97909263f79d4ff4c30a5d5fca2";
const MINIO_IMAGE = "minio/minio@sha256:6f23072e3e222e64fe6f86b31a7f7aca971e5129e55cbccef649b109b8e651a1";
const runId = randomBytes(6).toString("hex");
const postgresContainer = `poietra-storage-e2e-${runId}-postgres`;
const minioContainer = `poietra-storage-e2e-${runId}-minio`;
const createdContainers = [];
let testProcess = null;
let interruptedSignal = null;

function validateContainerName(name) {
  if (!new RegExp(`^poietra-storage-e2e-${runId}-(?:postgres|minio)$`).test(name)) {
    throw new Error("Refusing to operate on an unexpected Docker container name.");
  }
  return name;
}

async function docker(...args) {
  return execFile("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

async function startContainer(name, args) {
  validateContainerName(name);
  await docker("run", "--detach", "--name", name, "--label", `poietra.storage-e2e.run=${runId}`, ...args);
  createdContainers.push(name);
}

async function publishedPort(name, internalPort) {
  const { stdout } = await docker("port", validateContainerName(name), `${internalPort}/tcp`);
  const match = stdout.trim().match(/:(\d+)$/);
  if (!match) throw new Error(`Docker did not publish ${name}:${internalPort}.`);
  return Number(match[1]);
}

async function retry(label, operation, attempts = 150) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}.`);
    try {
      if (await operation()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready.`, { cause: lastError });
}

async function runTests(environment) {
  return new Promise((resolve, reject) => {
    testProcess = spawn(
      "pnpm",
      ["exec", "vitest", "run", "server/storage/workspace-source-storage.real.test.ts", "--reporter=verbose"],
      { env: { ...process.env, ...environment }, stdio: "inherit" },
    );
    testProcess.once("error", reject);
    testProcess.once("exit", (code, signal) => {
      testProcess = null;
      if (code === 0) resolve();
      else reject(new Error(`Storage E2E failed with ${code ?? signal}.`));
    });
  });
}

async function cleanup() {
  const errors = [];
  for (const name of [...createdContainers].reverse()) {
    try {
      await docker("rm", "--force", validateContainerName(name));
    } catch (error) {
      errors.push(error);
    }
  }
  const { stdout } = await docker("ps", "--all", "--quiet", "--filter", `label=poietra.storage-e2e.run=${runId}`);
  if (stdout.trim()) errors.push(new Error("Storage E2E left labeled Docker containers behind."));
  if (errors.length > 0) throw new AggregateError(errors, "Storage E2E cleanup failed.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    testProcess?.kill(signal);
  });
}

const postgresPassword = randomBytes(24).toString("hex");
const minioAccessKey = `poietra${runId}`;
const minioSecretKey = randomBytes(24).toString("hex");
let failure = null;
try {
  await startContainer(postgresContainer, [
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_DB=poietra",
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env",
    "POSTGRES_USER=poietra",
    POSTGRES_IMAGE,
  ]);
  await startContainer(minioContainer, [
    "--publish",
    "127.0.0.1::9000",
    "--env",
    `MINIO_ROOT_USER=${minioAccessKey}`,
    "--env",
    `MINIO_ROOT_PASSWORD=${minioSecretKey}`,
    MINIO_IMAGE,
    "server",
    "/data",
    "--address",
    ":9000",
  ]);

  const postgresPort = await publishedPort(postgresContainer, 5432);
  const minioPort = await publishedPort(minioContainer, 9000);
  const databaseUrl = `postgresql://poietra:${postgresPassword}@127.0.0.1:${postgresPort}/poietra`;
  await retry("PostgreSQL", async () => {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
  await retry("MinIO", async () => (await fetch(`http://127.0.0.1:${minioPort}/minio/health/ready`)).ok);

  await runTests({
    POIETRA_STORAGE_E2E_DATABASE_URL: databaseUrl,
    POIETRA_STORAGE_E2E_S3_ACCESS_KEY: minioAccessKey,
    POIETRA_STORAGE_E2E_S3_BUCKET: `poietra-storage-e2e-${runId}`,
    POIETRA_STORAGE_E2E_S3_ENDPOINT: `http://127.0.0.1:${minioPort}`,
    POIETRA_STORAGE_E2E_S3_SECRET_KEY: minioSecretKey,
  });
} catch (error) {
  failure = error;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    failure = failure ? new AggregateError([failure, cleanupError], "Storage E2E and cleanup failed.") : cleanupError;
  }
}

if (failure) throw failure;
if (interruptedSignal) process.kill(process.pid, interruptedSignal);
