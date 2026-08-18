import { describe, expect, it, vi } from "vitest";
import {
  type ClientExportArtifactReceiptV1,
  type ClientExportArtifactStoreV1,
  type ClientExportRepositoryV1,
  clientExportObjectKeyV1,
} from "./client-export-contract";
import { runClientExportGcV1 } from "./client-export-gc";

const TENANT = "tenant-a";
const OBJECT_LOCATOR_TOKEN = "00000000-0000-4000-8000-0000000000aa";

function receipt(): ClientExportArtifactReceiptV1 {
  const contentDigest = "1".repeat(64);
  return {
    byteSize: 3,
    contentDigest,
    etag: "immutable-etag",
    mediaType: "video/mp4",
    objectKey: clientExportObjectKeyV1(TENANT, contentDigest, OBJECT_LOCATOR_TOKEN),
    objectLocatorToken: OBJECT_LOCATOR_TOKEN,
  };
}

describe("runClientExportGcV1", () => {
  it("queues and deletes the exact unretained receipt then acknowledges its tombstone", async () => {
    const value = receipt();
    const deletion = {
      deletionId: "00000000-0000-4000-8000-000000000001",
      receipt: value,
      tenantId: TENANT,
    };
    const artifacts = {
      deleteObject: vi.fn(async () => undefined),
      listObjects: vi.fn(async () => ({
        nextCursor: null,
        objects: [{ lastModified: new Date(0), receipt: value }],
      })),
    } as unknown as ClientExportArtifactStoreV1;
    const repository = {
      acknowledgeDeletion: vi.fn(async () => undefined),
      isArtifactRetained: vi.fn(async () => false),
      pendingDeletions: vi.fn(async () => [deletion]),
      queueDeletion: vi.fn(async () => deletion),
    } as unknown as ClientExportRepositoryV1;

    await expect(
      runClientExportGcV1({
        artifacts,
        cutoff: new Date(1),
        graceMs: 60_000,
        maximum: 1,
        repository,
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ deleted: 1, examined: 1, nextCursor: null, queued: 1 });

    expect(repository.queueDeletion).toHaveBeenCalledWith(TENANT, value, 60_000, undefined);
    expect(artifacts.deleteObject).toHaveBeenCalledWith(TENANT, value, undefined);
    expect(repository.acknowledgeDeletion).toHaveBeenCalledWith(TENANT, deletion.deletionId, undefined);
  });

  it("never queues a receipt while a live publication or read claim retains it", async () => {
    const value = receipt();
    const artifacts = {
      deleteObject: vi.fn(async () => undefined),
      listObjects: vi.fn(async () => ({
        nextCursor: null,
        objects: [{ lastModified: new Date(0), receipt: value }],
      })),
    } as unknown as ClientExportArtifactStoreV1;
    const repository = {
      acknowledgeDeletion: vi.fn(async () => undefined),
      isArtifactRetained: vi.fn(async () => true),
      pendingDeletions: vi.fn(async () => []),
      queueDeletion: vi.fn(async () => null),
    } as unknown as ClientExportRepositoryV1;

    await expect(
      runClientExportGcV1({
        artifacts,
        cutoff: new Date(1),
        graceMs: 60_000,
        maximum: 1,
        repository,
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ deleted: 0, examined: 1, nextCursor: null, queued: 0 });

    expect(repository.queueDeletion).not.toHaveBeenCalled();
    expect(artifacts.deleteObject).not.toHaveBeenCalled();
  });
});
