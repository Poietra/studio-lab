import type { SceneIrBundleV1 } from "../engine/contracts";
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

function worldCenter(entity: SceneIrBundleV1["scene"]["entities"][number]) {
  const geometry = entity.geometry;
  const local =
    geometry.kind === "circle" || geometry.kind === "rectangle"
      ? geometry.center
      : geometry.kind === "line"
        ? { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 }
        : null;
  if (!local) return null;
  // Engine affine convention (prepare.rs): x' = m11*x + m12*y + tx and
  // y' = m21*x + m22*y + ty — m12/m21 are row entries, not a transposed pair.
  const transform = entity.transform;
  return {
    x: transform.m11 * local.x + transform.m12 * local.y + transform.tx,
    y: transform.m21 * local.x + transform.m22 * local.y + transform.ty,
  };
}

function transformedPoint(
  entity: SceneIrBundleV1["scene"]["entities"][number],
  point: Readonly<{ x: number; y: number }>,
) {
  const transform = entity.transform;
  return {
    x: transform.m11 * point.x + transform.m12 * point.y + transform.tx,
    y: transform.m21 * point.x + transform.m22 * point.y + transform.ty,
  };
}

function cubicCoordinate(from: number, control1: number, control2: number, to: number, time: number) {
  const inverse = 1 - time;
  return (
    inverse * inverse * inverse * from +
    3 * inverse * inverse * time * control1 +
    3 * inverse * time * time * control2 +
    time * time * time * to
  );
}

function cubicExtrema(from: number, control1: number, control2: number, to: number) {
  const quadratic = -from + 3 * control1 - 3 * control2 + to;
  const linear = 2 * (from - 2 * control1 + control2);
  const constant = control1 - from;
  if (Math.abs(quadratic) <= Number.EPSILON) {
    return Math.abs(linear) <= Number.EPSILON ? [] : [-constant / linear].filter((time) => time > 0 && time < 1);
  }
  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-linear - root) / (2 * quadratic), (-linear + root) / (2 * quadratic)].filter(
    (time) => time > 0 && time < 1,
  );
}

function cubicPathWorldBounds(entity: SceneIrBundleV1["scene"]["entities"][number]) {
  if (entity.geometry.kind !== "cubic-path") return null;
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  const includeX = (value: number) => {
    minimumX = Math.min(minimumX, value);
    maximumX = Math.max(maximumX, value);
  };
  const includeY = (value: number) => {
    minimumY = Math.min(minimumY, value);
    maximumY = Math.max(maximumY, value);
  };
  const includePoint = (point: Readonly<{ x: number; y: number }>) => {
    includeX(point.x);
    includeY(point.y);
  };
  for (const subpath of entity.geometry.path.subpaths) {
    let from = transformedPoint(entity, subpath.start);
    includePoint(from);
    for (const segment of subpath.segments) {
      const control1 = transformedPoint(entity, segment.control1);
      const control2 = transformedPoint(entity, segment.control2);
      const to = transformedPoint(entity, segment.end);
      includePoint(to);
      for (const time of cubicExtrema(from.x, control1.x, control2.x, to.x)) {
        includeX(cubicCoordinate(from.x, control1.x, control2.x, to.x, time));
      }
      for (const time of cubicExtrema(from.y, control1.y, control2.y, to.y)) {
        includeY(cubicCoordinate(from.y, control1.y, control2.y, to.y, time));
      }
      from = to;
    }
  }
  if (![minimumX, maximumX, minimumY, maximumY].every(Number.isFinite)) return null;
  return { maximumX, maximumY, minimumX, minimumY };
}

// Two affine row norms are treated as one uniform scale only within this
// tolerance (and only with orthogonal rows); anything wider is projected as an
// axis-aligned box so a circle never claims a radius the pixels do not draw.
const UNIFORM_ROW_NORM_TOLERANCE = 1e-6;

/**
 * True when nothing in the Scene can move geometry over time: base entity
 * transforms and the base camera are then exact for every sample time. Any
 * parent composition or any channel other than opacity (camera,
 * affine-transform, motion-path, path-morph, path-trim, and every future
 * kind) voids that guarantee, because this projection evaluates neither
 * parent chains nor animation.
 */
function sceneGeometryIsStatic(scene: SceneIrBundleV1["scene"]): boolean {
  return (
    scene.entities.every((entity) => entity.parentId === null) &&
    scene.animationChannels.every((channel) => channel.kind === "opacity")
  );
}

/**
 * Conservative interaction-geometry projection for the static-Scene slice of
 * issue #66: hit target positions and sizes come from the verified snapshot
 * itself, keyed by IR entity ID, and are exact ONLY under the narrow
 * guarantee enforced here — no parent composition, no camera or
 * geometry/transform-affecting channels (opacity-only Scenes qualify), and
 * only entities whose lifetime is active at `sampleTime`. Any Scene outside
 * that envelope gets an empty map, so the editing surface falls back to its
 * semantic geometry instead of claiming WebGPU-exact hit targets that would
 * drift over time. Extents are exact axis-aligned bounds under the full
 * affine: a rectangle's AABB is |m11|·w + |m12|·h by |m21|·w + |m22|·h, and a
 * circle uses the matrix row norms as half-extents. A circle keeps its
 * `radius` representation only for a similarity transform (equal row norms
 * AND orthogonal rows) — an equal-norm shear reports width/height bounds, so
 * circle resize stays disabled for it. Line hit targets are center-anchored
 * only (the semantic placeholder supplies the clickable extent).
 */
export function projectStudioPreviewStaticInteractionGeometryV1(
  scene: SceneIrBundleV1["scene"],
  frame: Readonly<{ height: number; width: number }>,
  sampleTime: number,
): StudioPreviewInteractionGeometryV1 {
  const view = scene.camera.view;
  const geometry = new Map<string, Readonly<{ dimensions: EntityDimensions | null; position: Point }>>();
  if (view.frameWidth <= 0 || view.frameHeight <= 0 || frame.height <= 0 || frame.width <= 0) return geometry;
  if (!sceneGeometryIsStatic(scene)) return geometry;
  const heightRatio = frame.height / view.frameHeight;
  const widthRatio = frame.width / view.frameWidth;
  for (const entity of scene.entities) {
    // Same active-lifetime convention as the engine: start <= t < end.
    if (!entity.lifetimes.some((lifetime) => sampleTime >= lifetime.start && sampleTime < lifetime.end)) continue;
    const cubicBounds = cubicPathWorldBounds(entity);
    const world = cubicBounds
      ? {
          x: (cubicBounds.minimumX + cubicBounds.maximumX) / 2,
          y: (cubicBounds.minimumY + cubicBounds.maximumY) / 2,
        }
      : worldCenter(entity);
    if (!world) continue;
    const position = {
      x: (0.5 + (world.x - view.center.x) / view.frameWidth) * STUDIO_VIEWPORT.width,
      y: (0.5 - (world.y - view.center.y) / view.frameHeight) * STUDIO_VIEWPORT.height,
    };
    const { m11, m12, m21, m22 } = entity.transform;
    const rowNormX = Math.hypot(m11, m12);
    const rowNormY = Math.hypot(m21, m22);
    let dimensions: EntityDimensions | null = null;
    if (cubicBounds) {
      dimensions = {
        height: (cubicBounds.maximumY - cubicBounds.minimumY) * heightRatio,
        width: (cubicBounds.maximumX - cubicBounds.minimumX) * widthRatio,
      };
    } else if (entity.geometry.kind === "circle") {
      const similarity =
        Math.abs(rowNormX - rowNormY) <= UNIFORM_ROW_NORM_TOLERANCE * Math.max(rowNormX, rowNormY, 1) &&
        Math.abs(m11 * m21 + m12 * m22) <= UNIFORM_ROW_NORM_TOLERANCE * Math.max(rowNormX * rowNormY, 1);
      dimensions = similarity
        ? { radius: entity.geometry.radius * rowNormX * heightRatio }
        : {
            height: 2 * entity.geometry.radius * rowNormY * heightRatio,
            width: 2 * entity.geometry.radius * rowNormX * widthRatio,
          };
    } else if (entity.geometry.kind === "rectangle") {
      dimensions = {
        height: (Math.abs(m21) * entity.geometry.width + Math.abs(m22) * entity.geometry.height) * heightRatio,
        width: (Math.abs(m11) * entity.geometry.width + Math.abs(m12) * entity.geometry.height) * widthRatio,
      };
    }
    geometry.set(entity.id, { dimensions, position });
  }
  return geometry;
}
