import { type DurableGcResultV1, DurableGcWorkerCoreV1, runDurableGcSweepV1 } from "./durable-gc-core";
import type { SnapshotArtifactStoreV1, SnapshotPublicationRepositoryV1 } from "./snapshot-publication-repository";

export const SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MS_V1 = 30 * 24 * 60 * 60_000;
export const SNAPSHOT_PUBLICATION_TOMBSTONE_COMPACTION_BATCH_V1 = 64;

type SnapshotArtifactGcSweepProgressV1 = DurableGcResultV1<string>;

export type SnapshotArtifactGcResultV1 = SnapshotArtifactGcSweepProgressV1 &
  Readonly<{
    compactedPublicationTombstones: number;
    tombstoneRetentionMs: number;
  }>;

export class SnapshotArtifactGcSweepErrorV1 extends AggregateError {
  readonly result: SnapshotArtifactGcSweepProgressV1;

  constructor(errors: readonly unknown[], result: SnapshotArtifactGcSweepProgressV1) {
    super(errors, `Snapshot artifact GC could not delete ${errors.length} queued object version(s).`);
    this.name = "SnapshotArtifactGcSweepErrorV1";
    this.result = result;
  }
}

export async function runSnapshotArtifactGcV1(
  options: Readonly<{
    artifacts: SnapshotArtifactStoreV1;
    cutoff: Date;
    cursor?: string | null;
    maximum: number;
    repository: SnapshotPublicationRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  const result = await runDurableGcSweepV1({
    ...options,
    list: (cutoff, maximum, cursor, signal) =>
      options.artifacts.listVersions(options.tenantId, cutoff, maximum, cursor, signal),
    isPublished: ({ artifact }, signal) => options.repository.isArtifactPublished(options.tenantId, artifact, signal),
    queue: ({ artifact }, signal) => options.repository.queueArtifactDeletion(options.tenantId, artifact, signal),
    pending: (maximum, signal) => options.repository.pendingArtifactDeletions(options.tenantId, maximum, signal),
    deleteVersion: ({ artifact, tenantId }, signal) => options.artifacts.deleteVersion(tenantId, artifact, signal),
    acknowledge: ({ deletionId, tenantId }, signal) =>
      options.repository.acknowledgeArtifactDeletion(tenantId, deletionId, signal),
    createError: (errors, result) => new SnapshotArtifactGcSweepErrorV1(errors, result),
  });
  options.signal?.throwIfAborted();
  const compactedPublicationTombstones = await options.repository.compactPublicationTombstones(
    options.tenantId,
    new Date(Date.now() - SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MS_V1),
    SNAPSHOT_PUBLICATION_TOMBSTONE_COMPACTION_BATCH_V1,
    options.signal,
  );
  return {
    ...result,
    compactedPublicationTombstones,
    tombstoneRetentionMs: SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MS_V1,
  };
}

export type DurableSnapshotArtifactGcWorkerOptionsV1 = Readonly<{
  artifacts: SnapshotArtifactStoreV1;
  batchSize: number;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: SnapshotPublicationRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

export class DurableSnapshotArtifactGcWorkerV1 extends DurableGcWorkerCoreV1<SnapshotArtifactGcResultV1, string> {
  constructor(options: DurableSnapshotArtifactGcWorkerOptionsV1) {
    super({
      ...options,
      validationPrefix: "Snapshot artifact GC",
      readinessError: "Durable snapshot artifact GC storage readiness is unavailable.",
      startOnceError: "The durable snapshot artifact GC worker can only be started once.",
      isStorageReady: async (signal) => {
        const ready = await Promise.all([options.repository.ready(signal), options.artifacts.ready(signal)]);
        return ready.every(Boolean);
      },
      cursorAfterFailure: (error, current) =>
        error instanceof SnapshotArtifactGcSweepErrorV1 ? error.result.nextCursor : current,
      run: ({ cutoff, cursor, maximum, signal }) =>
        runSnapshotArtifactGcV1({ ...options, cutoff, cursor, maximum, signal }),
    });
  }
}

export async function createDurableSnapshotArtifactGcWorkerV1(
  options: DurableSnapshotArtifactGcWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableSnapshotArtifactGcWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
