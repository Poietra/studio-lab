import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool } from "pg";
import { createServer } from "vite";

export const BUNDLED_MIGRATION_APPLY_SCHEMA_V1 = "poietra.bundled-migration-apply";
export const BUNDLED_MIGRATION_APPLY_VERSION_V1 = 1;

const POSTGRES_TIMEOUT_MS = 30_000;
const CHECKSUM = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

export function parseBundledMigrationApplyArgumentsV1(arguments_) {
  if (!Array.isArray(arguments_)) fail("Bundled migration apply arguments must be an array.");
  const filtered = arguments_.filter((argument) => argument !== "--");
  const dryRun = filtered.includes("--dry-run");
  const positional = filtered.filter((argument) => argument !== "--dry-run");
  if (positional.length === 0) return Object.freeze({ dryRun, through: null });
  if (positional.length !== 2 || positional[0] !== "--through") {
    fail("Usage: pnpm storage:migrate [-- --through <version>] [--dry-run]");
  }
  if (!/^[1-9][0-9]{0,3}$/u.test(positional[1] ?? "")) {
    fail("--through must be a bundled catalog version.");
  }
  return Object.freeze({ dryRun, through: Number(positional[1]) });
}

function normalizedInventory(value, label) {
  if (!Array.isArray(value)) fail(`${label} returned an invalid migration inventory.`);
  let previous = 0;
  return value.map((entry) => {
    const version = entry?.version;
    const checksum = entry?.checksum;
    if (!Number.isSafeInteger(version) || version <= previous || !CHECKSUM.test(checksum ?? "")) {
      fail(`${label} returned an invalid migration inventory.`);
    }
    previous = version;
    return Object.freeze({ checksum, version });
  });
}

function inspectInventory(catalog, inventory) {
  const byVersion = new Map(catalog.map((entry) => [entry.version, entry.checksum]));
  for (const [index, entry] of inventory.entries()) {
    const expected = byVersion.get(entry.version);
    if (expected === undefined) {
      fail(`PostgreSQL records durable storage migration v${entry.version}, which this bundle does not carry.`);
    }
    if (entry.checksum !== expected) {
      fail(`PostgreSQL durable storage migration v${entry.version} does not match this bundle's checksum.`);
    }
    if (catalog[index]?.version !== entry.version) {
      fail("PostgreSQL durable storage migrations are not a contiguous prefix of this bundle.");
    }
  }
  const recorded = new Set(inventory.map(({ version }) => version));
  return Object.freeze({
    databaseAtHead: catalog.every(({ version }) => recorded.has(version)),
    recorded,
  });
}

function report({ applied, catalog, dryRun, head, inspection, target }) {
  return Object.freeze({
    applied,
    databaseAtHead: inspection.databaseAtHead,
    dryRun,
    head,
    pending: catalog
      .filter(({ version }) => version <= target && !inspection.recorded.has(version))
      .map(({ version }) => version),
    recorded: [...inspection.recorded],
    schema: BUNDLED_MIGRATION_APPLY_SCHEMA_V1,
    target,
    targetIsHead: target === head,
    version: BUNDLED_MIGRATION_APPLY_VERSION_V1,
  });
}

/** Preflight or apply one exact target from the catalog carried by this artifact. */
export async function applyBundledMigrationsV1(options, dependencies) {
  const catalog = normalizedInventory(dependencies.bundledCatalog(), "The bundled durable-storage catalog");
  if (catalog.length === 0) fail("No durable storage migrations are bundled.");
  const head = dependencies.migrationHead();
  if (!Number.isSafeInteger(head) || head !== catalog.at(-1)?.version) {
    fail("The bundled durable-storage catalog head does not match its inventory.");
  }
  const target = options.through ?? head;
  if (!catalog.some(({ version }) => version === target)) {
    fail(`Durable storage migration v${target} is not bundled.`);
  }

  const before = normalizedInventory(await dependencies.recordedInventory(), "PostgreSQL");
  const beforeInspection = inspectInventory(catalog, before);
  if (options.dryRun) {
    return report({ applied: false, catalog, dryRun: true, head, inspection: beforeInspection, target });
  }

  const result = await dependencies.applyThrough(target);
  if (result?.version !== target) fail(`PostgreSQL did not reach the exact durable-storage migration v${target}.`);
  const after = normalizedInventory(await dependencies.recordedInventory(), "PostgreSQL");
  const afterInspection = inspectInventory(catalog, after);
  const missing = catalog.filter(({ version }) => version <= target && !afterInspection.recorded.has(version));
  if (missing.length > 0) {
    fail(
      `PostgreSQL is missing durable storage migrations after apply: ${missing.map(({ version }) => `v${version}`).join(", ")}.`,
    );
  }
  return report({
    applied: result.applied === true,
    catalog,
    dryRun: false,
    head,
    inspection: afterInspection,
    target,
  });
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
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

/** A fresh database has no migration ledger until migration v1 creates it. */
export async function readRecordedMigrationInventoryV1(pool) {
  const probe = await pool.query("SELECT to_regclass('public.poietra_schema_migrations')::text AS relation");
  if (probe.rows[0]?.relation === null || probe.rows[0]?.relation === undefined) return [];
  const result = await pool.query("SELECT version, checksum FROM public.poietra_schema_migrations ORDER BY version");
  return result.rows.map(({ checksum, version }) => ({ checksum, version: Number(version) }));
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
    const result = await applyBundledMigrationsV1(options, {
      applyThrough: (version) => migrationModule.applyBundledDurableStorageMigrationsThrough(pool, version),
      bundledCatalog: () => migrationModule.BUNDLED_DURABLE_STORAGE_MIGRATION_CATALOG_V1,
      migrationHead: () => migrationModule.BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1,
      recordedInventory: () => readRecordedMigrationInventoryV1(pool),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
