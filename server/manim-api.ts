import type {
  ManimProjectListView,
  ManimProjectMutationView,
  ManimSourceExport,
  ManimThumbnailStatus,
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  ProgramRenderRequest,
  RenderCommitRequest,
  RenderSessionView,
  RenderSourceActionCancellationRequest,
  RenderSourceActionCancellationView,
} from "../src/render-pipeline/contracts";
import type {
  FastManimSnapshotQueryV1,
  FastManimSnapshotRunRequestV1,
  FastManimSnapshotRunViewV1,
} from "./fast-manim-snapshot-contract";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";

/** A local adapter may return synchronously; durable adapters always await I/O. */
export type ManimApiResult<T> = T | Promise<T>;

export type ManimTenantStorageBoundary =
  | Readonly<{
      kind: "host-paths";
      roots: readonly string[];
    }>
  | Readonly<{
      /** Logical backing-store identity; tenant keys provide isolation within it. */
      kind: "shared-durable";
      namespace: string;
    }>;

export type ManimApiStorage =
  | Readonly<{
      /** Compatibility surface for the Vite/Electron host-filesystem adapters. */
      storageBoundary?: never;
      storageRoots: readonly string[];
    }>
  | Readonly<{
      storageBoundary: Extract<ManimTenantStorageBoundary, { kind: "shared-durable" }>;
      storageRoots?: never;
    }>;

/**
 * Transport-independent API consumed by the HTTP router.
 *
 * This port contains no concrete registry classes. Local Vite/Electron
 * adapters retain their explicitly discriminated host roots, while the
 * production runtime exposes only a tenant-keyed durable namespace.
 */
export interface ManimApiOperations {
  readonly tenantId: string;

  abandon(id: string, expectedRenderRequestId: string): ManimApiResult<Readonly<{ abandoned: true }>>;
  abandonStart(id: string): ManimApiResult<void>;
  cancel(id: string): ManimApiResult<RenderSessionView>;
  cancelSourceAction(
    id: string,
    request: RenderSourceActionCancellationRequest,
  ): ManimApiResult<RenderSourceActionCancellationView>;
  commit(id: string, expected: RenderCommitRequest, signal?: AbortSignal): ManimApiResult<RenderSessionView>;
  discard(id: string): ManimApiResult<RenderSessionView>;
  exportOriginalSource(
    request: OriginalManimSourceExportRequest,
    signal?: AbortSignal,
  ): ManimApiResult<ManimSourceExport>;
  exportSource(request: ProgramRenderRequest, signal?: AbortSignal): ManimApiResult<ManimSourceExport>;
  generateThumbnail(projectId: string): ManimApiResult<ManimThumbnailStatus>;
  projects(signal?: AbortSignal): ManimApiResult<ManimProjectListView>;
  runSceneSnapshot(
    request: FastManimSnapshotRunRequestV1,
    signal?: AbortSignal,
  ): ManimApiResult<FastManimSnapshotRunViewV1>;
  sceneSnapshot(projectId: string, query: FastManimSnapshotQueryV1): ManimApiResult<FastManimSnapshotRunViewV1>;
  start(request: ProgramRenderRequest, signal?: AbortSignal): ManimApiResult<RenderSessionView>;
  thumbnail(projectId: string): ManimApiResult<ThumbnailAsset>;
  thumbnailStatus(projectId: string): ManimApiResult<ManimThumbnailStatus>;
  undo(id: string, actionId: string, signal?: AbortSignal): ManimApiResult<RenderSessionView>;
  videoPath(id: string): ManimApiResult<string>;
  view(id: string): ManimApiResult<RenderSessionView>;
  workspace(projectId?: string, signal?: AbortSignal): ManimApiResult<ManimWorkspaceView>;
}

export type ManimApi = ManimApiOperations & ManimApiStorage;

/** Project-catalog mutations are optional for read/render-only adapters. */
export interface MutableManimProjectApiOperations extends ManimApiOperations {
  createManagedProject(name: string, signal?: AbortSignal): ManimApiResult<ManimProjectMutationView>;
  createProject(name: string, root: string, signal?: AbortSignal): ManimApiResult<ManimProjectMutationView>;
  renameProject(projectId: string, name: string, signal?: AbortSignal): ManimApiResult<ManimProjectMutationView>;
  unregisterProject(projectId: string, signal?: AbortSignal): ManimApiResult<ManimProjectMutationView>;
}

export type MutableManimProjectApi = MutableManimProjectApiOperations & ManimApiStorage;
