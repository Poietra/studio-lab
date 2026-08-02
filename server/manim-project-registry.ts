import type {
  BrowserManimProjectImportRequestV1,
  ManimProjectListView,
  ManimProjectMutationView,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
  RenderCommitRequest,
  RenderSourceActionCancellationRequest,
} from "../src/render-pipeline/contracts";
import type {
  FastManimSandboxAttestationVerifierV1,
  FastManimSandboxBackendV1,
  FastManimSandboxDeployment,
} from "./fast-manim-sandbox-backend";
import type {
  FastManimSnapshotProfileVersionV1,
  FastManimSnapshotQueryV1,
  FastManimSnapshotRunRequestV1,
} from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import {
  type PersistentManimProjectCatalog,
  type ResolvedManimProject,
  resolveManimProjects,
} from "./manim-project-catalog";
import type { ManimProjectConfig } from "./manim-render-config";
import { ManimRenderManager } from "./manim-render-manager";
import { manimTenantIdSchema } from "./manim-request-principal";
import { normalizeManimStorageRoots } from "./manim-tenant-storage";
import { validateBrowserManimProjectImportV1 } from "./manim-workspace";

export class ManimProjectRegistry {
  private readonly catalog: PersistentManimProjectCatalog | null;
  private readonly catalogStorageRoot: string | null;
  private readonly command: readonly string[];
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly managers = new Map<string, ManimRenderManager>();
  private readonly maxConcurrentRenders: number | undefined;
  private readonly maxRetainedSessions: number | undefined;
  private readonly renderTimeoutMs: number | undefined;
  private readonly sessionProjects = new Map<string, string>();
  private readonly sessionRetentionMs: number | undefined;
  private readonly snapshotSandboxAttestationVerifier: FastManimSandboxAttestationVerifierV1 | undefined;
  private readonly snapshotSandboxBackendFactory:
    | ((project: Readonly<{ projectId: string; projectRoot: string }>) => FastManimSandboxBackendV1)
    | undefined;
  private readonly snapshotSandboxDeployment: FastManimSandboxDeployment;
  private readonly snapshotProducerCommand: readonly string[] | undefined;
  private readonly snapshotProducerDevOptIn: boolean | undefined;
  private readonly snapshotVersion: FastManimSnapshotProfileVersionV1 | undefined;
  private readonly snapshotTimeoutMs: number | undefined;
  readonly tenantId: string;
  private readonly thumbnailCacheRoot: string | undefined;

  constructor(
    options: Readonly<{
      catalog?: PersistentManimProjectCatalog;
      catalogStorageRoot?: string;
      command: readonly string[];
      frame: Readonly<{ height: number; width: number }>;
      logger?: StructuredLogger;
      maxConcurrentRenders?: number;
      maxRetainedSessions?: number;
      projects: readonly ManimProjectConfig[];
      renderTimeoutMs?: number;
      sessionRetentionMs?: number;
      snapshotSandboxAttestationVerifier?: FastManimSandboxAttestationVerifierV1;
      snapshotSandboxBackendFactory?: (
        project: Readonly<{ projectId: string; projectRoot: string }>,
      ) => FastManimSandboxBackendV1;
      snapshotSandboxDeployment?: FastManimSandboxDeployment;
      snapshotProducerCommand?: readonly string[];
      snapshotProducerDevOptIn?: boolean;
      snapshotVersion?: FastManimSnapshotProfileVersionV1;
      snapshotTimeoutMs?: number;
      tenantId: string;
      thumbnailCacheRoot?: string;
    }>,
  ) {
    if (options.projects.length > 64) throw new TypeError("The Manim project registry accepts at most 64 projects.");
    this.catalog = options.catalog ?? null;
    if (this.catalog && !options.catalogStorageRoot?.trim()) {
      throw new TypeError("A persistent project catalog requires an explicit tenant storage root.");
    }
    this.catalogStorageRoot = options.catalogStorageRoot?.trim() || null;
    this.command = options.command;
    this.frame = options.frame;
    this.maxConcurrentRenders = options.maxConcurrentRenders;
    this.maxRetainedSessions = options.maxRetainedSessions;
    this.renderTimeoutMs = options.renderTimeoutMs;
    this.sessionRetentionMs = options.sessionRetentionMs;
    this.snapshotSandboxAttestationVerifier = options.snapshotSandboxAttestationVerifier;
    this.snapshotSandboxBackendFactory = options.snapshotSandboxBackendFactory;
    this.snapshotSandboxDeployment = options.snapshotSandboxDeployment ?? "production";
    this.snapshotProducerCommand = options.snapshotProducerCommand;
    this.snapshotProducerDevOptIn = options.snapshotProducerDevOptIn;
    this.snapshotVersion = options.snapshotVersion;
    this.snapshotTimeoutMs = options.snapshotTimeoutMs;
    this.thumbnailCacheRoot = options.thumbnailCacheRoot;
    const parsedTenantId = manimTenantIdSchema.safeParse(options.tenantId);
    if (!parsedTenantId.success) throw new TypeError("Manim tenant ID must be an opaque lower-case identifier.");
    this.tenantId = parsedTenantId.data;
    this.logger = (options.logger ?? nullLogger).child({ tenantId: this.tenantId });
    const configuredProjects = this.catalog?.projects() ?? resolveManimProjects(options.projects);
    for (const project of configuredProjects) this.addManager(project);
  }

  get defaultProjectId() {
    return this.managers.keys().next().value ?? null;
  }

  get storageRoots() {
    return normalizeManimStorageRoots([
      ...(this.catalogStorageRoot ? [this.catalogStorageRoot] : []),
      ...[...this.managers.values()].flatMap((manager) => manager.storageRoots),
    ]);
  }

  private addManager({ canonicalRoot, kind, projectId, projectName }: ResolvedManimProject) {
    if (this.managers.has(projectId)) throw new TypeError(`Duplicate Manim project ID ${projectId}.`);
    this.managers.set(
      projectId,
      new ManimRenderManager({
        command: this.command,
        frame: this.frame,
        logger: this.logger.child({ projectId }),
        maxConcurrentRenders: this.maxConcurrentRenders,
        maxRetainedSessions: this.maxRetainedSessions,
        onSessionRemoved: (id) => this.sessionProjects.delete(id),
        projectId,
        projectKind: kind,
        projectName,
        projectRoot: canonicalRoot,
        renderTimeoutMs: this.renderTimeoutMs,
        sessionRetentionMs: this.sessionRetentionMs,
        snapshotSandboxAttestationVerifier: this.snapshotSandboxAttestationVerifier,
        snapshotSandboxBackend: this.snapshotSandboxBackendFactory?.({
          projectId,
          projectRoot: canonicalRoot,
        }),
        snapshotSandboxDeployment: this.snapshotSandboxDeployment,
        snapshotProducerCommand: this.snapshotProducerCommand,
        snapshotProducerDevOptIn: this.snapshotProducerDevOptIn,
        snapshotVersion: this.snapshotVersion,
        snapshotTimeoutMs: this.snapshotTimeoutMs,
        tenantId: this.tenantId,
        thumbnailCacheRoot: this.thumbnailCacheRoot,
      }),
    );
  }

  private mutableCatalog() {
    if (!this.catalog) throw new HttpError("Workspace registry mutations are not configured.", 405);
    return this.catalog;
  }

  private mutationView(project: ManimProjectMutationView["project"]): ManimProjectMutationView {
    return { catalog: this.projects(), project };
  }

  projects(): ManimProjectListView {
    return {
      defaultProjectId: this.defaultProjectId,
      projects: [...this.managers.values()].map((manager) => ({
        id: manager.projectId,
        kind: manager.projectKind,
        name: manager.projectName,
      })),
    };
  }

  async cleanupExpiredSessions(now = Date.now()) {
    await Promise.all([...this.managers.values()].map((manager) => manager.cleanupExpiredSessions(now)));
  }

  private project(projectId: string) {
    const manager = this.managers.get(projectId);
    if (!manager) throw new HttpError("Configured Manim project not found.", 404);
    return manager;
  }

  private sessionProject(id: string) {
    const projectId = this.sessionProjects.get(id);
    if (!projectId) throw new HttpError("Render session not found.", 404);
    return this.project(projectId);
  }

  createProject(name: string, root: string) {
    const catalog = this.mutableCatalog();
    const created = catalog.create(name, root);
    try {
      this.addManager(created);
    } catch (error) {
      catalog.unregister(created.projectId);
      throw error;
    }
    return this.mutationView({ id: created.projectId, kind: created.kind, name: created.projectName });
  }

  createManagedProject(name: string) {
    const catalog = this.mutableCatalog();
    const created = catalog.createManaged(name);
    try {
      this.addManager(created);
    } catch (error) {
      try {
        catalog.rollbackManagedCreation(created.projectId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Could not roll back the managed workspace creation.");
      }
      throw error;
    }
    return this.mutationView({ id: created.projectId, kind: created.kind, name: created.projectName });
  }

  importBrowserProject(request: BrowserManimProjectImportRequestV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { projectPng, request: validated } = validateBrowserManimProjectImportV1(request, this.frame);
    signal?.throwIfAborted();
    const catalog = this.mutableCatalog();
    const created = catalog.createManagedFromSource(validated, projectPng?.bytes ?? null);
    try {
      this.addManager(created);
    } catch (error) {
      try {
        catalog.rollbackManagedCreation(created.projectId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Could not roll back the imported workspace creation.");
      }
      throw error;
    }
    // The catalog and source file are already published. Do not turn a late
    // caller cancellation into cleanup of a workspace now visible by ID.
    return this.mutationView({ id: created.projectId, kind: created.kind, name: created.projectName });
  }

  renameProject(projectId: string, name: string) {
    const manager = this.project(projectId);
    const renamed = this.mutableCatalog().rename(projectId, name);
    manager.renameProject(renamed.projectName);
    return this.mutationView({ id: projectId, kind: renamed.kind, name: renamed.projectName });
  }

  async unregisterProject(projectId: string) {
    const manager = this.project(projectId);
    if (!manager.canUnregister()) {
      throw new HttpError(
        "Wait for active workspace work and discard retained render sessions before removing it from Studio.",
        409,
      );
    }
    this.mutableCatalog().remove(projectId);
    this.managers.delete(projectId);
    for (const [sessionId, sessionProjectId] of this.sessionProjects) {
      if (sessionProjectId === projectId) this.sessionProjects.delete(sessionId);
    }
    await manager.close();
    await manager.removeThumbnailCache();
    return this.mutationView(null);
  }

  workspace(projectId: string | null = this.defaultProjectId) {
    if (!projectId) throw new HttpError("No Manim workspace is registered.", 404);
    return this.project(projectId).workspace(projectId);
  }

  thumbnail(projectId: string, signal?: AbortSignal) {
    return this.project(projectId).thumbnail(projectId, signal);
  }

  thumbnailStatus(projectId: string, signal?: AbortSignal) {
    return this.project(projectId).thumbnailStatus(projectId, signal);
  }

  generateThumbnail(projectId: string) {
    return this.project(projectId).generateThumbnail(projectId);
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal) {
    const session = await this.project(request.projectId).start(request, signal);
    this.sessionProjects.set(session.id, request.projectId);
    return session;
  }

  runSceneSnapshot(request: FastManimSnapshotRunRequestV1, signal?: AbortSignal) {
    return this.project(request.projectId).runSceneSnapshot(request, signal);
  }

  sceneSnapshot(projectId: string, query: FastManimSnapshotQueryV1) {
    return this.project(projectId).sceneSnapshot(projectId, query);
  }

  sceneSnapshotAsset(projectId: string, digest: string, signal?: AbortSignal) {
    return this.project(projectId).sceneSnapshotAsset(projectId, digest, signal);
  }

  exportSource(request: ProgramRenderRequest, signal?: AbortSignal) {
    return this.project(request.projectId).exportSource(request, signal);
  }

  exportOriginalSource(request: OriginalManimSourceExportRequest, signal?: AbortSignal) {
    return this.project(request.projectId).exportOriginalSource(request, signal);
  }

  view(id: string) {
    return this.sessionProject(id).view(id);
  }

  cancel(id: string) {
    return this.sessionProject(id).cancel(id);
  }

  commit(id: string, expected: RenderCommitRequest, signal?: AbortSignal) {
    return this.sessionProject(id).commit(id, expected, signal);
  }

  cancelSourceAction(id: string, request: RenderSourceActionCancellationRequest) {
    return this.sessionProject(id).cancelSourceAction(id, request);
  }

  undo(id: string, actionId: string, signal?: AbortSignal) {
    return this.sessionProject(id).undo(id, actionId, signal);
  }

  async discard(id: string) {
    const result = await this.sessionProject(id).discard(id);
    this.sessionProjects.delete(id);
    return result;
  }

  async abandonStart(id: string) {
    const projectId = this.sessionProjects.get(id);
    if (!projectId) return;
    await this.project(projectId).abandonStart(id);
    this.sessionProjects.delete(id);
  }

  async abandon(id: string, expectedRenderRequestId: string) {
    const projectId = this.sessionProjects.get(id);
    if (!projectId) return { abandoned: true } as const;
    const result = await this.project(projectId).abandon(id, expectedRenderRequestId);
    this.sessionProjects.delete(id);
    return result;
  }

  videoPath(id: string) {
    return this.sessionProject(id).videoPath(id);
  }

  video(id: string, signal?: AbortSignal) {
    return this.sessionProject(id).video(id, signal);
  }

  async close() {
    const results = await Promise.allSettled([...this.managers.values()].map((manager) => manager.close()));
    this.sessionProjects.clear();
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Manim project registry.");
  }
}
