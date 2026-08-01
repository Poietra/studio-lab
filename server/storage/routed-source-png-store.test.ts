import { describe, expect, it, vi } from "vitest";

import { immutableProjectPngObjectKeyV1, immutableSourceBlobObjectKeyV1 } from "./immutable-source-png-storage";
import type { ProjectPngBlobStoreV1 } from "./project-png-storage";
import { RoutedProjectPngBlobStoreV1, RoutedSourceContentBlobStoreV1 } from "./routed-source-png-store";
import type { SourceContentBlobStoreV1 } from "./workspace-source-repository";

const TENANT = "tenant-a";
const PROJECT = "project-a";
const DIGEST = "a".repeat(64);
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const CUTOFF = new Date("2026-08-01T00:00:00.000Z");
const LAST_MODIFIED = new Date("2026-07-01T00:00:00.000Z");

const versionedSource = {
  byteSize: 4,
  digest: DIGEST,
  etag: '"source-v"',
  objectKey: `tenants/${TENANT}/sources/${DIGEST}`,
  versionId: "source-version",
} as const;

const immutableSource = {
  byteSize: 4,
  digest: DIGEST,
  etag: '"source-i"',
  objectGeneration: GENERATION,
  objectKey: immutableSourceBlobObjectKeyV1(TENANT, DIGEST, GENERATION),
} as const;

const versionedPng = {
  byteSize: 64,
  digest: DIGEST,
  etag: '"png-v"',
  objectKey: `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${DIGEST}`,
  versionId: "png-version",
} as const;

const immutablePng = {
  byteSize: 64,
  digest: DIGEST,
  etag: '"png-i"',
  objectGeneration: GENERATION,
  objectKey: immutableProjectPngObjectKeyV1(TENANT, PROJECT, DIGEST, GENERATION),
} as const;

function sourceStore(overrides: Partial<SourceContentBlobStoreV1>): SourceContentBlobStoreV1 {
  return {
    close: vi.fn(async () => undefined),
    deleteVersion: vi.fn(async () => undefined),
    listSourceVersions: vi.fn(async () => ({ nextCursor: null, versions: [] })),
    putSource: vi.fn(async () => immutableSource),
    readSource: vi.fn(async () => "source"),
    ready: vi.fn(async () => true),
    ...overrides,
  };
}

function pngStore(overrides: Partial<ProjectPngBlobStoreV1>): ProjectPngBlobStoreV1 {
  return {
    close: vi.fn(async () => undefined),
    deleteVersion: vi.fn(async () => undefined),
    listVersions: vi.fn(async () => ({ nextCursor: null, versions: [] })),
    put: vi.fn(async () => immutablePng),
    read: vi.fn(async () => new Uint8Array([1])),
    ready: vi.fn(async () => true),
    ...overrides,
  };
}

describe("RoutedSourceContentBlobStoreV1", () => {
  it("routes writes explicitly, reads by locator, and scans both GC lanes", async () => {
    const legacy = sourceStore({
      listSourceVersions: vi.fn(async () => ({
        nextCursor: null,
        versions: [{ blob: versionedSource, lastModified: LAST_MODIFIED }],
      })),
      putSource: vi.fn(async () => versionedSource),
      readSource: vi.fn(async () => "legacy"),
    });
    const immutable = sourceStore({
      listSourceVersions: vi.fn(async () => ({
        nextCursor: null,
        versions: [{ blob: immutableSource, lastModified: LAST_MODIFIED }],
      })),
      putSource: vi.fn(async () => immutableSource),
      readSource: vi.fn(async () => "immutable"),
    });
    const store = new RoutedSourceContentBlobStoreV1({ immutable, legacy, writeLane: "immutable" });

    await expect(store.putSource(TENANT, "test")).resolves.toEqual(immutableSource);
    await expect(store.readSource(TENANT, versionedSource)).resolves.toBe("legacy");
    await expect(store.readSource(TENANT, immutableSource)).resolves.toBe("immutable");
    await store.deleteVersion(TENANT, versionedSource);
    await store.deleteVersion(TENANT, immutableSource);

    const legacyPage = await store.listSourceVersions(TENANT, CUTOFF, 10);
    expect(legacyPage.versions).toEqual([{ blob: versionedSource, lastModified: LAST_MODIFIED }]);
    expect(legacyPage.nextCursor).not.toBeNull();
    const immutablePage = await store.listSourceVersions(TENANT, CUTOFF, 10, legacyPage.nextCursor);
    expect(immutablePage).toEqual({
      nextCursor: null,
      versions: [{ blob: immutableSource, lastModified: LAST_MODIFIED }],
    });
    expect(legacy.putSource).not.toHaveBeenCalled();
    expect(legacy.deleteVersion).toHaveBeenCalledWith(TENANT, versionedSource, undefined);
    expect(immutable.deleteVersion).toHaveBeenCalledWith(TENANT, immutableSource, undefined);

    await store.close();
    await store.close();
    expect(legacy.close).toHaveBeenCalledOnce();
    expect(immutable.close).toHaveBeenCalledOnce();
  });

  it("fails closed when a legacy locator or write lane has no legacy store", async () => {
    const immutable = sourceStore({});
    expect(() => new RoutedSourceContentBlobStoreV1({ immutable, writeLane: "versioned" })).toThrow(
      "requires a legacy store",
    );
    const store = new RoutedSourceContentBlobStoreV1({ immutable, writeLane: "immutable" });
    expect(() => store.readSource(TENANT, versionedSource)).toThrow("without the legacy storage lane");
    await store.close();
  });

  it("rejects a store that returns a receipt from the configured write lane's opposite", async () => {
    const immutable = sourceStore({ putSource: vi.fn(async () => versionedSource) });
    const store = new RoutedSourceContentBlobStoreV1({ immutable, writeLane: "immutable" });
    await expect(store.putSource(TENANT, "test")).rejects.toThrow("other lane");
    await store.close();
  });
});

describe("RoutedProjectPngBlobStoreV1", () => {
  it("routes project PNG writes and GC using the same explicit cutover contract", async () => {
    const legacy = pngStore({
      listVersions: vi.fn(async () => ({
        nextCursor: null,
        versions: [{ lastModified: LAST_MODIFIED, projectId: PROJECT, receipt: versionedPng }],
      })),
      read: vi.fn(async () => new Uint8Array([1])),
    });
    const immutable = pngStore({
      listVersions: vi.fn(async () => ({
        nextCursor: null,
        versions: [{ lastModified: LAST_MODIFIED, projectId: PROJECT, receipt: immutablePng }],
      })),
      put: vi.fn(async () => immutablePng),
      read: vi.fn(async () => new Uint8Array([2])),
    });
    const store = new RoutedProjectPngBlobStoreV1({ immutable, legacy, writeLane: "immutable" });

    await expect(store.put(TENANT, PROJECT, new Uint8Array([9]))).resolves.toEqual(immutablePng);
    await expect(store.read(TENANT, PROJECT, versionedPng)).resolves.toEqual(new Uint8Array([1]));
    await expect(store.read(TENANT, PROJECT, immutablePng)).resolves.toEqual(new Uint8Array([2]));
    const legacyPage = await store.listVersions(TENANT, CUTOFF, 10);
    const immutablePage = await store.listVersions(TENANT, CUTOFF, 10, legacyPage.nextCursor);
    expect(legacyPage.versions[0]?.receipt).toEqual(versionedPng);
    expect(immutablePage.versions[0]?.receipt).toEqual(immutablePng);
    expect(immutablePage.nextCursor).toBeNull();

    await store.close();
    expect(legacy.close).toHaveBeenCalledOnce();
    expect(immutable.close).toHaveBeenCalledOnce();
  });

  it("rejects a malformed routed GC cursor", async () => {
    const store = new RoutedProjectPngBlobStoreV1({ immutable: pngStore({}), writeLane: "immutable" });
    await expect(store.listVersions(TENANT, CUTOFF, 10, "not-json")).rejects.toThrow(
      "Routed storage cursor is invalid",
    );
    await store.close();
  });
});
