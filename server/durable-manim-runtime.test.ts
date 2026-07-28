import { describe, expect, it, vi } from "vitest";

import { createDurableProductionManimRuntimeAdapterV1, DurableManimRuntimeV1 } from "./durable-manim-runtime";
import type { DurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import type { SourceContentBlobStoreV1, WorkspaceSourceRepositoryV1 } from "./storage/workspace-source-repository";

function partial<T>(value: Partial<T>): T {
  return value as T;
}

describe("DurableManimRuntimeV1 production readiness", () => {
  it("does not attest production readiness without the durable render service", async () => {
    const repositoryClose = vi.fn(async () => undefined);
    const blobsClose = vi.fn(async () => undefined);
    const maintenanceClose = vi.fn(async () => undefined);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: blobsClose,
        ready: async () => true,
      }),
      execution: { ready: async () => true },
      namespace: "production-readiness-test",
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: repositoryClose,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });
    const maintenance = partial<DurableSourceBlobGcWorkerV1>({
      close: maintenanceClose,
      ready: () => true,
    });
    const adapter = createDurableProductionManimRuntimeAdapterV1(runtime, maintenance);

    await expect(runtime.ready()).resolves.toBe(true);
    await expect(runtime.productionReady()).resolves.toBe(false);
    await expect(adapter.ready(new AbortController().signal)).resolves.toEqual({ ready: false });

    await adapter.close();
    expect(maintenanceClose).toHaveBeenCalledOnce();
    expect(blobsClose).toHaveBeenCalledOnce();
    expect(repositoryClose).toHaveBeenCalledOnce();
  });
});
