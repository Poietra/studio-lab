import { type DurableGcResultV1, DurableGcWorkerCoreV1, runDurableGcSweepV1 } from "./durable-gc-core";
import type {
  SourceBlobVersionCursorV1,
  SourceContentBlobStoreV1,
  WorkspaceSourceRepositoryV1,
} from "./workspace-source-repository";

export type SourceBlobGcResultV1 = DurableGcResultV1<SourceBlobVersionCursorV1>;
export class SourceBlobGcSweepErrorV1 extends AggregateError {
  readonly result: SourceBlobGcResultV1;

  constructor(errors: readonly unknown[], result: SourceBlobGcResultV1) {
    super(errors, `Source blob GC could not delete ${errors.length} queued object version(s).`);
    this.name = "SourceBlobGcSweepErrorV1";
    this.result = result;
  }
}

export async function runSourceBlobGcV1(
  options: Readonly<{
    blobs: SourceContentBlobStoreV1;
    cutoff: Date;
    cursor?: SourceBlobVersionCursorV1 | null;
    graceMs: number;
    maximum: number;
    repository: WorkspaceSourceRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  const result = await runDurableGcSweepV1({
    ...options,
    list: (cutoff, maximum, cursor, signal) =>
      options.blobs.listSourceVersions(options.tenantId, cutoff, maximum, cursor, signal),
    isPublished: ({ blob }, signal) => options.repository.isBlobVersionPublished(options.tenantId, blob, signal),
    queue: ({ blob }, signal) => options.repository.queueBlobDeletion(options.tenantId, blob, signal),
    pending: (maximum, signal) => options.repository.pendingBlobDeletions(options.tenantId, maximum, signal),
    deleteVersion: ({ blob, tenantId }, signal) => options.blobs.deleteVersion(tenantId, blob, signal),
    acknowledge: ({ deletionId, tenantId }, signal) =>
      options.repository.acknowledgeBlobDeletion(tenantId, deletionId, signal),
    createError: (errors, result) => new SourceBlobGcSweepErrorV1(errors, result),
  });
  const durableQueued = await options.repository.queueOrphanedBlobDeletions(
    options.tenantId,
    options.graceMs,
    options.maximum,
    options.signal,
  );
  return { ...result, queued: result.queued + durableQueued };
}

export type DurableSourceBlobGcWorkerOptionsV1 = Readonly<{
  batchSize: number;
  blobs: SourceContentBlobStoreV1;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: WorkspaceSourceRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

export class DurableSourceBlobGcWorkerV1 extends DurableGcWorkerCoreV1<
  SourceBlobGcResultV1,
  SourceBlobVersionCursorV1
> {
  constructor(options: DurableSourceBlobGcWorkerOptionsV1) {
    super({
      ...options,
      validationPrefix: "Source GC",
      readinessError: "Durable source GC storage readiness is unavailable.",
      startOnceError: "The durable source GC worker can only be started once.",
      isStorageReady: async (signal) => {
        const ready = await Promise.all([options.repository.ready(signal), options.blobs.ready(signal)]);
        return ready.every(Boolean);
      },
      cursorAfterFailure: (error, current) =>
        error instanceof SourceBlobGcSweepErrorV1 ? error.result.nextCursor : current,
      run: ({ cutoff, cursor, maximum, signal }) => runSourceBlobGcV1({ ...options, cutoff, cursor, maximum, signal }),
    });
  }
}

export async function createDurableSourceBlobGcWorkerV1(
  options: DurableSourceBlobGcWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableSourceBlobGcWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
