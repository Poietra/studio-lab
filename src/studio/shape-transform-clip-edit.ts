import type { RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_SHAPE_TRANSFORM_DURATION = 0.1;
const SHAPE_TRANSFORM_EPSILON = 0.0005;

export const SHAPE_TRANSFORM_EASINGS = ["linear", "smooth"] as const;
export type ShapeTransformEasing = (typeof SHAPE_TRANSFORM_EASINGS)[number];

type ShapeTransformOperation = Extract<SceneEditOperation, { kind: "TransformShape" }>;
export type ShapeTransformState = ShapeTransformOperation["from"];
export type ShapeTransformKind = ShapeTransformState["shape"];

export type ShapeTransformClip = Readonly<{
  easing: ShapeTransformEasing;
  entityId: string;
  from: ShapeTransformState;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  to: ShapeTransformState;
  transactionId: string;
}>;

function transformOperation(program: SceneEdit): ShapeTransformOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "TransformShape" ? operation : null;
}

/** Returns the one independently editable Rectangle/Circle Transform clip owned by a Program. */
export function shapeTransformClipFromProgram(program: SceneEdit): ShapeTransformClip | null {
  const operation = transformOperation(program);
  return operation
    ? {
        easing: operation.easing,
        entityId: operation.entityId,
        from: operation.from,
        interval: operation.interval,
        operationId: operation.id,
        to: operation.to,
        transactionId: program.transactionId,
      }
    : null;
}

function studioShapeRoot(scene: RuntimeSceneState, entityId: string) {
  const entity = scene.objectGraph.entities[entityId];
  if (
    !entity ||
    (entity.type !== "Circle" && entity.type !== "Rectangle") ||
    !entity.transactionId ||
    entity.sourceIdentity.kind !== "unknown"
  ) {
    throw new TypeError("Shape Transform supports only Studio-created Rectangle and Circle objects.");
  }
  return entity;
}

function validateShapeState(state: ShapeTransformState) {
  const values =
    state.shape === "circle" ? [state.dimensions.radius] : [state.dimensions.width, state.dimensions.height];
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    throw new TypeError("Shape Transform dimensions must be finite positive numbers.");
  }
}

function validateInterval(
  scene: RuntimeSceneState,
  entityId: string,
  interval: Readonly<{ end: number; start: number }>,
) {
  const entity = studioShapeRoot(scene, entityId);
  const lifetime = entity.lifetime.find(
    (candidate) => interval.start >= candidate.start && interval.start < candidate.end,
  );
  if (
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    interval.start < 0 ||
    interval.end - interval.start < MINIMUM_SHAPE_TRANSFORM_DURATION - SHAPE_TRANSFORM_EPSILON ||
    interval.end > scene.duration + SHAPE_TRANSFORM_EPSILON ||
    !lifetime ||
    interval.end > lifetime.end + SHAPE_TRANSFORM_EPSILON
  ) {
    throw new RangeError("Shape Transform must last at least 0.1 seconds and stay inside the object lifetime.");
  }
}

function canonicalTransformOperation(
  input: Readonly<{
    easing: ShapeTransformEasing;
    entityId: string;
    from: ShapeTransformState;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    to: ShapeTransformState;
  }>,
): ShapeTransformOperation {
  validateShapeState(input.from);
  validateShapeState(input.to);
  if (input.from.shape === input.to.shape) {
    throw new TypeError("Shape Transform must change between Rectangle and Circle.");
  }
  return {
    dependsOn: [],
    easing: input.easing,
    entityId: input.entityId,
    from: input.from,
    id: input.operationId,
    interval: input.interval,
    kind: "TransformShape",
    provenance: {
      evidence: ["Inspector Shape Transform", "canonical Rust path morph"],
      origin: "direct-manipulation",
    },
    to: input.to,
  };
}

/** Creates one Rectangle/Circle Transform clip while retaining the logical root identity. */
export function createShapeTransformProgram(
  input: Readonly<{
    capturedPlayhead: number;
    easing: ShapeTransformEasing;
    end: number;
    entityId: string;
    from: ShapeTransformState;
    scene: RuntimeSceneState;
    start: number;
    to: ShapeTransformState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  validateInterval(input.scene, input.entityId, { end: input.end, start: input.start });
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < SHAPE_TRANSFORM_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalTransformOperation({
    easing: input.easing,
    entityId: input.entityId,
    from: input.from,
    interval: { end: input.end, start: input.start },
    operationId: operationId(input.transactionId, "shape-transform"),
    to: input.to,
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [operation],
      provenance: {
        evidence: ["Inspector Shape Transform", "logical root retained"],
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

/** Replaces duration or easing without changing Program and operation identity. */
export function replaceShapeTransformProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    duration?: number;
    easing?: ShapeTransformEasing;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const clip = shapeTransformClipFromProgram(input.baseProgram);
  const operation = transformOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable Shape Transform clip.");
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const interval = { end: clip.interval.start + duration, start: clip.interval.start };
  validateInterval(input.scene, clip.entityId, interval);
  const replacement = canonicalTransformOperation({
    easing: input.easing ?? clip.easing,
    entityId: clip.entityId,
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
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline Shape Transform edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}
