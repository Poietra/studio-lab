import { describe, expect, it, vi } from "vitest";

import {
  type ImmutableRenderArtifactReceiptV1,
  immutableRenderArtifactObjectKeyV1,
  type RenderArtifactIdentityV1,
  type RenderArtifactObjectPageV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactStoreV1,
  renderArtifactObjectKeyV1,
  type VersionedRenderArtifactReceiptV1,
} from "./render-artifact-repository";
import { RoutedRenderArtifactStoreV1 } from "./routed-render-artifact-store";

const TENANT = "tenant-a";
const GENERATION = "00000000-0000-4000-8000-0000000000aa";

function identity(kind: "thumbnail" | "video" = "video"): RenderArtifactIdentityV1 {
  return {
    artifactDigest: (kind === "video" ? "1" : "2").repeat(64),
    byteSize: 3,
    kind,
    mediaType: kind === "video" ? "video/mp4" : "image/png",
    profileDigest: "3".repeat(64),
    requestDigest: "4".repeat(64),
    runtimeDigest: "5".repeat(64),
    sourceDigest: "6".repeat(64),
  };
}

function versionedReceipt(): VersionedRenderArtifactReceiptV1 {
  const value = identity();
  return {
    ...value,
    etag: "legacy-etag",
    objectKey: renderArtifactObjectKeyV1(TENANT, value),
    versionId: "legacy-version",
  };
}

function immutableReceipt(): ImmutableRenderArtifactReceiptV1 {
  const value = identity("thumbnail");
  return {
    ...value,
    etag: "immutable-etag",
    objectGeneration: GENERATION,
    objectKey: immutableRenderArtifactObjectKeyV1(TENANT, value, GENERATION),
  };
}

function fakeStore(receipt: RenderArtifactReceiptV1) {
  const page: RenderArtifactObjectPageV1 = { nextCursor: null, objects: [] };
  return {
    close: vi.fn(async () => undefined),
    deleteObject: vi.fn(async () => undefined),
    head: vi.fn(async () => undefined),
    listObjects: vi.fn(async () => page),
    open: vi.fn(async () =>
      (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
    ),
    put: vi.fn(async () => receipt),
    ready: vi.fn(async () => true),
  } satisfies RenderArtifactStoreV1;
}

async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("RoutedRenderArtifactStoreV1", () => {
  it("supports immutable-only production and fails closed for legacy receipts", async () => {
    const immutable = fakeStore(immutableReceipt());
    const routed = new RoutedRenderArtifactStoreV1({ immutable, writeLane: "immutable" });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(routed.put(TENANT, { ...identity("thumbnail"), bytes })).resolves.toEqual(immutableReceipt());
    await routed.head(TENANT, immutableReceipt());
    const stream = await routed.open(TENANT, immutableReceipt(), { end: 2, start: 1 });
    await expect(collect(stream)).resolves.toEqual([bytes]);
    await routed.deleteObject(TENANT, immutableReceipt());

    expect(immutable.open).toHaveBeenCalledWith(TENANT, immutableReceipt(), { end: 2, start: 1 }, undefined);
    await expect(routed.head(TENANT, versionedReceipt())).rejects.toThrow(/legacy.*unavailable/i);
  });

  it("requires a legacy provider for versioned writes and routes both receipt modes", async () => {
    const immutable = fakeStore(immutableReceipt());
    expect(() => new RoutedRenderArtifactStoreV1({ immutable, writeLane: "versioned" })).toThrow(
      /requires a legacy store/i,
    );
    const legacy = fakeStore(versionedReceipt());
    const routed = new RoutedRenderArtifactStoreV1({ immutable, legacy, writeLane: "versioned" });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(routed.put(TENANT, { ...identity(), bytes })).resolves.toEqual(versionedReceipt());
    await routed.head(TENANT, versionedReceipt());
    await routed.head(TENANT, immutableReceipt());
    await routed.deleteObject(TENANT, versionedReceipt());
    await routed.deleteObject(TENANT, immutableReceipt());

    expect(legacy.put).toHaveBeenCalledOnce();
    expect(immutable.put).not.toHaveBeenCalled();
    expect(legacy.head).toHaveBeenCalledOnce();
    expect(immutable.head).toHaveBeenCalledOnce();
    expect(legacy.deleteObject).toHaveBeenCalledOnce();
    expect(immutable.deleteObject).toHaveBeenCalledOnce();
  });

  it("supports dual reads with immutable writes and carries GC cursors across providers", async () => {
    const legacyReceipt = versionedReceipt();
    const currentReceipt = immutableReceipt();
    const legacy = fakeStore(legacyReceipt);
    const immutable = fakeStore(currentReceipt);
    legacy.listObjects.mockResolvedValueOnce({
      nextCursor: null,
      objects: [{ lastModified: new Date(1), receipt: legacyReceipt }],
    });
    immutable.listObjects.mockResolvedValueOnce({
      nextCursor: "immutable-next",
      objects: [{ lastModified: new Date(2), receipt: currentReceipt }],
    });
    const routed = new RoutedRenderArtifactStoreV1({ immutable, legacy, writeLane: "immutable" });
    const cutoff = new Date(3);

    await expect(routed.put(TENANT, { ...identity("thumbnail"), bytes: new Uint8Array([1, 2, 3]) })).resolves.toEqual(
      currentReceipt,
    );
    const first = await routed.listObjects(TENANT, cutoff, 10);
    expect(first.objects).toEqual([{ lastModified: new Date(1), receipt: legacyReceipt }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await routed.listObjects(TENANT, cutoff, 10, first.nextCursor);
    expect(second.objects).toEqual([{ lastModified: new Date(2), receipt: currentReceipt }]);
    expect(second.nextCursor).toEqual(expect.any(String));

    expect(immutable.put).toHaveBeenCalledOnce();
    expect(legacy.put).not.toHaveBeenCalled();
    expect(legacy.listObjects).toHaveBeenCalledWith(TENANT, cutoff, 10, undefined, undefined);
    expect(immutable.listObjects).toHaveBeenCalledWith(TENANT, cutoff, 10, null, undefined);
  });

  it("rejects a provider receipt from the configured wrong write lane", async () => {
    const immutable = fakeStore(versionedReceipt());
    const routed = new RoutedRenderArtifactStoreV1({ immutable, writeLane: "immutable" });
    await expect(routed.put(TENANT, { ...identity(), bytes: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /wrong lane/i,
    );
  });
});
