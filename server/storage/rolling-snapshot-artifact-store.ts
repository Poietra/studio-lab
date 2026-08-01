import type {
  ImmutableSnapshotArtifactStoreV1,
  ImmutableSnapshotArtifactUploadIdentityV1,
} from "./immutable-snapshot-artifact-store";
import {
  parseSnapshotArtifactReceiptV1,
  type SnapshotArtifactReceiptV1,
  type SnapshotArtifactStoreV1,
  type SnapshotArtifactWriteInputV1,
} from "./snapshot-publication-repository";

const MAX_CURSOR_BYTES = 16_384;

type CursorLane = "immutable" | "versioned";
type Cursor = Readonly<{ inner: string | null; lane: CursorLane }>;

function encodeCursor(tenantId: string, cursor: Cursor) {
  return Buffer.from(JSON.stringify([tenantId, cursor.lane, cursor.inner]), "utf8").toString("base64url");
}

function decodeCursor(tenantId: string, value: string | null | undefined): Cursor {
  if (value === null || value === undefined) return { inner: null, lane: "versioned" };
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError("Snapshot artifact rolling cursor is invalid.");
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_CURSOR_BYTES) throw new Error();
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new TypeError("Snapshot artifact rolling cursor is invalid.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== tenantId ||
    (parsed[1] !== "versioned" && parsed[1] !== "immutable") ||
    (parsed[2] !== null && typeof parsed[2] !== "string")
  ) {
    throw new TypeError("Snapshot artifact rolling cursor is invalid.");
  }
  return { inner: parsed[2], lane: parsed[1] };
}

function immutableUploadIdentity(input: SnapshotArtifactWriteInputV1): ImmutableSnapshotArtifactUploadIdentityV1 {
  return {
    kind: "runtime-digest",
    profileDigest: input.profileDigest,
    runtimeConfigHash: input.runtimeConfigHash,
    runtimeDigest: input.runtimeDigest,
    sourceDigest: input.sourceDigest,
  };
}

/** Rolling-cutover port for legacy-write, immutable-write, and immutable-only deployment phases. */
export class RollingSnapshotArtifactStoreV1 implements SnapshotArtifactStoreV1 {
  readonly #immutable: ImmutableSnapshotArtifactStoreV1;
  readonly #versioned: SnapshotArtifactStoreV1 | undefined;
  readonly #writeLane: CursorLane;
  #closeRequest: Promise<void> | null = null;

  constructor(
    options: Readonly<{
      immutable: ImmutableSnapshotArtifactStoreV1;
      versioned?: SnapshotArtifactStoreV1;
      writeLane: CursorLane;
    }>,
  ) {
    if (options.writeLane === "versioned" && options.versioned === undefined) {
      throw new TypeError("The versioned snapshot write lane requires a versioned store.");
    }
    this.#immutable = options.immutable;
    this.#versioned = options.versioned;
    this.#writeLane = options.writeLane;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const readiness = await Promise.all([
      ...(this.#versioned ? [this.#versioned.ready(signal)] : []),
      this.#immutable.ready(signal),
    ]);
    signal?.throwIfAborted();
    return readiness.every(Boolean);
  }

  async put(tenantId: string, input: SnapshotArtifactWriteInputV1, signal?: AbortSignal) {
    if (this.#writeLane === "versioned") return this.#versioned!.put(tenantId, input, signal);
    return this.#immutable.put(tenantId, { bytes: input.bytes, identity: immutableUploadIdentity(input) }, signal);
  }

  async read(tenantId: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const artifact = parseSnapshotArtifactReceiptV1(tenantId, artifactValue);
    if ("versionId" in artifact) {
      if (!this.#versioned) throw new Error("The legacy versioned snapshot lane is unavailable.");
      return this.#versioned.read(tenantId, artifact, signal);
    }
    return this.#immutable.read(tenantId, artifact, signal);
  }

  async deleteVersion(tenantId: string, artifactValue: SnapshotArtifactReceiptV1, signal?: AbortSignal) {
    const artifact = parseSnapshotArtifactReceiptV1(tenantId, artifactValue);
    if ("versionId" in artifact) {
      if (!this.#versioned) throw new Error("The legacy versioned snapshot lane is unavailable.");
      await this.#versioned.deleteVersion(tenantId, artifact, signal);
      return;
    }
    const target = this.#immutable.deletionTarget(tenantId, artifact);
    await this.#immutable.deleteTarget(tenantId, target, signal);
  }

  async listVersions(
    tenantId: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: string | null,
    signal?: AbortSignal,
  ) {
    let cursor = decodeCursor(tenantId, cursorValue);
    if (cursorValue == null && !this.#versioned) cursor = { inner: null, lane: "immutable" };
    if (cursor.lane === "versioned") {
      if (!this.#versioned) throw new Error("The legacy versioned snapshot lane is unavailable.");
      const page = await this.#versioned.listVersions(tenantId, cutoff, maximum, cursor.inner, signal);
      return {
        nextCursor:
          page.nextCursor === null
            ? encodeCursor(tenantId, { inner: null, lane: "immutable" })
            : encodeCursor(tenantId, { inner: page.nextCursor, lane: "versioned" }),
        versions: page.versions,
      };
    }
    const page = await this.#immutable.listOrphanCandidates(tenantId, cutoff, maximum, cursor.inner, signal);
    return {
      nextCursor:
        page.nextCursor === null ? null : encodeCursor(tenantId, { inner: page.nextCursor, lane: "immutable" }),
      versions: page.candidates.map(({ artifact, lastModified }) => ({ artifact, lastModified })),
    };
  }

  close() {
    this.#closeRequest ??= (async () => {
      const results = await Promise.allSettled([
        ...(this.#versioned ? [this.#versioned.close()] : []),
        this.#immutable.close(),
      ]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "Could not fully close rolling snapshot storage.");
    })();
    return this.#closeRequest;
  }
}
