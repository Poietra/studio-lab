import { describe, expect, it, vi } from "vitest";
import { runRenderArtifactGcV1 } from "./render-artifact-gc";
import {
  immutableRenderArtifactObjectKeyV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactRepositoryV1,
  type RenderArtifactStoreV1,
  renderArtifactObjectKeyV1,
} from "./render-artifact-repository";

const TENANT = "tenant-a";
const IDENTITY = {
  artifactDigest: "1".repeat(64),
  byteSize: 3,
  kind: "video" as const,
  mediaType: "video/mp4" as const,
  profileDigest: "2".repeat(64),
  requestDigest: "3".repeat(64),
  runtimeDigest: "4".repeat(64),
  sourceDigest: "5".repeat(64),
};

function receipt(lane: "immutable" | "versioned"): RenderArtifactReceiptV1 {
  if (lane === "versioned") {
    return {
      ...IDENTITY,
      etag: "legacy-etag",
      objectKey: renderArtifactObjectKeyV1(TENANT, IDENTITY),
      versionId: "legacy-version",
    };
  }
  const objectGeneration = "00000000-0000-4000-8000-0000000000aa";
  return {
    ...IDENTITY,
    etag: "immutable-etag",
    objectGeneration,
    objectKey: immutableRenderArtifactObjectKeyV1(TENANT, IDENTITY, objectGeneration),
  };
}

describe("runRenderArtifactGcV1", () => {
  it.each(["versioned", "immutable"] as const)("queues and deletes the exact %s receipt", async (lane) => {
    const value = receipt(lane);
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
    } as unknown as RenderArtifactStoreV1;
    const repository = {
      acknowledgeDeletion: vi.fn(async () => undefined),
      isArtifactRetained: vi.fn(async () => false),
      pendingDeletions: vi.fn(async () => [deletion]),
      queueDeletion: vi.fn(async () => deletion),
    } as unknown as RenderArtifactRepositoryV1;

    await expect(
      runRenderArtifactGcV1({
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
});
