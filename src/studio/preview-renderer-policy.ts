import type { CanvasInteractionResultV1 } from "../engine/canvas-worker-protocol";
import {
  type PreviewFallbackReasonV1,
  type PreviewRendererHostStateV1,
  type PreviewViewportV1,
  WEBGPU_ADAPTER_UNAVAILABLE_DETAIL,
} from "../engine/preview-renderer";
import type { EntityDimensions, Point } from "./model";
import {
  isStudioNativePreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotCorrelationV1,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewCapabilities = Readonly<{
  moduleWorkerSupported: boolean;
  offscreenCanvasTransferSupported: boolean;
  webgpuAvailable: boolean;
}>;

export type StudioPreviewEligibility =
  | Readonly<{
      detail: string;
      eligible: false;
      reason: Extract<PreviewFallbackReasonV1, "capability-unsupported">;
    }>
  | Readonly<{ eligible: true }>;

export function detectStudioPreviewCapabilities(): StudioPreviewCapabilities {
  return {
    moduleWorkerSupported: typeof Worker !== "undefined",
    offscreenCanvasTransferSupported:
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function" &&
      typeof OffscreenCanvas !== "undefined",
    webgpuAvailable: typeof navigator !== "undefined" && navigator.gpu !== undefined,
  };
}

/**
 * Truthful eligibility gate: it only decides whether the host may ATTEMPT the
 * retained WebGPU preview. Passing this gate proves nothing about rendering —
 * the canvas layer becomes visible only after an exactly correlated frame is
 * presented, and every failure past this point leaves Scene paint unavailable.
 */
export function evaluateStudioPreviewEligibility(input: StudioPreviewCapabilities): StudioPreviewEligibility {
  if (!input.moduleWorkerSupported) {
    return {
      detail: "Module workers are unavailable in this environment.",
      eligible: false,
      reason: "capability-unsupported",
    };
  }
  if (!input.offscreenCanvasTransferSupported) {
    return {
      detail: "OffscreenCanvas transfer is unavailable in this environment.",
      eligible: false,
      reason: "capability-unsupported",
    };
  }
  if (!input.webgpuAvailable) {
    return { detail: WEBGPU_ADAPTER_UNAVAILABLE_DETAIL, eligible: false, reason: "capability-unsupported" };
  }
  return { eligible: true };
}

/**
 * A verified snapshot may only be presented while it correlates with the live
 * editing context by project, source path, Scene name, source hash, and the
 * working revision of applied Studio edits. The snapshot's duration must be
 * internally self-correlated, but it need not equal Studio's conservative
 * static-import duration: for imported Python Scenes the verified fast-manim
 * execution is authoritative. Any identity/edit mismatch is a whole-Scene
 * non-present regardless of what the renderer has already presented.
 */
export function studioPreviewSnapshotCorrelatesV1(
  correlation: StudioPreviewSnapshotCorrelationV1,
  context: StudioPreviewEditingContextV1,
): boolean {
  return (
    studioPreviewSnapshotMatchesSourceV1(correlation, context) &&
    correlation.context.workingRevision === context.workingRevision &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    (!isStudioNativePreviewSceneIdentityV1(context) || correlation.sceneDuration === context.sourceDuration)
  );
}

/** Matches immutable source identity without conflating it with edit or timing state. */
export function studioPreviewSnapshotMatchesSourceV1(
  correlation: StudioPreviewSnapshotCorrelationV1,
  context: StudioPreviewEditingContextV1,
) {
  const correlationContext = correlation.context;
  const nativeContext = isStudioNativePreviewSceneIdentityV1(context);
  const nativeCorrelation = isStudioNativePreviewSceneIdentityV1(correlationContext);
  if (nativeContext || nativeCorrelation) {
    return (
      nativeContext &&
      nativeCorrelation &&
      correlationContext.projectId === context.projectId &&
      correlationContext.documentKey === context.documentKey &&
      correlationContext.sceneId === context.sceneId
    );
  }
  return (
    correlationContext.projectId === context.projectId &&
    correlationContext.sceneName === context.sceneName &&
    correlationContext.sourceHash === context.sourceHash &&
    correlationContext.sourcePath === context.sourcePath
  );
}

/**
 * Returns fast-manim's authoritative imported-Scene duration independently of
 * Studio's working revision. Applied Programs invalidate snapshot pixels, but
 * they are still evaluated on top of the same verified source execution.
 * Every source-identity and internal Scene-IR seam is checked synchronously so
 * a result retained across a workspace switch can never project stale time.
 */
export function studioPreviewVerifiedSourceDurationV1(
  snapshot: StudioVerifiedPreviewSnapshotV1 | null,
  context: StudioPreviewEditingContextV1 | null,
): number | null {
  if (!snapshot || !context) return null;
  const correlation = snapshot.correlation;
  const duration = correlation.sceneDuration;
  const nativeContext = isStudioNativePreviewSceneIdentityV1(context);
  if (
    !studioPreviewSnapshotMatchesSourceV1(correlation, context) ||
    correlation.context.workingRevision !== PRISTINE_WORKING_REVISION ||
    !Number.isFinite(duration) ||
    duration < 0.1 ||
    correlation.context.sourceDuration !== duration ||
    snapshot.duration !== duration ||
    snapshot.snapshot.scene.duration !== duration ||
    snapshot.sceneId !== correlation.sceneId ||
    snapshot.snapshot.scene.sceneId !== correlation.sceneId
  )
    return null;
  if (nativeContext && snapshot.snapshot.scene.source.kind !== "studio-edit-program") return null;
  return duration;
}

const FALLBACK_LABELS: Readonly<Record<PreviewFallbackReasonV1, string>> = {
  "capability-unsupported": "browser capability unsupported",
  disposed: "disposed",
  "frame-pending": "no correlated frame yet",
  "frame-stale": "frame does not match the current preview target",
  "install-failed": "snapshot install failed",
  installing: "installing snapshot",
  "render-error": "frame render failed",
  "renderer-failed": "renderer failed",
  "sample-out-of-range": "playhead outside installed Scene",
  "scene-unsupported": "Scene edit unsupported by the canonical renderer",
  "snapshot-unavailable": "verified snapshot unavailable",
  "snapshot-uncorrelated": "snapshot does not match the editing context",
  "viewport-unavailable": "viewport unavailable",
};

export function describeStudioPreviewFallback(reason: PreviewFallbackReasonV1) {
  return FALLBACK_LABELS[reason];
}

/**
 * Largest integer viewport that fits the measured canvas box while matching
 * the snapshot camera's aspect ratio strictly tighter than the engine's own
 * 1e-6 acceptance, so a rounded measurement can never produce a frame the
 * engine rejects — or worse, a frame with a subtly wrong aspect.
 */
export function snapStudioPreviewViewport(
  measured: Readonly<{ height: number; width: number }>,
  cameraAspect: number,
): PreviewViewportV1 | null {
  if (!Number.isFinite(cameraAspect) || cameraAspect <= 0) return null;
  const maxHeight = Math.floor(measured.height);
  const maxWidth = Math.floor(measured.width);
  for (let heightPx = maxHeight; heightPx >= 1; heightPx -= 1) {
    const widthPx = Math.round(heightPx * cameraAspect);
    if (widthPx < 1 || widthPx > maxWidth) continue;
    if (Math.abs(cameraAspect / (widthPx / heightPx) - 1) <= 1e-7) return { heightPx, widthPx };
  }
  return null;
}

/**
 * Identity of the exact resources a host emission belongs to. Every field is
 * compared by reference: a remounted canvas element, a replaced provider, a
 * reloaded snapshot, or a different workspace key each produce a different
 * binding, so an old host's presented state can never authorize paint on a new
 * canvas — including across StrictMode double-invoked effects.
 */
export type StudioPreviewHostBinding = Readonly<{
  canvas: object;
  provider: object;
  snapshot: object;
  workspaceKey: string;
}>;

export function studioPreviewHostBindingCurrent(
  binding: StudioPreviewHostBinding | null,
  current: StudioPreviewHostBinding,
): boolean {
  return (
    binding !== null &&
    binding.canvas === current.canvas &&
    binding.provider === current.provider &&
    binding.snapshot === current.snapshot &&
    binding.workspaceKey === current.workspaceKey
  );
}

export type StudioPreviewViewStateInput = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  eligibility: StudioPreviewEligibility;
  hostActive: boolean;
  hostState: PreviewRendererHostStateV1;
  sampleTime: number;
  sceneBoundaryActive: boolean;
  snapshot: StudioVerifiedPreviewSnapshotV1 | null;
  snapshotError: string | null;
  viewport: PreviewViewportV1 | null;
  workingScene?: Readonly<{ engineRevisionHash: string; workingRevision: string }> | null;
}>;

/**
 * Resolves the state the editing surface may act on for the current render,
 * synchronously: the host's last emission is only trusted as "presented" when
 * it matches the render's own playhead, viewport, active host, Scene-boundary
 * flag, and snapshot correlation. Anything passive effects have
 * not caught up with yet is non-present in this render, so the first paint
 * after a scrub, resize, host teardown, or Scene change never claims stale
 * canvas pixels.
 */
export function resolveStudioPreviewViewState(input: StudioPreviewViewStateInput): PreviewRendererHostStateV1 {
  const { eligibility } = input;
  // Snapshot metadata is loaded independently from renderer capabilities
  // because verified runtime duration also drives Studio timing. Report
  // that failure first even when this browser cannot create the WebGPU host;
  // otherwise a producer/runtime failure is silently misreported as only a
  // client capability limitation.
  if (input.snapshotError !== null) {
    return { detail: input.snapshotError, phase: "fallback", reason: "snapshot-unavailable" };
  }
  if (!eligibility.eligible) return { detail: eligibility.detail, phase: "fallback", reason: eligibility.reason };
  if (!input.snapshot) return { detail: "Loading the verified snapshot.", phase: "fallback", reason: "installing" };
  if (input.sceneBoundaryActive) {
    return {
      detail: "Scene transition preview is not supported by the canonical renderer.",
      phase: "fallback",
      reason: "scene-unsupported",
    };
  }
  if (input.hostState.phase !== "presented") return input.hostState;
  const revisionCorrelates = input.workingScene
    ? input.context !== null &&
      studioPreviewSnapshotMatchesSourceV1(input.snapshot.correlation, input.context) &&
      input.workingScene.workingRevision === input.context.workingRevision &&
      input.hostState.frame.revision === input.workingScene.engineRevisionHash
    : input.context !== null &&
      studioPreviewSnapshotCorrelatesV1(input.snapshot.correlation, input.context) &&
      input.hostState.frame.revision === input.snapshot.correlation.engineRevisionHash;
  if (!revisionCorrelates) {
    return {
      detail: "The verified snapshot does not correlate with the current editing context.",
      phase: "fallback",
      reason: "snapshot-uncorrelated",
    };
  }
  if (
    !input.hostActive ||
    input.viewport === null ||
    input.hostState.frame.sampleTime !== input.sampleTime ||
    input.hostState.frame.viewport.heightPx !== input.viewport.heightPx ||
    input.hostState.frame.viewport.widthPx !== input.viewport.widthPx
  ) {
    return { detail: null, phase: "fallback", reason: "frame-stale" };
  }
  return input.hostState;
}

export type StudioPreviewInteractionGeometry = ReadonlyMap<
  string,
  Readonly<{ dimensions: EntityDimensions | null; position: Point }>
>;

/**
 * Converts request-correlated clip-space AABBs produced from the exact Rust
 * prepared vertices into Studio's overlay coordinates. Bounds are visual hit
 * targets only: width/height never claim editable Circle radius or Rectangle
 * source dimensions.
 */
export function projectStudioPreviewInteractionGeometry(
  entityIds: readonly string[],
  interaction: CanvasInteractionResultV1 | null | undefined,
  frame: Readonly<{ height: number; width: number }>,
): StudioPreviewInteractionGeometry {
  const geometry = new Map<string, Readonly<{ dimensions: EntityDimensions | null; position: Point }>>();
  if (
    interaction?.status !== "available" ||
    interaction.space !== "clip-v1" ||
    interaction.entries.length !== entityIds.length ||
    !Number.isFinite(frame.height) ||
    !Number.isFinite(frame.width) ||
    frame.height <= 0 ||
    frame.width <= 0
  ) {
    return geometry;
  }
  interaction.entries.forEach((entry, index) => {
    if (entry.status !== "present") return;
    const [minimumX, minimumY, maximumX, maximumY] = entry.bounds;
    const centerX = (minimumX + maximumX) / 2;
    const centerY = (minimumY + maximumY) / 2;
    const position = {
      x: ((centerX + 1) / 2) * STUDIO_VIEWPORT.width,
      y: ((1 - centerY) / 2) * STUDIO_VIEWPORT.height,
    };
    geometry.set(entityIds[index], {
      dimensions: {
        height: ((maximumY - minimumY) / 2) * frame.height,
        width: ((maximumX - minimumX) / 2) * frame.width,
      },
      position,
    });
  });
  return geometry;
}
