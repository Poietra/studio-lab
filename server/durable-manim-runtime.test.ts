import { describe, expect, it, vi } from "vitest";

import type { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import type { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import { createDurableProductionManimRuntimeAdapterV1, DurableManimRuntimeV1 } from "./durable-manim-runtime";
import type { AuthorizedArtifactReaderV1 } from "./storage/authorized-artifact-reader";
import {
  inspectProjectPngBytesV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
  projectPngObjectKeyV1,
} from "./storage/project-png-storage";
import type { DurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import type { SourceContentBlobStoreV1, WorkspaceSourceRepositoryV1 } from "./storage/workspace-source-repository";

function partial<T>(value: Partial<T>): T {
  return value as T;
}

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngHead(generation = 1n): ProjectPngHeadV1 {
  const inspected = inspectProjectPngBytesV1(pngBytes);
  return {
    generation,
    projectId: "project-a",
    receipt: {
      byteSize: inspected.byteSize,
      digest: inspected.digest,
      etag: "etag-a",
      objectKey: projectPngObjectKeyV1("tenant-a", "project-a", inspected.digest),
      versionId: "version-a",
    },
    tenantId: "tenant-a",
  };
}

describe("DurableManimRuntimeV1 production readiness", () => {
  function workspaceRuntime(
    options: Readonly<{ executionReady?: () => Promise<boolean>; renderReady?: () => Promise<boolean> }>,
  ) {
    const now = new Date("2026-07-31T00:00:00.000Z");
    return new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: options.executionReady ? { ready: options.executionReady } : undefined,
      namespace: "workspace-capability-test",
      renders: options.renderReady
        ? partial<DurableManimRenderServiceV1>({
            close: async () => undefined,
            deliveryReady: options.renderReady,
          })
        : undefined,
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        listSourceHeads: async () => [],
        readProject: async () => ({
          createdAt: now,
          name: "Project A",
          projectId: "project-a",
          tenantId: "tenant-a",
          updatedAt: now,
        }),
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });
  }

  it("reports durable rendering independently from local command availability", async () => {
    const runtime = workspaceRuntime({ executionReady: async () => true, renderReady: async () => true });

    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      commandAvailable: false,
      renderCapability: { available: true, kind: "durable-sandbox", unavailableReason: null },
    });
    await runtime.close();
  });

  it("keeps workspace inspection available when durable rendering is unavailable", async () => {
    const unavailable = workspaceRuntime({ executionReady: async () => false, renderReady: async () => true });
    const failing = workspaceRuntime({
      executionReady: async () => {
        throw new Error("sandbox probe failed");
      },
      renderReady: async () => true,
    });
    const unconfigured = workspaceRuntime({ executionReady: async () => true });

    await expect(unavailable.workspace("project-a")).resolves.toMatchObject({
      renderCapability: {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unavailable",
      },
    });
    await expect(failing.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { available: false, unavailableReason: "durable-render-unavailable" },
    });
    await expect(unconfigured.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { available: false, unavailableReason: "durable-render-unconfigured" },
    });
    await Promise.all([unavailable.close(), failing.close(), unconfigured.close()]);
  });

  it("serves only the unchanged digest-addressed project PNG head", async () => {
    const head = pngHead();
    const readHead = vi.fn(async () => head);
    const read = vi.fn(async () => pngBytes);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: { ready: async () => true },
      namespace: "snapshot-png-test",
      projectPngRepository: partial<ProjectPngRepositoryV1>({ readHead }),
      projectPngs: partial<ProjectPngBlobStoreV1>({ read }),
      repository: partial<WorkspaceSourceRepositoryV1>({ close: async () => undefined, ready: async () => true }),
      tenantId: "tenant-a",
    });

    const asset = await runtime.sceneSnapshotAsset("project-a", head.receipt.digest);

    expect(asset).toEqual({ body: Uint8Array.from(pngBytes), digest: head.receipt.digest, mediaType: "image/png" });
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith("tenant-a", "project-a", head.receipt, undefined);
    await expect(runtime.sceneSnapshotAsset("project-a", "f".repeat(64))).rejects.toMatchObject({ status: 404 });
    await runtime.close();
  });

  it("refuses PNG delivery when the project head changes during the read", async () => {
    const before = pngHead();
    const after = { ...before, generation: 2n };
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: { ready: async () => true },
      namespace: "snapshot-png-stale-test",
      projectPngRepository: partial<ProjectPngRepositoryV1>({
        readHead: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      }),
      projectPngs: partial<ProjectPngBlobStoreV1>({ read: async () => pngBytes }),
      repository: partial<WorkspaceSourceRepositoryV1>({ close: async () => undefined, ready: async () => true }),
      tenantId: "tenant-a",
    });

    await expect(runtime.sceneSnapshotAsset("project-a", before.receipt.digest)).rejects.toMatchObject({ status: 409 });
    await runtime.close();
  });

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

    await Promise.all([adapter.close(), adapter.close()]);
    expect(maintenanceClose).toHaveBeenCalledOnce();
    expect(blobsClose).toHaveBeenCalledOnce();
    expect(repositoryClose).toHaveBeenCalledOnce();
  });

  it("requires and delegates durable snapshots in the production runtime", async () => {
    const closeOrder: string[] = [];
    const deleteController = new AbortController();
    const runSceneSnapshot = vi.fn(async () => ({ kind: "run" }));
    const sceneSnapshot = vi.fn(async () => ({ kind: "read" }));
    const releaseProject = vi.fn(async () => {
      deleteController.abort();
    });
    const softDeleteProject = vi.fn(async () => undefined);
    const listProjects = vi.fn(async (_tenantId: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { defaultProjectId: null, projects: [] };
    });
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
      listProjects,
      ready: async () => true,
      softDeleteProject,
    });
    const runtime = new DurableManimRuntimeV1({
      artifactReader: partial<AuthorizedArtifactReaderV1>({
        close: async () => {
          closeOrder.push("artifact-reader");
        },
        ready: async () => true,
      }),
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => {
          closeOrder.push("blobs");
        },
        ready: async () => true,
      }),
      execution: {
        close: async () => {
          closeOrder.push("execution");
        },
        ready: async () => true,
      },
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
    await expect(runtime.unregisterProject("project-a", deleteController.signal)).resolves.toMatchObject({
      project: null,
    });
    await runtime.close();

    expect(runSceneSnapshot).toHaveBeenCalledWith(request, undefined);
    expect(sceneSnapshot).toHaveBeenCalledWith("project-a", query);
    expect(releaseProject).toHaveBeenCalledWith("project-a", deleteController.signal);
    expect(listProjects).toHaveBeenCalledWith("tenant-a", undefined);
    expect(softDeleteProject).not.toHaveBeenCalled();
    expect(snapshotsClose).toHaveBeenCalledOnce();
    expect(closeOrder.indexOf("snapshots")).toBeLessThan(closeOrder.indexOf("repository"));
    expect(closeOrder.indexOf("snapshots")).toBeLessThan(closeOrder.indexOf("blobs"));
    expect(closeOrder.indexOf("execution")).toBeLessThan(closeOrder.indexOf("artifact-reader"));
  });

  it("falls back to the workspace repository when durable snapshots are not configured", async () => {
    const softDeleteProject = vi.fn(async () => undefined);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: { ready: async () => true },
      namespace: "workspace-delete-fallback-test",
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        listProjects: async () => ({ defaultProjectId: null, projects: [] }),
        ready: async () => true,
        softDeleteProject,
      }),
      tenantId: "tenant-a",
    });

    await expect(runtime.unregisterProject("project-a")).resolves.toMatchObject({ project: null });

    expect(softDeleteProject).toHaveBeenCalledWith("tenant-a", "project-a", undefined);
    await runtime.close();
  });
});
