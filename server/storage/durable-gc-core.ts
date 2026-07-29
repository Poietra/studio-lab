export type DurableGcResultV1<Cursor> = Readonly<{
  deleted: number;
  examined: number;
  nextCursor: Cursor | null;
  queued: number;
}>;

export const MIN_DURABLE_GC_GRACE_MS_V1 = 60_000;
export const MAX_DURABLE_GC_GRACE_MS_V1 = 30 * 24 * 60 * 60_000;

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

export type DurableMaintenanceWorkerCoreOptionsV1<Result> = Readonly<{
  intervalMs: number;
  onFailure: (error: unknown) => void;
  run: (signal: AbortSignal) => Promise<Result>;
  startOnceError: string;
  sweepTimeoutMs: number;
  validationPrefix: string;
}>;

/** Timer, deadline, cancellation, and retry lifecycle shared by durable maintenance loops. */
export class DurableMaintenanceWorkerCoreV1<Result> {
  readonly #controller = new AbortController();
  readonly #options: DurableMaintenanceWorkerCoreOptionsV1<Result>;
  readonly #state = { closed: false, healthy: false, started: false };
  #active: Promise<Result> | null = null;
  #closeRequest: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: DurableMaintenanceWorkerCoreOptionsV1<Result>) {
    const prefix = options.validationPrefix;
    const bounds = [
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
    const request = this.#options.run(sweepSignal);
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
      sweepSignal.throwIfAborted();
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

/** Adds bounded listing/grace/cursor semantics to the shared maintenance lifecycle. */
export class DurableGcWorkerCoreV1<
  Result extends DurableGcResultV1<Cursor>,
  Cursor,
> extends DurableMaintenanceWorkerCoreV1<Result> {
  constructor(options: DurableGcWorkerCoreOptionsV1<Result, Cursor>) {
    const bounds = [
      ["batchSize", options.batchSize, 1, 256, "an integer between 1 and 256."],
      [
        "graceMs",
        options.graceMs,
        MIN_DURABLE_GC_GRACE_MS_V1,
        MAX_DURABLE_GC_GRACE_MS_V1,
        "between one minute and 30 days.",
      ],
    ] as const;
    for (const [key, value, minimum, maximum, requirement] of bounds) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${options.validationPrefix} ${key} must be ${requirement}`);
      }
    }
    let cursor: Cursor | null = null;
    super({
      ...options,
      run: async (signal) => {
        const ready = await options.isStorageReady(signal);
        signal.throwIfAborted();
        if (!ready) throw new Error(options.readinessError);
        try {
          const result = await options.run({
            cursor,
            cutoff: new Date(Date.now() - options.graceMs),
            maximum: options.batchSize,
            signal,
          });
          cursor = result.nextCursor;
          return result;
        } catch (error) {
          cursor = options.cursorAfterFailure(error, cursor);
          throw error;
        }
      },
    });
  }
}
