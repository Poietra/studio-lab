import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

export const POSTGRES_REPOSITORY_OPTIONS_V1 = "-c search_path=pg_catalog,public";

export type PostgresRepositoryConnectionOptionsV1 = Readonly<{
  pool?: Pool;
  poolConfig?: PoolConfig;
  statementTimeoutMs?: number;
}>;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function boundedPositiveInteger(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function configuredPoolTimeout(value: false | number | undefined, fallback: number, name: string) {
  if (value === undefined || value === false || value === 0) return fallback;
  return Math.min(boundedPositiveInteger(value, name, 30_000), fallback);
}

function assertBoundedInjectedPool(pool: Pool, maximumTimeoutMs: number) {
  for (const name of ["connectionTimeoutMillis", "query_timeout", "statement_timeout"] as const) {
    const value = pool.options[name];
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximumTimeoutMs) {
      throw new TypeError(`An injected PostgreSQL pool requires a positive bounded ${name}.`);
    }
  }
  if (pool.options.options !== POSTGRES_REPOSITORY_OPTIONS_V1) {
    throw new TypeError("An injected PostgreSQL pool requires the fixed workspace/source search_path.");
  }
}

/** Shared bounded pool lifecycle for durable PostgreSQL repositories. */
export class PostgresRepositoryConnectionV1 {
  readonly #ownsPool: boolean;
  readonly #pool: Pool;
  readonly #statementTimeoutMs: number;

  constructor(options: PostgresRepositoryConnectionOptionsV1) {
    if ((options.pool === undefined) === (options.poolConfig === undefined)) {
      throw new TypeError("Provide exactly one PostgreSQL pool or pool configuration.");
    }
    this.#statementTimeoutMs = boundedPositiveInteger(
      options.statementTimeoutMs ?? 5_000,
      "statementTimeoutMs",
      30_000,
    );
    if (options.pool) assertBoundedInjectedPool(options.pool, this.#statementTimeoutMs);
    this.#pool =
      options.pool ??
      new Pool({
        ...options.poolConfig,
        connectionTimeoutMillis: configuredPoolTimeout(
          options.poolConfig?.connectionTimeoutMillis,
          this.#statementTimeoutMs,
          "connectionTimeoutMillis",
        ),
        query_timeout: configuredPoolTimeout(
          options.poolConfig?.query_timeout,
          this.#statementTimeoutMs,
          "query_timeout",
        ),
        statement_timeout: configuredPoolTimeout(
          options.poolConfig?.statement_timeout,
          this.#statementTimeoutMs,
          "statement_timeout",
        ),
        options: POSTGRES_REPOSITORY_OPTIONS_V1,
      });
    this.#ownsPool = options.pool === undefined;
  }

  async #connect(signal?: AbortSignal) {
    // Do not start pool acquisition for work the caller already cancelled.
    throwIfAborted(signal);
    const request = this.#pool.connect();
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("PostgreSQL connection acquisition timed out.")),
        this.#statementTimeoutMs,
      );
      // Node timers expose `unref`; Workers use numeric Web-standard timers.
      if (typeof timeout === "object" && typeof timeout.unref === "function") timeout.unref();
      if (signal) {
        abortListener = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", abortListener, { once: true });
        // `pool.connect()` is injectable and may synchronously abort before
        // this listener is installed while leaving acquisition pending.
        if (signal.aborted) abortListener();
      }
    });
    try {
      const client = await Promise.race([request, interrupted]);
      // `pool.connect()` may resolve while cancellation wins before its abort
      // listener is installed. Recheck before transferring client ownership.
      throwIfAborted(signal);
      settled = true;
      return client;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (!settled) void request.then((client) => client.release(true)).catch(() => undefined);
    }
  }

  async withClient<T>(operation: (client: PoolClient) => Promise<T>, signal?: AbortSignal) {
    const client = await this.#connect(signal);
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
    signal?: AbortSignal,
  ) {
    const client = await this.#connect(signal);
    try {
      throwIfAborted(signal);
      const result = await client.query<Row>(text, [...values]);
      throwIfAborted(signal);
      return result;
    } finally {
      client.release();
    }
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>, signal?: AbortSignal) {
    const client = await this.#connect(signal);
    let began = false;
    try {
      throwIfAborted(signal);
      await client.query("BEGIN");
      began = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.#statementTimeoutMs)]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [String(this.#statementTimeoutMs)]);
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
        String(this.#statementTimeoutMs),
      ]);
      const result = await operation(client);
      throwIfAborted(signal);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.#ownsPool) await this.#pool.end();
  }
}
