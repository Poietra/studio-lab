import { describe, expect, it, vi } from "vitest";

import { runProjectPngGcV1 } from "./project-png-gc";
import type { ProjectPngBlobStoreV1, ProjectPngRepositoryV1 } from "./project-png-storage";

describe("runProjectPngGcV1", () => {
  it("keeps a pinned replacement and deletes only the unreferenced upload orphan", async () => {
    const pinned = { digest: "a".repeat(64), projectId: "project-a" };
    const orphan = { digest: "b".repeat(64), projectId: "project-b" };
    const receipt = (candidate: typeof pinned) => ({
      byteSize: 128,
      digest: candidate.digest,
      etag: `etag-${candidate.projectId}`,
      objectKey: `tenants/tenant-a/projects/${candidate.projectId}/assets/image.png/${candidate.digest}`,
      versionId: `version-${candidate.projectId}`,
    });
    const deletion = {
      deletionId: "87654321-4321-4321-8321-cba987654321",
      projectId: orphan.projectId,
      receipt: receipt(orphan),
      tenantId: "tenant-a",
    };
    const repository = {
      acknowledgeDeletion: vi.fn(async () => undefined),
      isVersionRetained: vi.fn(async (_tenant, projectId) => projectId === pinned.projectId),
      pendingDeletions: vi.fn(async () => [deletion]),
      queueDeletion: vi.fn(async () => deletion),
    } as unknown as ProjectPngRepositoryV1;
    const store = {
      deleteVersion: vi.fn(async () => undefined),
      listVersions: vi.fn(async () => ({
        nextCursor: null,
        versions: [pinned, orphan].map((candidate) => ({
          lastModified: new Date("2026-07-27T00:00:00.000Z"),
          projectId: candidate.projectId,
          receipt: receipt(candidate),
        })),
      })),
    } as unknown as ProjectPngBlobStoreV1;

    await expect(
      runProjectPngGcV1({
        cutoff: new Date("2026-07-28T00:00:00.000Z"),
        maximum: 2,
        repository,
        store,
        tenantId: "tenant-a",
      }),
    ).resolves.toEqual({ deleted: 1, examined: 2, nextCursor: null, queued: 1 });
    expect(repository.queueDeletion).toHaveBeenCalledOnce();
    expect(repository.queueDeletion).toHaveBeenCalledWith("tenant-a", orphan.projectId, receipt(orphan), undefined);
    expect(store.deleteVersion).toHaveBeenCalledWith("tenant-a", orphan.projectId, receipt(orphan), undefined);
  });
});
