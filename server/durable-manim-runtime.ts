import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type {
  ManimProjectMutationView,
  ManimRenderCapability,
  ManimSourceExport,
  ManimThumbnailStatus,
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
  RenderCommitRequest,
  RenderSourceActionCancellationRequest,
} from "../src/render-pipeline/contracts";
import type { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import type { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import type { FastManimSnapshotQueryV1, FastManimSnapshotRunRequestV1 } from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import type { MutableManimProjectApiOperations } from "./manim-api";
import type { ProductionManimRuntimeAdapterV1 } from "./manim-production-server";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";
import { importSourceSnapshot } from "./manim-workspace";
import type { AuthorizedArtifactReaderV1 } from "./storage/authorized-artifact-reader";
import {
  assertProjectPngReceiptV1,
  inspectProjectPngBytesV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
} from "./storage/project-png-storage";
import type { DurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import type {
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

export const DURABLE_MANAGED_WORKSPACE_STARTER_V1 = `from manim import *

class MainScene(Scene):
    def construct(self):
        # poietra:anchor 0.000
        self.wait(1)
`;

const DEFAULT_FRAME = Object.freeze({ height: 8, width: 14.222 });

export type DurableManimExecutionReadinessV1 = Readonly<{
  close?: () => Promise<void>;
  ready: (signal?: AbortSignal) => Promise<boolean>;
}>;

export type DurableManimRuntimeOptionsV1 = Readonly<{
  artifactReader?: Pick<AuthorizedArtifactReaderV1, "close" | "projectThumbnail" | "projectThumbnailBytes" | "ready">;
  blobs: SourceContentBlobStoreV1;
  execution?: DurableManimExecutionReadinessV1;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  projectIdFactory?: () => string;
  projectPngRepository?: Pick<ProjectPngRepositoryV1, "readHead">;
  projectPngs?: Pick<ProjectPngBlobStoreV1, "read">;
  renders?: DurableManimRenderServiceV1;
  repository: WorkspaceSourceRepositoryV1;
  snapshots?: DurableFastManimSnapshotServiceV1;
  tenantId: string;
}>;

function projectIdFromUuid() {
  return `project-${randomUUID().replaceAll("-", "")}`;
}

function validateFrame(frame: Readonly<{ height: number; width: number }>) {
  if (!Number.isFinite(frame.height) || frame.height <= 0 || !Number.isFinite(frame.width) || frame.width <= 0) {
    throw new TypeError("The durable workspace frame must have finite positive dimensions.");
  }
  return { height: frame.height, width: frame.width };
}

function exportFileName(sourcePath: string, suffix = "") {
  const sourceName = basename(sourcePath)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = (sourceName || "manim-scene.py").replace(/[.]py$/, "");
  return `${stem}${suffix}.py`;
}

function sameProjectPngHead(left: ProjectPngHeadV1, right: ProjectPngHeadV1 | null) {
  return (
    right !== null &&
    left.tenantId === right.tenantId &&
    left.projectId === right.projectId &&
    left.generation === right.generation &&
    left.receipt.byteSize === right.receipt.byteSize &&
    left.receipt.digest === right.receipt.digest &&
    left.receipt.etag === right.receipt.etag &&
    left.receipt.objectKey === right.receipt.objectKey &&
    left.receipt.versionId === right.receipt.versionId
  );
}

function unavailableThumbnail(projectId: string): ManimThumbnailStatus {
  return {
    cachedSourceHash: null,
    error: "Thumbnail rendering is not connected to the durable sandbox runtime yet.",
    generatedAt: null,
    imageKind: "empty",
    projectId,
    sceneName: null,
    sourceHash: null,
    sourcePath: null,
    state: "unavailable",
  };
}

/**
 * Tenant-fixed production API backed exclusively by PostgreSQL and immutable,
 * version-addressed S3 objects. It never constructs a host project root.
 */
export class DurableManimRuntimeV1 implements MutableManimProjectApiOperations {
  readonly #artifactReader:
    | Pick<AuthorizedArtifactReaderV1, "close" | "projectThumbnail" | "projectThumbnailBytes" | "ready">
    | undefined;
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #execution: DurableManimExecutionReadinessV1 | undefined;
  readonly #frame: Readonly<{ height: number; width: number }>;
  readonly #projectIdFactory: () => string;
  readonly #projectPngRepository: Pick<ProjectPngRepositoryV1, "readHead"> | undefined;
  readonly #projectPngs: Pick<ProjectPngBlobStoreV1, "read"> | undefined;
  readonly #renders: DurableManimRenderServiceV1 | undefined;
  readonly #repository: WorkspaceSourceRepositoryV1;
  readonly #snapshots: DurableFastManimSnapshotServiceV1 | undefined;
  readonly storageBoundary: Readonly<{ kind: "shared-durable"; namespace: string }>;
  readonly tenantId: string;
  #closeRequest: Promise<void> | null = null;

  constructor(options: DurableManimRuntimeOptionsV1) {
    const parsedTenant = manimTenantIdSchema.safeParse(options.tenantId);
    if (!parsedTenant.success) throw new TypeError("The durable runtime tenant ID is invalid.");
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(options.namespace)) {
      throw new TypeError("The durable runtime namespace is invalid.");
    }
    this.tenantId = parsedTenant.data;
    this.storageBoundary = Object.freeze({ kind: "shared-durable", namespace: options.namespace });
    this.#repository = options.repository;
    this.#artifactReader = options.artifactReader;
    this.#blobs = options.blobs;
    this.#execution = options.execution;
    this.#renders = options.renders;
    this.#snapshots = options.snapshots;
    this.#frame = validateFrame(options.frame ?? DEFAULT_FRAME);
    this.#projectIdFactory = options.projectIdFactory ?? projectIdFromUuid;
    if ((options.projectPngRepository === undefined) !== (options.projectPngs === undefined)) {
      throw new TypeError("Durable project PNG repository and blob store must be configured together.");
    }
    this.#projectPngRepository = options.projectPngRepository;
    this.#projectPngs = options.projectPngs;
  }

  async initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.#repository.ensureTenant(this.tenantId, signal);
    signal?.throwIfAborted();
    return this;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [repositoryReady, blobsReady, artifactReaderReady, executionReady, rendersReady, snapshotsReady] =
      await Promise.all([
        this.#repository.ready(signal),
        this.#blobs.ready(signal),
        this.#artifactReader?.ready(signal) ?? Promise.resolve(true),
        this.#execution?.ready(signal) ?? Promise.resolve(false),
        this.#renders?.ready(signal) ?? Promise.resolve(true),
        this.#snapshots?.ready(signal) ?? Promise.resolve(true),
      ]);
    signal?.throwIfAborted();
    return repositoryReady && blobsReady && artifactReaderReady && executionReady && rendersReady && snapshotsReady;
  }

  /** Production attestation additionally requires the durable render service. */
  async productionReady(signal?: AbortSignal) {
    if (!this.#artifactReader || !this.#renders || !this.#snapshots) return false;
    return this.ready(signal);
  }

  async projects(signal?: AbortSignal) {
    return this.#repository.listProjects(this.tenantId, signal);
  }

  async #mutationView(
    project: ManimProjectMutationView["project"],
    signal?: AbortSignal,
  ): Promise<ManimProjectMutationView> {
    return { catalog: await this.projects(signal), project };
  }

  async createManagedProject(name: string, signal?: AbortSignal) {
    const projectId = this.#projectIdFactory();
    const candidate = await this.#blobs.putSource(this.tenantId, DURABLE_MANAGED_WORKSPACE_STARTER_V1, signal);
    const created = await this.#repository.createManagedProject(
      {
        name,
        projectId,
        source: { blob: candidate, path: "main.py" },
        tenantId: this.tenantId,
      },
      signal,
    );
    return this.#mutationView({ id: created.projectId, kind: "managed", name: created.name }, signal);
  }

  createProject(_name: string, _root: string, _signal?: AbortSignal): never {
    throw new HttpError("Production workspaces cannot register arbitrary host folders.", 403);
  }

  async renameProject(projectId: string, name: string, signal?: AbortSignal) {
    const renamed = await this.#repository.renameProject(this.tenantId, projectId, name, signal);
    return this.#mutationView({ id: renamed.projectId, kind: "managed", name: renamed.name }, signal);
  }

  async unregisterProject(projectId: string, signal?: AbortSignal) {
    if (this.#snapshots) {
      await this.#snapshots.releaseProject(projectId, signal);
    } else {
      await this.#repository.softDeleteProject(this.tenantId, projectId, signal);
    }
    // Deletion is already committed. Caller cancellation must not turn that
    // durable success into a failed API response during the catalog refresh.
    return this.#mutationView(null);
  }

  async #projectAndHeads(projectId?: string, signal?: AbortSignal) {
    const selectedProjectId = projectId ?? (await this.projects(signal)).defaultProjectId;
    if (!selectedProjectId) throw new HttpError("No Manim workspace is registered.", 404);
    const [project, heads] = await Promise.all([
      this.#repository.readProject(this.tenantId, selectedProjectId, signal),
      this.#repository.listSourceHeads(this.tenantId, selectedProjectId, signal),
    ]);
    return { heads, project };
  }

  async #renderCapability(signal?: AbortSignal): Promise<ManimRenderCapability> {
    if (!this.#execution || !this.#renders) {
      return {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unconfigured",
      };
    }
    try {
      const [executionReady, rendersReady] = await Promise.all([
        this.#execution.ready(signal),
        this.#renders.ready(signal),
      ]);
      signal?.throwIfAborted();
      return executionReady && rendersReady
        ? { available: true, kind: "durable-sandbox", unavailableReason: null }
        : { available: false, kind: "durable-sandbox", unavailableReason: "durable-render-unavailable" };
    } catch {
      signal?.throwIfAborted();
      return {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unavailable",
      };
    }
  }

  async workspace(projectId?: string, signal?: AbortSignal): Promise<ManimWorkspaceView> {
    const { heads, project } = await this.#projectAndHeads(projectId, signal);
    const [renderCapability, importedSources] = await Promise.all([
      this.#renderCapability(signal),
      Promise.all(
        heads.map(async (head) => {
          const source = await this.#blobs.readSource(this.tenantId, head.blob, signal);
          return importSourceSnapshot(source, head.sourcePath, this.#frame).view;
        }),
      ),
    ]);
    return {
      commandAvailable: false,
      frame: this.#frame,
      projectId: project.projectId,
      projectName: project.name,
      renderCapability,
      sources: importedSources.filter((source) => source.scenes.length > 0),
    };
  }

  async #source(projectId: string, sourcePath: string, signal?: AbortSignal) {
    const head = await this.#repository.readSourceHead(this.tenantId, projectId, sourcePath, signal);
    const source = await this.#blobs.readSource(this.tenantId, head.blob, signal);
    return { head, source };
  }

  async exportOriginalSource(request: OriginalManimSourceExportRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { head, source } = await this.#source(request.projectId, request.sourcePath, signal);
    signal?.throwIfAborted();
    if (head.blob.digest !== request.sourceHash) {
      throw new HttpError("The imported source changed before export. Reimport the workspace and try again.", 409);
    }
    return {
      fileName: exportFileName(request.sourcePath),
      projectId: request.projectId,
      source,
    } satisfies ManimSourceExport;
  }

  async exportSource(request: ProgramRenderRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { head, source } = await this.#source(request.projectId, request.sourcePath, signal);
    signal?.throwIfAborted();
    if (head.blob.digest !== request.sourceHash) {
      throw new HttpError("The imported source changed before export. Reimport the workspace and try again.", 409);
    }
    const lowered = lowerManimRenderRequest({
      frame: this.#frame,
      originalSource: source,
      projectId: request.projectId,
      request,
    });
    return {
      fileName: exportFileName(request.sourcePath, ".poietra"),
      projectId: request.projectId,
      source: lowered.lowered.source,
    } satisfies ManimSourceExport;
  }

  async compareAndSwapSource(
    input: Readonly<{
      expectedDigest: string;
      expectedGeneration: bigint;
      projectId: string;
      source: string;
      sourcePath: string;
    }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceSourceHeadV1> {
    signal?.throwIfAborted();
    const candidate = await this.#blobs.putSource(this.tenantId, input.source, signal);
    signal?.throwIfAborted();
    return this.#repository.compareAndSwapSource(
      {
        candidate,
        expectedDigest: input.expectedDigest,
        expectedGeneration: input.expectedGeneration,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        tenantId: this.tenantId,
      },
      signal,
    );
  }

  async thumbnailStatus(projectId: string, signal?: AbortSignal) {
    await this.#repository.readProject(this.tenantId, projectId, signal);
    if (!this.#artifactReader) return unavailableThumbnail(projectId);
    try {
      const asset = await this.#artifactReader.projectThumbnail(projectId, signal);
      await asset.close();
      return {
        cachedSourceHash: null,
        error: null,
        generatedAt: null,
        imageKind: "rendered" as const,
        projectId,
        sceneName: null,
        sourceHash: null,
        sourcePath: null,
        state: "current" as const,
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      return { ...unavailableThumbnail(projectId), error: null, state: "missing" as const };
    }
  }

  generateThumbnail(projectId: string) {
    return this.thumbnailStatus(projectId);
  }

  async thumbnail(projectId: string, signal?: AbortSignal): Promise<ThumbnailAsset> {
    await this.#repository.readProject(this.tenantId, projectId, signal);
    if (!this.#artifactReader) throw new HttpError("A durable thumbnail has not been generated.", 404);
    return {
      body: await this.#artifactReader.projectThumbnailBytes(projectId, signal),
      kind: "rendered",
      mediaType: "image/png",
      state: "current",
      status: 200,
    };
  }

  async runSceneSnapshot(request: FastManimSnapshotRunRequestV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#snapshots) throw new HttpError("Durable Scene snapshots require the external sandbox runtime.", 503);
    return this.#snapshots.run(request, signal);
  }

  async sceneSnapshot(projectId: string, query: FastManimSnapshotQueryV1) {
    if (!this.#snapshots) throw new HttpError("Durable Scene snapshots require the external sandbox runtime.", 503);
    return this.#snapshots.snapshot(projectId, query);
  }

  async sceneSnapshotAsset(projectId: string, digest: string, signal?: AbortSignal) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new HttpError("Scene snapshot PNG asset not found.", 404);
    if (!this.#projectPngRepository || !this.#projectPngs) {
      throw new HttpError("Scene snapshot PNG assets are not configured.", 404);
    }
    const before = await this.#projectPngRepository.readHead(this.tenantId, projectId, signal);
    if (!before || before.receipt.digest !== digest) throw new HttpError("Scene snapshot PNG asset not found.", 404);
    assertProjectPngReceiptV1(this.tenantId, projectId, before.receipt);
    const inspected = inspectProjectPngBytesV1(
      await this.#projectPngs.read(this.tenantId, projectId, before.receipt, signal),
    );
    if (inspected.digest !== digest || inspected.byteSize !== before.receipt.byteSize) {
      throw new Error("The durable Scene snapshot PNG bytes do not match their pinned receipt.");
    }
    const after = await this.#projectPngRepository.readHead(this.tenantId, projectId, signal);
    if (!sameProjectPngHead(before, after))
      throw new HttpError("Scene snapshot PNG asset changed during delivery.", 409);
    return { body: inspected.bytes, digest, mediaType: "image/png" as const };
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#renders) throw new HttpError("Durable rendering requires the external sandbox runtime.", 503);
    if (!(await this.#execution?.ready(signal))) {
      throw new HttpError("Durable rendering requires the external sandbox runtime.", 503);
    }
    return this.#renders.start(request, signal);
  }

  async view(id: string) {
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.view(id);
  }

  async video(id: string, signal?: AbortSignal) {
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.video(id, signal);
  }

  async cancel(id: string) {
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.cancel(id);
  }

  async commit(id: string, expected: RenderCommitRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.commit(id, expected, signal);
  }

  async undo(id: string, actionId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.undo(id, actionId, signal);
  }

  async cancelSourceAction(id: string, request: RenderSourceActionCancellationRequest) {
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.cancelSourceAction(id, request);
  }

  async discard(id: string) {
    if (!this.#renders) throw new HttpError("Render session not found.", 404);
    return this.#renders.discard(id);
  }

  async abandonStart(id: string) {
    await this.#renders?.abandonStart(id);
  }

  async abandon(id: string, expectedRenderRequestId: string) {
    return this.#renders?.abandon(id, expectedRenderRequestId) ?? ({ abandoned: true } as const);
  }

  close() {
    this.#closeRequest ??= (async () => {
      const errors: unknown[] = [];
      await (this.#snapshots?.close() ?? Promise.resolve()).catch((error: unknown) => errors.push(error));
      await (this.#execution?.close?.() ?? Promise.resolve()).catch((error: unknown) => errors.push(error));
      const results = await Promise.allSettled([
        this.#renders?.close() ?? Promise.resolve(),
        this.#artifactReader?.close() ?? Promise.resolve(),
        this.#blobs.close(),
        this.#repository.close(),
      ]);
      errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
      if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the durable Manim runtime.");
    })();
    return this.#closeRequest;
  }
}

export async function createDurableManimRuntimeV1(options: DurableManimRuntimeOptionsV1, signal?: AbortSignal) {
  const runtime = new DurableManimRuntimeV1(options);
  try {
    return await runtime.initialize(signal);
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
}

/** Production composition: readiness is true only when DB, S3, and the external executor all pass. */
export function createDurableProductionManimRuntimeAdapterV1(
  runtime: DurableManimRuntimeV1,
  maintenance: Pick<DurableSourceBlobGcWorkerV1, "close" | "ready">,
): ProductionManimRuntimeAdapterV1 {
  let closeRequest: Promise<void> | undefined;
  return {
    api: runtime,
    close() {
      closeRequest ??= (async () => {
        const errors: unknown[] = [];
        await maintenance.close().catch((error: unknown) => errors.push(error));
        await runtime.close().catch((error: unknown) => errors.push(error));
        if (errors.length > 0) {
          throw new AggregateError(errors, "Could not fully close the durable production runtime.");
        }
      })();
      return closeRequest;
    },
    async ready(signal) {
      if (!maintenance.ready() || !(await runtime.productionReady(signal))) return { ready: false };
      return {
        executionBoundary: "adapter-attests-external-sandbox",
        ready: true,
        storageBoundary: "shared-durable",
        tenantBoundary: "server-owned-tenant-key",
      };
    },
  };
}
