import {
  assertProjectPngReceiptV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngVersionPageV1,
} from "./project-png-storage";
import { isApplicationImmutableLocatorV1, storageObjectLocatorV1 } from "./storage-object-locator";
import {
  assertSourceBlobReceiptV1,
  type SourceBlobReceiptV1,
  type SourceBlobVersionPageV1,
  type SourceContentBlobStoreV1,
} from "./workspace-source-repository";

export type StorageWriteLaneV1 = "immutable" | "versioned";

type ScanLaneV1 = StorageWriteLaneV1;
type RoutedCursorV1 = Readonly<{ cursor: string | null; lane: ScanLaneV1; version: 1 }>;

const MAX_ROUTED_CURSOR_BYTES_V1 = 8_192;

function writeLaneV1(value: unknown): StorageWriteLaneV1 {
  if (value !== "immutable" && value !== "versioned") throw new TypeError("Storage write lane is invalid.");
  return value;
}

function encodeCursorV1(cursor: RoutedCursorV1) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursorV1(value: string): RoutedCursorV1 {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ROUTED_CURSOR_BYTES_V1
  ) {
    throw new TypeError("Routed storage cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Routed storage cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Routed storage cursor is invalid.");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "cursor,lane,version" ||
    candidate.version !== 1 ||
    (candidate.lane !== "immutable" && candidate.lane !== "versioned") ||
    (candidate.cursor !== null && typeof candidate.cursor !== "string")
  ) {
    throw new TypeError("Routed storage cursor is invalid.");
  }
  return { cursor: candidate.cursor, lane: candidate.lane, version: 1 };
}

function routedCursorV1(cursor: string | null | undefined, hasLegacy: boolean): RoutedCursorV1 {
  if (cursor === null || cursor === undefined) {
    return { cursor: null, lane: hasLegacy ? "versioned" : "immutable", version: 1 };
  }
  const parsed = decodeCursorV1(cursor);
  if (parsed.lane === "versioned" && !hasLegacy) {
    throw new TypeError("The routed storage cursor requires an unavailable versioned store.");
  }
  return parsed;
}

function nextRoutedCursorV1(lane: ScanLaneV1, nextCursor: string | null, hasLegacy: boolean) {
  if (nextCursor !== null) return encodeCursorV1({ cursor: nextCursor, lane, version: 1 });
  if (lane === "versioned" && hasLegacy) {
    return encodeCursorV1({ cursor: null, lane: "immutable", version: 1 });
  }
  return null;
}

function assertReceiptLaneV1(receipt: SourceBlobReceiptV1 | ProjectPngBlobReceiptV1, lane: ScanLaneV1) {
  const immutable = isApplicationImmutableLocatorV1(storageObjectLocatorV1(receipt));
  if ((lane === "immutable") !== immutable) {
    throw new TypeError(`The ${lane} storage lane returned a receipt from the other lane.`);
  }
}

function routeStoreV1<T>(receipt: SourceBlobReceiptV1 | ProjectPngBlobReceiptV1, immutable: T, legacy: T | undefined) {
  if (isApplicationImmutableLocatorV1(storageObjectLocatorV1(receipt))) return immutable;
  if (!legacy) throw new TypeError("A versioned object cannot be accessed without the legacy storage lane.");
  return legacy;
}

async function closeUniqueV1(stores: readonly Readonly<{ close(): Promise<void> }>[]) {
  const results = await Promise.allSettled([...new Set(stores)].map((store) => store.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, "Could not fully close routed object storage.");
}

export type RoutedSourceContentBlobStoreOptionsV1 = Readonly<{
  immutable: SourceContentBlobStoreV1;
  legacy?: SourceContentBlobStoreV1;
  writeLane: StorageWriteLaneV1;
}>;

/** Explicit source-object cutover router: legacy reads remain pinned while new writes move independently. */
export class RoutedSourceContentBlobStoreV1 implements SourceContentBlobStoreV1 {
  readonly #immutable: SourceContentBlobStoreV1;
  readonly #legacy: SourceContentBlobStoreV1 | undefined;
  readonly #writeLane: StorageWriteLaneV1;
  #closeRequest: Promise<void> | null = null;

  constructor(options: RoutedSourceContentBlobStoreOptionsV1) {
    this.#writeLane = writeLaneV1(options.writeLane);
    this.#immutable = options.immutable;
    this.#legacy = options.legacy;
    if (this.#writeLane === "versioned" && !this.#legacy) {
      throw new TypeError("The versioned source write lane requires a legacy store.");
    }
  }

  async ready(signal?: AbortSignal) {
    const results = await Promise.all([
      this.#immutable.ready(signal),
      this.#legacy?.ready(signal) ?? Promise.resolve(true),
    ]);
    return results.every(Boolean);
  }

  async putSource(tenantId: string, source: string, signal?: AbortSignal) {
    const store = this.#writeLane === "immutable" ? this.#immutable : this.#legacy!;
    const receipt = assertSourceBlobReceiptV1(tenantId, await store.putSource(tenantId, source, signal));
    assertReceiptLaneV1(receipt, this.#writeLane);
    return receipt;
  }

  readSource(tenantId: string, receiptValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    const receipt = assertSourceBlobReceiptV1(tenantId, receiptValue);
    return routeStoreV1(receipt, this.#immutable, this.#legacy).readSource(tenantId, receipt, signal);
  }

  deleteVersion(tenantId: string, receiptValue: SourceBlobReceiptV1, signal?: AbortSignal) {
    const receipt = assertSourceBlobReceiptV1(tenantId, receiptValue);
    return routeStoreV1(receipt, this.#immutable, this.#legacy).deleteVersion(tenantId, receipt, signal);
  }

  async listSourceVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<SourceBlobVersionPageV1> {
    const position = routedCursorV1(cursor, this.#legacy !== undefined);
    const store = position.lane === "immutable" ? this.#immutable : this.#legacy!;
    const page = await store.listSourceVersions(tenantId, cutoff, maximum, position.cursor, signal);
    const versions = page.versions.map((version) => {
      const blob = assertSourceBlobReceiptV1(tenantId, version.blob);
      assertReceiptLaneV1(blob, position.lane);
      return { ...version, blob };
    });
    return {
      nextCursor: nextRoutedCursorV1(position.lane, page.nextCursor, this.#legacy !== undefined),
      versions,
    };
  }

  close() {
    this.#closeRequest ??= closeUniqueV1(this.#legacy ? [this.#legacy, this.#immutable] : [this.#immutable]);
    return this.#closeRequest;
  }
}

export type RoutedProjectPngBlobStoreOptionsV1 = Readonly<{
  immutable: ProjectPngBlobStoreV1;
  legacy?: ProjectPngBlobStoreV1;
  writeLane: StorageWriteLaneV1;
}>;

/** Explicit project-PNG cutover router with receipt-directed reads, deletion, and GC enumeration. */
export class RoutedProjectPngBlobStoreV1 implements ProjectPngBlobStoreV1 {
  readonly #immutable: ProjectPngBlobStoreV1;
  readonly #legacy: ProjectPngBlobStoreV1 | undefined;
  readonly #writeLane: StorageWriteLaneV1;
  #closeRequest: Promise<void> | null = null;

  constructor(options: RoutedProjectPngBlobStoreOptionsV1) {
    this.#writeLane = writeLaneV1(options.writeLane);
    this.#immutable = options.immutable;
    this.#legacy = options.legacy;
    if (this.#writeLane === "versioned" && !this.#legacy) {
      throw new TypeError("The versioned project image.png write lane requires a legacy store.");
    }
  }

  async ready(signal?: AbortSignal) {
    const results = await Promise.all([
      this.#immutable.ready(signal),
      this.#legacy?.ready(signal) ?? Promise.resolve(true),
    ]);
    return results.every(Boolean);
  }

  async put(tenantId: string, projectId: string, bytes: Uint8Array, signal?: AbortSignal) {
    const store = this.#writeLane === "immutable" ? this.#immutable : this.#legacy!;
    const receipt = assertProjectPngReceiptV1(tenantId, projectId, await store.put(tenantId, projectId, bytes, signal));
    assertReceiptLaneV1(receipt, this.#writeLane);
    return receipt;
  }

  read(tenantId: string, projectId: string, receiptValue: ProjectPngBlobReceiptV1, signal?: AbortSignal) {
    const receipt = assertProjectPngReceiptV1(tenantId, projectId, receiptValue);
    return routeStoreV1(receipt, this.#immutable, this.#legacy).read(tenantId, projectId, receipt, signal);
  }

  deleteVersion(tenantId: string, projectId: string, receiptValue: ProjectPngBlobReceiptV1, signal?: AbortSignal) {
    const receipt = assertProjectPngReceiptV1(tenantId, projectId, receiptValue);
    return routeStoreV1(receipt, this.#immutable, this.#legacy).deleteVersion(tenantId, projectId, receipt, signal);
  }

  async listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursor?: string | null,
    signal?: AbortSignal,
  ): Promise<ProjectPngVersionPageV1> {
    const position = routedCursorV1(cursor, this.#legacy !== undefined);
    const store = position.lane === "immutable" ? this.#immutable : this.#legacy!;
    const page = await store.listVersions(tenantId, cutoff, maximum, position.cursor, signal);
    const versions = page.versions.map((version) => {
      const receipt = assertProjectPngReceiptV1(tenantId, version.projectId, version.receipt);
      assertReceiptLaneV1(receipt, position.lane);
      return { ...version, receipt };
    });
    return {
      nextCursor: nextRoutedCursorV1(position.lane, page.nextCursor, this.#legacy !== undefined),
      versions,
    };
  }

  close() {
    this.#closeRequest ??= closeUniqueV1(this.#legacy ? [this.#legacy, this.#immutable] : [this.#immutable]);
    return this.#closeRequest;
  }
}
