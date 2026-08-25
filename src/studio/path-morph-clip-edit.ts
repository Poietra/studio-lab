import {
  type StudioCubicBezierPath,
  type StudioCubicBezierPoint,
  type StudioCubicBezierPointRef,
  type StudioCubicBezierSpec,
  studioCubicBezierPathSchema,
} from "../engine/cubic-bezier-authoring";
import type { RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_PATH_MORPH_DURATION = 0.1;
const PATH_MORPH_EPSILON = 0.0005;

export const PATH_MORPH_EASINGS = ["linear", "smooth"] as const;
export type PathMorphEasing = (typeof PATH_MORPH_EASINGS)[number];

type PathMorphOperation = Extract<SceneEditOperation, { kind: "TransformPath" }>;

export type PathMorphClip = Readonly<{
  easing: PathMorphEasing;
  entityId: string;
  from: StudioCubicBezierPath;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  to: StudioCubicBezierPath;
  transactionId: string;
}>;

export function cubicBezierPathFromSpec(spec: StudioCubicBezierSpec): StudioCubicBezierPath {
  return studioCubicBezierPathSchema.parse({
    closed: spec.closed ?? false,
    segments: [
      { control1: spec.control1, control2: spec.control2, end: spec.end },
      ...(spec.continuationSegments ?? []),
    ],
    start: spec.start,
  });
}

export function replacePathMorphPoint(
  path: StudioCubicBezierPath,
  pointRef: StudioCubicBezierPointRef,
  point: StudioCubicBezierPoint,
): StudioCubicBezierPath {
  if (pointRef.kind === "start") return { ...path, start: point };
  const segment = path.segments[pointRef.segmentIndex];
  if (!segment) throw new RangeError("Path Morph control point is outside the path topology.");
  const segments = [...path.segments];
  segments[pointRef.segmentIndex] = { ...segment, [pointRef.point]: point };
  return { ...path, segments };
}

function pathMorphOperation(program: SceneEdit): PathMorphOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "TransformPath" ? operation : null;
}

export function pathMorphClipFromProgram(program: SceneEdit): PathMorphClip | null {
  const operation = pathMorphOperation(program);
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

function studioPenRoot(scene: RuntimeSceneState, entityId: string) {
  const entity = scene.objectGraph.entities[entityId];
  if (!entity || entity.type !== "CubicBezier" || !entity.transactionId || entity.sourceIdentity.kind !== "unknown") {
    throw new TypeError("Path Morph supports only Studio-created Pen paths.");
  }
  return entity;
}

function validateInterval(
  scene: RuntimeSceneState,
  entityId: string,
  interval: Readonly<{ end: number; start: number }>,
) {
  const entity = studioPenRoot(scene, entityId);
  const lifetime = entity.lifetime.find(
    (candidate) => interval.start >= candidate.start && interval.start < candidate.end,
  );
  if (
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    interval.start < 0 ||
    interval.end - interval.start < MINIMUM_PATH_MORPH_DURATION - PATH_MORPH_EPSILON ||
    interval.end > scene.duration + PATH_MORPH_EPSILON ||
    !lifetime ||
    interval.end > lifetime.end + PATH_MORPH_EPSILON
  ) {
    throw new RangeError("Path Morph must last at least 0.1 seconds and stay inside the object lifetime.");
  }
}

function canonicalPathMorphOperation(
  input: Readonly<{
    easing: PathMorphEasing;
    entityId: string;
    from: StudioCubicBezierPath;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    to: StudioCubicBezierPath;
  }>,
): PathMorphOperation {
  const from = studioCubicBezierPathSchema.parse(input.from);
  const to = studioCubicBezierPathSchema.parse(input.to);
  return {
    dependsOn: [],
    easing: input.easing,
    entityId: input.entityId,
    from,
    id: input.operationId,
    interval: input.interval,
    kind: "TransformPath",
    provenance: {
      evidence: ["Pen Path Morph", "canonical Rust path morph"],
      origin: "direct-manipulation",
    },
    to,
  };
}

export function createPathMorphProgram(
  input: Readonly<{
    capturedPlayhead: number;
    easing: PathMorphEasing;
    end: number;
    entityId: string;
    from: StudioCubicBezierPath;
    scene: RuntimeSceneState;
    start: number;
    to: StudioCubicBezierPath;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  validateInterval(input.scene, input.entityId, { end: input.end, start: input.start });
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < PATH_MORPH_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalPathMorphOperation({
    easing: input.easing,
    entityId: input.entityId,
    from: input.from,
    interval: { end: input.end, start: input.start },
    operationId: operationId(input.transactionId, "path-morph"),
    to: input.to,
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [operation],
      provenance: {
        evidence: ["Pen Path Morph", "logical root retained"],
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

export function replacePathMorphProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    duration?: number;
    easing?: PathMorphEasing;
    scene: RuntimeSceneState;
    to?: StudioCubicBezierPath;
  }>,
): SceneEditValidationResult {
  const clip = pathMorphClipFromProgram(input.baseProgram);
  const operation = pathMorphOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable Path Morph clip.");
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const interval = { end: clip.interval.start + duration, start: clip.interval.start };
  validateInterval(input.scene, clip.entityId, interval);
  const replacement = canonicalPathMorphOperation({
    easing: input.easing ?? clip.easing,
    entityId: clip.entityId,
    from: clip.from,
    interval,
    operationId: operation.id,
    to: input.to ?? clip.to,
  });
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      operations: [replacement],
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline Path Morph edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}
