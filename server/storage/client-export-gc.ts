import type { ClientExportArtifactStoreV1, ClientExportRepositoryV1 } from "./client-export-contract";
import { type DurableGcResultV1, DurableGcWorkerCoreV1, runDurableGcSweepV1 } from "./durable-gc-core";

export type ClientExportGcResultV1 = DurableGcResultV1<string>;

export class ClientExportGcSweepErrorV1 extends AggregateError {
  readonly result: ClientExportGcResultV1;

  constructor(errors: readonly unknown[], result: ClientExportGcResultV1) {
    super(errors, `Client export GC could not delete ${errors.length} queued object(s).`);
    this.name = "ClientExportGcSweepErrorV1";
    this.result = result;
  }
}

/**
 * Storage-first expiry sweep for published client exports: bucket objects
 * older than the cutoff that no live publication or read claim retains are
 * tombstoned into `client_export_deletions`, then the pending tombstones are
 * drained by deleting exactly the copied receipt and recording an
 * acknowledgement without resurrecting a later object under the same key.
 */
export async function runClientExportGcV1(
  options: Readonly<{
    artifacts: ClientExportArtifactStoreV1;
    cutoff: Date;
    cursor?: string | null;
    graceMs: number;
    maximum: number;
    repository: ClientExportRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  return runDurableGcSweepV1({
    ...options,
    list: async (cutoff, maximum, cursor, signal) => {
      const page = await options.artifacts.listObjects(options.tenantId, cutoff, maximum, cursor, signal);
      return { nextCursor: page.nextCursor, versions: page.objects };
    },
    isPublished: ({ receipt }, signal) => options.repository.isArtifactRetained(options.tenantId, receipt, signal),
    queue: ({ receipt }, signal) =>
      options.repository.queueDeletion(options.tenantId, receipt, options.graceMs, signal),
    pending: (maximum, signal) => options.repository.pendingDeletions(options.tenantId, maximum, signal),
    deleteVersion: ({ receipt, tenantId }, signal) => options.artifacts.deleteObject(tenantId, receipt, signal),
    acknowledge: ({ deletionId, tenantId }, signal) =>
      options.repository.acknowledgeDeletion(tenantId, deletionId, signal),
    createError: (errors, result) => new ClientExportGcSweepErrorV1(errors, result),
  });
}

export type DurableClientExportGcWorkerOptionsV1 = Readonly<{
  artifacts: ClientExportArtifactStoreV1;
  batchSize: number;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: ClientExportRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

export class DurableClientExportGcWorkerV1 extends DurableGcWorkerCoreV1<ClientExportGcResultV1, string> {
  constructor(options: DurableClientExportGcWorkerOptionsV1) {
    super({
      ...options,
      validationPrefix: "Client export GC",
      readinessError: "Durable client export GC storage readiness is unavailable.",
      startOnceError: "The durable client export GC worker can only be started once.",
      isStorageReady: async (signal) => {
        const ready = await Promise.all([options.repository.ready(signal), options.artifacts.ready(signal)]);
        return ready.every(Boolean);
      },
      cursorAfterFailure: (error, current) =>
        error instanceof ClientExportGcSweepErrorV1 ? error.result.nextCursor : current,
      run: ({ cutoff, cursor, maximum, signal }) =>
        runClientExportGcV1({ ...options, cutoff, cursor, maximum, signal }),
    });
  }
}

export async function createDurableClientExportGcWorkerV1(
  options: DurableClientExportGcWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableClientExportGcWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
