import { describe, expect, it, vi } from "vitest";

import type { RenderSessionRetentionRepositoryV1 } from "./render-session-repository";
import { DurableRenderSessionRetentionWorkerV1 } from "./render-session-retention";

const TENANT = "tenant-a";

function options(repository: RenderSessionRetentionRepositoryV1) {
  return {
    auditRetentionMs: 120_000,
    batchSize: 16,
    inputRetentionMs: 60_000,
    intervalMs: 1_000,
    onFailure: vi.fn(),
    repository,
    sweepTimeoutMs: 5_000,
    tenantId: TENANT,
  } as const;
}

describe("durable render-session retention", () => {
  it("checks readiness, releases terminal inputs, and only then purges expired audit rows", async () => {
    const calls: string[] = [];
    const repository = {
      async purgeReleasedSessions() {
        calls.push("purge");
        return 1;
      },
      async ready() {
        calls.push("ready");
        return true;
      },
      async releaseExpiredInputs() {
        calls.push("release");
        return {
          projectPngGenerationsOrphaned: 1,
          releasedSessionIds: ["00000000-0000-4000-8000-000000000001"],
          sourceBlobsOrphaned: 1,
        };
      },
    } satisfies RenderSessionRetentionRepositoryV1;
    const worker = new DurableRenderSessionRetentionWorkerV1(options(repository));

    try {
      await worker.start();
      expect(calls).toEqual(["ready", "release", "purge"]);
      expect(worker.ready()).toBe(true);
    } finally {
      await worker.close();
    }
    expect(worker.ready()).toBe(false);
  });

  it("does not mutate storage when schema readiness is unavailable", async () => {
    const releaseExpiredInputs = vi.fn();
    const purgeReleasedSessions = vi.fn();
    const repository = {
      purgeReleasedSessions,
      ready: vi.fn(async () => false),
      releaseExpiredInputs,
    } as unknown as RenderSessionRetentionRepositoryV1;
    const worker = new DurableRenderSessionRetentionWorkerV1(options(repository));

    await expect(worker.start()).rejects.toThrow(/readiness is unavailable/i);
    expect(releaseExpiredInputs).not.toHaveBeenCalled();
    expect(purgeReleasedSessions).not.toHaveBeenCalled();
    await worker.close();
  });

  it("rejects unbounded retention settings before starting maintenance", () => {
    const repository = {} as RenderSessionRetentionRepositoryV1;
    const valid = options(repository);

    expect(() => new DurableRenderSessionRetentionWorkerV1({ ...valid, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => new DurableRenderSessionRetentionWorkerV1({ ...valid, inputRetentionMs: 59_999 })).toThrow(
      /inputRetentionMs/,
    );
    expect(() => new DurableRenderSessionRetentionWorkerV1({ ...valid, auditRetentionMs: 59_999 })).toThrow(
      /auditRetentionMs/,
    );
  });
});
