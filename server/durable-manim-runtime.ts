import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type {
  ManimProjectMutationView,
  ManimSourceExport,
  ManimThumbnailStatus,
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
  RenderCommitRequest,
  RenderSourceActionCancellationRequest,
} from "../src/render-pipeline/contracts";
import type { FastManimSnapshotQueryV1, FastManimSnapshotRunRequestV1 } from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import type { MutableManimProjectApiOperations } from "./manim-api";
import type { ProductionManimRuntimeAdapterV1 } from "./manim-production-server";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";
import { manimTenantIdSchema } from "./manim-request-principal";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";
import { importSourceSnapshot } from "./manim-workspace";
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
  blobs: SourceContentBlobStoreV1;
  execution?: DurableManimExecutionReadinessV1;
  frame?: Readonly<{ height: number; width: number }>;
  namespace: string;
  projectIdFactory?: () => string;
  repository: WorkspaceSourceRepositoryV1;
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
  readonly #blobs: SourceContentBlobStoreV1;
  readonly #execution: DurableManimExecutionReadinessV1 | undefined;
  readonly #frame: Readonly<{ height: number; width: number }>;
  readonly #projectIdFactory: () => string;
  readonly #repository: WorkspaceSourceRepositoryV1;
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
    this.#blobs = options.blobs;
    this.#execution = options.execution;
    this.#frame = validateFrame(options.frame ?? DEFAULT_FRAME);
    this.#projectIdFactory = options.projectIdFactory ?? projectIdFromUuid;
  }

  async initialize(signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.#repository.ensureTenant(this.tenantId, signal);
    signal?.throwIfAborted();
    return this;
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const [repositoryReady, blobsReady, executionReady] = await Promise.all([
      this.#repository.ready(signal),
      this.#blobs.ready(signal),
      this.#execution?.ready(signal) ?? Promise.resolve(false),
    ]);
    signal?.throwIfAborted();
    return repositoryReady && blobsReady && executionReady;
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
    await this.#repository.softDeleteProject(this.tenantId, projectId, signal);
    return this.#mutationView(null, signal);
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

  async workspace(projectId?: string, signal?: AbortSignal): Promise<ManimWorkspaceView> {
    const { heads, project } = await this.#projectAndHeads(projectId, signal);
    const sources = (
      await Promise.all(
        heads.map(async (head) => {
          const source = await this.#blobs.readSource(this.tenantId, head.blob, signal);
          return importSourceSnapshot(source, head.sourcePath, this.#frame).view;
        }),
      )
    ).filter((source) => source.scenes.length > 0);
    return {
      commandAvailable: false,
      frame: this.#frame,
      projectId: project.projectId,
      projectName: project.name,
      sources,
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

  async thumbnailStatus(projectId: string) {
    await this.#repository.readProject(this.tenantId, projectId);
    return unavailableThumbnail(projectId);
  }

  generateThumbnail(projectId: string) {
    return this.thumbnailStatus(projectId);
  }

  async thumbnail(projectId: string): Promise<ThumbnailAsset> {
    await this.#repository.readProject(this.tenantId, projectId);
    throw new HttpError("A durable thumbnail has not been generated.", 404);
  }

  async runSceneSnapshot(_request: FastManimSnapshotRunRequestV1, signal?: AbortSignal): Promise<never> {
    signal?.throwIfAborted();
    throw new HttpError("Durable Scene snapshots require the external sandbox runtime.", 503);
  }

  async sceneSnapshot(_projectId: string, _query: FastManimSnapshotQueryV1): Promise<never> {
    throw new HttpError("Durable Scene snapshots require the external sandbox runtime.", 503);
  }

  async start(_request: ProgramRenderRequest, signal?: AbortSignal): Promise<never> {
    signal?.throwIfAborted();
    throw new HttpError("Durable rendering requires the external sandbox runtime.", 503);
  }

  async view(_id: string): Promise<never> {
    throw new HttpError("Render session not found.", 404);
  }

  async videoPath(_id: string): Promise<never> {
    throw new HttpError("Render session not found.", 404);
  }

  async cancel(_id: string): Promise<never> {
    throw new HttpError("Render session not found.", 404);
  }

  async commit(_id: string, _expected: RenderCommitRequest, signal?: AbortSignal): Promise<never> {
    signal?.throwIfAborted();
    throw new HttpError("Render session not found.", 404);
  }

  async undo(_id: string, _actionId: string, signal?: AbortSignal): Promise<never> {
    signal?.throwIfAborted();
    throw new HttpError("Render session not found.", 404);
  }

  async cancelSourceAction(_id: string, _request: RenderSourceActionCancellationRequest): Promise<never> {
    throw new HttpError("Render session not found.", 404);
  }

  async discard(_id: string): Promise<never> {
    throw new HttpError("Render session not found.", 404);
  }

  async abandonStart(_id: string) {}

  async abandon(_id: string, _expectedRenderRequestId: string) {
    return { abandoned: true } as const;
  }

  close() {
    this.#closeRequest ??= (async () => {
      const results = await Promise.allSettled([
        this.#execution?.close?.() ?? Promise.resolve(),
        this.#blobs.close(),
        this.#repository.close(),
      ]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the durable Manim runtime.");
    })();
    return this.#closeRequest;
  }
}

export async function createDurableManimRuntimeV1(options: DurableManimRuntimeOptionsV1, signal?: AbortSignal) {
  return new DurableManimRuntimeV1(options).initialize(signal);
}

/** Production composition: readiness is true only when DB, S3, and the external executor all pass. */
export function createDurableProductionManimRuntimeAdapterV1(
  runtime: DurableManimRuntimeV1,
): ProductionManimRuntimeAdapterV1 {
  return {
    api: runtime,
    close: () => runtime.close(),
    async ready(signal) {
      if (!(await runtime.ready(signal))) return { ready: false };
      return {
        executionBoundary: "adapter-attests-external-sandbox",
        ready: true,
        storageBoundary: "shared-durable",
        tenantBoundary: "server-owned-tenant-key",
      };
    },
  };
}
