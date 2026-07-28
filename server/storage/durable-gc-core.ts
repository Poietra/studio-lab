export type DurableGcResultV1<Cursor> = Readonly<{
  deleted: number;
  examined: number;
  nextCursor: Cursor | null;
  queued: number;
}>;

type DurableGcSweepOptionsV1<Candidate, Deletion, Cursor> = Readonly<{
  acknowledge: (deletion: Deletion, signal?: AbortSignal) => Promise<void>;
  createError: (errors: readonly unknown[], result: DurableGcResultV1<Cursor>) => unknown;
  cursor?: Cursor | null;
  deleteVersion: (deletion: Deletion, signal?: AbortSignal) => Promise<void>;
  isPublished: (candidate: Candidate, signal?: AbortSignal) => Promise<boolean>;
  list: (
    cutoff: Date,
    maximum: number,
    cursor: Cursor | null | undefined,
    signal?: AbortSignal,
  ) => Promise<Readonly<{ nextCursor: Cursor | null; versions: readonly Candidate[] }>>;
  pending: (maximum: number, signal?: AbortSignal) => Promise<readonly Deletion[]>;
  queue: (candidate: Candidate, signal?: AbortSignal) => Promise<unknown>;
  cutoff: Date;
  maximum: number;
  signal?: AbortSignal;
}>;

export async function runDurableGcSweepV1<C, D, K>(options: DurableGcSweepOptionsV1<C, D, K>) {
  if (!Number.isSafeInteger(options.maximum) || options.maximum <= 0 || options.maximum > 256) {
    throw new RangeError("maximum must be an integer between 1 and 256.");
  }
  options.signal?.throwIfAborted();
  const page = await options.list(options.cutoff, options.maximum, options.cursor, options.signal);
  let queued = 0;
  for (const candidate of page.versions) {
    options.signal?.throwIfAborted();
    if (!(await options.isPublished(candidate, options.signal)) && (await options.queue(candidate, options.signal))) {
      queued += 1;
    }
  }

  let deleted = 0;
  const deletionErrors: unknown[] = [];
  for (const deletion of await options.pending(options.maximum, options.signal)) {
    options.signal?.throwIfAborted();
    try {
      await options.deleteVersion(deletion, options.signal);
      await options.acknowledge(deletion, options.signal);
      deleted += 1;
    } catch (error) {
      options.signal?.throwIfAborted();
      deletionErrors.push(error);
    }
  }
  const result = { deleted, examined: page.versions.length, nextCursor: page.nextCursor, queued } as const;
  if (deletionErrors.length > 0) throw options.createError(deletionErrors, result);
  return result;
}

export type DurableGcWorkerCoreOptionsV1<Result extends DurableGcResultV1<Cursor>, Cursor> = Readonly<{
  batchSize: number;
  cursorAfterFailure: (error: unknown, current: Cursor | null) => Cursor | null;
  graceMs: number;
  intervalMs: number;
  isStorageReady: (signal: AbortSignal) => Promise<boolean>;
  onFailure: (error: unknown) => void;
  readinessError: string;
  run: (options: { cutoff: Date; cursor: Cursor | null; maximum: number; signal: AbortSignal }) => Promise<Result>;
  startOnceError: string;
  sweepTimeoutMs: number;
  validationPrefix: string;
}>;

/** Timer and cancellation lifecycle shared by explicitly composed durable maintenance loops. */
export class DurableGcWorkerCoreV1<Result extends DurableGcResultV1<Cursor>, Cursor> {
  readonly #controller = new AbortController();
  readonly #options: DurableGcWorkerCoreOptionsV1<Result, Cursor>;
  readonly #state = { closed: false, healthy: false, started: false };
  #active: Promise<Result> | null = null;
  #closeRequest: Promise<void> | null = null;
  #cursor: Cursor | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: DurableGcWorkerCoreOptionsV1<Result, Cursor>) {
    const prefix = options.validationPrefix;
    const bounds = [
      ["batchSize", 1, 256, "an integer between 1 and 256."],
      ["graceMs", 60_000, 30 * 24 * 60 * 60_000, "between one minute and 30 days."],
      ["intervalMs", 1_000, 24 * 60 * 60_000, "between one second and one day."],
      ["sweepTimeoutMs", 1_000, 5 * 60_000, "between one second and five minutes."],
    ] as const;
    for (const [key, minimum, maximum, requirement] of bounds) {
      const value = options[key];
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${prefix} ${key} must be ${requirement}`);
      }
    }
    this.#options = options;
  }

  async #sweep(signal: AbortSignal) {
    const sweepSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#options.sweepTimeoutMs)]);
    const request = (async () => {
      const ready = await this.#options.isStorageReady(sweepSignal);
      sweepSignal.throwIfAborted();
      if (!ready) throw new Error(this.#options.readinessError);
      try {
        const result = await this.#options.run({
          cursor: this.#cursor,
          cutoff: new Date(Date.now() - this.#options.graceMs),
          maximum: this.#options.batchSize,
          signal: sweepSignal,
        });
        this.#cursor = result.nextCursor;
        return result;
      } catch (error) {
        this.#cursor = this.#options.cursorAfterFailure(error, this.#cursor);
        throw error;
      }
    })();
    this.#active = request;
    try {
      const result = await request;
      this.#state.healthy = true;
      return result;
    } finally {
      if (this.#active === request) this.#active = null;
    }
  }

  #schedule() {
    if (this.#state.closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#sweep(this.#controller.signal)
        .catch((error: unknown) => {
          if (this.#state.closed || this.#controller.signal.aborted) return;
          this.#state.healthy = false;
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

  async start(signal?: AbortSignal): Promise<this> {
    if (this.#state.started || this.#state.closed) throw new Error(this.#options.startOnceError);
    this.#state.started = true;
    const sweepSignal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    try {
      await this.#sweep(sweepSignal);
      this.#schedule();
      return this;
    } catch (error) {
      this.#state.healthy = false;
      throw error;
    }
  }

  ready() {
    return this.#state.started && !this.#state.closed && this.#state.healthy;
  }

  close() {
    this.#closeRequest ??= (async () => {
      this.#state.closed = true;
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      this.#controller.abort();
      await this.#active?.catch(() => undefined);
      this.#state.healthy = false;
    })();
    return this.#closeRequest;
  }
}
