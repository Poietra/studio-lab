import { Pool, type PoolConfig } from "pg";
import type { S3ClientConfig } from "@aws-sdk/client-s3";

import {
  createDurableManimRuntimeV1,
  createDurableProductionManimRuntimeAdapterV1,
  type DurableManimExecutionReadinessV1,
} from "./durable-manim-runtime";
import { applyBundledWorkspaceSourceMigrationV1 } from "./storage/postgres/migrate";
import { PostgresWorkspaceSourceRepositoryV1 } from "./storage/postgres/postgres-workspace-source-repository";
import { S3ContentBlobStoreV1 } from "./storage/s3/s3-content-blob-store";
import { createDurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";

export type DurablePostgresS3ProductionRuntimeOptionsV1 = Readonly<{
  database: Readonly<{
    migrationPoolConfig: PoolConfig;
    migrationTimeoutMs?: number;
    runtimePoolConfig: PoolConfig;
    statementTimeoutMs?: number;
  }>;
  execution: DurableManimExecutionReadinessV1;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  objectStorage: Readonly<{
    bucket: string;
    clientConfig: S3ClientConfig;
  }>;
  sourceGc: Readonly<{
    batchSize: number;
    graceMs: number;
    intervalMs: number;
    onFailure: (error: unknown) => void;
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
    query_timeout: timeout,
    statement_timeout: timeout,
  });
  try {
    await applyBundledWorkspaceSourceMigrationV1(pool);
  } finally {
    await pool.end();
  }
}

/** Build the shipped PostgreSQL + private S3 production runtime, including its explicit GC worker. */
export async function createDurablePostgresS3ProductionRuntimeV1(
  options: DurablePostgresS3ProductionRuntimeOptionsV1,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  assertProductionPoolConfig(options.database.migrationPoolConfig, "Migration");
  assertProductionPoolConfig(options.database.runtimePoolConfig, "Runtime");
  await migrate(options.database);
  signal?.throwIfAborted();

  const repository = new PostgresWorkspaceSourceRepositoryV1({
    poolConfig: options.database.runtimePoolConfig,
    statementTimeoutMs: options.database.statementTimeoutMs,
  });
  let blobs: S3ContentBlobStoreV1;
  try {
    blobs = new S3ContentBlobStoreV1({
      bucket: options.objectStorage.bucket,
      clientConfig: options.objectStorage.clientConfig,
      deployment: "production",
    });
  } catch (error) {
    await repository.close().catch(() => undefined);
    throw error;
  }

  const runtime = await createDurableManimRuntimeV1(
    {
      blobs,
      execution: options.execution,
      frame: options.frame,
      namespace: options.namespace,
      repository,
      tenantId: options.tenantId,
    },
    signal,
  );
  try {
    const maintenance = await createDurableSourceBlobGcWorkerV1(
      {
        ...options.sourceGc,
        blobs,
        repository,
        tenantId: options.tenantId,
      },
      signal,
    );
    return createDurableProductionManimRuntimeAdapterV1(runtime, maintenance);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await runtime.close().catch((cleanupError: unknown) => cleanupErrors.push(cleanupError));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Production runtime composition and cleanup failed.");
    }
    throw error;
  }
}
