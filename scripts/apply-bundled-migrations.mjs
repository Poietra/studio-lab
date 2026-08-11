import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool } from "pg";
import { createServer } from "vite";

export const BUNDLED_MIGRATION_APPLY_SCHEMA_V1 = "poietra.bundled-migration-apply";
export const BUNDLED_MIGRATION_APPLY_VERSION_V1 = 1;

const POSTGRES_TIMEOUT_MS = 30_000;

function fail(message) {
  throw new Error(message);
}

/**
 * Every Worker and runtime-server runbook requires the bundled durable-storage
 * catalog to be applied before deployment, so this is the one supported way to
 * do it. It takes no target by default: the catalog head is the only state a
 * deployment may serve from. `--through` exists for the staged case where a
 * migration must land before the code that reads it, and it refuses any version
 * the bundle does not carry.
 */
export function parseBundledMigrationApplyArgumentsV1(arguments_) {
  if (!Array.isArray(arguments_)) fail("Bundled migration apply arguments must be an array.");
  const filtered = arguments_.filter((argument) => argument !== "--");
  const usage = "Usage: pnpm storage:migrate [-- --through <version>] [--dry-run]";
  const dryRun = filtered.includes("--dry-run");
  const positional = filtered.filter((argument) => argument !== "--dry-run");
  if (positional.length === 0) return Object.freeze({ dryRun, through: null });
  if (positional.length !== 2 || positional[0] !== "--through") fail(usage);
  if (!/^[1-9][0-9]{0,3}$/u.test(positional[1] ?? "")) fail("--through must be a bundled catalog version.");
  return Object.freeze({ dryRun, through: Number(positional[1]) });
}

/**
 * Reports what the catalog carries and what the database reached, without ever
 * reading a connection string into the report. A dry run is a preflight: it
 * resolves the target and reports the recorded versions, and applies nothing.
 */
export async function applyBundledMigrationsV1(options, dependencies) {
  const { dryRun, through } = options;
  const bundled = dependencies.bundledVersions();
  if (!Array.isArray(bundled) || bundled.length === 0) fail("No durable storage migrations are bundled.");
  const head = dependencies.migrationHead();
  if (!Number.isSafeInteger(head) || head !== bundled.at(-1)) {
    fail("The bundled durable-storage catalog head does not match its version list.");
  }
  const target = through ?? head;
  if (!bundled.includes(target)) fail(`Durable storage migration v${target} is not bundled.`);

  const before = await dependencies.recordedVersions();
  if (!Array.isArray(before)) fail("PostgreSQL returned an invalid recorded migration inventory.");
  const drift = before.filter((version) => !bundled.includes(version));
  if (drift.length > 0) {
    fail(`PostgreSQL records durable storage migrations this bundle does not carry: v${drift.join(", v")}.`);
  }

  if (dryRun) {
    return Object.freeze({
      applied: false,
      atHead: before.includes(head),
      dryRun: true,
      head,
      pending: bundled.filter((version) => version <= target && !before.includes(version)),
      recorded: before,
      schema: BUNDLED_MIGRATION_APPLY_SCHEMA_V1,
      target,
      version: BUNDLED_MIGRATION_APPLY_VERSION_V1,
    });
  }

  const result = await dependencies.applyThrough(target);
  if (result?.version !== target) fail(`PostgreSQL did not reach the exact durable-storage migration v${target}.`);
  const after = await dependencies.recordedVersions();
  const missing = bundled.filter((version) => version <= target && !after.includes(version));
  if (missing.length > 0) {
    fail(`PostgreSQL is missing durable storage migrations after apply: v${missing.join(", v")}.`);
  }
  return Object.freeze({
    applied: result.applied === true,
    atHead: target === head,
    dryRun: false,
    head,
    pending: [],
    recorded: after,
    schema: BUNDLED_MIGRATION_APPLY_SCHEMA_V1,
    target,
    version: BUNDLED_MIGRATION_APPLY_VERSION_V1,
  });
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  // An embedded NUL truncates the value inside the PostgreSQL startup packet
  // rather than being rejected, so it must fail closed here.
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${name} must be a non-empty explicit PostgreSQL setting.`);
  }
  return value;
}

function postgresEnvironment(environment) {
  const host = requiredEnvironmentValue(environment, "PGHOST");
  if (host !== host.trim() || host.startsWith("/")) fail("PGHOST must select a TCP PostgreSQL endpoint.");
  const portText = requiredEnvironmentValue(environment, "PGPORT");
  if (!/^[0-9]{1,5}$/u.test(portText)) fail("PGPORT must be a TCP port.");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("PGPORT must be a TCP port.");
  return Object.freeze({
    database: requiredEnvironmentValue(environment, "PGDATABASE"),
    host,
    password: requiredEnvironmentValue(environment, "PGPASSWORD"),
    port,
    user: requiredEnvironmentValue(environment, "PGUSER"),
  });
}

/**
 * Migration v1 creates the ledger this reads, so a database that has never been
 * migrated has no table to select from. Probe first and report an empty
 * inventory, exactly as `applyMigration` does when it bootstraps v1; anything
 * else would make the tool unusable on the fresh database it exists to set up.
 */
export async function readRecordedMigrationVersionsV1(pool) {
  const probe = await pool.query("SELECT to_regclass('public.poietra_schema_migrations')::text AS relation");
  if (probe.rows[0]?.relation === null || probe.rows[0]?.relation === undefined) return [];
  const result = await pool.query("SELECT version FROM public.poietra_schema_migrations ORDER BY version");
  return result.rows.map((row) => Number(row.version));
}

async function main() {
  const options = parseBundledMigrationApplyArgumentsV1(process.argv.slice(2));
  const database = postgresEnvironment(process.env);
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    root: repositoryRoot,
    server: { middlewareMode: true },
  });
  let pool;
  try {
    const [migrationModule, connectionModule] = await Promise.all([
      vite.ssrLoadModule("/server/storage/postgres/migrate.ts"),
      vite.ssrLoadModule("/server/storage/postgres/postgres-repository-connection.ts"),
    ]);
    pool = new Pool({
      ...database,
      connectionTimeoutMillis: POSTGRES_TIMEOUT_MS,
      idle_in_transaction_session_timeout: POSTGRES_TIMEOUT_MS,
      max: 1,
      options: connectionModule.POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: POSTGRES_TIMEOUT_MS,
      ssl: { rejectUnauthorized: true },
      statement_timeout: POSTGRES_TIMEOUT_MS,
    });
    const report = await applyBundledMigrationsV1(options, {
      applyThrough: (version) => migrationModule.applyBundledDurableStorageMigrationsThrough(pool, version),
      bundledVersions: () => migrationModule.BUNDLED_DURABLE_STORAGE_MIGRATION_VERSIONS_V1,
      migrationHead: () => migrationModule.BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1,
      recordedVersions: () => readRecordedMigrationVersionsV1(pool),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (pool) await pool.end();
    await vite.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
