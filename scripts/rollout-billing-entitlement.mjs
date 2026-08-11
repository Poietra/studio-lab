import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool } from "pg";
import { createServer } from "vite";
import { z } from "zod";

export const BILLING_ENTITLEMENT_ROLLOUT_SCHEMA_V1 = "poietra.billing-entitlement-rollout";
export const BILLING_ENTITLEMENT_ROLLOUT_VERSION_V1 = 1;
/** The bundled migration that carries the render lifecycle this rollout writes through. */
export const BILLING_RENDER_LIFECYCLE_MIGRATION_VERSION_V1 = 19;

const MAX_SPEC_BYTES = 16 * 1024;
const POSTGRES_TIMEOUT_MS = 30_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(message) {
  throw new Error(message);
}

const canonicalInstantSchema = z
  .string()
  .regex(CANONICAL_INSTANT)
  .transform((value, context) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
      context.addIssue({ code: "custom", message: "Expected a canonical UTC instant." });
      return z.NEVER;
    }
    return parsed;
  });

const rolloutSpecSchema = z
  .object({
    accessUntil: canonicalInstantSchema,
    periodEnd: canonicalInstantSchema,
    periodStart: canonicalInstantSchema,
    planKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    renderJobLimit: z.number().int().min(1).max(1_000_000),
    snapshotId: z.string().regex(UUID_V4),
    tenantId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    usagePeriodKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.periodEnd <= spec.periodStart) {
      context.addIssue({ code: "custom", message: "The usage period is invalid.", path: ["periodEnd"] });
    }
    if (spec.accessUntil <= spec.periodStart || spec.accessUntil > spec.periodEnd) {
      context.addIssue({
        code: "custom",
        message: "The entitlement access deadline is invalid.",
        path: ["accessUntil"],
      });
    }
  });

export function parseBillingEntitlementRolloutSpecV1(value) {
  const spec = rolloutSpecSchema.parse(value);
  return Object.freeze({
    accessState: "active",
    accessUntil: spec.accessUntil,
    expectedGeneration: 0n,
    periodEnd: spec.periodEnd,
    periodStart: spec.periodStart,
    planKey: spec.planKey,
    renderEnabled: true,
    renderJobLimit: spec.renderJobLimit,
    snapshotId: spec.snapshotId,
    sourceGeneration: 1n,
    tenantId: spec.tenantId,
    usagePeriodKey: spec.usagePeriodKey,
  });
}

export function parseBillingEntitlementRolloutArgumentsV1(arguments_) {
  if (!Array.isArray(arguments_)) fail("Billing entitlement rollout arguments must be an array.");
  const filtered = arguments_.filter((argument) => argument !== "--");
  if (filtered.length !== 2 || filtered[0] !== "--spec" || typeof filtered[1] !== "string" || !filtered[1]) {
    fail("Usage: pnpm billing:entitlement:rollout -- --spec /absolute/path/tenant-entitlement.json");
  }
  return Object.freeze({ specPath: resolve(filtered[1]) });
}

function snapshotMatchesInput(snapshot, input) {
  return (
    snapshot.accessState === input.accessState &&
    snapshot.accessUntil.getTime() === input.accessUntil.getTime() &&
    snapshot.periodEnd.getTime() === input.periodEnd.getTime() &&
    snapshot.periodStart.getTime() === input.periodStart.getTime() &&
    snapshot.planKey === input.planKey &&
    snapshot.renderEnabled === input.renderEnabled &&
    snapshot.renderJobLimit === input.renderJobLimit &&
    snapshot.snapshotId === input.snapshotId &&
    snapshot.sourceGeneration === input.sourceGeneration &&
    snapshot.tenantId === input.tenantId &&
    snapshot.usagePeriodKey === input.usagePeriodKey
  );
}

function activeAt(input, now) {
  return input.periodStart <= now && now < input.periodEnd && now < input.accessUntil;
}

export async function rolloutBillingEntitlementV1(specValue, dependencies) {
  const input = parseBillingEntitlementRolloutSpecV1(specValue);
  // The applier always runs the catalog to its head, so this pins the head the
  // bundle actually carries. A literal version here would silently pin a stale
  // head and reject every rollout as soon as one migration is added.
  const migrationHead = dependencies.migrationHead();
  if (!Number.isSafeInteger(migrationHead) || migrationHead < BILLING_RENDER_LIFECYCLE_MIGRATION_VERSION_V1) {
    fail("The bundled durable-storage catalog no longer carries the billing render-lifecycle migration.");
  }
  const migration = await dependencies.migrate();
  if (migration?.version !== migrationHead) {
    fail(`PostgreSQL did not reach the exact bundled durable-storage catalog head v${migrationHead}.`);
  }
  if (!(await dependencies.ready())) fail("PostgreSQL is not ready at the exact billing-entitlement schema v14.");

  const databaseNow = await dependencies.databaseNow();
  if (!(databaseNow instanceof Date) || Number.isNaN(databaseNow.getTime())) {
    fail("PostgreSQL returned an invalid database clock.");
  }
  if (!activeAt(input, databaseNow)) fail("The generation-1 entitlement is not active at the database clock.");

  const applied = await dependencies.applySnapshot(input);
  let status;
  if (applied.kind === "applied") status = "seeded";
  else if (applied.kind === "conflict" && applied.appliedGeneration === 1n) status = "already-current";
  else fail("The tenant already has a different entitlement generation; generation-1 rollout cannot continue.");

  const head = await dependencies.readCurrentHead(input.tenantId);
  if (
    head === null ||
    head.appliedGeneration !== 1n ||
    head.organizationActive !== true ||
    head.activeNow !== true ||
    !snapshotMatchesInput(head.snapshot, input)
  ) {
    fail("The persisted generation-1 entitlement does not exactly match the rollout specification.");
  }

  return Object.freeze({
    generation: "1",
    promotionReady: true,
    schema: BILLING_ENTITLEMENT_ROLLOUT_SCHEMA_V1,
    snapshotId: input.snapshotId,
    status,
    tenantId: input.tenantId,
    version: BILLING_ENTITLEMENT_ROLLOUT_VERSION_V1,
  });
}

async function readBoundedSpec(specPath) {
  const file = await open(specPath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SPEC_BYTES) {
      fail("The billing entitlement rollout specification must be a non-empty regular file of at most 16 KiB.");
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_SPEC_BYTES) fail("The billing entitlement rollout specification is oversized.");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (cause) {
      throw new Error("The billing entitlement rollout specification is not valid UTF-8 JSON.", { cause });
    }
  } finally {
    await file.close();
  }
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

function generation(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("PostgreSQL returned an invalid applied entitlement generation.");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("PostgreSQL returned an invalid applied entitlement generation.");
  return parsed;
}

async function readCurrentHead(pool, parseEntitlementSnapshot, tenantId) {
  const result = await pool.query(
    `WITH database_clock AS (SELECT clock_timestamp() AS now)
     SELECT account.applied_generation::text AS applied_generation,
            organization.status = 'active' AS organization_active,
            snapshot.tenant_id, snapshot.snapshot_id::text AS snapshot_id,
            snapshot.source_generation::text AS source_generation,
            snapshot.plan_key, snapshot.access_state, snapshot.render_enabled,
            snapshot.render_job_limit, snapshot.usage_period_key,
            snapshot.period_start, snapshot.period_end, snapshot.access_until, snapshot.created_at,
            snapshot.period_start <= database_clock.now
              AND database_clock.now < snapshot.period_end
              AND database_clock.now < snapshot.access_until AS active_now
       FROM public.billing_accounts account
       JOIN public.organizations organization ON organization.tenant_id = account.tenant_id
       JOIN public.entitlement_snapshots snapshot
         ON snapshot.tenant_id = account.tenant_id
        AND snapshot.snapshot_id = account.current_snapshot_id
        AND snapshot.source_generation = account.applied_generation
       CROSS JOIN database_clock
      WHERE account.tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) return null;
  return Object.freeze({
    activeNow: row.active_now,
    appliedGeneration: generation(row.applied_generation),
    organizationActive: row.organization_active,
    snapshot: parseEntitlementSnapshot({
      accessState: row.access_state,
      accessUntil: row.access_until,
      createdAt: row.created_at,
      periodEnd: row.period_end,
      periodStart: row.period_start,
      planKey: row.plan_key,
      renderEnabled: row.render_enabled,
      renderJobLimit: row.render_job_limit,
      snapshotId: row.snapshot_id,
      sourceGeneration: generation(row.source_generation),
      tenantId: row.tenant_id,
      usagePeriodKey: row.usage_period_key,
    }),
  });
}

async function main() {
  const { specPath } = parseBillingEntitlementRolloutArgumentsV1(process.argv.slice(2));
  const spec = await readBoundedSpec(specPath);
  parseBillingEntitlementRolloutSpecV1(spec);
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
  let repository;
  try {
    const [migrationModule, repositoryModule, connectionModule, domainModule] = await Promise.all([
      vite.ssrLoadModule("/server/storage/postgres/migrate.ts"),
      vite.ssrLoadModule("/server/storage/postgres/postgres-entitlement-repository.ts"),
      vite.ssrLoadModule("/server/storage/postgres/postgres-repository-connection.ts"),
      vite.ssrLoadModule("/server/billing/entitlement-repository.ts"),
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
    repository = new repositoryModule.PostgresBillingEntitlementRepositoryV1({
      pool,
      statementTimeoutMs: POSTGRES_TIMEOUT_MS,
    });
    const report = await rolloutBillingEntitlementV1(spec, {
      applySnapshot: (input) => repository.applySnapshot(input),
      databaseNow: async () => {
        const result = await pool.query("SELECT clock_timestamp() AS now");
        return result.rows[0]?.now;
      },
      migrate: () => migrationModule.applyBundledDurableStorageMigrations(pool),
      migrationHead: () => migrationModule.BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1,
      readCurrentHead: (tenantId) => readCurrentHead(pool, domainModule.parseEntitlementSnapshotV1, tenantId),
      ready: () => repository.ready(),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (repository) await repository.close();
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
