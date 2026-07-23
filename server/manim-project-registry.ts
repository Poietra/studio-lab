import type {
  ManimProjectListView,
  ManimProjectMutationView,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
} from "../src/render-pipeline/contracts";
import { HttpError } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimProjectConfig } from "./manim-render-config";
import { ManimRenderManager } from "./manim-render-manager";
import {
  type PersistentManimProjectCatalog,
  type ResolvedManimProject,
  resolveManimProjects,
} from "./manim-project-catalog";

export class ManimProjectRegistry {
  private readonly catalog: PersistentManimProjectCatalog | null;
  private readonly command: readonly string[];
  private readonly frame: Readonly<{ height: number; width: number }>;
  private readonly logger: StructuredLogger;
  private readonly managers = new Map<string, ManimRenderManager>();
  private readonly maxConcurrentRenders: number | undefined;
  private readonly maxRetainedSessions: number | undefined;
  private readonly renderTimeoutMs: number | undefined;
  private readonly sessionProjects = new Map<string, string>();
  private readonly sessionRetentionMs: number | undefined;
  private readonly thumbnailCacheRoot: string | undefined;

  constructor(
    options: Readonly<{
      catalog?: PersistentManimProjectCatalog;
      command: readonly string[];
      frame: Readonly<{ height: number; width: number }>;
      logger?: StructuredLogger;
      maxConcurrentRenders?: number;
      maxRetainedSessions?: number;
      projects: readonly ManimProjectConfig[];
      renderTimeoutMs?: number;
      sessionRetentionMs?: number;
      thumbnailCacheRoot?: string;
    }>,
  ) {
    if (options.projects.length > 64) throw new TypeError("The Manim project registry accepts at most 64 projects.");
    this.catalog = options.catalog ?? null;
    this.command = options.command;
    this.frame = options.frame;
    this.logger = options.logger ?? nullLogger;
    this.maxConcurrentRenders = options.maxConcurrentRenders;
    this.maxRetainedSessions = options.maxRetainedSessions;
    this.renderTimeoutMs = options.renderTimeoutMs;
    this.sessionRetentionMs = options.sessionRetentionMs;
    this.thumbnailCacheRoot = options.thumbnailCacheRoot;
    const configuredProjects = this.catalog?.projects() ?? resolveManimProjects(options.projects);
    for (const project of configuredProjects) this.addManager(project);
  }

  get defaultProjectId() {
    return this.managers.keys().next().value ?? null;
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

  thumbnail(projectId: string) {
    return this.project(projectId).thumbnail(projectId);
  }

  thumbnailStatus(projectId: string) {
    return this.project(projectId).thumbnailStatus(projectId);
  }

  generateThumbnail(projectId: string) {
    return this.project(projectId).generateThumbnail(projectId);
  }

  async start(request: ProgramRenderRequest, signal?: AbortSignal) {
    const session = await this.project(request.projectId).start(request, signal);
    this.sessionProjects.set(session.id, request.projectId);
    return session;
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

  commit(id: string) {
    return this.sessionProject(id).commit(id);
  }

  undo(id: string) {
    return this.sessionProject(id).undo(id);
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

  videoPath(id: string) {
    return this.sessionProject(id).videoPath(id);
  }

  async close() {
    const results = await Promise.allSettled([...this.managers.values()].map((manager) => manager.close()));
    this.sessionProjects.clear();
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Manim project registry.");
  }
}
