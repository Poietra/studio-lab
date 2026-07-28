import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { Pool, type PoolConfig } from "pg";

import { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import { type DurableManimRenderExecutorV1, DurableManimRenderWorkerV1 } from "./durable-manim-render-worker";
import { createDurableManimRuntimeV1, createDurableProductionManimRuntimeAdapterV1 } from "./durable-manim-runtime";
import {
  type FastManimProductionSnapshotRunnerFactoryOptionsV1,
  FastManimProductionSnapshotRunnerFactoryV1,
} from "./fast-manim-production-snapshot-runner-factory";
import { applyBundledDurableStorageMigrations } from "./storage/postgres/migrate";
import { PostgresRenderSessionRepositoryV1 } from "./storage/postgres/postgres-render-session-repository";
import { PostgresSnapshotPublicationRepositoryV1 } from "./storage/postgres/postgres-snapshot-publication-repository";
import {
  PostgresWorkspaceSourceRepositoryV1,
  WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
} from "./storage/postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./storage/s3/s3-content-blob-store";
import { S3SnapshotArtifactStoreV1 } from "./storage/s3/s3-snapshot-artifact-store";
import { createDurableSnapshotArtifactGcWorkerV1 } from "./storage/snapshot-artifact-gc";
import { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import { createDurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";

export type DurablePostgresS3ProductionRuntimeOptionsV1 = Readonly<{
  database: Readonly<{
    migrationPoolConfig: PoolConfig;
    migrationTimeoutMs?: number;
    runtimePoolConfig: PoolConfig;
    statementTimeoutMs?: number;
  }>;
  execution: DurableManimRenderExecutorV1;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  objectStorage: Readonly<{
    bucket: string;
    clientConfig: S3ClientConfig;
  }>;
  renderWorker: Readonly<{
    executionTimeoutMs?: number;
    leaseDurationMs?: number;
    maxConcurrentJobs?: number;
    onFailure: (error: unknown) => void;
    pollIntervalMs?: number;
    workerId?: string;
  }>;
  snapshot: Readonly<{
    artifactGc: Readonly<{
      batchSize: number;
      graceMs: number;
      intervalMs: number;
      onFailure: (error: unknown) => void;
      sweepTimeoutMs: number;
    }>;
    sandbox: FastManimProductionSnapshotRunnerFactoryOptionsV1["client"];
    timeoutMs?: number;
  }>;
  sourceGc: Readonly<{
    batchSize: number;
    graceMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
    sweepTimeoutMs: number;
  }>;
  tenantId: string;
}>;

function migrationTimeout(value: number | undefined) {
  const timeout = value ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 30_000) {
    throw new RangeError("Migration timeout must be between one and 30 seconds.");
  }
  return timeout;
}

function assertProductionPoolConfig(config: PoolConfig, label: string) {
  const ssl = config.ssl;
  if (
    config.connectionString !== undefined ||
    config.options !== undefined ||
    typeof config.host !== "string" ||
    config.host.length === 0 ||
    config.host.startsWith("/") ||
    config.stream !== undefined ||
    config.Client !== undefined ||
    typeof ssl !== "object" ||
    ssl === null ||
    ssl.rejectUnauthorized !== true ||
    ssl.checkServerIdentity !== undefined
  ) {
    throw new TypeError(
      `${label} PostgreSQL configuration requires an explicit TCP host and verified TLS without connection-string or custom-stream overrides.`,
    );
  }
}

async function migrate(options: DurablePostgresS3ProductionRuntimeOptionsV1["database"]) {
  const timeout = migrationTimeout(options.migrationTimeoutMs);
  const pool = new Pool({
    ...options.migrationPoolConfig,
    connectionTimeoutMillis: timeout,
    idle_in_transaction_session_timeout: timeout,
    lock_timeout: timeout,
    max: 1,
    options: WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
    query_timeout: timeout,
    statement_timeout: timeout,
  });
  try {
    await applyBundledDurableStorageMigrations(pool);
  } finally {
    await pool.end();
  }
}

type Closeable = Readonly<{ close: () => Promise<void> }>;

async function closeAll(resources: readonly (Closeable | undefined)[], message: string) {
  const unique = [...new Set(resources.filter((resource): resource is Closeable => resource !== undefined))];
  const results = await Promise.allSettled(unique.map((resource) => resource.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

async function cleanupAndThrow(
  error: unknown,
  resources: readonly (Closeable | undefined)[],
  message: string,
): Promise<never> {
  try {
    await closeAll(resources, message);
  } catch (cleanupError) {
    const cleanupErrors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
    throw new AggregateError([error, ...cleanupErrors], message);
  }
  throw error;
}

/** Build the shipped PostgreSQL + private S3 production runtime and both durable GC workers. */
export async function createDurablePostgresS3ProductionRuntimeV1(
  options: DurablePostgresS3ProductionRuntimeOptionsV1,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  assertProductionPoolConfig(options.database.migrationPoolConfig, "Migration");
  assertProductionPoolConfig(options.database.runtimePoolConfig, "Runtime");
  await migrate(options.database);
  signal?.throwIfAborted();

  let repository: PostgresWorkspaceSourceRepositoryV1 | undefined;
  let renderRepository: PostgresRenderSessionRepositoryV1 | undefined;
  let snapshotRepository: PostgresSnapshotPublicationRepositoryV1 | undefined;
  let blobs: S3ContentBlobStoreV1 | undefined;
  let artifacts: S3SnapshotArtifactStoreV1 | undefined;
  try {
    repository = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    renderRepository = new PostgresRenderSessionRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    snapshotRepository = new PostgresSnapshotPublicationRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    blobs = new S3ContentBlobStoreV1({
      bucket: options.objectStorage.bucket,
      clientConfig: options.objectStorage.clientConfig,
      deployment: "production",
    });
    artifacts = new S3SnapshotArtifactStoreV1({
      bucket: options.objectStorage.bucket,
      clientConfig: options.objectStorage.clientConfig,
      deployment: "production",
    });
  } catch (error) {
    return cleanupAndThrow(
      error,
      [options.execution, artifacts, blobs, snapshotRepository, renderRepository, repository],
      "Production storage composition and cleanup failed.",
    );
  }

  let renderWorker: DurableManimRenderWorkerV1 | undefined;
  let renders: DurableManimRenderServiceV1 | undefined;
  let snapshotFactory: FastManimProductionSnapshotRunnerFactoryV1 | undefined;
  let publisher: SnapshotArtifactPublisherV1 | undefined;
  let snapshots: DurableFastManimSnapshotServiceV1 | undefined;
  try {
    renderWorker = new DurableManimRenderWorkerV1({
      executor: options.execution,
      ...(options.renderWorker.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.renderWorker.leaseDurationMs }),
      ...(options.renderWorker.maxConcurrentJobs === undefined
        ? {}
        : { maxConcurrentJobs: options.renderWorker.maxConcurrentJobs }),
      onFailure: options.renderWorker.onFailure,
      ...(options.renderWorker.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.renderWorker.pollIntervalMs }),
      repository: renderRepository,
      tenantId: options.tenantId,
      ...(options.renderWorker.workerId === undefined ? {} : { workerId: options.renderWorker.workerId }),
    });
    renders = new DurableManimRenderServiceV1({
      blobs,
      ...(options.renderWorker.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: options.renderWorker.executionTimeoutMs }),
      execution: renderWorker,
      ...(options.frame ? { frame: options.frame } : {}),
      repository: renderRepository,
      sourceRepository: repository,
      tenantId: options.tenantId,
    });
    snapshotFactory = new FastManimProductionSnapshotRunnerFactoryV1({
      client: options.snapshot.sandbox,
      frame: options.frame ?? { height: 8, width: 14.222 },
      tenantId: options.tenantId,
      ...(options.snapshot.timeoutMs === undefined ? {} : { timeoutMs: options.snapshot.timeoutMs }),
    });
    publisher = new SnapshotArtifactPublisherV1({ artifacts, publications: snapshotRepository });
    snapshots = new DurableFastManimSnapshotServiceV1({
      blobs,
      factory: snapshotFactory,
      publisher,
      sourceRepository: repository,
      tenantId: options.tenantId,
    });
  } catch (error) {
    return cleanupAndThrow(
      error,
      [
        renderWorker ?? options.execution,
        renders ?? renderRepository,
        snapshots ?? publisher ?? artifacts,
        ...(snapshots ? [] : [snapshotFactory]),
        ...(publisher ? [] : [snapshotRepository]),
        blobs,
        repository,
      ],
      "Production runtime service composition and cleanup failed.",
    );
  }

  let runtime: Awaited<ReturnType<typeof createDurableManimRuntimeV1>> | undefined;
  try {
    runtime = await createDurableManimRuntimeV1(
      {
        blobs,
        execution: renderWorker,
        frame: options.frame,
        namespace: options.namespace,
        renders,
        repository,
        snapshots,
        tenantId: options.tenantId,
      },
      signal,
    );
    renderWorker.start();
  } catch (error) {
    return cleanupAndThrow(
      error,
      runtime ? [runtime] : [renderWorker, renders, snapshots, blobs, repository],
      "Production durable runtime construction and cleanup failed.",
    );
  }

  let sourceMaintenance: Awaited<ReturnType<typeof createDurableSourceBlobGcWorkerV1>> | undefined;
  let artifactMaintenance: Awaited<ReturnType<typeof createDurableSnapshotArtifactGcWorkerV1>> | undefined;
  try {
    const sourceGc = await createDurableSourceBlobGcWorkerV1(
      {
        ...options.sourceGc,
        blobs,
        repository,
        tenantId: options.tenantId,
      },
      signal,
    );
    sourceMaintenance = sourceGc;
    const artifactGc = await createDurableSnapshotArtifactGcWorkerV1(
      {
        ...options.snapshot.artifactGc,
        artifacts,
        repository: snapshotRepository,
        tenantId: options.tenantId,
      },
      signal,
    );
    artifactMaintenance = artifactGc;
    const maintenance = {
      close: () => closeAll([artifactGc, sourceGc], "Could not fully close durable storage maintenance."),
      ready: () => sourceGc.ready() && artifactGc.ready(),
    };
    return createDurableProductionManimRuntimeAdapterV1(runtime, maintenance);
  } catch (error) {
    return cleanupAndThrow(
      error,
      [artifactMaintenance, sourceMaintenance, runtime],
      "Production runtime maintenance composition and cleanup failed.",
    );
  }
}
