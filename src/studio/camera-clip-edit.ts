import type { RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_CAMERA_CLIP_DURATION = 0.1;
const CAMERA_EPSILON = 0.0005;
export const CAMERA_FOCUS_PADDING = 1.25;
export const MIN_CAMERA_FRAME_FACTOR = 1 / 16;
export const MAX_CAMERA_FRAME_FACTOR = 4;
const MAX_CAMERA_COORDINATE = 1_000_000_000;

export const CAMERA_CLIP_EASINGS = ["linear", "smooth"] as const;
export type CameraClipEasing = (typeof CAMERA_CLIP_EASINGS)[number];

type AnimateCameraOperation = Extract<SceneEditOperation, { kind: "AnimateCamera" }>;
export type CameraView = AnimateCameraOperation["from"];

export type CameraTimelineClip = Readonly<{
  easing: CameraClipEasing;
  from: CameraView;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  to: CameraView;
  transactionId: string;
}>;

function cameraOperation(program: SceneEdit): AnimateCameraOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "AnimateCamera" ? operation : null;
}

export function cameraClipFromProgram(program: SceneEdit): CameraTimelineClip | null {
  const operation = cameraOperation(program);
  return operation
    ? {
        easing: operation.easing,
        from: operation.from,
        interval: operation.interval,
        operationId: operation.id,
        to: operation.to,
        transactionId: program.transactionId,
      }
    : null;
}

function validateCameraView(view: CameraView) {
  if (
    !Number.isFinite(view.center.x) ||
    !Number.isFinite(view.center.y) ||
    !Number.isFinite(view.frameHeight) ||
    !Number.isFinite(view.frameWidth) ||
    view.frameHeight <= 0 ||
    view.frameWidth <= 0 ||
    Math.abs(view.center.x) > MAX_CAMERA_COORDINATE ||
    Math.abs(view.center.y) > MAX_CAMERA_COORDINATE ||
    view.frameHeight > MAX_CAMERA_COORDINATE ||
    view.frameWidth > MAX_CAMERA_COORDINATE
  ) {
    throw new TypeError("Camera views require a finite center and positive frame dimensions.");
  }
}

function viewsEqual(left: CameraView, right: CameraView) {
  return (
    Math.abs(left.center.x - right.center.x) < CAMERA_EPSILON &&
    Math.abs(left.center.y - right.center.y) < CAMERA_EPSILON &&
    Math.abs(left.frameHeight - right.frameHeight) < CAMERA_EPSILON &&
    Math.abs(left.frameWidth - right.frameWidth) < CAMERA_EPSILON
  );
}

function approximatelyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validateCameraViewAgainstBase(view: CameraView, baseView: CameraView) {
  validateCameraView(view);
  validateCameraView(baseView);
  if (!approximatelyEqual(view.frameWidth / view.frameHeight, baseView.frameWidth / baseView.frameHeight)) {
    throw new TypeError("Camera animation must preserve the Scene aspect ratio.");
  }
  if (
    view.frameHeight < baseView.frameHeight * MIN_CAMERA_FRAME_FACTOR ||
    view.frameHeight > baseView.frameHeight * MAX_CAMERA_FRAME_FACTOR ||
    view.frameWidth < baseView.frameWidth * MIN_CAMERA_FRAME_FACTOR ||
    view.frameWidth > baseView.frameWidth * MAX_CAMERA_FRAME_FACTOR
  ) {
    throw new RangeError("Camera view must stay between 1/16x and 4x of the base Scene frame.");
  }
}

function validateCameraTransition(from: CameraView, to: CameraView, baseView: CameraView) {
  validateCameraView(from);
  validateCameraView(to);
  validateCameraViewAgainstBase(from, baseView);
  validateCameraViewAgainstBase(to, baseView);
  if (viewsEqual(from, to)) throw new TypeError("Camera animation must change the current view.");
}

function validateInterval(scene: RuntimeSceneState, interval: Readonly<{ end: number; start: number }>) {
  if (
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    interval.start < 0 ||
    interval.end - interval.start < MINIMUM_CAMERA_CLIP_DURATION - CAMERA_EPSILON ||
    interval.end > scene.duration + CAMERA_EPSILON
  ) {
    throw new RangeError("Camera animation must last at least 0.1 seconds and stay inside the Scene.");
  }
}

function canonicalCameraOperation(
  input: Readonly<{
    easing: CameraClipEasing;
    baseView: CameraView;
    from: CameraView;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    to: CameraView;
  }>,
): AnimateCameraOperation {
  validateCameraTransition(input.from, input.to, input.baseView);
  return {
    dependsOn: [],
    easing: input.easing,
    from: input.from,
    id: input.operationId,
    interval: input.interval,
    kind: "AnimateCamera",
    provenance: {
      evidence: ["Inspector Camera controls", "exact prepared interaction bounds"],
      origin: "direct-manipulation",
    },
    to: input.to,
  };
}

export function createCameraProgram(
  input: Readonly<{
    capturedPlayhead: number;
    baseView: CameraView;
    easing: CameraClipEasing;
    end: number;
    from: CameraView;
    scene: RuntimeSceneState;
    start: number;
    to: CameraView;
    transactionId: string;
    workspaceOrigin: "imported-manim" | "studio-native";
  }>,
): SceneEditValidationResult {
  if (input.workspaceOrigin !== "studio-native") {
    throw new TypeError("Camera clips currently support only Studio-native Scenes.");
  }
  validateInterval(input.scene, { end: input.end, start: input.start });
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < CAMERA_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalCameraOperation({
    baseView: input.baseView,
    easing: input.easing,
    from: input.from,
    interval: { end: input.end, start: input.start },
    operationId: operationId(input.transactionId, "animate-camera"),
    to: input.to,
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [operation],
      provenance: {
        evidence: ["Inspector Camera controls", "canonical Rust camera channel"],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    },
    input.scene,
  );
}

export function replaceCameraProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    baseView: CameraView;
    duration?: number;
    easing?: CameraClipEasing;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const clip = cameraClipFromProgram(input.baseProgram);
  const operation = cameraOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable Camera clip.");
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const interval = { end: clip.interval.start + duration, start: clip.interval.start };
  validateInterval(input.scene, interval);
  const replacement = canonicalCameraOperation({
    baseView: input.baseView,
    easing: input.easing ?? clip.easing,
    from: clip.from,
    interval,
    operationId: operation.id,
    to: clip.to,
  });
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      operations: [replacement],
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline Camera clip edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}

/** Builds a target view only from exact prepared clip-space bounds and the
 * latest exact camera endpoint. Camera interpolation remains exclusively in Rust. */
export function cameraFocusViewFromPreparedBounds(
  input: Readonly<{
    bounds: Readonly<{ bottom: number; left: number; right: number; top: number }>;
    baseView: CameraView;
    currentView: CameraView;
    viewport: Readonly<{ height: number; width: number }>;
  }>,
): CameraView {
  validateCameraView(input.currentView);
  const { bounds, viewport } = input;
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.bottom) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new TypeError("Camera Focus requires non-empty exact prepared bounds.");
  }
  const aspect = input.currentView.frameWidth / input.currentView.frameHeight;
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const contentWidth = ((bounds.right - bounds.left) / viewport.width) * input.currentView.frameWidth;
  const contentHeight = ((bounds.bottom - bounds.top) / viewport.height) * input.currentView.frameHeight;
  const frameHeight = Math.max(contentHeight * CAMERA_FOCUS_PADDING, (contentWidth * CAMERA_FOCUS_PADDING) / aspect);
  const target = {
    center: {
      x: input.currentView.center.x + (centerX / viewport.width - 0.5) * input.currentView.frameWidth,
      y: input.currentView.center.y + (0.5 - centerY / viewport.height) * input.currentView.frameHeight,
    },
    frameHeight,
    frameWidth: frameHeight * aspect,
  };
  validateCameraViewAgainstBase(target, input.baseView);
  return target;
}
