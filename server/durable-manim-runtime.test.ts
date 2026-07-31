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
  it("reports the durable render capability and fails closed on readiness probe errors", async () => {
    let renderServiceReadiness: boolean | Error = true;
    let executorReadiness: boolean | Error | "pending" = true;
    const renderStart = vi.fn();
    const renderServiceReady = vi.fn(async () => {
      if (renderServiceReadiness instanceof Error) throw renderServiceReadiness;
      return renderServiceReadiness;
    });
    const executionReady = vi.fn(async () => {
      if (executorReadiness instanceof Error) throw executorReadiness;
      if (executorReadiness === "pending") return new Promise<boolean>(() => undefined);
      return executorReadiness;
    });
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: { ready: executionReady },
      namespace: "render-capability-test",
      renders: partial<DurableManimRenderServiceV1>({
        close: async () => undefined,
        ready: renderServiceReady,
        start: renderStart,
      }),
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        listSourceHeads: async () => [],
        readProject: async () => ({
          createdAt: new Date(0),
          name: "Project A",
          projectId: "project-a",
          tenantId: "tenant-a",
          updatedAt: new Date(0),
        }),
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { backend: "durable-sandbox", kind: "ready" },
    });
    await expect(runtime.start({} as never)).resolves.toBeUndefined();
    expect(renderStart).toHaveBeenCalledOnce();
    renderServiceReadiness = false;
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { kind: "unavailable", reason: "durable-render-service-unavailable" },
    });
    renderServiceReadiness = new Error("probe failed");
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { kind: "unavailable", reason: "durable-render-service-unavailable" },
    });
    renderServiceReadiness = true;
    executorReadiness = false;
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { kind: "unavailable", reason: "durable-executor-unavailable" },
    });
    executorReadiness = new Error("probe failed");
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { kind: "unavailable", reason: "durable-executor-unavailable" },
    });
    await expect(runtime.start({} as never)).rejects.toMatchObject({ status: 503 });
    executorReadiness = "pending";
    vi.useFakeTimers();
    try {
      const timedOutWorkspace = runtime.workspace("project-a");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(timedOutWorkspace).resolves.toMatchObject({
        renderCapability: { kind: "unavailable", reason: "durable-render-readiness-timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
    expect(executionReady).toHaveBeenCalled();
    expect(renderServiceReady).toHaveBeenCalled();
    expect(renderStart).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("keeps core API readiness independent from the render executor", async () => {
    const repositoryReady = vi.fn(async () => true);
    const blobsReady = vi.fn(async () => true);
    const artifactReaderReady = vi.fn(async () => true);
    const executionReady = vi.fn(async () => false);
    const rendersReady = vi.fn(async () => true);
    const snapshotsReady = vi.fn(async () => true);
    const runtime = new DurableManimRuntimeV1({
      artifactReader: partial<AuthorizedArtifactReaderV1>({
        close: async () => undefined,
        ready: artifactReaderReady,
      }),
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: blobsReady }),
      execution: { ready: executionReady },
      namespace: "api-readiness-test",
      renders: partial<DurableManimRenderServiceV1>({ close: async () => undefined, ready: rendersReady }),
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        ready: repositoryReady,
      }),
      snapshots: partial<DurableFastManimSnapshotServiceV1>({
        close: async () => undefined,
        ready: snapshotsReady,
      }),
      tenantId: "tenant-a",
    });
    const adapter = createDurableProductionManimRuntimeAdapterV1(
      runtime,
      partial<DurableSourceBlobGcWorkerV1>({ close: async () => undefined, ready: () => true }),
    );
    const signal = new AbortController().signal;

    await expect(adapter.apiReady(signal)).resolves.toBe(true);
    expect(repositoryReady).toHaveBeenCalledOnce();
    expect(blobsReady).toHaveBeenCalledOnce();
    expect(artifactReaderReady).not.toHaveBeenCalled();
    expect(executionReady).not.toHaveBeenCalled();
    expect(rendersReady).not.toHaveBeenCalled();
    expect(snapshotsReady).not.toHaveBeenCalled();

    await expect(adapter.ready(signal)).resolves.toEqual({ ready: false });
    expect(artifactReaderReady).toHaveBeenCalledOnce();
    expect(executionReady).toHaveBeenCalledOnce();
    expect(rendersReady).toHaveBeenCalledOnce();
    expect(snapshotsReady).toHaveBeenCalledOnce();
    await adapter.close();
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
