import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { Pool, type PoolConfig } from "pg";

import { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import {
  createDurableManimRenderCancellationRelayV1,
  DurableManimRenderCancellationCoordinatorV1,
  type DurableManimRenderCancellationRelayV1,
} from "./durable-manim-render-cancellation";
import { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import { DurableManimRenderWorkerV1 } from "./durable-manim-render-worker";
import { createDurableProductionManimRuntimeAdapterV1, DurableManimRuntimeV1 } from "./durable-manim-runtime";
import {
  type FastManimProductionSnapshotRunnerFactoryOptionsV1,
  FastManimProductionSnapshotRunnerFactoryV1,
} from "./fast-manim-production-snapshot-runner-factory";
import { ManimRenderCandidateVerifierV1 } from "./manim-render-candidate-verifier";
import type { ManimRenderProductionSandboxClientOptionsV1 } from "./manim-render-production-sandbox-client";
import { MANIM_RENDER_CANONICAL_SCENE_FRAME_V1 } from "./manim-render-sandbox-contract";
import {
  createProductionDurableManimRenderExecutorV1,
  type ProductionDurableManimRenderExecutorV1,
} from "./production-durable-manim-render-executor";
import type {
  ProductionManimRuntimeAdapterV1,
  ProductionManimRuntimeCellProvisionerV1,
  ProductionRuntimeCellAssignmentV1,
} from "./production-runtime-cell";
import { AuthorizedArtifactReaderV1 } from "./storage/authorized-artifact-reader";
import { applyBundledDurableStorageMigrations } from "./storage/postgres/migrate";
import { PostgresArtifactRepositoryV1 } from "./storage/postgres/postgres-artifact-repository";
import { PostgresEditorDocumentRepositoryV1 } from "./storage/postgres/postgres-editor-document-repository";
import { PostgresProjectPngRepositoryV1 } from "./storage/postgres/postgres-project-png-repository";
import { PostgresRenderSessionRepositoryV1 } from "./storage/postgres/postgres-render-session-repository";
import { PostgresSnapshotPublicationRepositoryV1 } from "./storage/postgres/postgres-snapshot-publication-repository";
import {
  PostgresWorkspaceSourceRepositoryV1,
  WORKSPACE_SOURCE_POSTGRES_OPTIONS_V1,
} from "./storage/postgres/postgres-workspace-source-repository";
import { createDurableProjectPngGcWorkerV1 } from "./storage/project-png-gc";
import { createDurableRenderArtifactGcWorkerV1 } from "./storage/render-artifact-gc";
import { createDurableRenderSessionRetentionWorkerV1 } from "./storage/render-session-retention";
import { RollingSnapshotArtifactStoreV1 } from "./storage/rolling-snapshot-artifact-store";
import { RoutedRenderArtifactStoreV1 } from "./storage/routed-render-artifact-store";
import {
  RoutedProjectPngBlobStoreV1,
  RoutedSourceContentBlobStoreV1,
  type StorageWriteLaneV1,
} from "./storage/routed-source-png-store";
import { S3ArtifactReaderV1 } from "./storage/s3/s3-artifact-reader";
import { S3ContentBlobStoreV1 } from "./storage/s3/s3-content-blob-store";
import { S3ImmutableRenderArtifactStoreV1 } from "./storage/s3/s3-immutable-render-artifact-store";
import { S3ImmutableSnapshotArtifactStoreV1 } from "./storage/s3/s3-immutable-snapshot-artifact-store";
import { ImmutableS3ProjectPngStoreV1, ImmutableS3SourceBlobStoreV1 } from "./storage/s3/s3-immutable-source-png-store";
import {
  PrivateImmutableS3BucketTransportV1,
  type PrivateImmutableS3ProductionProviderV1,
} from "./storage/s3/s3-private-immutable-bucket-transport";
import { PrivateVersionedS3BucketTransportV1 } from "./storage/s3/s3-private-versioned-bucket-transport";
import { S3ProjectPngStoreV1 } from "./storage/s3/s3-project-png-store";
import { S3SnapshotArtifactStoreV1 } from "./storage/s3/s3-snapshot-artifact-store";
import {
  createDurableSnapshotArtifactGcWorkerV1,
  type SnapshotPublicationTombstoneCompactionMetricsV1,
} from "./storage/snapshot-artifact-gc";
import { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import { createDurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import { VerifiedArtifactPublisherV1 } from "./storage/verified-artifact-publisher";

export type DurablePostgresS3ProductionRuntimeOptionsV1 = Readonly<{
  database: Readonly<{
    migrationPoolConfig: PoolConfig;
    migrationTimeoutMs?: number;
    runtimePoolConfig: PoolConfig;
    statementTimeoutMs?: number;
  }>;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  objectStorage: Readonly<{
    immutable: Readonly<{
      bucket: string;
      provider: PrivateImmutableS3ProductionProviderV1;
    }>;
    legacy?: Readonly<{
      bucket: string;
      clientConfig: S3ClientConfig;
    }>;
    writeLane: StorageWriteLaneV1;
  }>;
  renderWorker: Readonly<{
    executionTimeoutMs?: number;
    leaseDurationMs?: number;
    maxConcurrentJobs?: number;
    onFailure: (error: unknown) => void;
    pollIntervalMs?: number;
    workerId?: string;
  }>;
  renderSandbox: Omit<ManimRenderProductionSandboxClientOptionsV1, "stagingRoot">;
  renderArtifacts: Readonly<{
    artifactExpirationMs: number;
    claimDurationMs?: number;
    gc: Readonly<{
      batchSize: number;
      graceMs: number;
      intervalMs: number;
      onFailure: (error: unknown) => void;
      sweepTimeoutMs: number;
    }>;
    stagingRoot: string;
  }>;
  renderCancellation: Readonly<{
    acknowledgementPollMs?: number;
    acknowledgementTimeoutMs?: number;
    batchSize: number;
    deliveryLeaseMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
    relayId?: string;
    sweepTimeoutMs: number;
  }>;
  renderSessionRetention: Readonly<{
    auditRetentionMs: number;
    batchSize: number;
    inputRetentionMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
    sweepTimeoutMs: number;
  }>;
  snapshot: Readonly<{
    artifactGc: Readonly<{
      batchSize: number;
      graceMs: number;
      intervalMs: number;
      onFailure: (error: unknown) => void;
      onTombstoneCompactionMetrics: (metrics: SnapshotPublicationTombstoneCompactionMetricsV1) => void;
      sweepTimeoutMs: number;
    }>;
    sandbox: FastManimProductionSnapshotRunnerFactoryOptionsV1["client"];
    snapshotVersion?: FastManimProductionSnapshotRunnerFactoryOptionsV1["snapshotVersion"];
    timeoutMs?: number;
  }>;
  sourceGc: Readonly<{
    batchSize: number;
    graceMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
    sweepTimeoutMs: number;
  }>;
  projectPngGc: Readonly<{
    batchSize: number;
    graceMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
    sweepTimeoutMs: number;
  }>;
  tenantId: string;
}>;

export type DurablePostgresS3ProductionRuntimeCellProvisionerOptionsV1 = Omit<
  DurablePostgresS3ProductionRuntimeOptionsV1,
  "tenantId"
>;

/**
 * Shared-process topology for the runtime-cell resolver. Every provisioned
 * adapter receives only the tenant ID from a validated server-owned assignment;
 * database, object-store, and sandbox endpoints remain deployment config.
 */
export function createDurablePostgresS3ProductionRuntimeCellProvisionerV1(
  options: DurablePostgresS3ProductionRuntimeCellProvisionerOptionsV1,
): ProductionManimRuntimeCellProvisionerV1 {
  return Object.freeze({
    provision: (assignment: ProductionRuntimeCellAssignmentV1, signal: AbortSignal) =>
      createDurablePostgresS3ProductionRuntimeV1({ ...options, tenantId: assignment.tenantId }, signal),
  });
}

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
  const results = await Promise.allSettled(unique.map(async (resource) => resource.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

function collectCloseErrors(errors: unknown[], error: unknown) {
  errors.push(...(error instanceof AggregateError ? error.errors : [error]));
}

/**
 * Owns the shared object-storage transports below an otherwise complete
 * production adapter. Stores release their leases before transport shutdown;
 * every phase still runs when an earlier close reports an error.
 */
export function createProductionStorageOwnershipBoundaryV1(
  runtime: ProductionManimRuntimeAdapterV1,
  stores: readonly (Closeable | undefined)[],
  transports: readonly (Closeable | undefined)[],
): ProductionManimRuntimeAdapterV1 {
  let closeRequest: Promise<void> | undefined;
  return {
    ...runtime,
    close() {
      closeRequest ??= (async () => {
        const errors: unknown[] = [];
        await closeAll([runtime], "Could not close the production runtime.").catch((error: unknown) =>
          collectCloseErrors(errors, error),
        );
        await closeAll(stores, "Could not close the production object stores.").catch((error: unknown) =>
          collectCloseErrors(errors, error),
        );
        await closeAll(transports, "Could not close the production object transports.").catch((error: unknown) =>
          collectCloseErrors(errors, error),
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Could not fully close production storage ownership.");
        }
      })();
      return closeRequest;
    },
  };
}

async function cleanupInOrderAndThrow(
  error: unknown,
  phases: readonly (readonly (Closeable | undefined)[])[],
  message: string,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const phase of phases) {
    await closeAll(phase, message).catch((cleanupError: unknown) => {
      cleanupErrors.push(...(cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]));
    });
  }
  if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], message);
  throw error;
}

function renderExecutionBoundary(relay: DurableManimRenderCancellationRelayV1, worker: DurableManimRenderWorkerV1) {
  let closeRequest: Promise<void> | undefined;
  return {
    close() {
      closeRequest ??= (async () => {
        const errors: unknown[] = [];
        await relay.close().catch((error: unknown) => errors.push(error));
        await worker.close().catch((error: unknown) => errors.push(error));
        if (errors.length > 0) {
          throw new AggregateError(errors, "The durable render execution boundary did not close cleanly.");
        }
      })();
      return closeRequest;
    },
    async ready(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!relay.ready()) return false;
      return worker.ready(signal);
    },
  };
}

function assertObjectStorageCutoverOptions(options: DurablePostgresS3ProductionRuntimeOptionsV1["objectStorage"]) {
  if (options.writeLane !== "immutable" && options.writeLane !== "versioned") {
    throw new TypeError("Production object-storage write lane is invalid.");
  }
  if (options.writeLane === "versioned" && options.legacy === undefined) {
    throw new TypeError("The versioned production write lane requires legacy object storage.");
  }
}

/** Build the shipped PostgreSQL + private S3 runtime and its durable maintenance workers. */
export async function createDurablePostgresS3ProductionRuntimeV1(
  options: DurablePostgresS3ProductionRuntimeOptionsV1,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const frame = options.frame ?? MANIM_RENDER_CANONICAL_SCENE_FRAME_V1;
  if (
    frame.height !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.height ||
    frame.width !== MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.width
  ) {
    throw new TypeError("Production rendering currently requires the canonical 16:9 scene frame.");
  }
  assertProductionPoolConfig(options.database.migrationPoolConfig, "Migration");
  assertProductionPoolConfig(options.database.runtimePoolConfig, "Runtime");
  assertObjectStorageCutoverOptions(options.objectStorage);
  await migrate(options.database);
  signal?.throwIfAborted();

  let repository: PostgresWorkspaceSourceRepositoryV1 | undefined;
  let editorDocuments: PostgresEditorDocumentRepositoryV1 | undefined;
  let renderRepository: PostgresRenderSessionRepositoryV1 | undefined;
  let projectPngRepository: PostgresProjectPngRepositoryV1 | undefined;
  let mediaRepository: PostgresArtifactRepositoryV1 | undefined;
  let snapshotRepository: PostgresSnapshotPublicationRepositoryV1 | undefined;
  let immutableTransport: PrivateImmutableS3BucketTransportV1 | undefined;
  let legacyTransport: PrivateVersionedS3BucketTransportV1 | undefined;
  let immutableBlobs: ImmutableS3SourceBlobStoreV1 | undefined;
  let legacyBlobs: S3ContentBlobStoreV1 | undefined;
  let immutableProjectPngs: ImmutableS3ProjectPngStoreV1 | undefined;
  let legacyProjectPngs: S3ProjectPngStoreV1 | undefined;
  let immutableArtifacts: S3ImmutableSnapshotArtifactStoreV1 | undefined;
  let legacyArtifacts: S3SnapshotArtifactStoreV1 | undefined;
  let immutableMediaArtifacts: S3ImmutableRenderArtifactStoreV1 | undefined;
  let legacyMediaArtifacts: S3ArtifactReaderV1 | undefined;
  let blobs: RoutedSourceContentBlobStoreV1 | undefined;
  let projectPngs: RoutedProjectPngBlobStoreV1 | undefined;
  let artifacts: RollingSnapshotArtifactStoreV1 | undefined;
  let mediaArtifacts: RoutedRenderArtifactStoreV1 | undefined;
  try {
    repository = new PostgresWorkspaceSourceRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    editorDocuments = new PostgresEditorDocumentRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    renderRepository = new PostgresRenderSessionRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    projectPngRepository = new PostgresProjectPngRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    mediaRepository = new PostgresArtifactRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    snapshotRepository = new PostgresSnapshotPublicationRepositoryV1({
      poolConfig: options.database.runtimePoolConfig,
      statementTimeoutMs: options.database.statementTimeoutMs,
    });
    immutableTransport = new PrivateImmutableS3BucketTransportV1({
      bucket: options.objectStorage.immutable.bucket,
      deployment: "production",
      provider: options.objectStorage.immutable.provider,
    });
    if (options.objectStorage.legacy) {
      legacyTransport = new PrivateVersionedS3BucketTransportV1({
        bucket: options.objectStorage.legacy.bucket,
        clientConfig: options.objectStorage.legacy.clientConfig,
        deployment: "production",
      });
    }

    immutableBlobs = new ImmutableS3SourceBlobStoreV1({ transport: immutableTransport });
    immutableProjectPngs = new ImmutableS3ProjectPngStoreV1({ transport: immutableTransport });
    immutableArtifacts = new S3ImmutableSnapshotArtifactStoreV1({ transport: immutableTransport });
    immutableMediaArtifacts = new S3ImmutableRenderArtifactStoreV1({ transport: immutableTransport });
    if (legacyTransport) {
      legacyBlobs = new S3ContentBlobStoreV1({ transport: legacyTransport });
      legacyProjectPngs = new S3ProjectPngStoreV1({ transport: legacyTransport });
      legacyArtifacts = new S3SnapshotArtifactStoreV1({ transport: legacyTransport });
      legacyMediaArtifacts = new S3ArtifactReaderV1({ transport: legacyTransport });
    }

    blobs = new RoutedSourceContentBlobStoreV1({
      immutable: immutableBlobs,
      ...(legacyBlobs ? { legacy: legacyBlobs } : {}),
      writeLane: options.objectStorage.writeLane,
    });
    projectPngs = new RoutedProjectPngBlobStoreV1({
      immutable: immutableProjectPngs,
      ...(legacyProjectPngs ? { legacy: legacyProjectPngs } : {}),
      writeLane: options.objectStorage.writeLane,
    });
    artifacts = new RollingSnapshotArtifactStoreV1({
      immutable: immutableArtifacts,
      ...(legacyArtifacts ? { versioned: legacyArtifacts } : {}),
      writeLane: options.objectStorage.writeLane,
    });
    mediaArtifacts = new RoutedRenderArtifactStoreV1({
      immutable: immutableMediaArtifacts,
      ...(legacyMediaArtifacts ? { legacy: legacyMediaArtifacts } : {}),
      writeLane: options.objectStorage.writeLane,
    });
  } catch (error) {
    return cleanupInOrderAndThrow(
      error,
      [
        [mediaArtifacts, artifacts, projectPngs, blobs],
        [
          immutableMediaArtifacts,
          legacyMediaArtifacts,
          immutableArtifacts,
          legacyArtifacts,
          immutableProjectPngs,
          legacyProjectPngs,
          immutableBlobs,
          legacyBlobs,
        ],
        [immutableTransport, legacyTransport],
        [mediaRepository, snapshotRepository, projectPngRepository, renderRepository, editorDocuments, repository],
      ],
      "Production storage composition and cleanup failed.",
    );
  }

  let renderWorker: DurableManimRenderWorkerV1 | undefined;
  let renderExecutor: ProductionDurableManimRenderExecutorV1 | undefined;
  let renderCancellationRelay: DurableManimRenderCancellationRelayV1 | undefined;
  let artifactReader: AuthorizedArtifactReaderV1 | undefined;
  let renderPublisher: VerifiedArtifactPublisherV1 | undefined;
  let renders: DurableManimRenderServiceV1 | undefined;
  let snapshotFactory: FastManimProductionSnapshotRunnerFactoryV1 | undefined;
  let publisher: SnapshotArtifactPublisherV1 | undefined;
  let snapshots: DurableFastManimSnapshotServiceV1 | undefined;
  let candidateVerifier: ManimRenderCandidateVerifierV1 | undefined;
  try {
    snapshotFactory = new FastManimProductionSnapshotRunnerFactoryV1({
      client: options.snapshot.sandbox,
      frame,
      projectPngRepository,
      projectPngs,
      ...(options.snapshot.snapshotVersion === undefined ? {} : { snapshotVersion: options.snapshot.snapshotVersion }),
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
    renderExecutor = await createProductionDurableManimRenderExecutorV1({
      blobs,
      client: { ...options.renderSandbox, stagingRoot: options.renderArtifacts.stagingRoot },
      frame,
      ...(options.renderWorker.maxConcurrentJobs === undefined
        ? {}
        : { maxConcurrentJobs: options.renderWorker.maxConcurrentJobs }),
      projectPngs,
      tenantId: options.tenantId,
    });
    artifactReader = new AuthorizedArtifactReaderV1({
      ...(options.renderArtifacts.claimDurationMs === undefined
        ? {}
        : { claimDurationMs: options.renderArtifacts.claimDurationMs }),
      repository: mediaRepository,
      store: mediaArtifacts,
      tenantId: options.tenantId,
    });
    renderPublisher = new VerifiedArtifactPublisherV1({
      artifactExpirationMs: options.renderArtifacts.artifactExpirationMs,
      artifacts: mediaArtifacts,
      brokerUserId: options.renderSandbox.brokerUserId,
      profileDigest: renderExecutor.profileDigest,
      publications: mediaRepository,
      runtimeDigest: renderExecutor.runtimeDigest,
      stagingGroupId: options.renderSandbox.socketGroupId,
      stagingRoot: options.renderArtifacts.stagingRoot,
      tenantId: options.tenantId,
    });
    const worker = new DurableManimRenderWorkerV1({
      brokerShardId: renderExecutor.brokerShardId,
      executor: renderExecutor,
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
      publisher: renderPublisher,
      repository: renderRepository,
      tenantId: options.tenantId,
      ...(options.renderWorker.workerId === undefined ? {} : { workerId: options.renderWorker.workerId }),
    });
    renderWorker = worker;
    const cancellationCoordinator = new DurableManimRenderCancellationCoordinatorV1({
      ...(options.renderCancellation.acknowledgementPollMs === undefined
        ? {}
        : { acknowledgementPollMs: options.renderCancellation.acknowledgementPollMs }),
      ...(options.renderCancellation.acknowledgementTimeoutMs === undefined
        ? {}
        : { acknowledgementTimeoutMs: options.renderCancellation.acknowledgementTimeoutMs }),
      repository: renderRepository,
      tenantId: options.tenantId,
      wake: () => renderCancellationRelay?.wake(),
    });
    candidateVerifier = new ManimRenderCandidateVerifierV1({
      frame,
      runner: snapshots,
      runtimeTraceRunner: snapshots,
    });
    renders = new DurableManimRenderServiceV1({
      artifactReader,
      blobs,
      candidateVerifier,
      ...(options.renderWorker.executionTimeoutMs === undefined
        ? {}
        : { executionTimeoutMs: options.renderWorker.executionTimeoutMs }),
      execution: {
        cancel: (sessionId) => cancellationCoordinator.cancel(sessionId),
        wake: () => worker.wake(),
      },
      frame,
      repository: renderRepository,
      sourceRepository: repository,
      tenantId: options.tenantId,
    });
  } catch (error) {
    return cleanupInOrderAndThrow(
      error,
      [
        [renderWorker ?? renderExecutor, renders, snapshots ?? publisher, ...(snapshots ? [] : [snapshotFactory])],
        [mediaArtifacts, artifacts, projectPngs, blobs],
        [immutableTransport, legacyTransport],
        [mediaRepository, snapshotRepository, projectPngRepository, renderRepository, editorDocuments, repository],
      ],
      "Production runtime service composition and cleanup failed.",
    );
  }

  let renderExecution: ReturnType<typeof renderExecutionBoundary> | undefined;
  let runtime: DurableManimRuntimeV1 | undefined;
  try {
    if (!candidateVerifier) throw new Error("Production candidate verification is unavailable.");
    renderCancellationRelay = await createDurableManimRenderCancellationRelayV1(
      {
        abortActive: (sessionId) => renderWorker.abortActive(sessionId),
        batchSize: options.renderCancellation.batchSize,
        brokerShardId: renderExecutor.brokerShardId,
        deliveryLeaseMs: options.renderCancellation.deliveryLeaseMs,
        executor: renderExecutor,
        intervalMs: options.renderCancellation.intervalMs,
        onFailure: options.renderCancellation.onFailure,
        ...(options.renderCancellation.relayId === undefined ? {} : { relayId: options.renderCancellation.relayId }),
        repository: renderRepository,
        sweepTimeoutMs: options.renderCancellation.sweepTimeoutMs,
        tenantId: options.tenantId,
      },
      signal,
    );
    renderExecution = renderExecutionBoundary(renderCancellationRelay, renderWorker);
    runtime = new DurableManimRuntimeV1({
      artifactReader,
      blobs,
      candidateVerifier,
      editorDocuments,
      execution: renderExecution,
      frame,
      namespace: options.namespace,
      projectPngRepository,
      projectPngs,
      renders,
      repository,
      snapshots,
      tenantId: options.tenantId,
    });
    await runtime.initialize(signal);
    renderWorker.start();
  } catch (error) {
    return cleanupInOrderAndThrow(
      error,
      [
        runtime ? [runtime] : [renderExecution ?? renderWorker, renders, snapshots],
        [mediaArtifacts, artifacts, projectPngs, blobs],
        [immutableTransport, legacyTransport],
        [mediaRepository, snapshotRepository, projectPngRepository, renderRepository, editorDocuments, repository],
      ],
      "Production durable runtime construction and cleanup failed.",
    );
  }

  let sourceMaintenance: Awaited<ReturnType<typeof createDurableSourceBlobGcWorkerV1>> | undefined;
  let projectPngMaintenance: Awaited<ReturnType<typeof createDurableProjectPngGcWorkerV1>> | undefined;
  let snapshotMaintenance: Awaited<ReturnType<typeof createDurableSnapshotArtifactGcWorkerV1>> | undefined;
  let mediaMaintenance: Awaited<ReturnType<typeof createDurableRenderArtifactGcWorkerV1>> | undefined;
  let retentionMaintenance: Awaited<ReturnType<typeof createDurableRenderSessionRetentionWorkerV1>> | undefined;
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
    const projectPngGc = await createDurableProjectPngGcWorkerV1(
      {
        ...options.projectPngGc,
        repository: projectPngRepository,
        store: projectPngs,
        tenantId: options.tenantId,
      },
      signal,
    );
    projectPngMaintenance = projectPngGc;
    const artifactGc = await createDurableSnapshotArtifactGcWorkerV1(
      {
        ...options.snapshot.artifactGc,
        artifacts,
        repository: snapshotRepository,
        tenantId: options.tenantId,
      },
      signal,
    );
    snapshotMaintenance = artifactGc;
    const mediaGc = await createDurableRenderArtifactGcWorkerV1(
      {
        ...options.renderArtifacts.gc,
        artifacts: mediaArtifacts,
        repository: mediaRepository,
        tenantId: options.tenantId,
      },
      signal,
    );
    mediaMaintenance = mediaGc;
    const retention = await createDurableRenderSessionRetentionWorkerV1(
      {
        ...options.renderSessionRetention,
        repository: renderRepository,
        tenantId: options.tenantId,
      },
      signal,
    );
    retentionMaintenance = retention;
    const maintenance = {
      close: () =>
        closeAll(
          [retention, mediaGc, artifactGc, projectPngGc, sourceGc],
          "Could not fully close durable storage maintenance.",
        ),
      ready: () =>
        sourceGc.ready() && projectPngGc.ready() && artifactGc.ready() && mediaGc.ready() && retention.ready(),
    };
    const adapter = createDurableProductionManimRuntimeAdapterV1(runtime, maintenance);
    return createProductionStorageOwnershipBoundaryV1(
      adapter,
      [
        mediaArtifacts,
        artifacts,
        projectPngs,
        blobs,
        projectPngRepository,
        mediaRepository,
        snapshotRepository,
        renderRepository,
        editorDocuments,
        repository,
      ],
      [immutableTransport, legacyTransport],
    );
  } catch (error) {
    return cleanupInOrderAndThrow(
      error,
      [
        [retentionMaintenance, mediaMaintenance, snapshotMaintenance, projectPngMaintenance, sourceMaintenance],
        [runtime],
        [
          mediaArtifacts,
          artifacts,
          projectPngs,
          blobs,
          projectPngRepository,
          mediaRepository,
          snapshotRepository,
          renderRepository,
          editorDocuments,
          repository,
        ],
        [immutableTransport, legacyTransport],
      ],
      "Production runtime maintenance composition and cleanup failed.",
    );
  }
}
