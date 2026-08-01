import { describe, expect, it, vi } from "vitest";

import type {
  ImmutableSnapshotArtifactReceiptV1,
  ImmutableSnapshotArtifactStoreV1,
} from "./immutable-snapshot-artifact-store";
import { RollingSnapshotArtifactStoreV1 } from "./rolling-snapshot-artifact-store";
import type {
  SnapshotArtifactStoreV1,
  SnapshotArtifactWriteInputV1,
  VersionedSnapshotArtifactReceiptV1,
} from "./snapshot-publication-repository";

const TENANT = "tenant-a";
const SOURCE = "1".repeat(64);
const RUNTIME_CONFIG = "2".repeat(64);
const PROFILE = "3".repeat(64);
const RUNTIME = "4".repeat(64);
const RESULT = "5".repeat(64);
const GENERATION = "00000000-0000-4000-8000-000000000001";

const input: SnapshotArtifactWriteInputV1 = {
  bytes: Uint8Array.of(1),
  profileDigest: PROFILE,
  runtimeConfigHash: RUNTIME_CONFIG,
  runtimeDigest: RUNTIME,
  sourceDigest: SOURCE,
};

function versioned(): VersionedSnapshotArtifactReceiptV1 {
  return {
    byteSize: 1,
    etag: "legacy-etag",
    objectKey: `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RUNTIME}/${RESULT}`,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash: RUNTIME_CONFIG,
    runtimeDigest: RUNTIME,
    sourceDigest: SOURCE,
    versionId: "legacy-version",
  };
}

function immutable(): ImmutableSnapshotArtifactReceiptV1 {
  return {
    byteSize: 1,
    etag: "immutable-etag",
    identity: {
      kind: "runtime-digest",
      profileDigest: PROFILE,
      resultDigest: RESULT,
      runtimeConfigHash: RUNTIME_CONFIG,
      runtimeDigest: RUNTIME,
      sourceDigest: SOURCE,
    },
    objectGeneration: GENERATION,
    objectKey: `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RUNTIME}/${RESULT}/g/${GENERATION}`,
    schema: "poietra.immutable-snapshot-artifact-receipt",
    version: 1,
  };
}

function stores() {
  const legacy = versioned();
  const next = immutable();
  const versionedStore = {
    close: vi.fn(async () => undefined),
    deleteVersion: vi.fn(async () => undefined),
    listVersions: vi.fn(async () => ({
      nextCursor: null,
      versions: [{ artifact: legacy, lastModified: new Date(1) }],
    })),
    put: vi.fn(async () => legacy),
    read: vi.fn(async () => Uint8Array.of(1)),
    ready: vi.fn(async () => true),
  } as unknown as SnapshotArtifactStoreV1;
  const immutableStore = {
    close: vi.fn(async () => undefined),
    deletionTarget: vi.fn((_tenantId, artifact) => ({ artifact })),
    deleteTarget: vi.fn(async () => undefined),
    listOrphanCandidates: vi.fn(async () => ({
      candidates: [{ artifact: next, lastModified: new Date(2) }],
      nextCursor: null,
    })),
    put: vi.fn(async () => next),
    read: vi.fn(async () => Uint8Array.of(2)),
    ready: vi.fn(async () => true),
  } as unknown as ImmutableSnapshotArtifactStoreV1;
  return { immutableStore, next, legacy, versionedStore };
}

describe("RollingSnapshotArtifactStoreV1", () => {
  it("requires the versioned provider only when it is the explicit write lane", () => {
    const { immutableStore } = stores();
    expect(() => new RollingSnapshotArtifactStoreV1({ immutable: immutableStore, writeLane: "versioned" })).toThrow(
      /requires a versioned store/i,
    );
    expect(
      () => new RollingSnapshotArtifactStoreV1({ immutable: immutableStore, writeLane: "immutable" }),
    ).not.toThrow();
  });

  it("supports legacy-write and immutable-write phases without changing the consumer port", async () => {
    const { immutableStore, next, legacy, versionedStore } = stores();
    const legacyWriter = new RollingSnapshotArtifactStoreV1({
      immutable: immutableStore,
      versioned: versionedStore,
      writeLane: "versioned",
    });
    await expect(legacyWriter.put(TENANT, input)).resolves.toEqual(legacy);
    expect(versionedStore.put).toHaveBeenCalledOnce();

    const immutableWriter = new RollingSnapshotArtifactStoreV1({
      immutable: immutableStore,
      versioned: versionedStore,
      writeLane: "immutable",
    });
    await expect(immutableWriter.put(TENANT, input)).resolves.toEqual(next);
    expect(immutableStore.put).toHaveBeenCalledWith(
      TENANT,
      {
        bytes: input.bytes,
        identity: {
          kind: "runtime-digest",
          profileDigest: PROFILE,
          runtimeConfigHash: RUNTIME_CONFIG,
          runtimeDigest: RUNTIME,
          sourceDigest: SOURCE,
        },
      },
      undefined,
    );
  });

  it("routes exact reads and deletes by locator kind", async () => {
    const { immutableStore, next, legacy, versionedStore } = stores();
    const store = new RollingSnapshotArtifactStoreV1({
      immutable: immutableStore,
      versioned: versionedStore,
      writeLane: "immutable",
    });

    await expect(store.read(TENANT, legacy)).resolves.toEqual(Uint8Array.of(1));
    await expect(store.read(TENANT, next)).resolves.toEqual(Uint8Array.of(2));
    await store.deleteVersion(TENANT, legacy);
    await store.deleteVersion(TENANT, next);

    expect(versionedStore.deleteVersion).toHaveBeenCalledWith(TENANT, legacy, undefined);
    expect(immutableStore.deletionTarget).toHaveBeenCalledWith(TENANT, next);
    expect(immutableStore.deleteTarget).toHaveBeenCalledOnce();
  });

  it("walks the versioned lane before the immutable lane with a tenant-bound cursor", async () => {
    const { immutableStore, next, legacy, versionedStore } = stores();
    const store = new RollingSnapshotArtifactStoreV1({
      immutable: immutableStore,
      versioned: versionedStore,
      writeLane: "immutable",
    });
    const first = await store.listVersions(TENANT, new Date(), 10);
    expect(first.versions).toEqual([{ artifact: legacy, lastModified: new Date(1) }]);
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listVersions(TENANT, new Date(), 10, first.nextCursor);
    expect(second).toEqual({ nextCursor: null, versions: [{ artifact: next, lastModified: new Date(2) }] });
    await expect(store.listVersions("tenant-b", new Date(), 10, first.nextCursor)).rejects.toThrow(/cursor/i);
  });

  it("skips the retired lane for immutable-only operation and fails closed on legacy receipts", async () => {
    const { immutableStore, next, legacy } = stores();
    const store = new RollingSnapshotArtifactStoreV1({ immutable: immutableStore, writeLane: "immutable" });

    await expect(store.listVersions(TENANT, new Date(), 10)).resolves.toEqual({
      nextCursor: null,
      versions: [{ artifact: next, lastModified: new Date(2) }],
    });
    await expect(store.read(TENANT, legacy)).rejects.toThrow(/legacy versioned snapshot lane is unavailable/i);
    await expect(store.deleteVersion(TENANT, legacy)).rejects.toThrow(/legacy versioned snapshot lane is unavailable/i);
  });
});
