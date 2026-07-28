import type { CanvasInteractionResultV1 } from "../engine/canvas-worker-protocol";
import type {
  PreviewFallbackReasonV1,
  PreviewRendererHostStateV1,
  PreviewViewportV1,
} from "../engine/preview-renderer";
import type { EntityDimensions, Point } from "./model";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewEditingContextV1,
  type StudioPreviewSnapshotCorrelationV1,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewCapabilitiesV1 = Readonly<{
  moduleWorkerSupported: boolean;
  offscreenCanvasTransferSupported: boolean;
  webgpuAvailable: boolean;
}>;

export type StudioPreviewEligibilityInputV1 = StudioPreviewCapabilitiesV1 & Readonly<{ providerAvailable: boolean }>;

export type StudioPreviewEligibilityV1 =
  | Readonly<{
      detail: string;
      eligible: false;
      reason: Extract<PreviewFallbackReasonV1, "capability-unsupported" | "disabled">;
    }>
  | Readonly<{ eligible: true }>;

export function detectStudioPreviewCapabilitiesV1(): StudioPreviewCapabilitiesV1 {
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
 * presented, and every failure past this point is a whole-Scene fallback.
 */
export function evaluateStudioPreviewEligibilityV1(input: StudioPreviewEligibilityInputV1): StudioPreviewEligibilityV1 {
  if (!input.providerAvailable) {
    return {
      detail: "No verified snapshot provider is configured, so the semantic preview stays authoritative.",
      eligible: false,
      reason: "disabled",
    };
  }
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
    return { detail: "WebGPU is unavailable in this browser.", eligible: false, reason: "capability-unsupported" };
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
 * fallback regardless of what the renderer has already presented.
 */
export function studioPreviewSnapshotCorrelatesV1(
  correlation: StudioPreviewSnapshotCorrelationV1,
  context: StudioPreviewEditingContextV1,
): boolean {
  return (
    studioPreviewSnapshotMatchesSourceV1(correlation, context) &&
    correlation.context.workingRevision === context.workingRevision &&
    correlation.sceneDuration === correlation.context.sourceDuration
  );
}

function studioPreviewSnapshotMatchesSourceV1(
  correlation: StudioPreviewSnapshotCorrelationV1,
  context: StudioPreviewEditingContextV1,
) {
  return (
    correlation.context.projectId === context.projectId &&
    correlation.context.sceneName === context.sceneName &&
    correlation.context.sourceHash === context.sourceHash &&
    correlation.context.sourcePath === context.sourcePath
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
  return duration;
}

const FALLBACK_LABELS: Readonly<Record<PreviewFallbackReasonV1, string>> = {
  "capability-unsupported": "browser capability unsupported",
  disabled: "disabled",
  disposed: "disposed",
  "frame-pending": "no correlated frame yet",
  "frame-stale": "frame does not match the current preview target",
  "install-failed": "snapshot install failed",
  installing: "installing snapshot",
  "render-error": "frame render failed",
  "renderer-failed": "renderer failed",
  "sample-out-of-range": "playhead outside installed Scene",
  "snapshot-unavailable": "verified snapshot unavailable",
  "snapshot-uncorrelated": "snapshot does not match the editing context",
  "transient-edit": "transient edit in progress",
  "viewport-unavailable": "viewport unavailable",
};

export function describeStudioPreviewFallbackV1(reason: PreviewFallbackReasonV1) {
  return FALLBACK_LABELS[reason];
}

/**
 * Largest integer viewport that fits the measured canvas box while matching
 * the snapshot camera's aspect ratio strictly tighter than the engine's own
 * 1e-6 acceptance, so a rounded measurement can never produce a frame the
 * engine rejects — or worse, a frame with a subtly wrong aspect.
 */
export function snapStudioPreviewViewportV1(
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
export type StudioPreviewHostBindingV1 = Readonly<{
  canvas: object;
  provider: object;
  snapshot: object;
  workspaceKey: string;
}>;

export function studioPreviewHostBindingCurrentV1(
  binding: StudioPreviewHostBindingV1 | null,
  current: StudioPreviewHostBindingV1,
): boolean {
  return (
    binding !== null &&
    binding.canvas === current.canvas &&
    binding.provider === current.provider &&
    binding.snapshot === current.snapshot &&
    binding.workspaceKey === current.workspaceKey
  );
}

export type StudioPreviewViewStateInputV1 = Readonly<{
  context: StudioPreviewEditingContextV1 | null;
  eligibility: StudioPreviewEligibilityV1;
  hostActive: boolean;
  hostState: PreviewRendererHostStateV1;
  sampleTime: number;
  snapshot: StudioVerifiedPreviewSnapshotV1 | null;
  snapshotError: string | null;
  transientEdit: boolean;
  viewport: PreviewViewportV1 | null;
}>;

/**
 * Resolves the state the editing surface may act on for the current render,
 * synchronously: the host's last emission is only trusted as "presented" when
 * it matches the render's own playhead, viewport, active host, transient-edit
 * flag, and snapshot correlation. Anything the passive effects have not caught
 * up with yet is a whole-Scene fallback in this very render — the first paint
 * after a scrub, resize, host teardown, or drag start never shows a stale
 * canvas frame.
 */
export function resolveStudioPreviewViewStateV1(input: StudioPreviewViewStateInputV1): PreviewRendererHostStateV1 {
  const { eligibility } = input;
  // Snapshot metadata is loaded independently from renderer capabilities
  // because verified runtime duration also drives the semantic editor. Report
  // that failure first even when this browser cannot create the WebGPU host;
  // otherwise a producer/runtime failure is silently misreported as only a
  // client capability limitation.
  if (input.snapshotError !== null) {
    return { detail: input.snapshotError, phase: "fallback", reason: "snapshot-unavailable" };
  }
  if (!eligibility.eligible) return { detail: eligibility.detail, phase: "fallback", reason: eligibility.reason };
  if (!input.snapshot) return { detail: "Loading the verified snapshot.", phase: "fallback", reason: "installing" };
  if (input.transientEdit) {
    return {
      detail: "A direct manipulation or Scene boundary edit is in progress.",
      phase: "fallback",
      reason: "transient-edit",
    };
  }
  if (input.hostState.phase !== "presented") return input.hostState;
  if (
    !input.context ||
    !studioPreviewSnapshotCorrelatesV1(input.snapshot.correlation, input.context) ||
    input.hostState.frame.revision !== input.snapshot.correlation.engineRevisionHash
  ) {
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

export type StudioPreviewInteractionGeometryV1 = ReadonlyMap<
  string,
  Readonly<{ dimensions: EntityDimensions | null; position: Point }>
>;

/**
 * Converts request-correlated clip-space AABBs produced from the exact Rust
 * prepared vertices into Studio's overlay coordinates. Bounds are visual hit
 * targets only: width/height never claim editable Circle radius or Rectangle
 * source dimensions.
 */
export function projectStudioPreviewInteractionGeometryV1(
  entityIds: readonly string[],
  interaction: CanvasInteractionResultV1 | null | undefined,
  frame: Readonly<{ height: number; width: number }>,
): StudioPreviewInteractionGeometryV1 {
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
