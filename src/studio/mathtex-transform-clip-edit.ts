import { canonicalEditableContent } from "./editable-content";
import type { EntityContent, RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId, provisionalEntityId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_MATH_TEX_TRANSFORM_DURATION = 0.1;
const MATH_TEX_TRANSFORM_EPSILON = 0.0005;

export const MATH_TEX_TRANSFORM_EASINGS = ["linear", "smooth"] as const;
export type MathTexTransformEasing = (typeof MATH_TEX_TRANSFORM_EASINGS)[number];

type MathTexTransformOperation = Extract<SceneEditOperation, { kind: "TransformContent" }> &
  Readonly<{ easing: MathTexTransformEasing }>;

export type MathTexTransformClip = Readonly<{
  content: EntityContent;
  easing: MathTexTransformEasing;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  rootEntityId: string;
  targetEntityId: string;
  transactionId: string;
}>;

function transformOperation(program: SceneEdit): MathTexTransformOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  if (
    operation?.kind !== "TransformContent" ||
    operation.strategy !== "replacement-transform" ||
    (operation.targetType !== undefined && operation.targetType !== "MathTex")
  ) {
    return null;
  }
  const easing = "easing" in operation ? operation.easing : "smooth";
  return easing === "linear" || easing === "smooth" ? ({ ...operation, easing } as MathTexTransformOperation) : null;
}

/** Returns the one editable Studio-native MathTex Transform clip owned by a Program. */
export function mathTexTransformClipFromProgram(program: SceneEdit, rootEntityId: string): MathTexTransformClip | null {
  const operation = transformOperation(program);
  const content = operation ? canonicalEditableContent(operation.replacement, "MathTex") : null;
  if (!operation || !content) return null;
  return {
    content,
    easing: operation.easing,
    interval: operation.interval,
    operationId: operation.id,
    rootEntityId,
    targetEntityId: operation.targetEntityId,
    transactionId: program.transactionId,
  };
}

function studioMathTexRoot(scene: RuntimeSceneState, entityId: string) {
  const entity = scene.objectGraph.entities[entityId];
  if (!entity || entity.type !== "MathTex" || !entity.transactionId || entity.sourceIdentity.kind !== "unknown") {
    throw new TypeError("MathTex Transform supports only Studio-created logical MathTex roots.");
  }
  return entity;
}

function canonicalTargetContent(content: EntityContent) {
  const canonical = canonicalEditableContent(content, "MathTex");
  if (!canonical) throw new TypeError("MathTex Transform requires one to 16 non-blank target TeX parts.");
  return canonical;
}

function validateInterval(
  scene: RuntimeSceneState,
  entityId: string,
  interval: Readonly<{ end: number; start: number }>,
) {
  const entity = studioMathTexRoot(scene, entityId);
  const lifetime = entity.lifetime.find(
    (candidate) => interval.start >= candidate.start && interval.start < candidate.end,
  );
  if (
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    interval.start < 0 ||
    interval.end - interval.start < MINIMUM_MATH_TEX_TRANSFORM_DURATION - MATH_TEX_TRANSFORM_EPSILON ||
    interval.end > scene.duration + MATH_TEX_TRANSFORM_EPSILON ||
    !lifetime ||
    interval.end > lifetime.end + MATH_TEX_TRANSFORM_EPSILON
  ) {
    throw new RangeError("MathTex Transform must last at least 0.1 seconds and stay inside the root lifetime.");
  }
}

function canonicalTransformOperation(
  input: Readonly<{
    content: EntityContent;
    easing: MathTexTransformEasing;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    sourceEntityId: string;
    targetEntityId: string;
  }>,
): SceneEditOperation {
  return {
    dependsOn: [],
    easing: input.easing,
    id: input.operationId,
    interval: input.interval,
    kind: "TransformContent",
    provenance: {
      evidence: ["Inspector MathTex Transform", "canonical Rust replacement morph"],
      origin: "direct-manipulation",
    },
    replacement: canonicalTargetContent(input.content),
    sourceEntityId: input.sourceEntityId,
    strategy: "replacement-transform",
    targetEntityId: input.targetEntityId,
    targetType: "MathTex",
  };
}

/** Creates one independently editable Transform clip while retaining the logical root identity in Studio. */
export function createMathTexTransformProgram(
  input: Readonly<{
    capturedPlayhead: number;
    content: EntityContent;
    easing: MathTexTransformEasing;
    end: number;
    rootEntityId: string;
    scene: RuntimeSceneState;
    sourceEntityId: string;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  validateInterval(input.scene, input.rootEntityId, { end: input.end, start: input.start });
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < MATH_TEX_TRANSFORM_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalTransformOperation({
    content: input.content,
    easing: input.easing,
    interval: { end: input.end, start: input.start },
    operationId: operationId(input.transactionId, "math-tex-transform"),
    // The first stage starts from rootEntityId. A later stage starts from the
    // previous Transform target, preserving the Rust planner's identity chain.
    sourceEntityId: input.sourceEntityId,
    // This identity is an internal morph artifact. The authoring projection
    // keeps exposing rootEntityId to Canvas, Layers, selection, and Timeline.
    targetEntityId: provisionalEntityId(input.transactionId, "math-tex-transform-target"),
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: {
        evidence: ["Inspector MathTex Transform", "logical root retained"],
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

/** Replaces content, duration, or easing without changing Program/operation/artifact identity. */
export function replaceMathTexTransformProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    content?: EntityContent;
    duration?: number;
    easing?: MathTexTransformEasing;
    rootEntityId: string;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const clip = mathTexTransformClipFromProgram(input.baseProgram, input.rootEntityId);
  const operation = transformOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable MathTex Transform clip.");
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const interval = { end: clip.interval.start + duration, start: clip.interval.start };
  validateInterval(input.scene, clip.rootEntityId, interval);
  const replacement = canonicalTransformOperation({
    content: input.content ?? clip.content,
    easing: input.easing ?? clip.easing,
    interval,
    operationId: operation.id,
    sourceEntityId: operation.sourceEntityId,
    targetEntityId: clip.targetEntityId,
  });
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      operations: [replacement],
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline MathTex Transform edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}
