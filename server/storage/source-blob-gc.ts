import type { SourceContentBlobStoreV1, WorkspaceSourceRepositoryV1 } from "./workspace-source-repository";

export type SourceBlobGcResultV1 = Readonly<{ deleted: number; examined: number; queued: number }>;

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
    maximum: number;
    repository: WorkspaceSourceRepositoryV1;
    signal?: AbortSignal;
    tenantId: string;
  }>,
) {
  if (!Number.isSafeInteger(options.maximum) || options.maximum <= 0 || options.maximum > 256) {
    throw new RangeError("maximum must be an integer between 1 and 256.");
  }
  options.signal?.throwIfAborted();
  // DB-published receipts are intentionally retained until a later history/
  // reference model can assign an orphaned-at time. This sweep only collects
  // immutable S3 versions that were never published (for example after a
  // failed transaction or losing CAS), so grace is based on S3 LastModified.
  const versions = await options.blobs.listSourceVersions(
    options.tenantId,
    options.cutoff,
    options.maximum,
    options.signal,
  );
  let queued = 0;
  for (const { blob } of versions) {
    options.signal?.throwIfAborted();
    if (await options.repository.isBlobVersionPublished(options.tenantId, blob, options.signal)) continue;
    if (await options.repository.queueBlobDeletion(options.tenantId, blob, options.signal)) queued += 1;
  }

  const pending = await options.repository.pendingBlobDeletions(options.tenantId, options.maximum, options.signal);
  let deleted = 0;
  const deletionErrors: unknown[] = [];
  for (const deletion of pending) {
    options.signal?.throwIfAborted();
    try {
      await options.blobs.deleteVersion(deletion.tenantId, deletion.blob, options.signal);
      await options.repository.acknowledgeBlobDeletion(deletion.tenantId, deletion.deletionId, options.signal);
      deleted += 1;
    } catch (error) {
      options.signal?.throwIfAborted();
      deletionErrors.push(error);
    }
  }
  const result = { deleted, examined: versions.length, queued } as const;
  if (deletionErrors.length > 0) throw new SourceBlobGcSweepErrorV1(deletionErrors, result);
  return result;
}

export type DurableSourceBlobGcWorkerOptionsV1 = Readonly<{
  batchSize: number;
  blobs: SourceContentBlobStoreV1;
  graceMs: number;
  intervalMs: number;
  onFailure: (error: unknown) => void;
  repository: WorkspaceSourceRepositoryV1;
  tenantId: string;
}>;

/** One explicitly composed tenant maintenance loop; it never owns DB/S3 clients. */
export class DurableSourceBlobGcWorkerV1 {
  readonly #controller = new AbortController();
  readonly #options: DurableSourceBlobGcWorkerOptionsV1;
  #active: Promise<SourceBlobGcResultV1> | null = null;
  #closeRequest: Promise<void> | null = null;
  #closed = false;
  #healthy = false;
  #started = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: DurableSourceBlobGcWorkerOptionsV1) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0 || options.batchSize > 256) {
      throw new RangeError("Source GC batchSize must be an integer between 1 and 256.");
    }
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 60_000 || options.graceMs > 30 * 24 * 60 * 60_000) {
      throw new RangeError("Source GC graceMs must be between one minute and 30 days.");
    }
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1_000 ||
      options.intervalMs > 24 * 60 * 60_000
    ) {
      throw new RangeError("Source GC intervalMs must be between one second and one day.");
    }
    this.#options = options;
  }

  async #sweep(signal: AbortSignal) {
    const request = (async () => {
      const [repositoryReady, blobsReady] = await Promise.all([
        this.#options.repository.ready(signal),
        this.#options.blobs.ready(signal),
      ]);
      signal.throwIfAborted();
      if (!repositoryReady || !blobsReady) {
        throw new Error("Durable source GC storage readiness is unavailable.");
      }
      return runSourceBlobGcV1({
        blobs: this.#options.blobs,
        cutoff: new Date(Date.now() - this.#options.graceMs),
        maximum: this.#options.batchSize,
        repository: this.#options.repository,
        signal,
        tenantId: this.#options.tenantId,
      });
    })();
    this.#active = request;
    try {
      const result = await request;
      this.#healthy = true;
      return result;
    } finally {
      if (this.#active === request) this.#active = null;
    }
  }

  #schedule() {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#sweep(this.#controller.signal)
        .catch((error: unknown) => {
          if (this.#closed || this.#controller.signal.aborted) return;
          this.#healthy = false;
          try {
            this.#options.onFailure(error);
          } catch {
            // A diagnostic hook cannot stop later maintenance retries.
          }
        })
        .finally(() => this.#schedule());
    }, this.#options.intervalMs);
    this.#timer.unref();
  }

  async start(signal?: AbortSignal) {
    if (this.#started || this.#closed) throw new Error("The durable source GC worker can only be started once.");
    this.#started = true;
    const sweepSignal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    try {
      await this.#sweep(sweepSignal);
      this.#schedule();
      return this;
    } catch (error) {
      this.#healthy = false;
      throw error;
    }
  }

  ready() {
    return this.#started && !this.#closed && this.#healthy;
  }

  close() {
    this.#closeRequest ??= (async () => {
      this.#closed = true;
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      this.#controller.abort();
      await this.#active?.catch(() => undefined);
      this.#healthy = false;
    })();
    return this.#closeRequest;
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
