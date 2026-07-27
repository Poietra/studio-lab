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
  it("continues past a full published page so later orphans cannot starve", async () => {
    vi.useFakeTimers();
    const published = deletion("a", "00000000-0000-4000-8000-000000000001");
    const orphan = deletion("b", "00000000-0000-4000-8000-000000000002");
    const cursors: Array<string | null> = [];
    const queued: string[] = [];
    const pages = [
      {
        nextCursor: "published-page-end",
        versions: [{ blob: published.blob, lastModified: new Date(0) }],
      },
      { nextCursor: null, versions: [{ blob: orphan.blob, lastModified: new Date(0) }] },
    ];
    const blobs = {
      async listSourceVersions(_tenant: string, _cutoff: Date, _maximum: number, cursor?: string | null) {
        cursors.push(cursor ?? null);
        return pages.shift() ?? { nextCursor: null, versions: [] };
      },
      ready: vi.fn(async () => true),
    } as unknown as SourceContentBlobStoreV1;
    const repository = {
      async isBlobVersionPublished(_tenant: string, blob: BlobDeletionV1["blob"]) {
        return blob.digest === published.blob.digest;
      },
      async pendingBlobDeletions() {
        return [];
      },
      async queueBlobDeletion(_tenant: string, blob: BlobDeletionV1["blob"]) {
        queued.push(blob.digest);
        return orphan;
      },
      ready: vi.fn(async () => true),
    } as unknown as WorkspaceSourceRepositoryV1;
    const worker = new DurableSourceBlobGcWorkerV1({
      batchSize: 1,
      blobs,
      graceMs: 60_000,
      intervalMs: 1_000,
      onFailure: vi.fn(),
      repository,
      sweepTimeoutMs: 5_000,
      tenantId: "tenant-a",
    });

    try {
      await worker.start();
      expect(queued).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cursors).toEqual([null, "published-page-end"]);
      expect(queued).toEqual([orphan.blob.digest]);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

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
        return { nextCursor: null, versions: [] };
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
    expect((error as SourceBlobGcSweepErrorV1).result).toEqual({
      deleted: 1,
      examined: 0,
      nextCursor: null,
      queued: 0,
    });
    expect(attempted).toEqual([first.blob.digest, second.blob.digest]);
    expect(acknowledged).toEqual([second.deletionId]);
  });

  it("probes storage before the explicit worker performs destructive maintenance", async () => {
    const listSourceVersions = vi.fn(async () => ({ nextCursor: null, versions: [] }));
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
      sweepTimeoutMs: 5_000,
      tenantId: "tenant-a",
    });

    await expect(worker.start()).rejects.toThrow(/readiness is unavailable/i);
    expect(listSourceVersions).not.toHaveBeenCalled();
    expect(worker.ready()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    await worker.close();
  });
});
