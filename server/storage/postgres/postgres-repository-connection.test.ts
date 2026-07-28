import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { POSTGRES_REPOSITORY_OPTIONS_V1, PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

function fakePool(timeoutMs = 5_000) {
  const query = vi.fn(async () => ({ fields: [], rowCount: 0, rows: [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const end = vi.fn(async () => undefined);
  const pool = {
    connect,
    end,
    options: {
      connectionTimeoutMillis: timeoutMs,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
    },
  } as unknown as Pool;
  return { client, connect, end, pool, query, release };
}

describe("PostgresRepositoryConnectionV1", () => {
  it.each([
    [
      "withClient",
      (connection: PostgresRepositoryConnectionV1, signal: AbortSignal) =>
        connection.withClient(async () => undefined, signal),
    ],
    [
      "query",
      (connection: PostgresRepositoryConnectionV1, signal: AbortSignal) => connection.query("SELECT 1", [], signal),
    ],
    [
      "transaction",
      (connection: PostgresRepositoryConnectionV1, signal: AbortSignal) =>
        connection.transaction(async () => undefined, signal),
    ],
  ])("rejects an already-aborted %s before acquiring a pool client", async (_name, execute) => {
    const fixture = fakePool();
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });
    const controller = new AbortController();
    const reason = new Error("cancelled before PostgreSQL acquisition");
    controller.abort(reason);

    await expect(execute(connection, controller.signal)).rejects.toBe(reason);
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it("destroys a client that arrives after acquisition is aborted", async () => {
    const fixture = fakePool();
    let resolveClient: ((client: PoolClient) => void) | undefined;
    fixture.connect.mockImplementation(
      () =>
        new Promise<PoolClient>((resolve) => {
          resolveClient = resolve;
        }),
    );
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });
    const controller = new AbortController();
    const reason = new Error("cancelled during PostgreSQL acquisition");

    const result = connection.query("SELECT 1", [], controller.signal);
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    resolveClient?.(fixture.client);
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(true));
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("destroys a client when cancellation races synchronous pool acquisition", async () => {
    const fixture = fakePool();
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });
    const controller = new AbortController();
    const reason = new Error("cancelled as PostgreSQL acquisition resolved");
    fixture.connect.mockImplementation(() => {
      controller.abort(reason);
      return Promise.resolve(fixture.client);
    });
    const operation = vi.fn(async () => undefined);

    await expect(connection.withClient(operation, controller.signal)).rejects.toBe(reason);
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(true));
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects immediately when pool acquisition synchronously aborts and remains pending", async () => {
    const fixture = fakePool(50);
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool, statementTimeoutMs: 50 });
    const controller = new AbortController();
    const reason = new Error("cancelled before the acquisition listener was installed");
    fixture.connect.mockImplementation(() => {
      controller.abort(reason);
      return new Promise<PoolClient>(() => undefined);
    });

    await expect(connection.query("SELECT 1", [], controller.signal)).rejects.toBe(reason);
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it("contains a synchronous failure while destroying a late client", async () => {
    const fixture = fakePool();
    let resolveClient: ((client: PoolClient) => void) | undefined;
    fixture.connect.mockImplementation(
      () =>
        new Promise<PoolClient>((resolve) => {
          resolveClient = resolve;
        }),
    );
    fixture.release.mockImplementation(() => {
      throw new Error("late client release failed");
    });
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });
    const controller = new AbortController();
    const result = connection.query("SELECT 1", [], controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    resolveClient?.(fixture.client);
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(true));
  });

  it("preserves transaction timeout setup and commit ordering", async () => {
    const fixture = fakePool(4_000);
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool, statementTimeoutMs: 4_000 });

    await expect(
      connection.transaction(async (client) => {
        await client.query("SELECT domain_operation");
        return "committed";
      }),
    ).resolves.toBe("committed");

    expect(fixture.query.mock.calls).toEqual([
      ["BEGIN"],
      ["SELECT set_config('statement_timeout', $1, true)", ["4000"]],
      ["SELECT set_config('lock_timeout', $1, true)", ["4000"]],
      ["SELECT set_config('idle_in_transaction_session_timeout', $1, true)", ["4000"]],
      ["SELECT domain_operation"],
      ["COMMIT"],
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the acquired client when an operation fails", async () => {
    const fixture = fakePool();
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });
    const failure = new Error("domain operation failed");

    await expect(
      connection.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(fixture.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("does not close an injected pool", async () => {
    const fixture = fakePool();
    const connection = new PostgresRepositoryConnectionV1({ pool: fixture.pool });

    await connection.close();

    expect(fixture.end).not.toHaveBeenCalled();
  });
});
