import { pathToFileURL } from "node:url";

import type { PoolConfig } from "pg";
import { z } from "zod";

import { createAccountSessionIdentityAuthenticatorV1 } from "./accounts/account-session-authenticator";
import { createOrganizationMembershipProductionAdmissionV1 } from "./accounts/organization-membership-admission";
import {
  createDurablePostgresS3ProductionRuntimeCellProvisionerV1,
  createPostgresProductionManimRuntimeCellResolverV1,
  type DurablePostgresS3ProductionRuntimeCellProvisionerOptionsV1,
} from "./durable-manim-production-composition";
import { fastManimGatedOciSignedReleaseV1Schema } from "./fast-manim-gated-oci-release";
import { createStructuredLogger, type StructuredLogger } from "./logging/structured-logger";
import { type ProductionManimServer, startProductionManimServer } from "./manim-production-server";
import { readRootOwnedProductionConfigV1 } from "./root-owned-production-config";
import { PostgresAccountSessionRepositoryV1 } from "./storage/postgres/postgres-account-session-repository";
import { PostgresOrganizationMembershipRepositoryV1 } from "./storage/postgres/postgres-organization-membership-repository";

const identifierSchema = z.string().min(1).max(256);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "Paths must be absolute and NUL-free.");
const posixIdSchema = z.number().int().nonnegative().max(0xffff_ffff);
const releasePublicKeySchema = z
  .object({ keyId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u), publicKeyPem: z.string().min(1).max(16_384) })
  .strict();
const boundedMsSchema = z.number().int().positive().max(86_400_000);

const databaseEndpointSchema = z
  .object({
    database: identifierSchema,
    host: z
      .string()
      .min(1)
      .max(255)
      .refine((value) => !value.startsWith("/"), "The database host must be a TCP endpoint, not a socket path."),
    maxConnections: z.number().int().positive().max(256).default(8),
    migrationMaxConnections: z.number().int().positive().max(8).default(1),
    password: z.string().min(1).max(1_024),
    port: z.number().int().min(1).max(65_535),
    statementTimeoutMs: boundedMsSchema.default(30_000),
    user: identifierSchema,
  })
  .strict();

const sweepSchema = z
  .object({
    batchSize: z.number().int().positive().max(10_000).default(128),
    graceMs: boundedMsSchema.default(3_600_000),
    intervalMs: boundedMsSchema.default(300_000),
    sweepTimeoutMs: boundedMsSchema.default(30_000),
  })
  .strict();

const immutableProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      accountId: identifierSchema,
      credentials: z
        .object({
          accessKeyId: identifierSchema,
          secretAccessKey: z.string().min(1).max(1_024),
          sessionToken: z.string().min(1).max(4_096).optional(),
        })
        .strict(),
      jurisdiction: z.enum(["default", "eu", "fedramp"]).optional(),
      kind: z.literal("cloudflare-r2"),
    })
    .strict(),
  z
    .object({
      credentials: z.union([
        z.object({ source: z.literal("aws-default-chain") }).strict(),
        z
          .object({
            accessKeyId: identifierSchema,
            secretAccessKey: z.string().min(1).max(1_024),
            sessionToken: z.string().min(1).max(4_096).optional(),
            source: z.literal("static"),
          })
          .strict(),
      ]),
      kind: z.literal("aws-s3"),
      region: identifierSchema,
    })
    .strict(),
]);

/**
 * The complete deployment contract for one runtime server process. Everything
 * here is plain data an operator can review in a root-owned file: no
 * connection strings, no code, and no credential indirection beyond the
 * provider's own default chain.
 */
export const productionRuntimeConfigV1Schema = z
  .object({
    database: databaseEndpointSchema,
    namespace: identifierSchema,
    objectStorage: z
      .object({
        immutable: z.object({ bucket: identifierSchema, provider: immutableProviderSchema }).strict(),
        writeLane: z.enum(["immutable", "versioned"]),
      })
      .strict(),
    render: z
      .object({
        artifactExpirationMs: boundedMsSchema.default(86_400_000),
        artifactGc: sweepSchema.prefault({}),
        cancellation: z
          .object({
            batchSize: z.number().int().positive().max(10_000).default(128),
            deliveryLeaseMs: boundedMsSchema.default(60_000),
            intervalMs: boundedMsSchema.default(15_000),
            sweepTimeoutMs: boundedMsSchema.default(30_000),
          })
          .strict()
          .prefault({}),
        sandbox: z
          .object({
            brokerShardId: identifierSchema,
            brokerUserId: posixIdSchema,
            imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            socketGroupId: posixIdSchema,
            socketPath: absolutePathSchema,
          })
          .strict(),
        sessionRetention: z
          .object({
            auditRetentionMs: boundedMsSchema.default(2_592_000_000),
            batchSize: z.number().int().positive().max(10_000).default(128),
            inputRetentionMs: boundedMsSchema.default(604_800_000),
            intervalMs: boundedMsSchema.default(300_000),
            sweepTimeoutMs: boundedMsSchema.default(30_000),
          })
          .strict()
          .prefault({}),
        stagingRoot: absolutePathSchema,
        worker: z
          .object({
            executionTimeoutMs: boundedMsSchema.optional(),
            leaseDurationMs: boundedMsSchema.optional(),
            maxConcurrentJobs: z.number().int().positive().max(64).optional(),
            pollIntervalMs: boundedMsSchema.optional(),
            workerId: identifierSchema.optional(),
          })
          .strict()
          .prefault({}),
      })
      .strict(),
    server: z
      .object({
        host: z.string().min(1).max(64),
        port: z.number().int().min(1).max(65_535),
        publicOrigin: z.string().min(1).max(2_048),
        trustedProxyAddresses: z.array(z.string().min(1).max(64)).max(64).default([]),
      })
      .strict(),
    snapshot: z
      .object({
        artifactGc: sweepSchema.prefault({}),
        sandbox: z
          .object({
            brokerUserId: posixIdSchema,
            publicKeys: z.array(releasePublicKeySchema).min(1).max(32),
            signedRelease: fastManimGatedOciSignedReleaseV1Schema,
            socketGroupId: posixIdSchema,
            socketPath: absolutePathSchema,
          })
          .strict(),
        timeoutMs: boundedMsSchema.optional(),
      })
      .strict(),
    sourceGc: sweepSchema.prefault({}),
    projectPngGc: sweepSchema.prefault({}),
    runtimeCells: z
      .object({
        maxAssignments: z.number().int().positive().max(4_096).optional(),
        maxCells: z.number().int().positive().max(1_024).optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type ProductionRuntimeConfigV1 = z.infer<typeof productionRuntimeConfigV1Schema>;

/**
 * `assertProductionPoolConfig` refuses a connection string, a socket host, a
 * custom stream, and unverified TLS, so the entry never offers a way to express
 * them: the config carries endpoint fields and this is the only place that
 * turns them into a pool.
 */
function poolConfig(database: ProductionRuntimeConfigV1["database"], max: number): PoolConfig {
  return {
    database: database.database,
    host: database.host,
    max,
    password: database.password,
    port: database.port,
    ssl: { rejectUnauthorized: true },
    user: database.user,
  };
}

/**
 * Turns a validated config into the exact option objects the production server
 * and its runtime-cell provisioner consume. Kept free of I/O so a deployment
 * can be proven correct without a database, an object store, or a sandbox.
 */
export function resolveProductionRuntimeCompositionV1(config: ProductionRuntimeConfigV1, logger: StructuredLogger) {
  const onFailure = (component: string) => (error: unknown) => {
    logger.child({ component }).error("runtime.background_failure", error);
  };
  const runtimePoolConfig = poolConfig(config.database, config.database.maxConnections);
  const provisioner: DurablePostgresS3ProductionRuntimeCellProvisionerOptionsV1 = {
    database: {
      migrationPoolConfig: poolConfig(config.database, config.database.migrationMaxConnections),
      runtimePoolConfig,
      statementTimeoutMs: config.database.statementTimeoutMs,
    },
    namespace: config.namespace,
    objectStorage: {
      immutable: config.objectStorage.immutable,
      writeLane: config.objectStorage.writeLane,
    },
    projectPngGc: { ...config.projectPngGc, onFailure: onFailure("project-png-gc") },
    renderArtifacts: {
      artifactExpirationMs: config.render.artifactExpirationMs,
      gc: { ...config.render.artifactGc, onFailure: onFailure("render-artifact-gc") },
      stagingRoot: config.render.stagingRoot,
    },
    renderCancellation: { ...config.render.cancellation, onFailure: onFailure("render-cancellation") },
    renderSandbox: config.render.sandbox,
    renderSessionRetention: { ...config.render.sessionRetention, onFailure: onFailure("render-session-retention") },
    renderWorker: { ...config.render.worker, onFailure: onFailure("render-worker") },
    snapshot: {
      artifactGc: {
        ...config.snapshot.artifactGc,
        onFailure: onFailure("snapshot-artifact-gc"),
        onTombstoneCompactionMetrics: (metrics) => {
          logger.child({ component: "snapshot-artifact-gc" }).info("snapshot.tombstone_compacted", metrics);
        },
      },
      sandbox: config.snapshot.sandbox,
      ...(config.snapshot.timeoutMs === undefined ? {} : { timeoutMs: config.snapshot.timeoutMs }),
    },
    sourceGc: { ...config.sourceGc, onFailure: onFailure("source-gc") },
  };
  return Object.freeze({
    provisioner,
    runtimePoolConfig,
    server: {
      deployment: "production" as const,
      host: config.server.host,
      port: config.server.port,
      publicOrigin: config.server.publicOrigin,
      trustedProxyAddresses: config.server.trustedProxyAddresses,
    },
  });
}

type Closeable = Readonly<{ close: () => Promise<void> }>;

async function closeQuietly(resources: readonly (Closeable | undefined)[]) {
  const results = await Promise.allSettled(resources.map(async (resource) => resource?.close()));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

/**
 * Composition root for one runtime server process. It owns every dependency it
 * builds: a construction failure closes what already exists before rethrowing,
 * and SIGINT/SIGTERM drain the server before the repositories behind it.
 */
export async function startProductionRuntimeEntryV1(
  configPath: string,
  overrides?: Readonly<{ logger?: StructuredLogger }>,
): Promise<ProductionManimServer> {
  const config = await readRootOwnedProductionConfigV1(configPath, productionRuntimeConfigV1Schema);
  const logger =
    overrides?.logger ?? createStructuredLogger({ context: { component: "production-runtime" }, sinks: [] });
  const composition = resolveProductionRuntimeCompositionV1(config, logger);

  let accountSessions: PostgresAccountSessionRepositoryV1 | undefined;
  let memberships: PostgresOrganizationMembershipRepositoryV1 | undefined;
  let resolver: Awaited<ReturnType<typeof createPostgresProductionManimRuntimeCellResolverV1>> | undefined;
  let server: ProductionManimServer | undefined;
  try {
    accountSessions = new PostgresAccountSessionRepositoryV1({ poolConfig: composition.runtimePoolConfig });
    memberships = new PostgresOrganizationMembershipRepositoryV1({ poolConfig: composition.runtimePoolConfig });
    resolver = await createPostgresProductionManimRuntimeCellResolverV1({
      assignmentDatabase: {
        poolConfig: composition.runtimePoolConfig,
        statementTimeoutMs: config.database.statementTimeoutMs,
      },
      ...(config.runtimeCells.maxAssignments === undefined
        ? {}
        : { maxAssignments: config.runtimeCells.maxAssignments }),
      ...(config.runtimeCells.maxCells === undefined ? {} : { maxCells: config.runtimeCells.maxCells }),
      provisioner: createDurablePostgresS3ProductionRuntimeCellProvisionerV1(composition.provisioner),
    });
    server = await startProductionManimServer({
      admission: createOrganizationMembershipProductionAdmissionV1({
        identities: createAccountSessionIdentityAuthenticatorV1(accountSessions),
        memberships,
      }),
      config: composition.server,
      logger,
      runtimeResolver: resolver,
    });
  } catch (error) {
    const cleanup = await closeQuietly([server, resolver, memberships, accountSessions]);
    if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], "The production runtime failed to start.");
    throw error;
  }

  const started = server;
  const owned = [memberships, accountSessions];
  let shutdown: Promise<void> | undefined;
  const drain = () => {
    shutdown ??= (async () => {
      try {
        await started.close();
      } finally {
        const cleanup = await closeQuietly(owned);
        if (cleanup.length > 0) process.exitCode = 1;
      }
    })().catch(() => {
      process.exitCode = 1;
    });
    return shutdown;
  };
  process.once("SIGINT", drain);
  process.once("SIGTERM", drain);
  return started;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const [configPath, extra] = process.argv.slice(2);
  if (!configPath || extra) {
    console.error("Usage: poietra-production-runtime <absolute-config-path>");
    process.exitCode = 2;
  } else {
    void startProductionRuntimeEntryV1(configPath).catch(() => {
      // The config, its credentials, and the failing endpoint must never reach
      // a process log; the operator reads the structured log instead.
      console.error("The production runtime failed closed.");
      process.exitCode = 1;
    });
  }
}
