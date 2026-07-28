import { describe, expect, it, vi } from "vitest";

import type { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import type { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
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

  it("requires and delegates durable snapshots in the production runtime", async () => {
    const closeOrder: string[] = [];
    const runSceneSnapshot = vi.fn(async () => ({ kind: "run" }));
    const sceneSnapshot = vi.fn(async () => ({ kind: "read" }));
    const releaseProject = vi.fn(async () => undefined);
    const snapshotsClose = vi.fn(async () => {
      closeOrder.push("snapshots");
    });
    const snapshots = partial<DurableFastManimSnapshotServiceV1>({
      close: snapshotsClose,
      ready: async () => true,
      releaseProject,
      run: runSceneSnapshot as never,
      snapshot: sceneSnapshot as never,
    });
    const renders = partial<DurableManimRenderServiceV1>({
      close: async () => undefined,
      ready: async () => true,
    });
    const repository = partial<WorkspaceSourceRepositoryV1>({
      close: async () => {
        closeOrder.push("repository");
      },
      listProjects: async () => ({ defaultProjectId: null, projects: [] }),
      ready: async () => true,
      softDeleteProject: async () => undefined,
    });
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => {
          closeOrder.push("blobs");
        },
        ready: async () => true,
      }),
      execution: { ready: async () => true },
      namespace: "production-snapshot-test",
      renders,
      repository,
      snapshots,
      tenantId: "tenant-a",
    });
    const request = {
      projectId: "project-a",
      requestId: "request-a",
      sceneName: "MainScene",
      sourcePath: "main.py",
    } as const;
    const query = { sceneName: "MainScene", sourcePath: "main.py" } as const;

    await expect(runtime.productionReady()).resolves.toBe(true);
    await expect(runtime.runSceneSnapshot(request)).resolves.toEqual({ kind: "run" });
    await expect(runtime.sceneSnapshot("project-a", query)).resolves.toEqual({ kind: "read" });
    await runtime.unregisterProject("project-a");
    await runtime.close();

    expect(runSceneSnapshot).toHaveBeenCalledWith(request, undefined);
    expect(sceneSnapshot).toHaveBeenCalledWith("project-a", query);
    expect(releaseProject).toHaveBeenCalledWith("project-a");
    expect(snapshotsClose).toHaveBeenCalledOnce();
    expect(closeOrder.indexOf("snapshots")).toBeLessThan(closeOrder.indexOf("repository"));
    expect(closeOrder.indexOf("snapshots")).toBeLessThan(closeOrder.indexOf("blobs"));
  });
});
