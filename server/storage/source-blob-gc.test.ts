import { describe, expect, it, vi } from "vitest";

import { DurableSourceBlobGcWorkerV1, runSourceBlobGcV1, SourceBlobGcSweepErrorV1 } from "./source-blob-gc";
import type {
  BlobDeletionV1,
  SourceContentBlobStoreV1,
  WorkspaceSourceRepositoryV1,
} from "./workspace-source-repository";

function deletion(digestCharacter: string, deletionId: string): BlobDeletionV1 {
  const digest = digestCharacter.repeat(64);
  return {
    blob: {
      byteSize: 1,
      digest,
      etag: `etag-${digestCharacter}`,
      objectKey: `tenants/tenant-a/sources/${digest}`,
      versionId: `version-${digestCharacter}`,
    },
    deletionId,
    tenantId: "tenant-a",
  };
}

describe("durable source blob GC", () => {
  it("continues a bounded batch after one queued version fails to delete", async () => {
    const first = deletion("a", "00000000-0000-4000-8000-000000000001");
    const second = deletion("b", "00000000-0000-4000-8000-000000000002");
    const attempted: string[] = [];
    const acknowledged: string[] = [];
    const blobs = {
      async deleteVersion(_tenantId: string, blob: BlobDeletionV1["blob"]) {
        attempted.push(blob.digest);
        if (blob.digest === first.blob.digest) throw new Error("locked version");
      },
      async listSourceVersions() {
        return [];
      },
    } as unknown as SourceContentBlobStoreV1;
    const repository = {
      async acknowledgeBlobDeletion(_tenantId: string, deletionId: string) {
        acknowledged.push(deletionId);
      },
      async pendingBlobDeletions() {
        return [first, second];
      },
    } as unknown as WorkspaceSourceRepositoryV1;

    const error = await runSourceBlobGcV1({
      blobs,
      cutoff: new Date(),
      maximum: 2,
      repository,
      tenantId: "tenant-a",
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SourceBlobGcSweepErrorV1);
    expect((error as SourceBlobGcSweepErrorV1).result).toEqual({ deleted: 1, examined: 0, queued: 0 });
    expect(attempted).toEqual([first.blob.digest, second.blob.digest]);
    expect(acknowledged).toEqual([second.deletionId]);
  });

  it("probes storage before the explicit worker performs destructive maintenance", async () => {
    const listSourceVersions = vi.fn(async () => []);
    const blobs = {
      listSourceVersions,
      ready: vi.fn(async () => false),
    } as unknown as SourceContentBlobStoreV1;
    const repository = {
      ready: vi.fn(async () => true),
    } as unknown as WorkspaceSourceRepositoryV1;
    const onFailure = vi.fn();
    const worker = new DurableSourceBlobGcWorkerV1({
      batchSize: 16,
      blobs,
      graceMs: 60_000,
      intervalMs: 1_000,
      onFailure,
      repository,
      tenantId: "tenant-a",
    });

    await expect(worker.start()).rejects.toThrow(/readiness is unavailable/i);
    expect(listSourceVersions).not.toHaveBeenCalled();
    expect(worker.ready()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    await worker.close();
  });
});
