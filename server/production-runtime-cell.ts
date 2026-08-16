import { z } from "zod";

import { HttpError } from "./http/json";
import type { ManimApi } from "./manim-api";
import {
  isReservedLocalManimTenantId,
  isVerifiedManimPrincipal,
  manimTenantIdSchema,
  type VerifiedManimPrincipal,
} from "./manim-request-principal";
import type { EditorDocumentRepositoryV1 } from "./storage/editor-document-repository";

export type ProductionRuntimeReadinessV1 =
  | Readonly<{ ready: false }>
  | Readonly<{
      executionBoundary: "adapter-attests-external-sandbox";
      ready: true;
      storageBoundary: "shared-durable";
      tenantBoundary: "server-owned-tenant-key";
    }>;

/**
 * Trusted in-process adapter whose readiness assertion is backed by an
 * independently verified external sandbox and durable stores. It is not an
 * isolation boundary by itself.
 */
export type ProductionManimRuntimeAdapterV1 = Readonly<{
  api: ManimApi;
  close: () => Promise<void>;
  editorDocuments?: EditorDocumentRepositoryV1;
  editorReady?: (signal: AbortSignal) => Promise<boolean>;
  /** Covers fresh sandbox attestation plus PostgreSQL/S3 durable probes. */
  ready: (signal: AbortSignal) => Promise<ProductionRuntimeReadinessV1>;
  /** Covers the exact source, sandbox, session, and media dependencies required to start a render. */
  renderReady: (signal: AbortSignal) => Promise<boolean>;
  /** Covers the durable source workspace required to serve the editor shell. */
  workspaceReady: (signal: AbortSignal) => Promise<boolean>;
}>;

/**
 * TenantCell vocabulary (ADR 0005 §"Tenant Cell decision"). A Tenant Cell is
 * the server-owned tenant-fixed durable composition and routing boundary; its
 * storage readiness covers projects, editor documents, and published-artifact
 * reads without claiming a Manim sandbox is ready. Existing
 * `ProductionManimRuntime*` names, `runtime_cell_*` tables, health fields, and
 * error strings remain compatibility surfaces; only the new contracts
 * introduced by the readiness split use TenantCell names. The split is
 * internal structure: it does not claim per-cell database, object-store, or
 * failure isolation.
 */
export type TenantCellStorageReadinessV1 = Readonly<{
  /**
   * Storage/tenant lane only: durable project repository, source blobs, and
   * published-artifact reads. Never attests the external Manim sandbox.
   */
  tenantCellStorageReady: (signal: AbortSignal) => Promise<boolean>;
}>;

/** Adapter that also reports the split TenantCell storage-lane readiness. */
export type TenantCellRuntimeAdapterV1 = ProductionManimRuntimeAdapterV1 & TenantCellStorageReadinessV1;

export function hasTenantCellStorageReadinessV1(
  runtime: ProductionManimRuntimeAdapterV1,
): runtime is TenantCellRuntimeAdapterV1 {
  return typeof (runtime as Partial<TenantCellRuntimeAdapterV1>).tenantCellStorageReady === "function";
}

export const productionRuntimeCellIdSchemaV1 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

const productionRuntimeCellAssignmentSchemaV1 = z
  .object({
    cellId: productionRuntimeCellIdSchemaV1,
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["active", "disabled"]),
    tenantId: manimTenantIdSchema,
  })
  .strict();

export type ProductionRuntimeCellAssignmentV1 = z.infer<typeof productionRuntimeCellAssignmentSchemaV1>;

/**
 * Durable, server-owned assignment authority. Implementations may use a
 * shared-process cell pool or isolated cell processes, but must never derive
 * assignments from request URLs, headers, or client state.
 */
export type ProductionRuntimeCellAssignmentSourceV1 = Readonly<{
  close?: () => Promise<void>;
  ready: (signal: AbortSignal) => Promise<boolean>;
  resolve: (tenantId: string, signal: AbortSignal) => Promise<unknown>;
}>;

/** Constructs one tenant-fixed runtime from a validated server-owned assignment. */
export type ProductionManimRuntimeCellProvisionerV1 = Readonly<{
  close?: () => Promise<void>;
  provision: (
    assignment: ProductionRuntimeCellAssignmentV1,
    signal: AbortSignal,
  ) => Promise<ProductionManimRuntimeAdapterV1>;
  ready?: (signal: AbortSignal) => Promise<boolean>;
}>;

export type ProductionManimRuntimeCellLeaseV1 = Readonly<{
  release: () => void;
  runtime: ProductionManimRuntimeAdapterV1;
}>;

/** Selection accepts only the branded principal produced by membership admission. */
export type ProductionManimRuntimeCellResolverV1 = Readonly<{
  acquire: (principal: VerifiedManimPrincipal, signal: AbortSignal) => Promise<ProductionManimRuntimeCellLeaseV1>;
  close: () => Promise<void>;
  ready: (signal: AbortSignal) => Promise<boolean>;
}>;

export function assertProductionManimRuntimeCellResolverV1(
  resolver: unknown,
): asserts resolver is ProductionManimRuntimeCellResolverV1 {
  if (
    typeof resolver !== "object" ||
    resolver === null ||
    !("acquire" in resolver) ||
    typeof resolver.acquire !== "function" ||
    !("close" in resolver) ||
    typeof resolver.close !== "function" ||
    !("ready" in resolver) ||
    typeof resolver.ready !== "function"
  ) {
    throw new TypeError("Production runtime cell resolver is incomplete.");
  }
}

export function assertProductionManimRuntimeCellLeaseV1(
  lease: unknown,
  expectedTenantId: string,
): asserts lease is ProductionManimRuntimeCellLeaseV1 {
  if (
    typeof lease !== "object" ||
    lease === null ||
    !("release" in lease) ||
    typeof lease.release !== "function" ||
    !("runtime" in lease)
  ) {
    throw new TypeError("Production runtime cell lease is incomplete.");
  }
  assertProductionManimRuntimeAdapterV1(lease.runtime, expectedTenantId);
}

type CellEntry = {
  assignment: ProductionRuntimeCellAssignmentV1;
  closeRequest: Promise<void> | null;
  lastUsed: number;
  leases: number;
  retired: boolean;
  runtime: ProductionManimRuntimeAdapterV1;
};

type AssignmentInvalidationState = {
  epoch: symbol;
  readers: number;
};

type AssignmentInvalidationSnapshot = Readonly<{
  epoch: symbol;
  state: AssignmentInvalidationState;
}>;

function unavailableCell(): HttpError {
  return new HttpError("Tenant runtime cell is temporarily unavailable.", 503);
}

function sameAssignment(left: ProductionRuntimeCellAssignmentV1, right: ProductionRuntimeCellAssignmentV1) {
  return (
    left.cellId === right.cellId &&
    left.generation === right.generation &&
    left.state === right.state &&
    left.tenantId === right.tenantId
  );
}

function assertEditorAdapter(runtime: ProductionManimRuntimeAdapterV1) {
  if (
    (runtime.editorDocuments === undefined) !== (runtime.editorReady === undefined) ||
    (runtime.editorDocuments !== undefined &&
      (typeof runtime.editorDocuments !== "object" ||
        runtime.editorDocuments === null ||
        typeof runtime.editorDocuments.openDocument !== "function" ||
        typeof runtime.editorDocuments.commitMutation !== "function" ||
        typeof runtime.editorDocuments.putSessionSnapshot !== "function" ||
        typeof runtime.editorDocuments.readEventTail !== "function" ||
        typeof runtime.editorDocuments.readSessionSnapshot !== "function" ||
        typeof runtime.editorReady !== "function"))
  ) {
    throw new TypeError("Production editor document adapter is incomplete.");
  }
}

export function assertProductionManimRuntimeAdapterV1(
  runtime: unknown,
  expectedTenantId?: string,
): asserts runtime is ProductionManimRuntimeAdapterV1 {
  if (
    typeof runtime !== "object" ||
    runtime === null ||
    !("api" in runtime) ||
    typeof runtime.api !== "object" ||
    runtime.api === null ||
    !("ready" in runtime) ||
    typeof runtime.ready !== "function" ||
    !("renderReady" in runtime) ||
    typeof runtime.renderReady !== "function" ||
    !("workspaceReady" in runtime) ||
    typeof runtime.workspaceReady !== "function" ||
    !("close" in runtime) ||
    typeof runtime.close !== "function"
  ) {
    throw new TypeError("Production Manim runtime adapter is incomplete.");
  }
  const candidate = runtime as ProductionManimRuntimeAdapterV1;
  const parsedTenant = manimTenantIdSchema.safeParse(candidate.api.tenantId);
  if (!parsedTenant.success) throw new TypeError("Production runtime tenant ID is invalid.");
  if (isReservedLocalManimTenantId(parsedTenant.data)) {
    throw new TypeError("Production runtime tenant ID must not use a reserved local identity.");
  }
  if (expectedTenantId !== undefined && parsedTenant.data !== expectedTenantId) {
    throw new TypeError("Production runtime tenant does not match its server-owned assignment.");
  }
  if (
    candidate.api.storageBoundary?.kind !== "shared-durable" ||
    typeof candidate.api.storageBoundary.namespace !== "string" ||
    !/^[a-z][a-z0-9._-]{0,127}$/.test(candidate.api.storageBoundary.namespace)
  ) {
    throw new TypeError("Production runtime storage must use a tenant-keyed shared durable boundary.");
  }
  assertEditorAdapter(candidate);
}

function assertAssignmentSource(source: unknown): asserts source is ProductionRuntimeCellAssignmentSourceV1 {
  if (
    typeof source !== "object" ||
    source === null ||
    !("resolve" in source) ||
    typeof source.resolve !== "function" ||
    !("ready" in source) ||
    typeof source.ready !== "function" ||
    ("close" in source && source.close !== undefined && typeof source.close !== "function")
  ) {
    throw new TypeError("Production runtime cell assignment source is incomplete.");
  }
}

function assertProvisioner(provisioner: unknown): asserts provisioner is ProductionManimRuntimeCellProvisionerV1 {
  if (
    typeof provisioner !== "object" ||
    provisioner === null ||
    !("provision" in provisioner) ||
    typeof provisioner.provision !== "function" ||
    ("ready" in provisioner && provisioner.ready !== undefined && typeof provisioner.ready !== "function") ||
    ("close" in provisioner && provisioner.close !== undefined && typeof provisioner.close !== "function")
  ) {
    throw new TypeError("Production runtime cell provisioner is incomplete.");
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return resolved;
}

/**
 * A bounded, request-safe cell pool. Assignment lookup runs for every acquire,
 * while construction is serialized and cached by tenant/generation. This is a
 * local routing primitive, not a region scheduler or autoscaler.
 */
export class BoundedProductionManimRuntimeCellResolverV1 implements ProductionManimRuntimeCellResolverV1 {
  readonly #assignments: ProductionRuntimeCellAssignmentSourceV1;
  readonly #cellOwners = new Map<string, string>();
  readonly #closeController = new AbortController();
  readonly #closeErrors: unknown[] = [];
  readonly #current = new Map<string, CellEntry>();
  readonly #invalidationStates = new Map<string, AssignmentInvalidationState>();
  readonly #live = new Set<CellEntry>();
  readonly #maxAssignments: number;
  readonly #maxCells: number;
  readonly #observed = new Map<string, ProductionRuntimeCellAssignmentV1>();
  readonly #provisioner: ProductionManimRuntimeCellProvisionerV1;
  #clock = 0;
  #closeRequest: Promise<void> | null = null;
  #failed = false;
  #lifecycle: "accepting" | "draining" | "closed" = "accepting";
  #provisionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    options: Readonly<{
      assignments: ProductionRuntimeCellAssignmentSourceV1;
      maxAssignments?: number;
      maxCells?: number;
      provisioner: ProductionManimRuntimeCellProvisionerV1;
    }>,
  ) {
    assertAssignmentSource(options.assignments);
    assertProvisioner(options.provisioner);
    this.#assignments = options.assignments;
    this.#provisioner = options.provisioner;
    this.#maxCells = boundedPositiveInteger(options.maxCells, 64, 1_024, "maxCells");
    this.#maxAssignments = boundedPositiveInteger(options.maxAssignments, 1_024, 16_384, "maxAssignments");
    if (this.#maxAssignments < this.#maxCells) {
      throw new RangeError("maxAssignments must be greater than or equal to maxCells.");
    }
  }

  async ready(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.#lifecycle !== "accepting" || this.#failed) return false;
    try {
      const [assignmentsReady, provisionerReady] = await Promise.all([
        this.#assignments.ready(signal),
        this.#provisioner.ready?.(signal) ?? Promise.resolve(true),
      ]);
      signal.throwIfAborted();
      return assignmentsReady === true && provisionerReady === true && !this.#failed;
    } catch {
      if (signal.aborted) throw signal.reason;
      return false;
    }
  }

  async acquire(principal: VerifiedManimPrincipal, signal: AbortSignal): Promise<ProductionManimRuntimeCellLeaseV1> {
    signal.throwIfAborted();
    if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
    if (this.#lifecycle !== "accepting" || this.#failed) throw unavailableCell();
    const invalidation = this.#beginAssignmentRead(principal.tenantId);
    try {
      return await this.#acquireObserved(principal.tenantId, signal, invalidation);
    } finally {
      this.#endAssignmentRead(principal.tenantId, invalidation.state);
    }
  }

  async #acquireObserved(
    tenantId: string,
    signal: AbortSignal,
    invalidation: AssignmentInvalidationSnapshot,
  ): Promise<ProductionManimRuntimeCellLeaseV1> {
    let rawAssignment: unknown;
    try {
      rawAssignment = await this.#assignments.resolve(tenantId, signal);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw unavailableCell();
    }
    signal.throwIfAborted();
    if (rawAssignment === null) {
      this.#invalidateAssignment(invalidation.state);
      const existing = this.#current.get(tenantId);
      if (existing) {
        this.#current.delete(tenantId);
        this.#retire(existing);
      }
      throw unavailableCell();
    }
    const parsed = productionRuntimeCellAssignmentSchemaV1.safeParse(rawAssignment);
    if (!parsed.success || parsed.data.tenantId !== tenantId) throw unavailableCell();
    const assignment = parsed.data;
    if (!this.#assignmentReadIsCurrent(assignment.tenantId, invalidation)) throw unavailableCell();
    this.#recordAssignment(assignment);
    if (assignment.state !== "active") {
      const existing = this.#current.get(assignment.tenantId);
      if (existing && existing.assignment.generation < assignment.generation) {
        this.#current.delete(assignment.tenantId);
        this.#retire(existing);
      }
      throw unavailableCell();
    }

    let entry = this.#current.get(assignment.tenantId);
    if (!entry || !sameAssignment(entry.assignment, assignment)) {
      try {
        entry = await this.#provisionSerialized(assignment, invalidation);
      } catch {
        if (signal.aborted) throw signal.reason;
        throw unavailableCell();
      }
    }
    signal.throwIfAborted();
    if (
      this.#lifecycle !== "accepting" ||
      this.#failed ||
      !this.#assignmentReadIsCurrent(assignment.tenantId, invalidation) ||
      entry.retired ||
      this.#current.get(assignment.tenantId) !== entry ||
      !sameAssignment(this.#observed.get(assignment.tenantId) ?? assignment, assignment) ||
      !sameAssignment(entry.assignment, assignment)
    ) {
      throw unavailableCell();
    }
    entry.leases += 1;
    entry.lastUsed = ++this.#clock;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        entry!.leases -= 1;
        if (entry!.leases < 0) {
          this.#failed = true;
          entry!.leases = 0;
        }
        if (entry!.retired && entry!.leases === 0) this.#scheduleClose(entry!);
      },
      runtime: entry.runtime,
    });
  }

  #recordAssignment(assignment: ProductionRuntimeCellAssignmentV1) {
    const previous = this.#observed.get(assignment.tenantId);
    if (previous) {
      if (assignment.generation < previous.generation) throw unavailableCell();
      if (assignment.generation === previous.generation && !sameAssignment(previous, assignment)) {
        throw unavailableCell();
      }
    } else if (this.#observed.size >= this.#maxAssignments) {
      throw unavailableCell();
    }
    const owner = this.#cellOwners.get(assignment.cellId);
    if (owner !== undefined && owner !== assignment.tenantId) throw unavailableCell();
    if (owner === undefined && this.#cellOwners.size >= this.#maxAssignments) throw unavailableCell();
    this.#cellOwners.set(assignment.cellId, assignment.tenantId);
    if (!previous || assignment.generation > previous.generation) this.#observed.set(assignment.tenantId, assignment);
  }

  #beginAssignmentRead(tenantId: string): AssignmentInvalidationSnapshot {
    let state = this.#invalidationStates.get(tenantId);
    if (!state) {
      if (this.#invalidationStates.size >= this.#maxAssignments) throw unavailableCell();
      state = { epoch: Symbol(), readers: 0 };
      this.#invalidationStates.set(tenantId, state);
    }
    state.readers += 1;
    return { epoch: state.epoch, state };
  }

  #endAssignmentRead(tenantId: string, state: AssignmentInvalidationState) {
    state.readers -= 1;
    if (
      state.readers === 0 &&
      !this.#observed.has(tenantId) &&
      !this.#current.has(tenantId) &&
      this.#invalidationStates.get(tenantId) === state
    ) {
      this.#invalidationStates.delete(tenantId);
    }
  }

  #invalidateAssignment(state: AssignmentInvalidationState) {
    state.epoch = Symbol();
  }

  #assignmentReadIsCurrent(tenantId: string, snapshot: AssignmentInvalidationSnapshot) {
    return this.#invalidationStates.get(tenantId) === snapshot.state && snapshot.state.epoch === snapshot.epoch;
  }

  #provisionSerialized(assignment: ProductionRuntimeCellAssignmentV1, invalidation: AssignmentInvalidationSnapshot) {
    const provision = this.#provisionQueue.then(
      () => this.#provision(assignment, invalidation),
      () => this.#provision(assignment, invalidation),
    );
    this.#provisionQueue = provision.then(
      () => undefined,
      () => undefined,
    );
    return provision;
  }

  async #provision(
    assignment: ProductionRuntimeCellAssignmentV1,
    invalidation: AssignmentInvalidationSnapshot,
  ): Promise<CellEntry> {
    if (this.#lifecycle !== "accepting" || this.#failed) throw unavailableCell();
    const latest = this.#observed.get(assignment.tenantId);
    if (
      !latest ||
      !sameAssignment(latest, assignment) ||
      assignment.state !== "active" ||
      !this.#assignmentReadIsCurrent(assignment.tenantId, invalidation)
    ) {
      throw unavailableCell();
    }
    const cached = this.#current.get(assignment.tenantId);
    if (cached && sameAssignment(cached.assignment, assignment)) return cached;
    await this.#makeRoom();

    let runtime: ProductionManimRuntimeAdapterV1 | null = null;
    try {
      runtime = await this.#provisioner.provision(assignment, this.#closeController.signal);
      assertProductionManimRuntimeAdapterV1(runtime, assignment.tenantId);
      if (
        this.#lifecycle !== "accepting" ||
        this.#failed ||
        !this.#assignmentReadIsCurrent(assignment.tenantId, invalidation) ||
        !sameAssignment(this.#observed.get(assignment.tenantId) ?? assignment, assignment)
      ) {
        throw unavailableCell();
      }
      const entry: CellEntry = {
        assignment,
        closeRequest: null,
        lastUsed: ++this.#clock,
        leases: 0,
        retired: false,
        runtime,
      };
      const previous = this.#current.get(assignment.tenantId);
      this.#current.set(assignment.tenantId, entry);
      this.#live.add(entry);
      if (previous && previous !== entry) this.#retire(previous);
      return entry;
    } catch {
      if (runtime) await this.#closeRejectedRuntime(runtime);
      throw unavailableCell();
    }
  }

  async #makeRoom() {
    while (this.#live.size >= this.#maxCells) {
      const candidate = [...this.#live]
        .filter((entry) => entry.leases === 0 && entry.closeRequest === null)
        .sort((left, right) => Number(right.retired) - Number(left.retired) || left.lastUsed - right.lastUsed)[0];
      if (!candidate) throw unavailableCell();
      if (this.#current.get(candidate.assignment.tenantId) === candidate) {
        this.#current.delete(candidate.assignment.tenantId);
      }
      candidate.retired = true;
      await this.#closeEntry(candidate);
      if (this.#failed) throw unavailableCell();
    }
  }

  #retire(entry: CellEntry) {
    entry.retired = true;
    if (entry.leases === 0) this.#scheduleClose(entry);
  }

  #scheduleClose(entry: CellEntry) {
    void this.#closeEntry(entry).catch(() => undefined);
  }

  #closeEntry(entry: CellEntry) {
    entry.closeRequest ??= Promise.resolve()
      .then(() => entry.runtime.close())
      .then(
        () => {
          this.#live.delete(entry);
        },
        (error: unknown) => {
          this.#failed = true;
          this.#closeErrors.push(error);
          throw error;
        },
      );
    return entry.closeRequest;
  }

  async #closeRejectedRuntime(runtime: ProductionManimRuntimeAdapterV1) {
    try {
      await runtime.close();
    } catch (error) {
      this.#failed = true;
      this.#closeErrors.push(error);
    }
  }

  close() {
    this.#closeRequest ??= (async () => {
      this.#lifecycle = "draining";
      this.#closeController.abort(new Error("Production runtime cell resolver is closing."));
      await this.#provisionQueue.catch(() => undefined);
      const runtimeResults = await Promise.allSettled([...this.#live].map((entry) => this.#closeEntry(entry)));
      const ownedAdapters = [...new Set([this.#assignments, this.#provisioner])];
      const adapterResults = await Promise.allSettled(
        ownedAdapters.map((adapter) => (adapter.close ? adapter.close() : Promise.resolve())),
      );
      this.#lifecycle = "closed";
      const errors = [
        ...this.#closeErrors,
        ...runtimeResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ...adapterResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ];
      if (errors.length > 0) throw new AggregateError([...new Set(errors)], "Production runtime cell cleanup failed.");
    })();
    return this.#closeRequest;
  }
}

/** Backward-compatible one-cell resolver used during migration and rollback. */
export function createPinnedProductionManimRuntimeCellResolverV1(
  runtime: ProductionManimRuntimeAdapterV1,
): ProductionManimRuntimeCellResolverV1 {
  assertProductionManimRuntimeAdapterV1(runtime);
  let lifecycle: "accepting" | "closed" = "accepting";
  let closeRequest: Promise<void> | null = null;
  return Object.freeze({
    async acquire(principal: VerifiedManimPrincipal, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
      if (lifecycle !== "accepting") throw unavailableCell();
      if (principal.tenantId !== runtime.api.tenantId) throw new HttpError("Tenant access is not available.", 403);
      return Object.freeze({
        release: () => undefined,
        runtime,
      });
    },
    close() {
      if (!closeRequest) {
        lifecycle = "closed";
        closeRequest = Promise.resolve().then(() => runtime.close());
      }
      return closeRequest;
    },
    async ready(signal: AbortSignal) {
      signal.throwIfAborted();
      if (lifecycle !== "accepting") return false;
      const [workspaceReady, editorReady] = await Promise.all([
        runtime.workspaceReady(signal),
        runtime.editorReady?.(signal) ?? Promise.resolve(true),
      ]);
      signal.throwIfAborted();
      return workspaceReady === true && editorReady === true;
    },
  });
}
