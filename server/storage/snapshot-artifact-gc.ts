import type { SnapshotArtifactStoreV1, SnapshotPublicationRepositoryV1 } from "./snapshot-publication-repository";

export type SnapshotArtifactGcResultV1 = Readonly<{
  deleted: number;
  examined: number;
  nextCursor: string | null;
  queued: number;
}>;

export class SnapshotArtifactGcSweepErrorV1 extends AggregateError {
  readonly result: SnapshotArtifactGcResultV1;

  constructor(errors: readonly unknown[], result: SnapshotArtifactGcResultV1) {
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
  if (!Number.isSafeInteger(options.maximum) || options.maximum <= 0 || options.maximum > 256) {
    throw new RangeError("maximum must be an integer between 1 and 256.");
  }
  options.signal?.throwIfAborted();
  // Artifact versions only enter the deletion queue after the publication
  // repository confirms that no current scene head references the exact
  // receipt. LastModified therefore supplies the grace period for uploads
  // orphaned between S3 put and the publication transaction.
  const page = await options.artifacts.listVersions(
    options.tenantId,
    options.cutoff,
    options.maximum,
    options.cursor,
    options.signal,
  );
  let queued = 0;
  for (const { artifact } of page.versions) {
    options.signal?.throwIfAborted();
    if (await options.repository.isArtifactPublished(options.tenantId, artifact, options.signal)) continue;
    if (await options.repository.queueArtifactDeletion(options.tenantId, artifact, options.signal)) queued += 1;
  }

  const pending = await options.repository.pendingArtifactDeletions(options.tenantId, options.maximum, options.signal);
  let deleted = 0;
  const deletionErrors: unknown[] = [];
  for (const deletion of pending) {
    options.signal?.throwIfAborted();
    try {
      await options.artifacts.deleteVersion(deletion.tenantId, deletion.artifact, options.signal);
      await options.repository.acknowledgeArtifactDeletion(deletion.tenantId, deletion.deletionId, options.signal);
      deleted += 1;
    } catch (error) {
      options.signal?.throwIfAborted();
      deletionErrors.push(error);
    }
  }
  const result = { deleted, examined: page.versions.length, nextCursor: page.nextCursor, queued } as const;
  if (deletionErrors.length > 0) throw new SnapshotArtifactGcSweepErrorV1(deletionErrors, result);
  return result;
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

/** One explicitly composed tenant maintenance loop; it never owns DB/S3 clients. */
export class DurableSnapshotArtifactGcWorkerV1 {
  readonly #controller = new AbortController();
  readonly #options: DurableSnapshotArtifactGcWorkerOptionsV1;
  #active: Promise<SnapshotArtifactGcResultV1> | null = null;
  #closeRequest: Promise<void> | null = null;
  #closed = false;
  #cursor: string | null = null;
  #healthy = false;
  #started = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: DurableSnapshotArtifactGcWorkerOptionsV1) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize <= 0 || options.batchSize > 256) {
      throw new RangeError("Snapshot artifact GC batchSize must be an integer between 1 and 256.");
    }
    if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 60_000 || options.graceMs > 30 * 24 * 60 * 60_000) {
      throw new RangeError("Snapshot artifact GC graceMs must be between one minute and 30 days.");
    }
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1_000 ||
      options.intervalMs > 24 * 60 * 60_000
    ) {
      throw new RangeError("Snapshot artifact GC intervalMs must be between one second and one day.");
    }
    if (
      !Number.isSafeInteger(options.sweepTimeoutMs) ||
      options.sweepTimeoutMs < 1_000 ||
      options.sweepTimeoutMs > 5 * 60_000
    ) {
      throw new RangeError("Snapshot artifact GC sweepTimeoutMs must be between one second and five minutes.");
    }
    this.#options = options;
  }

  async #sweep(signal: AbortSignal) {
    const sweepSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#options.sweepTimeoutMs)]);
    const request = (async () => {
      const [repositoryReady, artifactsReady] = await Promise.all([
        this.#options.repository.ready(sweepSignal),
        this.#options.artifacts.ready(sweepSignal),
      ]);
      sweepSignal.throwIfAborted();
      if (!repositoryReady || !artifactsReady) {
        throw new Error("Durable snapshot artifact GC storage readiness is unavailable.");
      }
      try {
        const result = await runSnapshotArtifactGcV1({
          artifacts: this.#options.artifacts,
          cursor: this.#cursor,
          cutoff: new Date(Date.now() - this.#options.graceMs),
          maximum: this.#options.batchSize,
          repository: this.#options.repository,
          signal: sweepSignal,
          tenantId: this.#options.tenantId,
        });
        this.#cursor = result.nextCursor;
        return result;
      } catch (error) {
        // A failed exact-version delete remains in the durable queue. Advance
        // the object-list cursor so that one failure cannot starve later
        // upload orphans from discovery.
        if (error instanceof SnapshotArtifactGcSweepErrorV1) this.#cursor = error.result.nextCursor;
        throw error;
      }
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
    if (this.#started || this.#closed) {
      throw new Error("The durable snapshot artifact GC worker can only be started once.");
    }
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
