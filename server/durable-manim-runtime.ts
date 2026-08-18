import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type {
  BrowserManimProjectImportRequestV1,
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
import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import type { DurableFastManimSnapshotServiceV1 } from "./durable-fast-manim-snapshot-service";
import type { DurableManimRenderServiceV1 } from "./durable-manim-render-service";
import type { FastManimSnapshotQueryV1, FastManimSnapshotRunRequestV1 } from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import type { MutableManimProjectApiOperations } from "./manim-api";
import type { ProductionManimRuntimeAdapterV1 } from "./manim-production-server";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { ManimRuntimeTraceEditVerifier } from "./manim-runtime-trace-edit-verifier";
import { authorizeSnapshotProgramWithSnapshot } from "./manim-snapshot-program-authorizer";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";
import { importSourceSnapshot, validateBrowserManimProjectImportV1 } from "./manim-workspace";
import type { TenantCellRuntimeAdapterV1 } from "./production-runtime-cell";
import type { AuthorizedArtifactReaderV1 } from "./storage/authorized-artifact-reader";
import type { ClientThumbnailReaderV1 } from "./storage/client-thumbnail-reader";
import { MIN_DURABLE_GC_GRACE_MS_V1 } from "./storage/durable-gc-core";
import type { EditorDocumentOriginV1, EditorDocumentRepositoryV1 } from "./storage/editor-document-repository";
import {
  assertProjectPngReceiptV1,
  inspectProjectPngBytesV1,
  type ProjectPngBlobReceiptV1,
  type ProjectPngBlobStoreV1,
  type ProjectPngHeadV1,
  type ProjectPngRepositoryV1,
  sameProjectPngReceiptV1,
} from "./storage/project-png-storage";
import type { DurableSourceBlobGcWorkerV1 } from "./storage/source-blob-gc";
import type {
  SourceBlobReceiptV1,
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceProjectV1,
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
  clientThumbnailReader?: Pick<ClientThumbnailReaderV1, "head" | "headBytes" | "ready">;
  runtimeTraceEditVerifier?: Pick<ManimRuntimeTraceEditVerifier, "verify">;
  editorDocuments?: EditorDocumentRepositoryV1;
  execution?: DurableManimExecutionReadinessV1;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  projectIdFactory?: () => string;
  projectPngRepository?: Pick<ProjectPngRepositoryV1, "queueDeletion" | "readHead" | "ready">;
  projectPngs?: Pick<ProjectPngBlobStoreV1, "close" | "put" | "read" | "ready">;
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
    sameProjectPngReceiptV1(left.receipt, right.receipt)
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
  readonly #clientThumbnailReader: Pick<ClientThumbnailReaderV1, "head" | "headBytes" | "ready"> | undefined;
  readonly #runtimeTraceEditVerifier: Pick<ManimRuntimeTraceEditVerifier, "verify"> | undefined;
  readonly editorDocuments: EditorDocumentRepositoryV1 | undefined;
  readonly #execution: DurableManimExecutionReadinessV1 | undefined;
  readonly #frame: Readonly<{ height: number; width: number }>;
  readonly #projectIdFactory: () => string;
  readonly #projectPngRepository: Pick<ProjectPngRepositoryV1, "queueDeletion" | "readHead" | "ready"> | undefined;
  readonly #projectPngs: Pick<ProjectPngBlobStoreV1, "close" | "put" | "read" | "ready"> | undefined;
  readonly #renders: DurableManimRenderServiceV1 | undefined;
  readonly #repository: WorkspaceSourceRepositoryV1;
  readonly #snapshots: DurableFastManimSnapshotServiceV1 | undefined;
  readonly storageBoundary: Readonly<{ kind: "shared-durable"; namespace: string }>;
  readonly tenantId: string;
  #closeRequest: Promise<void> | null = null;
  #productionRenderOperationalReadiness: (() => boolean) | null = null;

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
    this.#clientThumbnailReader = options.clientThumbnailReader;
    this.#runtimeTraceEditVerifier = options.runtimeTraceEditVerifier;
    this.editorDocuments = options.editorDocuments;
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
    const [
      repositoryReady,
      blobsReady,
      artifactReaderReady,
      clientThumbnailReaderReady,
      executionReady,
      rendersReady,
      snapshotsReady,
    ] = await Promise.all([
      this.#repository.ready(signal),
      this.#blobs.ready(signal),
      this.#artifactReader?.ready(signal) ?? Promise.resolve(true),
      this.#clientThumbnailReader?.ready(signal) ?? Promise.resolve(true),
      this.#execution?.ready(signal) ?? Promise.resolve(false),
      this.#renders?.ready(signal) ?? Promise.resolve(true),
      this.#snapshots?.ready(signal) ?? Promise.resolve(true),
    ]);
    signal?.throwIfAborted();
    return (
      repositoryReady &&
      blobsReady &&
      artifactReaderReady &&
      clientThumbnailReaderReady &&
      executionReady &&
      rendersReady &&
      snapshotsReady
    );
  }

  async workspaceReady(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [repositoryReady, blobsReady, editorDocumentsReady, projectPngRepositoryReady, projectPngsReady] =
      await Promise.all([
        this.#repository.ready(signal),
        this.#blobs.ready(signal),
        this.editorDocuments?.ready(signal) ?? Promise.resolve(true),
        this.#projectPngRepository?.ready(signal) ?? Promise.resolve(true),
        this.#projectPngs?.ready(signal) ?? Promise.resolve(true),
      ]);
    signal?.throwIfAborted();
    return repositoryReady && blobsReady && editorDocumentsReady && projectPngRepositoryReady && projectPngsReady;
  }

  async editorReady(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.editorDocuments) return false;
    const editorDocumentsReady = await this.editorDocuments.ready(signal);
    signal?.throwIfAborted();
    return editorDocumentsReady;
  }

  /**
   * TenantCell storage lane (ADR 0005 §"Tenant Cell decision"): the durable
   * stores behind projects, editor documents, and published-artifact reads.
   * It intentionally omits the sandbox execution boundary, so a Tenant Cell
   * can be ready for projects, documents, and artifacts without claiming a
   * Manim sandbox is ready.
   *
   * The probe is the union of every storage dependency used by the routes in
   * `isTenantCellStorageLaneManimRequest` (kept in lockstep with it):
   * - POST /api/manim/projects, kind "managed": blobs.putSource +
   *   repository.createManagedProject;
   * - POST /api/manim/projects, kind "studio-native":
   *   editorDocuments.createNativeDocument;
   * - PATCH /api/manim/projects/:projectId: repository.renameProject;
   * - DELETE /api/manim/projects/:projectId: snapshots.releaseProject, whose
   *   only durable write is the snapshot publication ledger
   *   (publicationStorageReady), or repository.softDeleteProject when
   *   snapshots are unconfigured;
   * - thumbnail GET / GET status / POST generate: repository.readProject +
   *   artifactReader.projectThumbnail(...Bytes);
   * - GET|HEAD /projects/:projectId/scene-snapshot-assets/:digest:
   *   projectPngRepository.readHead + projectPngs.read.
   * Every mutation additionally refreshes the catalog via
   * repository.listProjects. An unconfigured optional dependency keeps its
   * route's own deterministic 503/404 response, so it probes as ready.
   */
  async tenantCellStorageReady(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [
      repositoryReady,
      blobsReady,
      artifactReaderReady,
      clientThumbnailReaderReady,
      editorDocumentsReady,
      projectPngRepositoryReady,
      projectPngsReady,
      publicationStorageReady,
    ] = await Promise.all([
      this.#repository.ready(signal),
      this.#blobs.ready(signal),
      this.#artifactReader?.ready(signal) ?? Promise.resolve(true),
      this.#clientThumbnailReader?.ready(signal) ?? Promise.resolve(true),
      this.editorDocuments?.ready(signal) ?? Promise.resolve(true),
      this.#projectPngRepository?.ready(signal) ?? Promise.resolve(true),
      this.#projectPngs?.ready(signal) ?? Promise.resolve(true),
      this.#snapshots?.publicationStorageReady(signal) ?? Promise.resolve(true),
    ]);
    signal?.throwIfAborted();
    return (
      repositoryReady &&
      blobsReady &&
      artifactReaderReady &&
      clientThumbnailReaderReady &&
      editorDocumentsReady &&
      projectPngRepositoryReady &&
      projectPngsReady &&
      publicationStorageReady
    );
  }

  /** Exact source, execution, and artifact-delivery boundary used to admit final renders. */
  async renderReady(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#execution || !this.#renders || this.#productionRenderOperationalReadiness?.() === false) return false;
    const [repositoryReady, blobsReady, executionReady, deliveryReady] = await Promise.all([
      this.#repository.ready(signal),
      this.#blobs.ready(signal),
      this.#execution.ready(signal),
      this.#renders.deliveryReady(signal),
    ]);
    signal?.throwIfAborted();
    return (
      this.#productionRenderOperationalReadiness?.() !== false &&
      repositoryReady &&
      blobsReady &&
      executionReady &&
      deliveryReady
    );
  }

  /** Bind the production GC/retention admission gate exactly once before exposing the runtime. */
  bindProductionRenderOperationalReadiness(ready: () => boolean) {
    if (typeof ready !== "function") throw new TypeError("Production render operational readiness is invalid.");
    if (this.#productionRenderOperationalReadiness) {
      throw new Error("Production render operational readiness is already bound.");
    }
    this.#productionRenderOperationalReadiness = ready;
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

  /**
   * The default imported-Manim origin keeps the historical behavior exactly:
   * a starter `main.py` blob plus a workspace source head. The explicit
   * `studio-native` origin instead creates the Project with a source-free
   * native Editor Document and persists no starter `.py` at all.
   */
  async createManagedProject(
    name: string,
    signal?: AbortSignal,
    documentOrigin: EditorDocumentOriginV1 = "imported-manim",
  ) {
    const projectId = this.#projectIdFactory();
    if (documentOrigin === "studio-native") {
      if (!this.editorDocuments) {
        throw new HttpError("Studio-native projects require durable editor document storage.", 503);
      }
      const created = await this.editorDocuments.createNativeDocument(
        { name, projectId, tenantId: this.tenantId },
        signal,
      );
      return this.#mutationView({ id: created.project.projectId, kind: "managed", name: created.project.name }, signal);
    }
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

  /** Explicit native lane for the HTTP `studio-native` project kind. */
  createNativeStudioProject(name: string, signal?: AbortSignal) {
    return this.createManagedProject(name, signal, "studio-native");
  }

  async importBrowserProject(request: BrowserManimProjectImportRequestV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { projectPng, request: validated } = validateBrowserManimProjectImportV1(request, this.#frame);
    if (projectPng && (!this.#projectPngRepository || !this.#projectPngs)) {
      throw new HttpError("Browser image.png import is not configured.", 503);
    }

    const projectId = this.#projectIdFactory();
    let candidate: SourceBlobReceiptV1 | null = null;
    let projectPngCandidate: ProjectPngBlobReceiptV1 | null = null;
    let created: WorkspaceSourceProjectV1;
    try {
      candidate = await this.#blobs.putSource(this.tenantId, validated.source, signal);
      if (projectPng && this.#projectPngs) {
        projectPngCandidate = await this.#projectPngs.put(this.tenantId, projectId, projectPng.bytes, signal);
      }
      signal?.throwIfAborted();
      created = await this.#repository.createManagedProject(
        {
          name: validated.name,
          ...(projectPngCandidate ? { projectPng: projectPngCandidate } : {}),
          projectId,
          source: { blob: candidate, path: validated.sourceName },
          tenantId: this.tenantId,
        },
        signal,
      );
    } catch (error) {
      const cleanup = await Promise.allSettled([
        candidate ? this.#repository.queueBlobDeletion(this.tenantId, candidate) : Promise.resolve(null),
        projectPngCandidate && this.#projectPngRepository
          ? this.#projectPngRepository.queueDeletion(
              this.tenantId,
              projectId,
              projectPngCandidate,
              MIN_DURABLE_GC_GRACE_MS_V1,
            )
          : Promise.resolve(null),
      ]);
      const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "Project import and orphan cleanup both failed.");
      }
      throw error;
    }
    // Publication is committed once createManagedProject returns. A later
    // catalog-read or response failure is an unknown client outcome, not an
    // orphan, and must never queue the referenced object for deletion.
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

  async #renderCapability(nativeRenderFrozen: boolean, signal?: AbortSignal): Promise<ManimRenderCapability> {
    if (nativeRenderFrozen) {
      return {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "native-render-frozen",
      };
    }
    if (!this.#execution || !this.#renders) {
      return {
        available: false,
        kind: "durable-sandbox",
        unavailableReason: "durable-render-unconfigured",
      };
    }
    try {
      return (await this.renderReady(signal))
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
    // Imported workspaces always carry at least one source head, so their
    // responses never gain the marker and stay byte-identical. Only a
    // head-less project probes for its Studio-native document.
    const nativeDocument =
      heads.length === 0 && this.editorDocuments
        ? await this.editorDocuments.readNativeDocumentHead(
            { projectId: project.projectId, tenantId: this.tenantId },
            signal,
          )
        : null;
    const [renderCapability, importedSources] = await Promise.all([
      this.#renderCapability(nativeDocument !== null, signal),
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
      ...(nativeDocument ? { nativeDocument: { documentKey: nativeDocument.documentKey } } : {}),
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
    const lowered = await lowerManimRenderRequest({
      frame: this.#frame,
      originalSource: source,
      snapshotProgramAuthorizer: this.#snapshots
        ? (input) =>
            authorizeSnapshotProgramWithSnapshot(
              input,
              (projectId, query, lookupSignal) => this.#snapshots!.snapshot(projectId, query, lookupSignal),
              signal,
            )
        : null,
      projectId: request.projectId,
      request,
    });
    if (
      lowered.lowered.preflight?.kind === "runtime-trace-move-edit" ||
      lowered.lowered.preflight?.kind === "runtime-trace-opacity-edit" ||
      lowered.lowered.preflight?.kind === "runtime-trace-resize-edit" ||
      lowered.lowered.preflight?.kind === "runtime-trace-rotation-edit"
    ) {
      if (!this.#runtimeTraceEditVerifier) {
        throw new HttpError("Runtime Trace edit verification is unavailable.", 503);
      }
      await this.#runtimeTraceEditVerifier.verify(lowered.lowered, lowered.renderRequest, signal);
      signal?.throwIfAborted();
    }
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
    if (this.#clientThumbnailReader) {
      try {
        const head = await this.#clientThumbnailReader.head(projectId, signal);
        const publication = head.publication;
        return {
          cachedSourceHash: null,
          error: null,
          generatedAt: publication.publishedAt.toISOString(),
          imageLineage: "editor-document" as const,
          imageKind: "rendered" as const,
          projectId,
          sceneName: null,
          sourceHash: null,
          sourcePath: null,
          state: head.current ? ("current" as const) : ("stale" as const),
        };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
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
    if (this.#clientThumbnailReader) {
      try {
        const head = await this.#clientThumbnailReader.headBytes(projectId, signal);
        return {
          body: head.bytes,
          kind: "rendered",
          mediaType: "image/png",
          state: head.current ? "current" : "stale",
          status: 200,
        };
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
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

  async runRuntimeTrace(request: FastManimRuntimeTraceRunRequestV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.#snapshots)
      throw new HttpError("Durable Runtime Trace preview requires the external sandbox runtime.", 503);
    return this.#snapshots.runRuntimeTrace(request, signal);
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
    if (!(await this.renderReady(signal))) {
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
        this.editorDocuments?.close() ?? Promise.resolve(),
        this.#projectPngs?.close() ?? Promise.resolve(),
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

export type TenantCellMaintenanceReadinessV1 = Readonly<{
  close: () => Promise<void>;
  ready: () => boolean;
}>;

/**
 * TenantCell maintenance split (ADR 0005 §"Tenant Cell decision"): the durable
 * maintenance workers are assigned to the readiness lane whose routes can grow
 * the storage family they reclaim, so each lane keeps its own fail-closed gate.
 */
export type TenantCellMaintenanceSplitV1 = Readonly<{
  /** Workers reclaiming families that only render execution can grow. */
  execution: TenantCellMaintenanceReadinessV1;
  /** Workers reclaiming families written by the storage lane itself. */
  storage: TenantCellMaintenanceReadinessV1;
}>;

/**
 * TenantCell production composition: full attestation still requires DB, S3,
 * the external executor, and every maintenance worker exactly as before, while
 * the storage lane (`workspaceReady`, `tenantCellStorageReady`) gates only on
 * durable storage plus the storage-integrity maintenance group.
 */
export function createTenantCellProductionManimRuntimeAdapterV1(
  runtime: DurableManimRuntimeV1,
  maintenance: TenantCellMaintenanceSplitV1,
): TenantCellRuntimeAdapterV1 {
  const editorDocuments = runtime.editorDocuments;
  if (!editorDocuments) throw new TypeError("The durable production runtime requires editor document storage.");
  const maintenanceGroups = [...new Set([maintenance.execution, maintenance.storage])];
  const allMaintenanceReady = () => maintenanceGroups.every((group) => group.ready());
  // Render admission keeps requiring every worker: renders read source blobs
  // and write project PNGs, media artifacts, and session rows, so both
  // maintenance groups guard families that render execution grows.
  runtime.bindProductionRenderOperationalReadiness(allMaintenanceReady);
  let closeRequest: Promise<void> | undefined;
  return {
    api: runtime,
    editorDocuments,
    close() {
      closeRequest ??= (async () => {
        const errors: unknown[] = [];
        const maintenanceResults = await Promise.allSettled(maintenanceGroups.map((group) => group.close()));
        errors.push(...maintenanceResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
        await runtime.close().catch((error: unknown) => errors.push(error));
        if (errors.length > 0) {
          throw new AggregateError(errors, "Could not fully close the durable production runtime.");
        }
      })();
      return closeRequest;
    },
    async ready(signal) {
      if (!allMaintenanceReady() || !(await runtime.productionReady(signal))) return { ready: false };
      return {
        executionBoundary: "adapter-attests-external-sandbox",
        ready: true,
        storageBoundary: "shared-durable",
        tenantBoundary: "server-owned-tenant-key",
      };
    },
    editorReady(signal) {
      return runtime.editorReady(signal);
    },
    renderReady(signal) {
      return runtime.renderReady(signal);
    },
    async tenantCellStorageReady(signal) {
      return maintenance.storage.ready() && (await runtime.tenantCellStorageReady(signal));
    },
    async workspaceReady(signal) {
      return maintenance.storage.ready() && (await runtime.workspaceReady(signal));
    },
  };
}

/**
 * Backward-compatible production composition: the single maintenance gate
 * guards both TenantCell lanes, so readiness fails closed exactly as before
 * the storage/execution split.
 */
export function createDurableProductionManimRuntimeAdapterV1(
  runtime: DurableManimRuntimeV1,
  maintenance: Pick<DurableSourceBlobGcWorkerV1, "close" | "ready">,
): ProductionManimRuntimeAdapterV1 {
  const shared: TenantCellMaintenanceReadinessV1 = {
    close: () => maintenance.close(),
    ready: () => maintenance.ready(),
  };
  return createTenantCellProductionManimRuntimeAdapterV1(runtime, { execution: shared, storage: shared });
}
