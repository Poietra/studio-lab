import type { PoolClient, QueryResultRow } from "pg";

import { manimTenantIdSchema } from "../../manim-request-principal";
import { type ProductionRuntimeCellAssignmentV1, productionRuntimeCellIdSchemaV1 } from "../../production-runtime-cell";
import {
  type CreateRuntimeCellAssignmentInputV1,
  createRuntimeCellAssignmentInputSchemaV1,
  type DisableRuntimeCellAssignmentInputV1,
  disableRuntimeCellAssignmentInputSchemaV1,
  type RotateRuntimeCellAssignmentInputV1,
  type RuntimeCellAssignmentMutationResultV1,
  type RuntimeCellAssignmentRepositoryV1,
  rotateRuntimeCellAssignmentInputSchemaV1,
  runtimeCellAssignmentMutationIdSchemaV1,
} from "../../runtime-cell-assignment-repository";
import {
  type PostgresRepositoryConnectionOptionsV1,
  PostgresRepositoryConnectionV1,
} from "./postgres-repository-connection";
import { RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM } from "./runtime-cell-assignment-schema";

type AssignmentRowV1 = QueryResultRow & {
  cell_id: string;
  generation: string;
  state: string;
  tenant_id: string;
};

type MutationRowV1 = QueryResultRow & {
  expected_generation: string | null;
  kind: string;
  mutation_id: string;
  request_cell_id: string | null;
  result_cell_id: string;
  result_generation: string;
  result_state: string;
  tenant_id: string;
};

type OrganizationRowV1 = QueryResultRow & {
  status: string;
  tenant_id: string;
};

type MutationInputV1 =
  | Readonly<{ input: CreateRuntimeCellAssignmentInputV1; kind: "create" }>
  | Readonly<{ input: RotateRuntimeCellAssignmentInputV1; kind: "rotate" }>
  | Readonly<{ input: DisableRuntimeCellAssignmentInputV1; kind: "disable" }>;

type PersistedMutationV1 = Readonly<{
  assignment: ProductionRuntimeCellAssignmentV1;
  expectedGeneration: number | null;
  kind: MutationInputV1["kind"];
  mutationId: string;
  requestCellId: string | null;
  tenantId: string;
}>;

const ASSIGNMENT_COLUMNS_V1 = `assignment.tenant_id,
       assignment.cell_id,
       assignment.generation::text AS generation,
       assignment.state`;

const MUTATION_COLUMNS_V1 = `mutation.tenant_id,
       mutation.mutation_id::text AS mutation_id,
       mutation.kind,
       mutation.request_cell_id,
       mutation.expected_generation::text AS expected_generation,
       mutation.result_cell_id,
       mutation.result_generation::text AS result_generation,
       mutation.result_state`;

class RuntimeCellAssignmentConflictV1 extends Error {}

class RuntimeCellAssignmentStorageErrorV1 extends Error {
  constructor() {
    super("Runtime cell assignment storage is unavailable.");
    this.name = "RuntimeCellAssignmentStorageErrorV1";
  }
}

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactTenantId(value: unknown) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success || parsed.data === "studio-local" || parsed.data.startsWith("local-")) {
    throw new TypeError("Runtime cell assignment tenant is invalid.");
  }
  return parsed.data;
}

function exactCellId(value: unknown) {
  const parsed = productionRuntimeCellIdSchemaV1.safeParse(value);
  if (!parsed.success) throw new TypeError("Runtime cell assignment cell is invalid.");
  return parsed.data;
}

function exactGeneration(value: unknown, allowZero = false) {
  if (typeof value !== "string" || !(allowZero ? /^(?:0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u).test(value)) {
    throw new TypeError("Runtime cell assignment generation is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed < 1)) {
    throw new TypeError("Runtime cell assignment generation is invalid.");
  }
  return parsed;
}

function assignmentFromRowV1(row: AssignmentRowV1, expectedTenantId?: string): ProductionRuntimeCellAssignmentV1 {
  const tenantId = exactTenantId(row.tenant_id);
  if (expectedTenantId !== undefined && tenantId !== expectedTenantId) {
    throw new TypeError("Runtime cell assignment identity is inconsistent.");
  }
  if (row.state !== "active" && row.state !== "disabled") {
    throw new TypeError("Runtime cell assignment state is invalid.");
  }
  return Object.freeze({
    cellId: exactCellId(row.cell_id),
    generation: exactGeneration(row.generation),
    state: row.state,
    tenantId,
  });
}

function mutationFromRowV1(row: MutationRowV1, expectedTenantId: string): PersistedMutationV1 {
  const tenantId = exactTenantId(row.tenant_id);
  const mutationId = runtimeCellAssignmentMutationIdSchemaV1.safeParse(row.mutation_id);
  if (tenantId !== expectedTenantId || !mutationId.success) {
    throw new TypeError("Runtime cell assignment mutation identity is invalid.");
  }
  if (row.kind !== "create" && row.kind !== "rotate" && row.kind !== "disable") {
    throw new TypeError("Runtime cell assignment mutation kind is invalid.");
  }
  const requestCellId = row.request_cell_id === null ? null : exactCellId(row.request_cell_id);
  const expectedGeneration = row.expected_generation === null ? null : exactGeneration(row.expected_generation, false);
  const assignment = assignmentFromRowV1(
    {
      cell_id: row.result_cell_id,
      generation: row.result_generation,
      state: row.result_state,
      tenant_id: row.tenant_id,
    },
    tenantId,
  );
  const validCreate =
    row.kind === "create" &&
    requestCellId !== null &&
    expectedGeneration === null &&
    assignment.cellId === requestCellId &&
    assignment.generation === 1 &&
    assignment.state === "active";
  const validRotate =
    row.kind === "rotate" &&
    requestCellId !== null &&
    expectedGeneration !== null &&
    expectedGeneration < Number.MAX_SAFE_INTEGER &&
    assignment.cellId === requestCellId &&
    assignment.generation === expectedGeneration + 1 &&
    assignment.state === "active";
  const validDisable =
    row.kind === "disable" &&
    requestCellId === null &&
    expectedGeneration !== null &&
    expectedGeneration < Number.MAX_SAFE_INTEGER &&
    assignment.generation === expectedGeneration + 1 &&
    assignment.state === "disabled";
  if (!validCreate && !validRotate && !validDisable) {
    throw new TypeError("Runtime cell assignment mutation result is invalid.");
  }
  return Object.freeze({
    assignment,
    expectedGeneration,
    kind: row.kind,
    mutationId: mutationId.data,
    requestCellId,
    tenantId,
  });
}

function mutationPayloadMatchesV1(persisted: PersistedMutationV1, request: MutationInputV1) {
  if (
    persisted.kind !== request.kind ||
    persisted.mutationId !== request.input.mutationId ||
    persisted.tenantId !== request.input.tenantId
  ) {
    return false;
  }
  if (request.kind === "create") {
    return (
      request.input.expectedGeneration === 0 &&
      persisted.expectedGeneration === null &&
      persisted.requestCellId === request.input.cellId
    );
  }
  if (request.kind === "rotate") {
    return (
      persisted.expectedGeneration === request.input.expectedGeneration &&
      persisted.requestCellId === request.input.cellId
    );
  }
  return persisted.expectedGeneration === request.input.expectedGeneration && persisted.requestCellId === null;
}

function postgresErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function parseMutationInputV1(input: unknown, kind: MutationInputV1["kind"]): MutationInputV1 {
  const schema =
    kind === "create"
      ? createRuntimeCellAssignmentInputSchemaV1
      : kind === "rotate"
        ? rotateRuntimeCellAssignmentInputSchemaV1
        : disableRuntimeCellAssignmentInputSchemaV1;
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new TypeError("Runtime cell assignment mutation is invalid.");
  if (kind === "create") return { input: parsed.data as CreateRuntimeCellAssignmentInputV1, kind };
  if (kind === "rotate") return { input: parsed.data as RotateRuntimeCellAssignmentInputV1, kind };
  return { input: parsed.data as DisableRuntimeCellAssignmentInputV1, kind };
}

async function selectOrganizationV1(client: PoolClient, tenantId: string) {
  const result = await client.query<OrganizationRowV1>(
    `SELECT organization.tenant_id, organization.status
       FROM public.organizations organization
      WHERE organization.tenant_id = $1
      LIMIT 2
      FOR UPDATE OF organization`,
    [tenantId],
  );
  if (result.rows.length > 1) throw new TypeError("Runtime cell assignment organization is duplicated.");
  const row = result.rows[0];
  if (!row) return null;
  if (exactTenantId(row.tenant_id) !== tenantId || (row.status !== "active" && row.status !== "suspended")) {
    throw new TypeError("Runtime cell assignment organization is invalid.");
  }
  return row.status;
}

async function selectMutationV1(client: PoolClient, tenantId: string, mutationId: string) {
  const result = await client.query<MutationRowV1>(
    `SELECT ${MUTATION_COLUMNS_V1}
       FROM public.runtime_cell_assignment_mutations mutation
      WHERE mutation.tenant_id = $1
        AND mutation.mutation_id = $2::uuid
      LIMIT 2`,
    [tenantId, mutationId],
  );
  if (result.rows.length > 1) throw new TypeError("Runtime cell assignment mutation is duplicated.");
  return result.rows[0] ?? null;
}

async function selectCurrentAssignmentV1(client: PoolClient, tenantId: string) {
  const result = await client.query<AssignmentRowV1>(
    `SELECT ${ASSIGNMENT_COLUMNS_V1}
       FROM public.runtime_cell_assignments assignment
      WHERE assignment.tenant_id = $1
      LIMIT 2
      FOR UPDATE OF assignment`,
    [tenantId],
  );
  if (result.rows.length > 1) throw new TypeError("Runtime cell assignment is duplicated.");
  return result.rows[0] ? assignmentFromRowV1(result.rows[0], tenantId) : null;
}

async function insertMutationV1(
  client: PoolClient,
  request: MutationInputV1,
  assignment: ProductionRuntimeCellAssignmentV1,
) {
  const requestCellId = request.kind === "disable" ? null : request.input.cellId;
  const expectedGeneration = request.kind === "create" ? null : request.input.expectedGeneration;
  const result = await client.query<{ inserted: number }>(
    `INSERT INTO public.runtime_cell_assignment_mutations
       (tenant_id, mutation_id, kind, request_cell_id, expected_generation,
        result_cell_id, result_generation, result_state)
     VALUES ($1, $2::uuid, $3, $4, $5::bigint, $6, $7::bigint, $8)
     ON CONFLICT DO NOTHING
     RETURNING 1 AS inserted`,
    [
      request.input.tenantId,
      request.input.mutationId,
      request.kind,
      requestCellId,
      expectedGeneration,
      assignment.cellId,
      assignment.generation,
      assignment.state,
    ],
  );
  if (result.rows.length > 1 || (result.rows[0] !== undefined && result.rows[0].inserted !== 1)) {
    throw new TypeError("Runtime cell assignment mutation insert is invalid.");
  }
  return result.rows.length === 1;
}

async function createAssignmentV1(client: PoolClient, request: Extract<MutationInputV1, { kind: "create" }>) {
  const expected: ProductionRuntimeCellAssignmentV1 = Object.freeze({
    cellId: request.input.cellId,
    generation: 1,
    state: "active",
    tenantId: request.input.tenantId,
  });
  const result = await client.query<AssignmentRowV1>(
    `INSERT INTO public.runtime_cell_assignments (tenant_id, cell_id, generation, state)
     VALUES ($1, $2, 1, 'active')
     ON CONFLICT DO NOTHING
     RETURNING tenant_id, cell_id, generation::text AS generation, state`,
    [request.input.tenantId, request.input.cellId],
  );
  if (result.rows.length > 1) throw new TypeError("Runtime cell assignment create is duplicated.");
  const row = result.rows[0];
  if (!row) throw new RuntimeCellAssignmentConflictV1();
  const assignment = assignmentFromRowV1(row, request.input.tenantId);
  if (
    assignment.cellId !== expected.cellId ||
    assignment.generation !== expected.generation ||
    assignment.state !== expected.state
  ) {
    throw new TypeError("Runtime cell assignment create result is invalid.");
  }
  if (!(await insertMutationV1(client, request, assignment))) throw new RuntimeCellAssignmentConflictV1();
  return assignment;
}

async function advanceAssignmentV1(
  client: PoolClient,
  request: Extract<MutationInputV1, { kind: "disable" | "rotate" }>,
  current: ProductionRuntimeCellAssignmentV1,
) {
  const assignment: ProductionRuntimeCellAssignmentV1 = Object.freeze({
    cellId: request.kind === "rotate" ? request.input.cellId : current.cellId,
    generation: request.input.expectedGeneration + 1,
    state: request.kind === "rotate" ? "active" : "disabled",
    tenantId: request.input.tenantId,
  });
  if (!(await insertMutationV1(client, request, assignment))) return null;
  const result = await client.query<AssignmentRowV1>(
    `UPDATE public.runtime_cell_assignments assignment
        SET cell_id = $2,
            generation = $3::bigint,
            state = $4
      WHERE assignment.tenant_id = $1
        AND assignment.generation = $5::bigint
        AND assignment.state = 'active'
      RETURNING assignment.tenant_id,
                assignment.cell_id,
                assignment.generation::text AS generation,
                assignment.state`,
    [
      request.input.tenantId,
      assignment.cellId,
      assignment.generation,
      assignment.state,
      request.input.expectedGeneration,
    ],
  );
  if (result.rows.length > 1) throw new TypeError("Runtime cell assignment update is duplicated.");
  const row = result.rows[0];
  if (!row) throw new RuntimeCellAssignmentConflictV1();
  const updated = assignmentFromRowV1(row, request.input.tenantId);
  if (
    updated.cellId !== assignment.cellId ||
    updated.generation !== assignment.generation ||
    updated.state !== assignment.state
  ) {
    throw new TypeError("Runtime cell assignment update result is invalid.");
  }
  return updated;
}

export class PostgresRuntimeCellAssignmentRepositoryV1 implements RuntimeCellAssignmentRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: PostgresRepositoryConnectionOptionsV1) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 29 LIMIT 2",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 29 &&
        result.rows[0]?.checksum === RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async resolve(tenantIdValue: string, signal?: AbortSignal) {
    const tenantId = exactTenantId(tenantIdValue);
    throwIfAborted(signal);
    try {
      const result = await this.#connection.query<AssignmentRowV1>(
        `SELECT ${ASSIGNMENT_COLUMNS_V1}
           FROM public.runtime_cell_assignments assignment
           JOIN public.organizations organization
             ON organization.tenant_id = assignment.tenant_id
            AND organization.status = 'active'
          WHERE assignment.tenant_id = $1
          LIMIT 2`,
        [tenantId],
        signal,
      );
      throwIfAborted(signal);
      if (result.rows.length > 1) throw new TypeError("Runtime cell assignment is duplicated.");
      return result.rows[0] ? assignmentFromRowV1(result.rows[0], tenantId) : null;
    } catch {
      throwIfAborted(signal);
      throw new RuntimeCellAssignmentStorageErrorV1();
    }
  }

  createAssignment(inputValue: CreateRuntimeCellAssignmentInputV1, signal?: AbortSignal) {
    return this.#mutate(parseMutationInputV1(inputValue, "create"), signal);
  }

  rotateAssignment(inputValue: RotateRuntimeCellAssignmentInputV1, signal?: AbortSignal) {
    return this.#mutate(parseMutationInputV1(inputValue, "rotate"), signal);
  }

  disableAssignment(inputValue: DisableRuntimeCellAssignmentInputV1, signal?: AbortSignal) {
    return this.#mutate(parseMutationInputV1(inputValue, "disable"), signal);
  }

  async #mutate(request: MutationInputV1, signal?: AbortSignal): Promise<RuntimeCellAssignmentMutationResultV1> {
    throwIfAborted(signal);
    try {
      return await this.#connection.transaction(async (client) => {
        const organizationStatus = await selectOrganizationV1(client, request.input.tenantId);
        throwIfAborted(signal);

        const existingRow = await selectMutationV1(client, request.input.tenantId, request.input.mutationId);
        throwIfAborted(signal);
        if (existingRow) {
          const existing = mutationFromRowV1(existingRow, request.input.tenantId);
          if (!mutationPayloadMatchesV1(existing, request)) return { kind: "conflict" } as const;
          return { assignment: existing.assignment, kind: "applied", replayed: true } as const;
        }
        if (organizationStatus !== "active") return { kind: "organization-unavailable" } as const;

        const current = await selectCurrentAssignmentV1(client, request.input.tenantId);
        throwIfAborted(signal);
        let assignment: ProductionRuntimeCellAssignmentV1 | null;
        if (request.kind === "create") {
          if (current !== null) return { kind: "conflict" } as const;
          assignment = await createAssignmentV1(client, request);
        } else {
          if (
            !current ||
            current.state !== "active" ||
            current.generation !== request.input.expectedGeneration ||
            (request.kind === "rotate" && current.cellId === request.input.cellId)
          ) {
            return { kind: "conflict" } as const;
          }
          assignment = await advanceAssignmentV1(client, request, current);
          if (!assignment) return { kind: "conflict" } as const;
        }
        throwIfAborted(signal);
        return { assignment, kind: "applied", replayed: false } as const;
      }, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof RuntimeCellAssignmentConflictV1 || postgresErrorCode(error) === "23505") {
        return { kind: "conflict" };
      }
      throw new RuntimeCellAssignmentStorageErrorV1();
    }
  }

  async close() {
    try {
      await this.#connection.close();
    } catch {
      throw new RuntimeCellAssignmentStorageErrorV1();
    }
  }
}
