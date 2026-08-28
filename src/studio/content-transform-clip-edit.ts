import { canonicalEditableContent, studioCreationTextContent } from "./editable-content";
import type { EntityContent, RuntimeSceneState } from "./model";
import { EDIT_OPERATION_VERSION, operationId, provisionalEntityId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { resolveTimeAnchorOnce } from "./time";

const MINIMUM_CONTENT_TRANSFORM_DURATION = 0.1;
const CONTENT_TRANSFORM_EPSILON = 0.0005;

export const CONTENT_TRANSFORM_EASINGS = ["linear", "smooth"] as const;
export type ContentTransformEasing = (typeof CONTENT_TRANSFORM_EASINGS)[number];
export type ContentTransformTargetType = "MathTex" | "Text";

type ContentTransformOperation = Extract<SceneEditOperation, { kind: "TransformContent" }> &
  Readonly<{ easing: ContentTransformEasing; targetType: ContentTransformTargetType }>;

export type ContentTransformClip = Readonly<{
  content: EntityContent;
  easing: ContentTransformEasing;
  interval: Readonly<{ end: number; start: number }>;
  operationId: string;
  rootEntityId: string;
  targetEntityId: string;
  targetType: ContentTransformTargetType;
  transactionId: string;
}>;

function transformOperation(program: SceneEdit): ContentTransformOperation | null {
  if (program.provenance.origin !== "direct-manipulation" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  if (operation?.kind !== "TransformContent" || operation.strategy !== "replacement-transform") return null;
  const targetType = operation.targetType ?? "MathTex";
  if (targetType !== "MathTex" && targetType !== "Text") return null;
  const easing = "easing" in operation ? operation.easing : "smooth";
  return easing === "linear" || easing === "smooth" ? { ...operation, easing, targetType } : null;
}

/** Returns the one editable Studio-native content Transform clip owned by a Program. */
export function contentTransformClipFromProgram(program: SceneEdit, rootEntityId: string): ContentTransformClip | null {
  const operation = transformOperation(program);
  const content = operation ? canonicalEditableContent(operation.replacement, operation.targetType) : null;
  if (!operation || !content) return null;
  return {
    content,
    easing: operation.easing,
    interval: operation.interval,
    operationId: operation.id,
    rootEntityId,
    targetEntityId: operation.targetEntityId,
    targetType: operation.targetType,
    transactionId: program.transactionId,
  };
}

function studioContentRoot(scene: RuntimeSceneState, entityId: string) {
  const entity = scene.objectGraph.entities[entityId];
  if (
    !entity ||
    (entity.type !== "MathTex" && entity.type !== "Text") ||
    !entity.transactionId ||
    entity.sourceIdentity.kind !== "unknown"
  ) {
    throw new TypeError("Content Transform supports only Studio-created logical MathTex and Text roots.");
  }
  return entity;
}

function sameTextTypography(left: EntityContent, right: EntityContent) {
  const leftText = studioCreationTextContent(left);
  const rightText = studioCreationTextContent(right);
  return (
    leftText !== null &&
    rightText !== null &&
    leftText.layout.alignment === rightText.layout.alignment &&
    leftText.layout.fontFamily === rightText.layout.fontFamily &&
    leftText.layout.fontSize === rightText.layout.fontSize &&
    leftText.layout.fontWeight === rightText.layout.fontWeight &&
    leftText.layout.lineHeight === rightText.layout.lineHeight
  );
}

function canonicalTargetContent(
  scene: RuntimeSceneState,
  rootEntityId: string,
  content: EntityContent,
  targetType: ContentTransformTargetType,
) {
  const root = studioContentRoot(scene, rootEntityId);
  if (root.type !== targetType) throw new TypeError("Content Transform cannot change the object's content type.");
  const canonical = canonicalEditableContent(content, targetType);
  if (!canonical) {
    throw new TypeError(
      targetType === "MathTex"
        ? "MathTex Transform requires one to 16 non-blank target TeX parts."
        : "Text Transform requires one bounded, non-empty target string.",
    );
  }
  if (targetType === "Text" && (!root.content || !sameTextTypography(root.content, canonical))) {
    throw new TypeError("Text Transform requires the target to keep the source typography.");
  }
  return canonical;
}

function validateInterval(
  scene: RuntimeSceneState,
  entityId: string,
  interval: Readonly<{ end: number; start: number }>,
) {
  const entity = studioContentRoot(scene, entityId);
  const lifetime = entity.lifetime.find(
    (candidate) => interval.start >= candidate.start && interval.start < candidate.end,
  );
  if (
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    interval.start < 0 ||
    interval.end - interval.start < MINIMUM_CONTENT_TRANSFORM_DURATION - CONTENT_TRANSFORM_EPSILON ||
    interval.end > scene.duration + CONTENT_TRANSFORM_EPSILON ||
    !lifetime ||
    interval.end > lifetime.end + CONTENT_TRANSFORM_EPSILON
  ) {
    throw new RangeError("Content Transform must last at least 0.1 seconds and stay inside the root lifetime.");
  }
}

function canonicalTransformOperation(
  input: Readonly<{
    content: EntityContent;
    easing: ContentTransformEasing;
    interval: Readonly<{ end: number; start: number }>;
    operationId: string;
    sourceEntityId: string;
    targetEntityId: string;
    targetType: ContentTransformTargetType;
  }>,
): SceneEditOperation {
  return {
    dependsOn: [],
    easing: input.easing,
    id: input.operationId,
    interval: input.interval,
    kind: "TransformContent",
    provenance: {
      evidence: ["Inspector Content Transform", "canonical Rust content morph"],
      origin: "direct-manipulation",
    },
    replacement: input.content,
    sourceEntityId: input.sourceEntityId,
    strategy: "replacement-transform",
    targetEntityId: input.targetEntityId,
    targetType: input.targetType,
  };
}

/** Creates one independently editable Transform clip while retaining the logical root identity in Studio. */
export function createContentTransformProgram(
  input: Readonly<{
    capturedPlayhead: number;
    content: EntityContent;
    easing: ContentTransformEasing;
    end: number;
    rootEntityId: string;
    scene: RuntimeSceneState;
    sourceEntityId: string;
    start: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const root = studioContentRoot(input.scene, input.rootEntityId);
  validateInterval(input.scene, input.rootEntityId, { end: input.end, start: input.start });
  const targetType: ContentTransformTargetType = root.type === "Text" ? "Text" : "MathTex";
  const content = canonicalTargetContent(input.scene, input.rootEntityId, input.content, targetType);
  const resolution = resolveTimeAnchorOnce(
    Math.abs(input.start - input.capturedPlayhead) < CONTENT_TRANSFORM_EPSILON
      ? { kind: "playhead" as const, referenceSeconds: input.capturedPlayhead }
      : { kind: "absolute" as const, seconds: input.start },
    { capturedPlayhead: input.capturedPlayhead, sceneDuration: input.scene.duration },
  );
  if (resolution.kind === "invalid") throw new TypeError(resolution.message);
  const operation = canonicalTransformOperation({
    content,
    easing: input.easing,
    interval: { end: input.end, start: input.start },
    operationId: operationId(input.transactionId, "content-transform"),
    // The first stage starts from rootEntityId. A later stage starts from the
    // previous Transform target, preserving the Rust planner's identity chain.
    sourceEntityId: input.sourceEntityId,
    // This identity is an internal morph artifact. The authoring projection
    // keeps exposing rootEntityId to Canvas, Layers, selection, and Timeline.
    targetEntityId: provisionalEntityId(input.transactionId, "content-transform-target"),
    targetType,
  });
  return validateAndScheduleProgram(
    {
      anchor: resolution.anchor,
      intentCount: 1,
      loweringStatus: targetType === "Text" ? "unsupported" : "supported",
      operations: [operation],
      provenance: {
        evidence: ["Inspector Content Transform", "logical root retained"],
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
export function replaceContentTransformProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    content?: EntityContent;
    duration?: number;
    easing?: ContentTransformEasing;
    rootEntityId: string;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const clip = contentTransformClipFromProgram(input.baseProgram, input.rootEntityId);
  const operation = transformOperation(input.baseProgram);
  if (!clip || !operation) throw new TypeError("The Program does not own one editable Content Transform clip.");
  const duration = input.duration ?? clip.interval.end - clip.interval.start;
  const interval = { end: clip.interval.start + duration, start: clip.interval.start };
  validateInterval(input.scene, clip.rootEntityId, interval);
  const content = canonicalTargetContent(
    input.scene,
    clip.rootEntityId,
    input.content ?? clip.content,
    clip.targetType,
  );
  const replacement = canonicalTransformOperation({
    content,
    easing: input.easing ?? clip.easing,
    interval,
    operationId: operation.id,
    sourceEntityId: operation.sourceEntityId,
    targetEntityId: clip.targetEntityId,
    targetType: clip.targetType,
  });
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      operations: [replacement],
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [...new Set([...input.baseProgram.provenance.evidence, "Timeline Content Transform edit"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [replacement.id] },
    },
    input.scene,
  );
}
