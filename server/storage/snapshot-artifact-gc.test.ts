import { describe, expect, it, vi } from "vitest";

import {
  DurableSnapshotArtifactGcWorkerV1,
  runSnapshotArtifactGcV1,
  SnapshotArtifactGcSweepErrorV1,
} from "./snapshot-artifact-gc";
import type {
  SnapshotArtifactDeletionV1,
  SnapshotArtifactReceiptV1,
  SnapshotArtifactStoreV1,
  SnapshotPublicationRepositoryV1,
} from "./snapshot-publication-repository";

const TENANT = "tenant-a";

function artifact(digestCharacter: string): SnapshotArtifactReceiptV1 {
  const resultDigest = digestCharacter.repeat(64);
  const runtimeDigest = "4".repeat(64);
  return {
    byteSize: 1,
    etag: `etag-${digestCharacter}`,
    objectKey:
      `tenants/${TENANT}/snapshots/${"1".repeat(64)}/${"2".repeat(64)}/${"3".repeat(64)}` +
      `/${runtimeDigest}/${resultDigest}`,
    profileDigest: "3".repeat(64),
    resultDigest,
    runtimeConfigHash: "2".repeat(64),
    runtimeDigest,
    sourceDigest: "1".repeat(64),
    versionId: `version-${digestCharacter}`,
  };
}

function deletion(digestCharacter: string, deletionId: string): SnapshotArtifactDeletionV1 {
  return { artifact: artifact(digestCharacter), deletionId, tenantId: TENANT };
}

describe("durable snapshot artifact GC", () => {
  it("retains published versions and durably queues then deletes an upload orphan", async () => {
    const published = artifact("a");
    const orphan = deletion("b", "00000000-0000-4000-8000-000000000002");
    const queued: string[] = [];
    const deleted: Array<readonly [string, string]> = [];
    const acknowledged: string[] = [];
    const artifacts = {
      async deleteVersion(tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        deleted.push([tenantId, receipt.versionId]);
      },
      async listVersions() {
        return {
          nextCursor: "next-page",
          versions: [
            { artifact: published, lastModified: new Date(0) },
            { artifact: orphan.artifact, lastModified: new Date(0) },
          ],
        };
      },
    } as unknown as SnapshotArtifactStoreV1;
    const repository = {
      async acknowledgeArtifactDeletion(_tenantId: string, deletionId: string) {
        acknowledged.push(deletionId);
      },
      async isArtifactPublished(_tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        return receipt.resultDigest === published.resultDigest;
      },
      async pendingArtifactDeletions() {
        return [orphan];
      },
      async queueArtifactDeletion(_tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        queued.push(receipt.resultDigest);
        return orphan;
      },
    } as unknown as SnapshotPublicationRepositoryV1;

    await expect(
      runSnapshotArtifactGcV1({
        artifacts,
        cutoff: new Date(),
        maximum: 2,
        repository,
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ deleted: 1, examined: 2, nextCursor: "next-page", queued: 1 });
    expect(queued).toEqual([orphan.artifact.resultDigest]);
    expect(deleted).toEqual([[TENANT, orphan.artifact.versionId]]);
    expect(acknowledged).toEqual([orphan.deletionId]);
  });

  it("continues past a full published page so a later orphan cannot starve", async () => {
    vi.useFakeTimers();
    const published = artifact("a");
    const orphan = deletion("b", "00000000-0000-4000-8000-000000000002");
    const cursors: Array<string | null> = [];
    const queued: string[] = [];
    const pages = [
      { nextCursor: "published-page-end", versions: [{ artifact: published, lastModified: new Date(0) }] },
      { nextCursor: null, versions: [{ artifact: orphan.artifact, lastModified: new Date(0) }] },
    ];
    const artifacts = {
      async listVersions(_tenantId: string, _cutoff: Date, _maximum: number, cursor?: string | null) {
        cursors.push(cursor ?? null);
        return pages.shift() ?? { nextCursor: null, versions: [] };
      },
      ready: vi.fn(async () => true),
    } as unknown as SnapshotArtifactStoreV1;
    const repository = {
      async isArtifactPublished(_tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        return receipt.resultDigest === published.resultDigest;
      },
      async pendingArtifactDeletions() {
        return [];
      },
      async queueArtifactDeletion(_tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        queued.push(receipt.resultDigest);
        return orphan;
      },
      ready: vi.fn(async () => true),
    } as unknown as SnapshotPublicationRepositoryV1;
    const worker = new DurableSnapshotArtifactGcWorkerV1({
      artifacts,
      batchSize: 1,
      graceMs: 60_000,
      intervalMs: 1_000,
      onFailure: vi.fn(),
      repository,
      sweepTimeoutMs: 5_000,
      tenantId: TENANT,
    });

    try {
      await worker.start();
      expect(queued).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cursors).toEqual([null, "published-page-end"]);
      expect(queued).toEqual([orphan.artifact.resultDigest]);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it("continues the pending batch and reports partial progress after a delete fails", async () => {
    const first = deletion("a", "00000000-0000-4000-8000-000000000001");
    const second = deletion("b", "00000000-0000-4000-8000-000000000002");
    const attempted: string[] = [];
    const acknowledged: string[] = [];
    const artifacts = {
      async deleteVersion(_tenantId: string, receipt: SnapshotArtifactReceiptV1) {
        attempted.push(receipt.versionId);
        if (receipt.versionId === first.artifact.versionId) throw new Error("locked version");
      },
      async listVersions() {
        return { nextCursor: null, versions: [] };
      },
    } as unknown as SnapshotArtifactStoreV1;
    const repository = {
      async acknowledgeArtifactDeletion(_tenantId: string, deletionId: string) {
        acknowledged.push(deletionId);
      },
      async pendingArtifactDeletions() {
        return [first, second];
      },
    } as unknown as SnapshotPublicationRepositoryV1;

    const error = await runSnapshotArtifactGcV1({
      artifacts,
      cutoff: new Date(),
      maximum: 2,
      repository,
      tenantId: TENANT,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SnapshotArtifactGcSweepErrorV1);
    expect((error as SnapshotArtifactGcSweepErrorV1).errors).toHaveLength(1);
    expect((error as SnapshotArtifactGcSweepErrorV1).result).toEqual({
      deleted: 1,
      examined: 0,
      nextCursor: null,
      queued: 0,
    });
    expect(attempted).toEqual([first.artifact.versionId, second.artifact.versionId]);
    expect(acknowledged).toEqual([second.deletionId]);
  });

  it("checks both storage dependencies before destructive maintenance", async () => {
    const listVersions = vi.fn(async () => ({ nextCursor: null, versions: [] }));
    const artifacts = {
      listVersions,
      ready: vi.fn(async () => false),
    } as unknown as SnapshotArtifactStoreV1;
    const repository = {
      ready: vi.fn(async () => true),
    } as unknown as SnapshotPublicationRepositoryV1;
    const worker = new DurableSnapshotArtifactGcWorkerV1({
      artifacts,
      batchSize: 16,
      graceMs: 60_000,
      intervalMs: 1_000,
      onFailure: vi.fn(),
      repository,
      sweepTimeoutMs: 5_000,
      tenantId: TENANT,
    });

    await expect(worker.start()).rejects.toThrow(/readiness is unavailable/i);
    expect(listVersions).not.toHaveBeenCalled();
    expect(worker.ready()).toBe(false);
    await worker.close();
  });

  it("bounds worker options and propagates abort instead of treating it as a delete failure", async () => {
    const first = deletion("a", "00000000-0000-4000-8000-000000000001");
    const controller = new AbortController();
    const artifacts = {
      async deleteVersion() {
        controller.abort(new Error("shutdown"));
        throw new Error("request cancelled");
      },
      async listVersions() {
        return { nextCursor: null, versions: [] };
      },
      ready: vi.fn(async () => true),
    } as unknown as SnapshotArtifactStoreV1;
    const repository = {
      async pendingArtifactDeletions() {
        return [first];
      },
      ready: vi.fn(async () => true),
    } as unknown as SnapshotPublicationRepositoryV1;

    await expect(
      runSnapshotArtifactGcV1({
        artifacts,
        cutoff: new Date(),
        maximum: 1,
        repository,
        signal: controller.signal,
        tenantId: TENANT,
      }),
    ).rejects.toThrow("shutdown");

    const validOptions = {
      artifacts,
      batchSize: 1,
      graceMs: 60_000,
      intervalMs: 1_000,
      onFailure: vi.fn(),
      repository,
      sweepTimeoutMs: 1_000,
      tenantId: TENANT,
    } as const;
    expect(() => new DurableSnapshotArtifactGcWorkerV1({ ...validOptions, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => new DurableSnapshotArtifactGcWorkerV1({ ...validOptions, graceMs: 59_999 })).toThrow(/graceMs/);
    expect(() => new DurableSnapshotArtifactGcWorkerV1({ ...validOptions, intervalMs: 999 })).toThrow(/intervalMs/);
    expect(() => new DurableSnapshotArtifactGcWorkerV1({ ...validOptions, sweepTimeoutMs: 999 })).toThrow(
      /sweepTimeoutMs/,
    );
  });
});
