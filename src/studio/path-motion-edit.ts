import type { RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_PATH_MOTION_DURATION = 0.1;
const PATH_MOTION_EPSILON = 0.0005;

export type PathMotionEasing = "linear" | "smooth";
type CreatePathMotionOperation = Extract<SceneEditOperation, { kind: "CreatePathMotion" }>;

export type PathMotionClip = Readonly<{
  easing: PathMotionEasing;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  pathEntityId: string;
  targetEntityId: string;
  transactionId: string;
}>;

function validatePathMotionInterval(scene: RuntimeSceneState, start: number, end: number) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end - start < MINIMUM_PATH_MOTION_DURATION - PATH_MOTION_EPSILON ||
    end > scene.duration + PATH_MOTION_EPSILON
  ) {
    throw new RangeError("Pen motion must last at least 0.1 seconds and stay inside the Scene.");
  }
}

function canonicalPathMotionOperation(
  input: Readonly<{
    easing: PathMotionEasing;
    end: number;
    operationId: string;
    pathEntityId: string;
    start: number;
    targetEntityId: string;
  }>,
): CreatePathMotionOperation {
  if (!input.pathEntityId || !input.targetEntityId || input.pathEntityId === input.targetEntityId) {
    throw new TypeError("Pen motion requires one distinct path and target object.");
  }
  return {
    dependsOn: [],
    easing: input.easing,
    id: input.operationId,
    interval: { end: input.end, start: input.start },
    kind: "CreatePathMotion",
    pathEntityId: input.pathEntityId,
    provenance: {
      evidence: ["Use Pen as motion path", "Rust-authorized exact cubic path"],
      origin: "direct-manipulation",
    },
    targetEntityId: input.targetEntityId,
  };
}

function pathMotionOperation(program: SceneEdit): CreatePathMotionOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "CreatePathMotion" ? operation : null;
}

export function pathMotionClipFromProgram(program: SceneEdit): PathMotionClip | null {
  const operation = pathMotionOperation(program);
  return operation
    ? {
        easing: operation.easing,
        interval: operation.interval,
        operationId: operation.id,
        pathEntityId: operation.pathEntityId,
        targetEntityId: operation.targetEntityId,
        transactionId: program.transactionId,
      }
    : null;
}

export function createPathMotionProgram(
  input: Readonly<{
    capturedPlayhead: number;
    easing: PathMotionEasing;
    end: number;
    pathEntityId: string;
    scene: RuntimeSceneState;
    start: number;
    targetEntityId: string;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  validatePathMotionInterval(input.scene, input.start, input.end);
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < PATH_MOTION_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalPathMotionOperation({
    easing: input.easing,
    end: input.end,
    operationId: operationId(input.transactionId, "pen-motion"),
    pathEntityId: input.pathEntityId,
    start: input.start,
    targetEntityId: input.targetEntityId,
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [operation],
      provenance: {
        evidence: ["Use Pen as motion path", "canonical Rust motion channel"],
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

export function replacePathMotionProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    duration?: number;
    easing?: PathMotionEasing;
    scene: RuntimeSceneState;
    start?: number;
  }>,
): SceneEditValidationResult {
  const clip = pathMotionClipFromProgram(input.baseProgram);
  const operation = pathMotionOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable Pen motion clip.");
  const start = input.start ?? clip.interval.start;
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const end = start + duration;
  validatePathMotionInterval(input.scene, start, end);
  const resolution = resolveTimeAnchorOnce(
    { kind: "absolute", seconds: start },
    { capturedPlayhead: input.baseProgram.anchor.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const replacement = canonicalPathMotionOperation({
    easing: input.easing ?? clip.easing,
    end,
    operationId: operation.id,
    pathEntityId: clip.pathEntityId,
    start,
    targetEntityId: clip.targetEntityId,
  });
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      anchor: resolution.anchor,
      operations: [replacement],
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline Pen motion edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}
