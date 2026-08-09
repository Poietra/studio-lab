import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

import { assertStorageE2eNotInterrupted, BoundedUtf8OutputTail } from "./storage-e2e-runner-support.mjs";

const execFile = promisify(execFileCallback);
const { Client } = pg;
const POSTGRES_IMAGE = "postgres@sha256:23e88eb049fd5d54894d70100df61d38a49ed97909263f79d4ff4c30a5d5fca2";
const MINIO_IMAGE = "minio/minio@sha256:6f23072e3e222e64fe6f86b31a7f7aca971e5129e55cbccef649b109b8e651a1";
const STORAGE_SUITE_CONCURRENCY = 2;
const TEST_OUTPUT_TAIL_BYTES = 256 * 1024;
const runId = randomBytes(6).toString("hex");
const postgresContainer = `poietra-storage-e2e-${runId}-postgres`;
const minioContainer = `poietra-storage-e2e-${runId}-minio`;
const createdContainers = [];
const testProcesses = new Set();
let interruptedSignal = null;

function throwIfInterrupted() {
  assertStorageE2eNotInterrupted(interruptedSignal);
}

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
    throwIfInterrupted();
    try {
      if (await operation()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready.`, { cause: lastError });
}

const STORAGE_SUITES = [
  {
    database: "poietra_account_organization",
    file: "server/storage/account-organization-storage.real.test.ts",
    id: "account-organization",
    objectStorage: false,
    titles: [
      "resolves only active membership boundaries and preserves the last active owner",
      "onboards invited members atomically through fake OIDC and real PostgreSQL",
    ],
  },
  {
    database: "poietra_billing_entitlement",
    file: "server/storage/billing-entitlement-storage.real.test.ts",
    id: "billing-entitlement",
    objectStorage: false,
    titles: [
      "atomically reserves one render quota, replays safely, preserves period usage, and isolates tenants",
      "reconciles Stripe state into render admission atomically and replays duplicate delivery",
    ],
  },
  {
    database: "poietra_runtime_cell_assignment",
    file: "server/storage/runtime-cell-assignment-storage.real.test.ts",
    id: "runtime-cell-assignment",
    objectStorage: false,
    title: "routes two Organizations through replay-safe durable assignments and drains rotated cells",
  },
  {
    database: "poietra_editor_document",
    file: "server/storage/editor-document-storage.real.test.ts",
    id: "editor-document",
    objectStorage: false,
    title: "serializes edits, replays mutations, rotates source epochs, and isolates tenants",
  },
  {
    database: "poietra_immutable_object_generation",
    file: "server/storage/immutable-object-generation-storage.real.test.ts",
    id: "immutable-object-generation",
    objectStorage: false,
    title: "keeps legacy locators explicit and constrains every new generation key",
  },
  {
    database: "poietra_immutable_source_png",
    file: "server/storage/immutable-source-png-postgres.real.test.ts",
    id: "immutable-source-png",
    objectStorage: false,
    title: "persists exact generations through source heads, PNG heads, render pins, and deletion claims",
  },
  {
    database: "poietra_immutable_s3_transport",
    file: "server/storage/s3/s3-private-immutable-bucket-transport.real.test.ts",
    id: "immutable-s3-transport",
    title: "publishes, pins, ranges, lists, and deletes without bucket versioning",
  },
  {
    database: "poietra_workspace_source",
    file: "server/storage/workspace-source-storage.real.test.ts",
    id: "workspace-source",
    title: "survives SIGKILL, resolves cross-process CAS exactly once, isolates tenants, and collects orphans",
  },
  {
    database: "poietra_render_session",
    file: "server/storage/render-session-storage.real.test.ts",
    id: "render-session",
    titles: [
      "survives SIGKILL and fences recovery, source actions, CAS, and tenant routing",
      "binds one broker shard and cancels only after its durable ACK",
    ],
  },
  {
    database: "poietra_snapshot_publication",
    file: "server/storage/snapshot-publication-storage.real.test.ts",
    id: "snapshot-publication",
    title: "publishes across processes, isolates tenants, rejects stale source CAS, and deletes an upload orphan",
  },
  {
    database: "poietra_render_artifact",
    file: "server/storage/render-artifact-storage.real.test.ts",
    id: "render-artifact",
    titles: [
      "upgrades a nonempty media deletion queue and retains its acknowledgement",
      "survives SIGKILL, atomically publishes versioned media, fences races, expires reads, and collects orphans",
      "publishes, reads, and deletes an immutable media generation",
      "serves an authenticated production export, render, and downloadable MP4 lifecycle",
    ],
  },
  {
    database: "poietra_project_png",
    file: "server/storage/project-png-storage.real.test.ts",
    id: "project-png",
    title: "replaces atomically across ABA reuse, pins render generations, isolates tenants, and collects orphans",
  },
];

function postgresIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Refusing to create an invalid E2E database name.");
  return `"${value}"`;
}

async function createSuiteDatabases(adminUrl) {
  throwIfInterrupted();
  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    throwIfInterrupted();
    for (const suite of STORAGE_SUITES) {
      await client.query(`CREATE DATABASE ${postgresIdentifier(suite.database)}`);
      throwIfInterrupted();
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  throwIfInterrupted();
}

function suiteEnvironment(commonEnvironment, postgresAdminUrl, suite) {
  const databaseUrl = new URL(postgresAdminUrl);
  databaseUrl.pathname = `/${suite.database}`;
  const postgresEnvironment = { POIETRA_STORAGE_E2E_DATABASE_URL: databaseUrl.href };
  if (suite.objectStorage === false) return postgresEnvironment;
  return {
    ...commonEnvironment,
    ...postgresEnvironment,
    POIETRA_STORAGE_E2E_S3_BUCKET: `poietra-storage-e2e-${runId}-${suite.id}`,
  };
}

function writeFailureOutput(stdout, stderr) {
  if (stdout.length > 0) process.stderr.write(`${stdout}\n`);
  if (stderr.length > 0) process.stderr.write(`${stderr}\n`);
}

async function runTestFile(environment, suite) {
  throwIfInterrupted();
  return new Promise((resolve, reject) => {
    process.stdout.write(`[storage-e2e] starting ${suite.file}\n`);
    const requiredTitles = suite.titles ?? [suite.title];
    const titlePattern = requiredTitles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const child = spawn("pnpm", ["exec", "vitest", "run", suite.file, "-t", titlePattern, "--reporter=json"], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    testProcesses.add(child);
    const stdout = new BoundedUtf8OutputTail(TEST_OUTPUT_TAIL_BYTES);
    const stderr = new BoundedUtf8OutputTail(TEST_OUTPUT_TAIL_BYTES);
    let spawnError = null;
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      testProcesses.delete(child);
      const stdoutText = stdout.text();
      const stderrText = stderr.text();
      if (spawnError) {
        reject(new Error(`Storage E2E could not start: ${suite.file}.`, { cause: spawnError }));
        return;
      }
      if (code !== 0) {
        writeFailureOutput(stdoutText, stderrText);
        reject(new Error(`Storage E2E failed with ${code ?? signal}: ${suite.file}.`));
        return;
      }
      if (stdout.truncated) {
        writeFailureOutput(stdoutText, stderrText);
        reject(new Error(`Storage E2E exceeded its bounded JSON report: ${suite.file}.`));
        return;
      }
      let report;
      try {
        report = JSON.parse(stdoutText);
      } catch (error) {
        writeFailureOutput(stdoutText, stderrText);
        reject(new Error(`Storage E2E returned an invalid Vitest report: ${suite.file}.`, { cause: error }));
        return;
      }
      const assertions = Array.isArray(report.testResults)
        ? report.testResults.flatMap((result) =>
            Array.isArray(result?.assertionResults) ? result.assertionResults : [],
          )
        : [];
      const requiredTestsPassed = requiredTitles.every((title) =>
        assertions.some((assertion) => assertion?.title === title && assertion?.status === "passed"),
      );
      if (
        report.success !== true ||
        report.numPassedTests !== requiredTitles.length ||
        report.numFailedTests !== 0 ||
        !requiredTestsPassed
      ) {
        writeFailureOutput(stdoutText, stderrText);
        reject(new Error(`Storage E2E must execute its required parent test: ${suite.file}.`));
        return;
      }
      process.stdout.write(`[storage-e2e] passed ${suite.file}\n`);
      resolve();
    });
  });
}

async function runTests(environment) {
  throwIfInterrupted();
  const pending = [...STORAGE_SUITES];
  const failures = [];
  const workers = Array.from({ length: Math.min(STORAGE_SUITE_CONCURRENCY, pending.length) }, async () => {
    while (pending.length > 0) {
      throwIfInterrupted();
      const suite = pending.shift();
      try {
        await runTestFile(suiteEnvironment(environment.common, environment.postgresAdminUrl, suite), suite);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  const workerResults = await Promise.allSettled(workers);
  failures.push(...workerResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} durable storage E2E suite(s) failed.`);
  }
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
    for (const child of testProcesses) child.kill(signal);
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
  const postgresAdminUrl = `postgresql://poietra:${postgresPassword}@127.0.0.1:${postgresPort}/postgres`;
  await retry("PostgreSQL", async () => {
    const client = new Client({ connectionString: postgresAdminUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
  await retry("MinIO", async () => (await fetch(`http://127.0.0.1:${minioPort}/minio/health/ready`)).ok);
  await createSuiteDatabases(postgresAdminUrl);
  throwIfInterrupted();

  await runTests({
    common: {
      POIETRA_STORAGE_E2E_S3_ACCESS_KEY: minioAccessKey,
      POIETRA_STORAGE_E2E_S3_ENDPOINT: `http://127.0.0.1:${minioPort}`,
      POIETRA_STORAGE_E2E_S3_SECRET_KEY: minioSecretKey,
    },
    postgresAdminUrl,
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

if (interruptedSignal) process.kill(process.pid, interruptedSignal);
if (failure) throw failure;
