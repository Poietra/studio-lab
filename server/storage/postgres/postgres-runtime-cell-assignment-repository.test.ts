import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import { PostgresRuntimeCellAssignmentRepositoryV1 } from "./postgres-runtime-cell-assignment-repository";
import { RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM } from "./runtime-cell-assignment-schema";

const TENANT_A = "organization-a";
const TENANT_B = "organization-b";
const CELL_A = "cell-a";
const CELL_B = "cell-b";
const CELL_C = "cell-c";
const MUTATION_A = "11111111-1111-4111-8111-111111111111";
const MUTATION_B = "22222222-2222-4222-8222-222222222222";
const MUTATION_C = "33333333-3333-4333-8333-333333333333";
const MUTATION_D = "44444444-4444-4444-8444-444444444444";
const UPPERCASE_MUTATION = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

type AssignmentRow = {
  cell_id: string;
  generation: string;
  state: "active" | "disabled";
  tenant_id: string;
};

type MutationRow = {
  expected_generation: string | null;
  kind: "create" | "disable" | "rotate";
  mutation_id: string;
  request_cell_id: string | null;
  result_cell_id: string;
  result_generation: string;
  result_state: "active" | "disabled";
  tenant_id: string;
};

type Snapshot = {
  assignments: Map<string, AssignmentRow>;
  mutations: Map<string, MutationRow>;
};

type ClientContext = {
  releaseTransaction: (() => void) | null;
  snapshot: Snapshot | null;
};

function copyMap<T extends Record<string, unknown>>(source: Map<string, T>) {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

class FakeRuntimeCellDatabase {
  readonly assignments = new Map<string, AssignmentRow>();
  readonly mutations = new Map<string, MutationRow>();
  readonly organizations = new Map<string, "active" | "suspended">([
    [TENANT_A, "active"],
    [TENANT_B, "active"],
  ]);
  readonly pool: Pool;
  readonly queryTexts: string[] = [];
  releaseCount = 0;
  migrationChecksum = RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM;
  afterQuery: ((text: string) => void) | null = null;
  failNext: { error: Error & { code?: string }; pattern: string } | null = null;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor() {
    this.pool = {
      connect: vi.fn(async () => {
        const context: ClientContext = { releaseTransaction: null, snapshot: null };
        return {
          query: vi.fn(async (text: string, values: readonly unknown[] = []) => this.#query(context, text, values)),
          release: vi.fn(() => {
            this.releaseCount += 1;
          }),
        } as unknown as PoolClient;
      }),
      end: vi.fn(async () => undefined),
      options: {
        connectionTimeoutMillis: 5_000,
        options: POSTGRES_REPOSITORY_OPTIONS_V1,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      },
    } as unknown as Pool;
  }

  snapshot(): Snapshot {
    return { assignments: copyMap(this.assignments), mutations: copyMap(this.mutations) };
  }

  async #begin(context: ClientContext) {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    context.releaseTransaction = release;
    context.snapshot = this.snapshot();
  }

  #finish(context: ClientContext, rollback: boolean) {
    if (rollback && context.snapshot) {
      this.assignments.clear();
      this.mutations.clear();
      for (const [key, value] of context.snapshot.assignments) this.assignments.set(key, { ...value });
      for (const [key, value] of context.snapshot.mutations) this.mutations.set(key, { ...value });
    }
    context.snapshot = null;
    context.releaseTransaction?.();
    context.releaseTransaction = null;
  }

  async #query(context: ClientContext, text: string, values: readonly unknown[]) {
    this.queryTexts.push(text);
    const failure = this.failNext;
    if (failure && text.includes(failure.pattern)) {
      this.failNext = null;
      throw failure.error;
    }
    let rows: readonly unknown[];
    if (text === "BEGIN") {
      await this.#begin(context);
      rows = [];
    } else if (text === "COMMIT") {
      this.#finish(context, false);
      rows = [];
    } else if (text === "ROLLBACK") {
      this.#finish(context, true);
      rows = [];
    } else if (text.startsWith("SELECT set_config")) {
      rows = [];
    } else {
      rows = this.#dataQuery(text, values);
    }
    this.afterQuery?.(text);
    return { rowCount: rows.length, rows };
  }

  #dataQuery(text: string, values: readonly unknown[]): readonly unknown[] {
    if (text.includes("FROM public.poietra_schema_migrations")) {
      return [{ checksum: this.migrationChecksum, version: 29 }];
    }
    if (text.includes("FROM public.organizations organization") && text.includes("FOR UPDATE OF organization")) {
      const tenantId = values[0] as string;
      const status = this.organizations.get(tenantId);
      return status ? [{ status, tenant_id: tenantId }] : [];
    }
    if (text.includes("FROM public.runtime_cell_assignment_mutations mutation") && !text.includes("INSERT INTO")) {
      const row = this.mutations.get(`${values[0]}:${values[1]}`);
      return row ? [{ ...row }] : [];
    }
    if (text.includes("INSERT INTO public.runtime_cell_assignments")) {
      const [tenantId, cellId] = values as readonly [string, string];
      if (this.assignments.has(tenantId) || [...this.assignments.values()].some((row) => row.cell_id === cellId)) {
        return [];
      }
      const row: AssignmentRow = { cell_id: cellId, generation: "1", state: "active", tenant_id: tenantId };
      this.assignments.set(tenantId, row);
      return [{ ...row }];
    }
    if (text.includes("INSERT INTO public.runtime_cell_assignment_mutations")) {
      const [tenantId, mutationId, kind, requestCellId, expectedGeneration, resultCellId, resultGeneration, state] =
        values as readonly [
          string,
          string,
          MutationRow["kind"],
          string | null,
          number | null,
          string,
          number,
          MutationRow["result_state"],
        ];
      const key = `${tenantId}:${mutationId}`;
      if (
        this.mutations.has(key) ||
        [...this.mutations.values()].some(
          (row) =>
            (kind === "create" || kind === "rotate") &&
            (row.kind === "create" || row.kind === "rotate") &&
            row.result_cell_id === resultCellId,
        ) ||
        [...this.mutations.values()].some(
          (row) => row.tenant_id === tenantId && row.result_generation === String(resultGeneration),
        )
      ) {
        return [];
      }
      if (!this.assignments.has(tenantId)) {
        throw Object.assign(new Error("foreign key"), { code: "23503" });
      }
      this.mutations.set(key, {
        expected_generation: expectedGeneration === null ? null : String(expectedGeneration),
        kind,
        mutation_id: mutationId,
        request_cell_id: requestCellId,
        result_cell_id: resultCellId,
        result_generation: String(resultGeneration),
        result_state: state,
        tenant_id: tenantId,
      });
      return [{ inserted: 1 }];
    }
    if (text.includes("UPDATE public.runtime_cell_assignments assignment")) {
      const [tenantId, cellId, generation, state, expectedGeneration] = values as readonly [
        string,
        string,
        number,
        AssignmentRow["state"],
        number,
      ];
      const current = this.assignments.get(tenantId);
      if (!current || current.state !== "active" || current.generation !== String(expectedGeneration)) return [];
      if ([...this.assignments.values()].some((row) => row.tenant_id !== tenantId && row.cell_id === cellId)) {
        throw Object.assign(new Error("unique violation"), { code: "23505" });
      }
      const updated: AssignmentRow = {
        cell_id: cellId,
        generation: String(generation),
        state,
        tenant_id: tenantId,
      };
      this.assignments.set(tenantId, updated);
      return [{ ...updated }];
    }
    if (
      text.includes("FROM public.runtime_cell_assignments assignment") &&
      text.includes("JOIN public.organizations organization")
    ) {
      const tenantId = values[0] as string;
      const row = this.assignments.get(tenantId);
      return row && this.organizations.get(tenantId) === "active" ? [{ ...row }] : [];
    }
    if (text.includes("FROM public.runtime_cell_assignments assignment") && text.includes("FOR UPDATE OF assignment")) {
      const row = this.assignments.get(values[0] as string);
      return row ? [{ ...row }] : [];
    }
    throw new Error("Unexpected fake PostgreSQL query.");
  }
}

function repository(database = new FakeRuntimeCellDatabase()) {
  return { database, repository: new PostgresRuntimeCellAssignmentRepositoryV1({ pool: database.pool }) };
}

function createInput(tenantId = TENANT_A, cellId = CELL_A, mutationId = MUTATION_A) {
  return { cellId, expectedGeneration: 0, mutationId, tenantId } as const;
}

function signal() {
  return new AbortController().signal;
}

describe("PostgresRuntimeCellAssignmentRepositoryV1", () => {
  it("checks migration readiness and resolves only active organizations while retaining disabled drain evidence", async () => {
    const fixture = repository();
    await expect(fixture.repository.ready(signal())).resolves.toBe(true);
    fixture.database.migrationChecksum = "0".repeat(64);
    await expect(fixture.repository.ready(signal())).resolves.toBe(false);

    await expect(fixture.repository.createAssignment(createInput(), signal())).resolves.toMatchObject({
      assignment: { cellId: CELL_A, generation: 1, state: "active", tenantId: TENANT_A },
      kind: "applied",
      replayed: false,
    });
    await expect(fixture.repository.resolve(TENANT_A, signal())).resolves.toMatchObject({ state: "active" });
    await expect(
      fixture.repository.disableAssignment(
        { expectedGeneration: 1, mutationId: MUTATION_B, tenantId: TENANT_A },
        signal(),
      ),
    ).resolves.toMatchObject({ assignment: { cellId: CELL_A, generation: 2, state: "disabled" } });
    await expect(fixture.repository.resolve(TENANT_A, signal())).resolves.toMatchObject({
      cellId: CELL_A,
      generation: 2,
      state: "disabled",
    });

    fixture.database.organizations.set(TENANT_A, "suspended");
    await expect(fixture.repository.resolve(TENANT_A, signal())).resolves.toBeNull();
    await expect(fixture.repository.resolve("organization-missing", signal())).resolves.toBeNull();
  });

  it("serializes concurrent exact create retries and rejects mutation-key payload reuse", async () => {
    const fixture = repository();
    const input = createInput(TENANT_A, CELL_A, UPPERCASE_MUTATION);
    const results = await Promise.all([
      fixture.repository.createAssignment(input, signal()),
      fixture.repository.createAssignment(input, signal()),
    ]);

    expect(results).toEqual([
      {
        assignment: { cellId: CELL_A, generation: 1, state: "active", tenantId: TENANT_A },
        kind: "applied",
        replayed: false,
      },
      {
        assignment: { cellId: CELL_A, generation: 1, state: "active", tenantId: TENANT_A },
        kind: "applied",
        replayed: true,
      },
    ]);
    await expect(
      fixture.repository.createAssignment(createInput(TENANT_A, CELL_B, MUTATION_A), signal()),
    ).resolves.toEqual({ kind: "conflict" });
    expect(fixture.database.queryTexts.some((text) => text.includes("FOR UPDATE OF organization"))).toBe(true);
    expect(fixture.database.mutations.has(`${TENANT_A}:${UPPERCASE_MUTATION.toLowerCase()}`)).toBe(true);
    expect(fixture.database.assignments.get(TENANT_A)).toMatchObject({ cell_id: CELL_A, generation: "1" });
  });

  it("allows only one concurrent rotation at an expected generation and exactly replays the winner", async () => {
    const fixture = repository();
    await fixture.repository.createAssignment(createInput(), signal());
    const first = { cellId: CELL_B, expectedGeneration: 1, mutationId: MUTATION_B, tenantId: TENANT_A } as const;
    const second = { cellId: CELL_C, expectedGeneration: 1, mutationId: MUTATION_C, tenantId: TENANT_A } as const;

    const results = await Promise.all([
      fixture.repository.rotateAssignment(first, signal()),
      fixture.repository.rotateAssignment(second, signal()),
    ]);
    expect(results).toEqual([
      {
        assignment: { cellId: CELL_B, generation: 2, state: "active", tenantId: TENANT_A },
        kind: "applied",
        replayed: false,
      },
      { kind: "conflict" },
    ]);
    await expect(fixture.repository.rotateAssignment(first, signal())).resolves.toEqual({
      assignment: { cellId: CELL_B, generation: 2, state: "active", tenantId: TENANT_A },
      kind: "applied",
      replayed: true,
    });
  });

  it("disables with the same cell and next generation, then fails missing, disabled, and stale mutations closed", async () => {
    const fixture = repository();
    await fixture.repository.createAssignment(createInput(), signal());
    await fixture.repository.rotateAssignment(
      { cellId: CELL_B, expectedGeneration: 1, mutationId: MUTATION_B, tenantId: TENANT_A },
      signal(),
    );
    const disable = { expectedGeneration: 2, mutationId: MUTATION_C, tenantId: TENANT_A } as const;

    await expect(fixture.repository.disableAssignment(disable, signal())).resolves.toEqual({
      assignment: { cellId: CELL_B, generation: 3, state: "disabled", tenantId: TENANT_A },
      kind: "applied",
      replayed: false,
    });
    await expect(fixture.repository.disableAssignment(disable, signal())).resolves.toMatchObject({
      assignment: { cellId: CELL_B, generation: 3, state: "disabled" },
      kind: "applied",
      replayed: true,
    });
    await expect(
      fixture.repository.disableAssignment(
        { expectedGeneration: 3, mutationId: MUTATION_D, tenantId: TENANT_A },
        signal(),
      ),
    ).resolves.toEqual({ kind: "conflict" });
    await expect(
      fixture.repository.rotateAssignment(
        { cellId: CELL_C, expectedGeneration: 2, mutationId: MUTATION_D, tenantId: TENANT_A },
        signal(),
      ),
    ).resolves.toEqual({ kind: "conflict" });

    const missing = repository();
    await expect(
      missing.repository.rotateAssignment(
        { cellId: CELL_C, expectedGeneration: 1, mutationId: MUTATION_A, tenantId: TENANT_A },
        signal(),
      ),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("never reuses a cell across tenants, including a rotated historical cell", async () => {
    const fixture = repository();
    await fixture.repository.createAssignment(createInput(), signal());
    await fixture.repository.rotateAssignment(
      { cellId: CELL_B, expectedGeneration: 1, mutationId: MUTATION_B, tenantId: TENANT_A },
      signal(),
    );

    await expect(
      fixture.repository.createAssignment(createInput(TENANT_B, CELL_A, MUTATION_C), signal()),
    ).resolves.toEqual({ kind: "conflict" });
    await expect(
      fixture.repository.createAssignment(createInput(TENANT_B, CELL_B, MUTATION_D), signal()),
    ).resolves.toEqual({ kind: "conflict" });
    expect(fixture.database.assignments.has(TENANT_B)).toBe(false);
  });

  it("replays a durable result after suspension without accepting a new mutation", async () => {
    const fixture = repository();
    const input = createInput();
    await expect(fixture.repository.createAssignment(input, signal())).resolves.toMatchObject({
      kind: "applied",
      replayed: false,
    });
    fixture.database.organizations.set(TENANT_A, "suspended");

    await expect(fixture.repository.createAssignment(input, signal())).resolves.toMatchObject({
      assignment: { cellId: CELL_A, generation: 1, state: "active", tenantId: TENANT_A },
      kind: "applied",
      replayed: true,
    });
    await expect(
      fixture.repository.rotateAssignment(
        { cellId: CELL_B, expectedGeneration: 1, mutationId: MUTATION_B, tenantId: TENANT_A },
        signal(),
      ),
    ).resolves.toEqual({ kind: "organization-unavailable" });
    await expect(fixture.repository.resolve(TENANT_A, signal())).resolves.toBeNull();
  });

  it("maps unknown and suspended organizations without revealing which state was observed", async () => {
    const fixture = repository();
    fixture.database.organizations.set(TENANT_A, "suspended");
    await expect(fixture.repository.createAssignment(createInput(), signal())).resolves.toEqual({
      kind: "organization-unavailable",
    });
    await expect(
      fixture.repository.createAssignment(createInput("organization-missing", CELL_B, MUTATION_B), signal()),
    ).resolves.toEqual({ kind: "organization-unavailable" });
    expect(fixture.database.assignments.size).toBe(0);
    expect(fixture.database.mutations.size).toBe(0);
  });

  it("rolls back cancellation, propagates its reason, releases the client, and permits a clean retry", async () => {
    const fixture = repository();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    fixture.database.afterQuery = (text) => {
      if (text.includes("INSERT INTO public.runtime_cell_assignment_mutations")) controller.abort(reason);
    };

    await expect(fixture.repository.createAssignment(createInput(), controller.signal)).rejects.toBe(reason);
    expect(fixture.database.assignments.size).toBe(0);
    expect(fixture.database.mutations.size).toBe(0);
    expect(fixture.database.queryTexts).toContain("ROLLBACK");
    expect(fixture.database.releaseCount).toBe(1);

    fixture.database.afterQuery = null;
    await expect(fixture.repository.createAssignment(createInput(), signal())).resolves.toMatchObject({
      kind: "applied",
      replayed: false,
    });
  });

  it("redacts internal foreign-key details instead of misclassifying them as an unavailable organization", async () => {
    const fixture = repository();
    const raw = Object.assign(new Error("postgres://admin:secret@db.internal/runtime identity tenant-a"), {
      code: "23503",
    });
    fixture.database.failNext = {
      error: raw,
      pattern: "INSERT INTO public.runtime_cell_assignment_mutations",
    };

    const failure = await fixture.repository.createAssignment(createInput(), signal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Runtime cell assignment storage is unavailable.");
    expect((failure as Error).message).not.toContain("secret");
    expect((failure as Error).message).not.toContain(TENANT_A);
    expect(fixture.database.assignments.size).toBe(0);
    expect(fixture.database.mutations.size).toBe(0);

    await expect(fixture.repository.createAssignment(createInput(), signal())).resolves.toMatchObject({
      kind: "applied",
      replayed: false,
    });
  });
});
