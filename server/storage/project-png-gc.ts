import { type DurableGcResultV1, DurableGcWorkerCoreV1, runDurableGcSweepV1 } from "./durable-gc-core";
import type { ProjectPngBlobStoreV1, ProjectPngRepositoryV1, ProjectPngVersionCursorV1 } from "./project-png-storage";

export type ProjectPngGcResultV1 = DurableGcResultV1<ProjectPngVersionCursorV1>;

export class ProjectPngGcSweepErrorV1 extends AggregateError {
  readonly result: ProjectPngGcResultV1;

  constructor(errors: readonly unknown[], result: ProjectPngGcResultV1) {
    super(errors, `Project image.png GC could not delete ${errors.length} queued object version(s).`);
    this.name = "ProjectPngGcSweepErrorV1";
    this.result = result;
  }
}

export async function runProjectPngGcV1(
  options: Readonly<{
    cutoff: Date;
    cursor?: ProjectPngVersionCursorV1 | null;
    graceMs: number;
    maximum: number;
    repository: ProjectPngRepositoryV1;
    signal?: AbortSignal;
    store: ProjectPngBlobStoreV1;
    tenantId: string;
  }>,
) {
  return runDurableGcSweepV1({
    ...options,
    list: (cutoff, maximum, cursor, signal) =>
      options.store.listVersions(options.tenantId, cutoff, maximum, cursor, signal),
    isPublished: ({ projectId, receipt }, signal) =>
      options.repository.isVersionRetained(options.tenantId, projectId, receipt, signal),
    queue: ({ projectId, receipt }, signal) =>
      options.repository.queueDeletion(options.tenantId, projectId, receipt, options.graceMs, signal),
    pending: (maximum, signal) => options.repository.pendingDeletions(options.tenantId, maximum, signal),
    deleteVersion: ({ projectId, receipt, tenantId }, signal) =>
      options.store.deleteVersion(tenantId, projectId, receipt, signal),
    acknowledge: ({ deletionId, tenantId }, signal) =>
      options.repository.acknowledgeDeletion(tenantId, deletionId, signal),
    createError: (errors, result) => new ProjectPngGcSweepErrorV1(errors, result),
  });
}

export type DurableProjectPngGcWorkerOptionsV1 = Readonly<{
  batchSize: number;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: ProjectPngRepositoryV1;
  store: ProjectPngBlobStoreV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

export class DurableProjectPngGcWorkerV1 extends DurableGcWorkerCoreV1<
  ProjectPngGcResultV1,
  ProjectPngVersionCursorV1
> {
  constructor(options: DurableProjectPngGcWorkerOptionsV1) {
    super({
      ...options,
      validationPrefix: "Project image.png GC",
      readinessError: "Durable project image.png GC storage readiness is unavailable.",
      startOnceError: "The durable project image.png GC worker can only be started once.",
      isStorageReady: async (signal) => {
        const ready = await Promise.all([options.repository.ready(signal), options.store.ready(signal)]);
        return ready.every(Boolean);
      },
      cursorAfterFailure: (error, current) =>
        error instanceof ProjectPngGcSweepErrorV1 ? error.result.nextCursor : current,
      run: ({ cutoff, cursor, maximum, signal }) => runProjectPngGcV1({ ...options, cutoff, cursor, maximum, signal }),
    });
  }
}

export async function createDurableProjectPngGcWorkerV1(
  options: DurableProjectPngGcWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableProjectPngGcWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
