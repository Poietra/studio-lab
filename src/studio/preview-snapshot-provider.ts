import type { CanvasWorkerClientEvidenceAdapterV1 } from "../engine/canvas-worker-client";
import type { SceneIrBundleV1 } from "../engine/contracts";

export type StudioPreviewSceneIdentityV1 = Readonly<{
  projectId: string;
  sceneName: string;
  sourceHash: string;
  sourcePath: string;
}>;

export const PRISTINE_WORKING_REVISION = "pristine" as const;

export type StudioPreviewEditingContextV1 = StudioPreviewSceneIdentityV1 &
  Readonly<{
    /**
     * Conservative duration projected by Studio's source importer before any
     * edits. A verified server snapshot may carry a different duration because
     * fast-manim execution, not static source analysis, is authoritative for
     * imported Python Scenes.
     */
    sourceDuration: number;
    /**
     * Identity of the applied Studio Edit Programs and draft state on top of
     * the imported source. `PRISTINE_WORKING_REVISION` means no Studio edits.
     */
    workingRevision: string;
  }>;

/**
 * Correlation evidence carried by every verified snapshot. `engineRevisionHash`
 * is the Scene IR source revision hash (the sha-256 the canvas worker echoes on
 * every frame); `serverPublicationRevision` is the issue #65 server publication
 * counter, which is a different namespace and must never be conflated with the
 * engine hash; `assetsManifestDigest` pins the verified asset revision the
 * snapshot was checked against; `sceneDuration` and `sceneId` identify the
 * Scene IR itself. Snapshot duration is internally self-correlated, while the
 * live context is correlated by project/source/Scene identity and working
 * revision: its conservative importer duration is not Python runtime evidence.
 */
export type StudioPreviewSnapshotCorrelationV1 = Readonly<{
  assetsManifestDigest: string;
  context: StudioPreviewEditingContextV1;
  engineRevisionHash: string;
  sceneDuration: number;
  sceneId: string;
  serverPublicationRevision: number | null;
}>;

export type StudioVerifiedPreviewSnapshotV1 = Readonly<{
  correlation: StudioPreviewSnapshotCorrelationV1;
  duration: number;
  sceneId: string;
  snapshot: SceneIrBundleV1;
  sourceLabel: string;
}>;

export type StudioPreviewSnapshotRequestV1 = Readonly<{
  identity: StudioPreviewSceneIdentityV1;
  signal?: AbortSignal;
}>;

/**
 * Supplies one verified Scene snapshot for the retained WebGPU preview. The
 * checked-in fixture provider below is the interim source until the server
 * snapshot endpoint (issue #65) implements this same interface.
 */
export type StudioPreviewSnapshotProviderV1 = Readonly<{
  /**
   * Dev/test-only client extension proving presented frames. Harness
   * providers wire it explicitly; a server provider must never set it, and
   * production builds never resolve a provider at all.
   */
  evidence?: CanvasWorkerClientEvidenceAdapterV1;
  id: string;
  loadVerifiedSnapshot: (request: StudioPreviewSnapshotRequestV1) => Promise<StudioVerifiedPreviewSnapshotV1>;
}>;

export const STUDIO_PREVIEW_RENDERER_QUERY_PARAM = "previewRenderer";

/**
 * Stable key for the Scene identity that owns a retained preview worker. Any
 * identity axis change — the active project/workspace ID, source path, Scene
 * name, or source hash — yields a different key and therefore a clean worker
 * teardown and reinstall, including a project switch onto a Scene with an
 * identical source hash and name. The working revision is deliberately not
 * part of ownership: Studio edits gate presentation synchronously instead of
 * churning the retained worker (incremental deltas are issue #67's boundary).
 */
export function studioPreviewWorkspaceKeyV1(context: StudioPreviewEditingContextV1) {
  return JSON.stringify([context.projectId, context.sourcePath, context.sceneName, context.sourceHash]);
}

/**
 * The retained WebGPU preview stays off unless explicitly requested, and the
 * fixture provider lives behind this DEV-gated dynamic import boundary: a
 * production build ships neither the fixture schema/identity nor the client
 * evidence extension, and can never present the checked-in fixture. The
 * existing semantic preview remains the default editing surface everywhere.
 */
export async function resolveStudioPreviewSnapshotProviderV1(
  search: string,
): Promise<StudioPreviewSnapshotProviderV1 | null> {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(search);
  if (params.get(STUDIO_PREVIEW_RENDERER_QUERY_PARAM) !== "fixture") return null;
  const fixture = await import("./preview-snapshot-provider.fixture");
  return fixture.createFixturePreviewSnapshotProviderV1();
}
