import { type DurableGcResultV1, DurableGcWorkerCoreV1, runDurableGcSweepV1 } from "./durable-gc-core";
import type { RenderArtifactRepositoryV1, RenderArtifactStoreV1 } from "./render-artifact-repository";

export type RenderArtifactGcResultV1 = DurableGcResultV1<string>;

export class RenderArtifactGcSweepErrorV1 extends AggregateError {
  readonly result: RenderArtifactGcResultV1;

  constructor(errors: readonly unknown[], result: RenderArtifactGcResultV1) {
    super(errors, `Render artifact GC could not delete ${errors.length} queued object version(s).`);
    this.name = "RenderArtifactGcSweepErrorV1";
    this.result = result;
  }
}

export async function runRenderArtifactGcV1(
  options: Readonly<{
    artifacts: RenderArtifactStoreV1;
    cutoff: Date;
    cursor?: string | null;
    graceMs: number;
    maximum: number;
    repository: RenderArtifactRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  return runDurableGcSweepV1({
    ...options,
    list: (cutoff, maximum, cursor, signal) =>
      options.artifacts.listVersions(options.tenantId, cutoff, maximum, cursor, signal),
    isPublished: ({ receipt }, signal) => options.repository.isArtifactRetained(options.tenantId, receipt, signal),
    queue: ({ receipt }, signal) =>
      options.repository.queueDeletion(options.tenantId, receipt, options.graceMs, signal),
    pending: (maximum, signal) => options.repository.pendingDeletions(options.tenantId, maximum, signal),
    deleteVersion: ({ receipt, tenantId }, signal) => options.artifacts.deleteVersion(tenantId, receipt, signal),
    acknowledge: ({ deletionId, tenantId }, signal) =>
      options.repository.acknowledgeDeletion(tenantId, deletionId, signal),
    createError: (errors, result) => new RenderArtifactGcSweepErrorV1(errors, result),
  });
}

export type DurableRenderArtifactGcWorkerOptionsV1 = Readonly<{
  artifacts: RenderArtifactStoreV1;
  batchSize: number;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: RenderArtifactRepositoryV1;
  sweepTimeoutMs: number;
  tenantId: string;
}>;

export class DurableRenderArtifactGcWorkerV1 extends DurableGcWorkerCoreV1<RenderArtifactGcResultV1, string> {
  constructor(options: DurableRenderArtifactGcWorkerOptionsV1) {
    super({
      ...options,
      validationPrefix: "Render artifact GC",
      readinessError: "Durable render artifact GC storage readiness is unavailable.",
      startOnceError: "The durable render artifact GC worker can only be started once.",
      isStorageReady: async (signal) => {
        const ready = await Promise.all([options.repository.ready(signal), options.artifacts.ready(signal)]);
        return ready.every(Boolean);
      },
      cursorAfterFailure: (error, current) =>
        error instanceof RenderArtifactGcSweepErrorV1 ? error.result.nextCursor : current,
      run: ({ cutoff, cursor, maximum, signal }) =>
        runRenderArtifactGcV1({ ...options, cutoff, cursor, maximum, signal }),
    });
  }
}

export async function createDurableRenderArtifactGcWorkerV1(
  options: DurableRenderArtifactGcWorkerOptionsV1,
  signal?: AbortSignal,
) {
  const worker = new DurableRenderArtifactGcWorkerV1(options);
  try {
    return await worker.start(signal);
  } catch (error) {
    await worker.close();
    throw error;
  }
}
