import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditProgram } from "../src/studio/operations";
import type { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import type { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import { createDurableProductionManimRuntimeAdapterV1, DurableManimRuntimeV1 } from "./durable-manim-runtime";
import type { ManimRuntimeTraceEditVerifier } from "./manim-runtime-trace-edit-verifier";
import type { AuthorizedArtifactReaderV1 } from "./storage/authorized-artifact-reader";
import { MIN_DURABLE_GC_GRACE_MS_V1 } from "./storage/durable-gc-core";
import type { EditorDocumentRepositoryV1 } from "./storage/editor-document-repository";
import {
  inspectProjectPngBytesV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
  projectPngObjectKeyV1,
} from "./storage/project-png-storage";
import type { DurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import type {
  SourceBlobReceiptV1,
  SourceContentBlobStoreV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

function partial<T>(value: Partial<T>): T {
  return value as T;
}

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngReceipt(projectId: string, versionId = "version-a") {
  const inspected = inspectProjectPngBytesV1(pngBytes);
  return {
    byteSize: inspected.byteSize,
    digest: inspected.digest,
    etag: '"png-a"',
    objectKey: projectPngObjectKeyV1("tenant-a", projectId, inspected.digest),
    versionId,
  } as const;
}

function pngHead(generation = 1n): ProjectPngHeadV1 {
  return {
    generation,
    projectId: "project-a",
    receipt: pngReceipt("project-a"),
    tenantId: "tenant-a",
  };
}

function runtimeTraceEditExportFixture(withVerifier: boolean, edit: "move" | "resize" = "move") {
  const source = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(0.1)
`;
  const digest = createHash("sha256").update(source).digest("hex");
  const sourcePath = "scene.py";
  const entityId = `source:${sourcePath}#StaticSquare:square`;
  const operation =
    edit === "move"
      ? ({
          dependsOn: [],
          entityId,
          id: "durable-runtime-trace-position",
          interval: { end: 0, start: 0 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
          value: { x: 410, y: 135 },
        } as const)
      : ({
          dependsOn: [],
          easing: "smooth",
          entityId,
          from: 1,
          id: "durable-runtime-trace-scale",
          interval: { end: 0, start: 0 },
          key: "scale",
          kind: "AnimateProperty",
          provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
          relativeFactor: 1.5,
          to: 1.5,
        } as const);
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["durable Runtime Trace export"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "durable-runtime-trace-export",
    version: 1,
  };
  const request: ProgramRenderRequest = {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "project-a",
    sceneName: "StaticSquare",
    sourceValidation: "runtime-trace",
    sourceBindings: [{ entityId, sourceVariable: "square" }],
    sourceHash: digest,
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
  const head = {
    blob: {
      byteSize: Buffer.byteLength(source),
      digest,
      etag: '"source-runtime-trace"',
      objectKey: `tenants/tenant-a/sources/${digest}`,
      versionId: "source-runtime-trace-version",
    },
    generation: 1n,
    projectId: request.projectId,
    sourcePath,
    tenantId: "tenant-a",
  } as const;
  const verify = vi.fn<ManimRuntimeTraceEditVerifier["verify"]>(async () => undefined);
  const runtime = new DurableManimRuntimeV1({
    blobs: partial<SourceContentBlobStoreV1>({
      close: async () => undefined,
      readSource: async () => source,
      ready: async () => true,
    }),
    ...(withVerifier ? { runtimeTraceEditVerifier: { verify } } : {}),
    namespace: "runtime-trace-export-test",
    repository: partial<WorkspaceSourceRepositoryV1>({
      close: async () => undefined,
      readSourceHead: async () => head,
      ready: async () => true,
    }),
    tenantId: "tenant-a",
  });
  return { digest, entityId, request, runtime, verify };
}

describe("DurableManimRuntimeV1 production readiness", () => {
  function workspaceRuntime(
    options: Readonly<{
      blobsReady?: () => Promise<boolean>;
      editorDocuments?: EditorDocumentRepositoryV1;
      executionReady?: () => Promise<boolean>;
      renderReady?: () => Promise<boolean>;
      repositoryReady?: () => Promise<boolean>;
    }>,
  ) {
    const now = new Date("2026-07-31T00:00:00.000Z");
    return new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        ready: options.blobsReady ?? (async () => true),
      }),
      execution: options.executionReady ? { ready: options.executionReady } : undefined,
      editorDocuments: options.editorDocuments,
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
        ready: options.repositoryReady ?? (async () => true),
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

  it("verifies a generic move edit before exporting its durable source", async () => {
    const { digest, entityId, request, runtime, verify } = runtimeTraceEditExportFixture(true);

    const exported = await runtime.exportSource(request);

    expect(exported).toMatchObject({ fileName: "scene.poietra.py", projectId: "project-a" });
    expect(exported.source).toContain("square.move_to(");
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0].preflight).toMatchObject({
      baseSourceHash: digest,
      entityId,
      kind: "runtime-trace-move-edit",
      sourceAnchor: 0,
    });
    expect(verify.mock.calls[0]?.[1]).toEqual(request);
    await runtime.close();
  });

  it("fails generic durable source export closed when candidate verification is unavailable", async () => {
    const { request, runtime } = runtimeTraceEditExportFixture(false);

    await expect(runtime.exportSource(request)).rejects.toMatchObject({ status: 503 });
    await runtime.close();
  });

  it("verifies a generic resize edit before exporting its durable source", async () => {
    const { digest, entityId, request, runtime, verify } = runtimeTraceEditExportFixture(true, "resize");

    const exported = await runtime.exportSource(request);

    expect(exported).toMatchObject({ fileName: "scene.poietra.py", projectId: "project-a" });
    expect(exported.source).toContain("square.scale(1.5)");
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.calls[0]?.[0].preflight).toMatchObject({
      baseSourceHash: digest,
      entityId,
      expectedScaleFactor: 1.5,
      kind: "runtime-trace-resize-edit",
      sourceAnchor: 0,
    });
    expect(verify.mock.calls[0]?.[1]).toEqual(request);
    await runtime.close();
  });

  it("fails generic resize durable source export closed when candidate verification is unavailable", async () => {
    const { request, runtime } = runtimeTraceEditExportFixture(false, "resize");

    await expect(runtime.exportSource(request)).rejects.toMatchObject({ status: 503 });
    await runtime.close();
  });

  it("uses the same source-to-delivery readiness boundary for the workspace capability", async () => {
    const sourceUnavailable = workspaceRuntime({
      blobsReady: async () => false,
      executionReady: async () => true,
      renderReady: async () => true,
    });

    await expect(sourceUnavailable.renderReady()).resolves.toBe(false);
    await expect(sourceUnavailable.workspace("project-a")).resolves.toMatchObject({
      renderCapability: {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unavailable",
      },
    });
    await sourceUnavailable.close();
  });

  it("includes the production maintenance gate in both capability and render admission readiness", async () => {
    let maintenanceAvailable = false;
    const runtime = workspaceRuntime({
      editorDocuments: partial<EditorDocumentRepositoryV1>({ close: async () => undefined }),
      executionReady: async () => true,
      renderReady: async () => true,
    });
    const adapter = createDurableProductionManimRuntimeAdapterV1(
      runtime,
      partial<DurableSourceBlobGcWorkerV1>({
        close: async () => undefined,
        ready: () => maintenanceAvailable,
      }),
    );

    await expect(adapter.renderReady(new AbortController().signal)).resolves.toBe(false);
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { available: false, unavailableReason: "durable-render-unavailable" },
    });

    maintenanceAvailable = true;
    await expect(adapter.renderReady(new AbortController().signal)).resolves.toBe(true);
    await expect(runtime.workspace("project-a")).resolves.toMatchObject({
      renderCapability: { available: true, unavailableReason: null },
    });
    await adapter.close();
  });

  it("serves only the unchanged digest-addressed project PNG head", async () => {
    const head = pngHead();
    const readHead = vi.fn(async () => head);
    const read = vi.fn(async () => pngBytes);
    const closeProjectPngs = vi.fn(async () => undefined);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, ready: async () => true }),
      execution: { ready: async () => true },
      namespace: "snapshot-png-test",
      projectPngRepository: partial<ProjectPngRepositoryV1>({ readHead }),
      projectPngs: partial<ProjectPngBlobStoreV1>({ close: closeProjectPngs, read }),
      repository: partial<WorkspaceSourceRepositoryV1>({ close: async () => undefined, ready: async () => true }),
      tenantId: "tenant-a",
    });

    const asset = await runtime.sceneSnapshotAsset("project-a", head.receipt.digest);

    expect(asset).toEqual({ body: Uint8Array.from(pngBytes), digest: head.receipt.digest, mediaType: "image/png" });
    expect(readHead).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith("tenant-a", "project-a", head.receipt, undefined);
    await expect(runtime.sceneSnapshotAsset("project-a", "f".repeat(64))).rejects.toMatchObject({ status: 404 });
    await runtime.close();
    await runtime.close();
    expect(closeProjectPngs).toHaveBeenCalledOnce();
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
      projectPngs: partial<ProjectPngBlobStoreV1>({
        close: async () => undefined,
        read: async () => pngBytes,
      }),
      repository: partial<WorkspaceSourceRepositoryV1>({ close: async () => undefined, ready: async () => true }),
      tenantId: "tenant-a",
    });

    await expect(runtime.sceneSnapshotAsset("project-a", before.receipt.digest)).rejects.toMatchObject({ status: 409 });
    await runtime.close();
  });

  it("does not attest production readiness without the durable render service", async () => {
    const repositoryClose = vi.fn(async () => undefined);
    const blobsClose = vi.fn(async () => undefined);
    const repositoryReady = vi.fn(async () => true);
    const blobsReady = vi.fn(async () => true);
    const editorDocumentsClose = vi.fn(async () => undefined);
    const editorDocumentsReady = vi.fn(async () => false);
    const editorDocuments = partial<EditorDocumentRepositoryV1>({
      close: editorDocumentsClose,
      ready: editorDocumentsReady,
    });
    const maintenanceClose = vi.fn(async () => undefined);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: blobsClose,
        ready: blobsReady,
      }),
      editorDocuments,
      execution: { ready: async () => true },
      namespace: "production-readiness-test",
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: repositoryClose,
        ready: repositoryReady,
      }),
      tenantId: "tenant-a",
    });
    const maintenance = partial<DurableSourceBlobGcWorkerV1>({
      close: maintenanceClose,
      ready: () => true,
    });
    const adapter = createDurableProductionManimRuntimeAdapterV1(runtime, maintenance);

    await expect(runtime.ready()).resolves.toBe(true);
    expect(editorDocumentsReady).not.toHaveBeenCalled();
    await expect(runtime.workspaceReady()).resolves.toBe(true);
    await expect(runtime.productionReady()).resolves.toBe(false);
    expect(adapter.editorDocuments).toBe(editorDocuments);
    if (!adapter.editorReady) throw new Error("The durable adapter did not expose editor readiness.");
    const workspaceProbeCounts = [repositoryReady.mock.calls.length, blobsReady.mock.calls.length];
    await expect(adapter.editorReady(new AbortController().signal)).resolves.toBe(false);
    expect([repositoryReady.mock.calls.length, blobsReady.mock.calls.length]).toEqual(workspaceProbeCounts);
    await expect(adapter.workspaceReady(new AbortController().signal)).resolves.toBe(true);
    await expect(adapter.ready(new AbortController().signal)).resolves.toEqual({ ready: false });

    await Promise.all([adapter.close(), adapter.close()]);
    expect(maintenanceClose).toHaveBeenCalledOnce();
    expect(blobsClose).toHaveBeenCalledOnce();
    expect(editorDocumentsClose).toHaveBeenCalledOnce();
    expect(repositoryClose).toHaveBeenCalledOnce();
  });

  it("requires and delegates durable snapshots in the production runtime", async () => {
    const closeOrder: string[] = [];
    const deleteController = new AbortController();
    const runSceneSnapshot = vi.fn(async () => ({ kind: "run" }));
    const runRuntimeTrace = vi.fn(async () => ({ kind: "trace" }));
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
      runRuntimeTrace: runRuntimeTrace as never,
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
    const runtimeTraceRequest = { ...request, sourceHash: "a".repeat(64) };

    await expect(runtime.productionReady()).resolves.toBe(true);
    await expect(runtime.runSceneSnapshot(request)).resolves.toEqual({ kind: "run" });
    await expect(runtime.runRuntimeTrace(runtimeTraceRequest)).resolves.toEqual({ kind: "trace" });
    await expect(runtime.sceneSnapshot("project-a", query)).resolves.toEqual({ kind: "read" });
    await expect(runtime.unregisterProject("project-a", deleteController.signal)).resolves.toMatchObject({
      project: null,
    });
    await runtime.close();

    expect(runSceneSnapshot).toHaveBeenCalledWith(request, undefined);
    expect(runRuntimeTrace).toHaveBeenCalledWith(runtimeTraceRequest, undefined);
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

  it("atomically publishes a browser-imported Scene under one server-owned project identity", async () => {
    const source = `from manim import *

class ImportedScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
`;
    const digest = createHash("sha256").update(source).digest("hex");
    const candidate: SourceBlobReceiptV1 = {
      byteSize: Buffer.byteLength(source),
      digest,
      etag: '"source-a"',
      objectKey: `tenants/tenant-a/sources/${digest}`,
      versionId: "source-version-a",
    };
    const putSource = vi.fn(async () => candidate);
    const createManagedProject = vi.fn(async () => ({
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      name: "Imported demo",
      projectId: "project-browser-import",
      tenantId: "tenant-a",
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    }));
    const catalog = {
      defaultProjectId: "project-browser-import",
      projects: [{ id: "project-browser-import", kind: "managed" as const, name: "Imported demo" }],
    };
    const listProjects = vi.fn(async () => catalog);
    const project = {
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      name: "Imported demo",
      projectId: "project-browser-import",
      tenantId: "tenant-a",
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    };
    const head = {
      blob: candidate,
      generation: 1n,
      projectId: project.projectId,
      sourcePath: "lesson.py",
      tenantId: "tenant-a",
    };
    const queueBlobDeletion = vi.fn(async () => null);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        putSource,
        readSource: async () => source,
        ready: async () => true,
      }),
      namespace: "browser-import-success-test",
      projectIdFactory: () => "project-browser-import",
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        createManagedProject,
        listProjects,
        listSourceHeads: async () => [head],
        queueBlobDeletion,
        readProject: async () => project,
        readSourceHead: async () => head,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    await expect(
      runtime.importBrowserProject({ imagePngBase64: null, name: "Imported demo", source, sourceName: "lesson.py" }),
    ).resolves.toEqual({
      catalog,
      project: { id: "project-browser-import", kind: "managed", name: "Imported demo" },
    });
    expect(putSource).toHaveBeenCalledWith("tenant-a", source, undefined);
    expect(createManagedProject).toHaveBeenCalledWith(
      {
        name: "Imported demo",
        projectId: "project-browser-import",
        source: { blob: candidate, path: "lesson.py" },
        tenantId: "tenant-a",
      },
      undefined,
    );
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    await expect(runtime.workspace("project-browser-import")).resolves.toMatchObject({
      projectId: "project-browser-import",
      sources: [{ path: "lesson.py", scenes: [{ name: "ImportedScene", sourceHash: digest }] }],
    });
    await expect(
      runtime.exportOriginalSource({
        projectId: "project-browser-import",
        sourceHash: digest,
        sourcePath: "lesson.py",
      }),
    ).resolves.toEqual({ fileName: "lesson.py", projectId: "project-browser-import", source });
    await runtime.close();
  });

  it("publishes an exact browser image.png in the same project transaction as its source", async () => {
    const source = `from manim import *
class ImportedScene(Scene):
    def construct(self):
        image = ImageMobject("image.png")
        self.add(image)
`;
    const sourceCandidate = {
      byteSize: Buffer.byteLength(source),
      digest: createHash("sha256").update(source).digest("hex"),
      etag: '"source-png"',
      objectKey: `tenants/tenant-a/sources/${createHash("sha256").update(source).digest("hex")}`,
      versionId: "source-version-png",
    } satisfies SourceBlobReceiptV1;
    const projectPngCandidate = pngReceipt("project-browser-png");
    const createManagedProject = vi.fn(async () => ({
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      name: "Image demo",
      projectId: "project-browser-png",
      tenantId: "tenant-a",
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    }));
    const putProjectPng = vi.fn(async () => projectPngCandidate);
    const queueBlobDeletion = vi.fn(async () => null);
    const queueProjectPngDeletion = vi.fn(async () => null);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        putSource: async () => sourceCandidate,
        ready: async () => true,
      }),
      namespace: "browser-png-import-success-test",
      projectIdFactory: () => "project-browser-png",
      projectPngRepository: partial<ProjectPngRepositoryV1>({
        queueDeletion: queueProjectPngDeletion,
        readHead: async () => null,
      }),
      projectPngs: partial<ProjectPngBlobStoreV1>({
        close: async () => undefined,
        put: putProjectPng,
        read: async () => pngBytes,
      }),
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        createManagedProject,
        listProjects: async () => ({
          defaultProjectId: "project-browser-png",
          projects: [{ id: "project-browser-png", kind: "managed", name: "Image demo" }],
        }),
        queueBlobDeletion,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    await expect(
      runtime.importBrowserProject({
        imagePngBase64: pngBytes.toString("base64"),
        name: "Image demo",
        source,
        sourceName: "scene.py",
      }),
    ).resolves.toMatchObject({ project: { id: "project-browser-png", kind: "managed", name: "Image demo" } });
    expect(putProjectPng).toHaveBeenCalledWith("tenant-a", "project-browser-png", Uint8Array.from(pngBytes), undefined);
    expect(createManagedProject).toHaveBeenCalledWith(
      {
        name: "Image demo",
        projectId: "project-browser-png",
        projectPng: projectPngCandidate,
        source: { blob: sourceCandidate, path: "scene.py" },
        tenantId: "tenant-a",
      },
      undefined,
    );
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(queueProjectPngDeletion).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("queues both immutable candidates after image-backed project publication fails", async () => {
    const source = `from manim import *
class ImportedScene(Scene):
    def construct(self):
        image = ImageMobject("image.png")
        self.add(image)
`;
    const sourceCandidate = {
      byteSize: Buffer.byteLength(source),
      digest: "d".repeat(64),
      etag: '"source-d"',
      objectKey: `tenants/tenant-a/sources/${"d".repeat(64)}`,
      versionId: "source-version-d",
    } satisfies SourceBlobReceiptV1;
    const projectPngCandidate = pngReceipt("project-browser-png-failed", "version-failed");
    const publicationError = new Error("publication failed");
    const sourceCleanupError = new Error("source cleanup failed");
    const queueBlobDeletion = vi.fn(async () => {
      throw sourceCleanupError;
    });
    const queueProjectPngDeletion = vi.fn(async () => null);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        putSource: async () => sourceCandidate,
        ready: async () => true,
      }),
      namespace: "browser-png-import-rollback-test",
      projectIdFactory: () => "project-browser-png-failed",
      projectPngRepository: partial<ProjectPngRepositoryV1>({
        queueDeletion: queueProjectPngDeletion,
        readHead: async () => null,
      }),
      projectPngs: partial<ProjectPngBlobStoreV1>({
        close: async () => undefined,
        put: async () => projectPngCandidate,
        read: async () => pngBytes,
      }),
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        createManagedProject: async () => {
          throw publicationError;
        },
        queueBlobDeletion,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    const failure = runtime.importBrowserProject({
      imagePngBase64: pngBytes.toString("base64"),
      name: "Image demo",
      source,
      sourceName: "scene.py",
    });
    await expect(failure).rejects.toMatchObject({
      errors: expect.arrayContaining([publicationError, sourceCleanupError]),
      message: "Project import and orphan cleanup both failed.",
    });
    expect(queueBlobDeletion).toHaveBeenCalledWith("tenant-a", sourceCandidate);
    expect(queueProjectPngDeletion).toHaveBeenCalledWith(
      "tenant-a",
      "project-browser-png-failed",
      projectPngCandidate,
      MIN_DURABLE_GC_GRACE_MS_V1,
    );
    await runtime.close();
  });

  it("queues an uploaded source only when atomic project publication fails", async () => {
    const source = "from manim import *\nclass MainScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const candidate = {
      byteSize: Buffer.byteLength(source),
      digest: "b".repeat(64),
      etag: '"source-b"',
      objectKey: `tenants/tenant-a/sources/${"b".repeat(64)}`,
      versionId: "source-version-b",
    } satisfies SourceBlobReceiptV1;
    const publicationError = new Error("publication failed");
    const queueBlobDeletion = vi.fn(async () => null);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        putSource: async () => candidate,
        ready: async () => true,
      }),
      namespace: "browser-import-rollback-test",
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        createManagedProject: async () => {
          throw publicationError;
        },
        queueBlobDeletion,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    await expect(
      runtime.importBrowserProject({ imagePngBase64: null, name: "Demo", source, sourceName: "scene.py" }),
    ).rejects.toBe(publicationError);
    expect(queueBlobDeletion).toHaveBeenCalledWith("tenant-a", candidate);
    await runtime.close();
  });

  it("never queues referenced source or image candidates when the response fails after publication", async () => {
    const source = `from manim import *
class MainScene(Scene):
    def construct(self):
        image = ImageMobject("image.png")
        self.add(image)
`;
    const candidate = {
      byteSize: Buffer.byteLength(source),
      digest: "c".repeat(64),
      etag: '"source-c"',
      objectKey: `tenants/tenant-a/sources/${"c".repeat(64)}`,
      versionId: "source-version-c",
    } satisfies SourceBlobReceiptV1;
    const projectPngCandidate = pngReceipt("project-browser-import", "version-committed");
    const queueBlobDeletion = vi.fn(async () => null);
    const queueProjectPngDeletion = vi.fn(async () => null);
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({
        close: async () => undefined,
        putSource: async () => candidate,
        ready: async () => true,
      }),
      namespace: "browser-import-post-publication-test",
      projectIdFactory: () => "project-browser-import",
      projectPngRepository: partial<ProjectPngRepositoryV1>({
        queueDeletion: queueProjectPngDeletion,
        readHead: async () => null,
      }),
      projectPngs: partial<ProjectPngBlobStoreV1>({
        close: async () => undefined,
        put: async () => projectPngCandidate,
        read: async () => pngBytes,
      }),
      repository: partial<WorkspaceSourceRepositoryV1>({
        close: async () => undefined,
        createManagedProject: async () => ({
          createdAt: new Date(),
          name: "Demo",
          projectId: "project-browser-import",
          tenantId: "tenant-a",
          updatedAt: new Date(),
        }),
        listProjects: async () => {
          throw new Error("catalog unavailable");
        },
        queueBlobDeletion,
        ready: async () => true,
      }),
      tenantId: "tenant-a",
    });

    await expect(
      runtime.importBrowserProject({
        imagePngBase64: pngBytes.toString("base64"),
        name: "Demo",
        source,
        sourceName: "scene.py",
      }),
    ).rejects.toThrow("catalog unavailable");
    expect(queueBlobDeletion).not.toHaveBeenCalled();
    expect(queueProjectPngDeletion).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("reports missing Scenes and unsupported browser assets before uploading source bytes", async () => {
    const putSource = vi.fn();
    const runtime = new DurableManimRuntimeV1({
      blobs: partial<SourceContentBlobStoreV1>({ close: async () => undefined, putSource, ready: async () => true }),
      namespace: "browser-import-diagnostics-test",
      repository: partial<WorkspaceSourceRepositoryV1>({ close: async () => undefined, ready: async () => true }),
      tenantId: "tenant-a",
    });

    await expect(
      runtime.importBrowserProject({
        imagePngBase64: null,
        name: "No Scene",
        source: "print('hello')\n",
        sourceName: "script.py",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      runtime.importBrowserProject({
        imagePngBase64: null,
        name: "Asset Scene",
        source:
          'from manim import *\nclass AssetScene(Scene):\n    def construct(self):\n        image = ImageMobject("asset.png")\n        self.add(image)\n',
        sourceName: "asset_scene.py",
      }),
    ).rejects.toThrow(/only direct ImageMobject assignments/i);
    expect(putSource).not.toHaveBeenCalled();
    await runtime.close();
  });
});
