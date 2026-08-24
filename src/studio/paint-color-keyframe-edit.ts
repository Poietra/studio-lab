import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import type { RuntimeSceneState } from "./model";
import { initialAppearanceEnd, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import {
  isCanonicalRgbHex,
  type SceneEdit,
  type SceneEditOperation,
  studioPaintColorTrackProperty,
} from "./scene-edit-contract";

const KEYFRAME_EPSILON = 0.0005;
const MIN_KEYFRAMES = 2;
const MAX_KEYFRAMES = 32;

export type PaintColorProperty = "fillColor" | "strokeColor";
export type PaintColorKeyframeEasing = Extract<StudioPropertyKeyframeEasing, "linear" | "smooth">;

export type PaintColorKeyframe = Readonly<{
  easing: PaintColorKeyframeEasing;
  time: number;
  value: string;
}>;

export type PaintColorKeyframeTrack = Readonly<{
  entityId: string;
  keyframes: readonly PaintColorKeyframe[];
  programIndex: number;
  property: PaintColorProperty;
  transactionId: string;
}>;

function validKeyframes(keyframes: readonly PaintColorKeyframe[], duration: number) {
  return (
    keyframes.length >= MIN_KEYFRAMES &&
    keyframes.length <= MAX_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) => Number.isFinite(time) && time >= 0 && time <= duration && isCanonicalRgbHex(value),
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

function paintColorOperations(
  entityId: string,
  keyframes: readonly PaintColorKeyframe[],
  property: PaintColorProperty,
  transactionId: string,
): readonly SceneEditOperation[] {
  return keyframes.slice(0, -1).map((from, index): SceneEditOperation => {
    const to = keyframes[index + 1]!;
    return {
      dependsOn: [],
      easing: from.easing,
      entityId,
      from: from.value,
      id: operationId(transactionId, `${property === "fillColor" ? "fill" : "stroke"}-color-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: property,
      kind: "AnimateProperty",
      provenance: {
        evidence: ["Studio solid paint color track", `absolute ${property} segment`],
        origin: "direct-manipulation",
      },
      timelineTrack: true,
      to: to.value,
    };
  });
}

function hasClientOnlyTrack(operations: readonly SceneEditOperation[]) {
  return operations.some(
    (operation) =>
      operation.kind === "AnimateProperty" &&
      (operation.materialParameter !== undefined || operation.timelineTrack === true),
  );
}

export function replacePaintColorKeyframeProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    baseline: string;
    entityId: string;
    keyframes: readonly PaintColorKeyframe[];
    property: PaintColorProperty;
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const targetCreate = input.baseProgram.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.id === input.entityId,
  );
  if (!targetCreate || targetCreate.kind !== "CreateEntity") {
    throw new TypeError("Paint color keyframes support only Studio-created objects.");
  }
  if (studioPaintColorTrackProperty(targetCreate.entity.type) !== input.property) {
    throw new TypeError("This Studio-created object does not support the requested paint color track.");
  }
  if (!isCanonicalRgbHex(input.baseline)) {
    throw new TypeError("The Studio-created object's canonical paint color baseline is unavailable.");
  }
  if (input.keyframes.length > 0 && !validKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError(
      `Paint color keyframes must contain ${MIN_KEYFRAMES} to ${MAX_KEYFRAMES} ordered, distinct, canonical colors inside the Scene.`,
    );
  }
  if (input.keyframes.length > 0 && input.keyframes[0]?.value !== input.baseline) {
    throw new TypeError("The first paint color keyframe must preserve the object's canonical static color.");
  }
  const entranceEnd = initialAppearanceEnd(
    input.baseProgram.operations,
    input.entityId,
    targetCreate.entity.lifetime.start,
  );
  if (input.keyframes[0] && input.keyframes[0].time <= entranceEnd + KEYFRAME_EPSILON) {
    throw new TypeError("The first paint color keyframe must be after the object's initial entrance.");
  }
  const existing = paintColorKeyframeTrackFromProgram(input.baseProgram, 0);
  if (existing && (existing.entityId !== input.entityId || existing.property !== input.property)) {
    throw new TypeError("A Studio creation Program can own only one object's paint color track.");
  }
  const hasMaterialOrWriteConflict = input.baseProgram.operations.some(
    (operation) =>
      (operation.kind === "AnimateProperty" &&
        operation.key === "appearance" &&
        operation.materialParameter !== undefined &&
        operation.entityId === input.entityId) ||
      (operation.kind === "WriteIn" && operation.entityId === input.entityId) ||
      (input.property === "fillColor" && operation.kind === "DrawIn" && operation.entityId === input.entityId),
  );
  if (input.keyframes.length > 0 && hasMaterialOrWriteConflict) {
    throw new TypeError("Remove the object's material or incompatible entrance before adding paint color keyframes.");
  }
  const retained = input.baseProgram.operations
    .filter(
      (operation) =>
        !(
          operation.kind === "AnimateProperty" &&
          (operation.key === "fillColor" || operation.key === "strokeColor") &&
          operation.timelineTrack === true
        ),
    )
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const paintColor = paintColorOperations(
    input.entityId,
    input.keyframes,
    input.property,
    input.baseProgram.transactionId,
  );
  const operations = [...retained, ...paintColor];
  const evidence = input.baseProgram.provenance.evidence.filter(
    (entry) => entry !== "Studio solid paint color keyframes",
  );
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: hasClientOnlyTrack(operations) ? "unsupported" : "supported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence:
          paintColor.length === 0
            ? evidence
            : [...new Set([...evidence, "Studio solid paint color keyframes", "canonical Rust evaluation"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}

function paintColorTrackOperations(program: SceneEdit) {
  if (program.provenance.origin !== "direct-manipulation" || program.requestedExecution !== "sequence") return null;
  const colorAnimations = program.operations.filter(
    (operation) =>
      operation.kind === "AnimateProperty" && (operation.key === "fillColor" || operation.key === "strokeColor"),
  );
  const operations = colorAnimations.filter(
    (
      operation,
    ): operation is Extract<SceneEditOperation, { kind: "AnimateProperty" }> &
      Readonly<{
        from: string;
        easing: PaintColorKeyframeEasing;
        key: PaintColorProperty;
        timelineTrack: true;
        to: string;
      }> =>
      operation.kind === "AnimateProperty" &&
      (operation.key === "fillColor" || operation.key === "strokeColor") &&
      operation.timelineTrack === true &&
      isCanonicalRgbHex(operation.from) &&
      isCanonicalRgbHex(operation.to) &&
      (operation.easing === "linear" || operation.easing === "smooth"),
  );
  if (operations.length === 0 || operations.length !== colorAnimations.length) return null;
  return operations;
}

export function paintColorKeyframeTrackFromProgram(
  program: SceneEdit,
  programIndex: number,
): PaintColorKeyframeTrack | null {
  const operations = paintColorTrackOperations(program);
  const first = operations?.[0];
  if (!operations || !first) return null;
  if (
    !program.operations.some(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === first.entityId,
    ) ||
    operations.some((operation) => operation.entityId !== first.entityId || operation.key !== first.key)
  ) {
    return null;
  }
  const keyframes: PaintColorKeyframe[] = [{ easing: first.easing, time: first.interval.start, value: first.from }];
  for (const [index, operation] of operations.entries()) {
    const previous = operations[index - 1];
    if (
      operation.interval.end <= operation.interval.start + KEYFRAME_EPSILON ||
      (previous &&
        (Math.abs(previous.interval.end - operation.interval.start) > KEYFRAME_EPSILON ||
          previous.to !== operation.from))
    ) {
      return null;
    }
    keyframes.push({
      easing: operations[index + 1]?.easing ?? "smooth",
      time: operation.interval.end,
      value: operation.to,
    });
  }
  if (keyframes.length < MIN_KEYFRAMES || keyframes.length > MAX_KEYFRAMES) return null;
  return {
    entityId: first.entityId,
    keyframes,
    programIndex,
    property: first.key,
    transactionId: program.transactionId,
  };
}

export function replacePaintColorKeyframe(
  keyframes: readonly PaintColorKeyframe[],
  index: number,
  patch: Partial<PaintColorKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected paint color keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function initialPaintColorKeyframes(
  input: Readonly<{ baseline: string; entranceEnd: number; playhead: number }>,
) {
  if (!isCanonicalRgbHex(input.baseline)) throw new TypeError("The canonical paint color baseline is unavailable.");
  const baselineTime = input.entranceEnd + KEYFRAME_EPSILON * 2;
  if (!Number.isFinite(input.playhead) || input.playhead <= baselineTime + KEYFRAME_EPSILON) {
    throw new RangeError("Move the playhead farther past the object's initial entrance before adding a color track.");
  }
  return [
    { easing: "smooth" as const, time: baselineTime, value: input.baseline },
    { easing: "smooth" as const, time: input.playhead, value: input.baseline },
  ];
}

export function appendPaintColorKeyframe(keyframes: readonly PaintColorKeyframe[], time: number) {
  const last = keyframes.at(-1);
  if (!last) throw new RangeError("Create the fixed paint color baseline before adding another marker.");
  if (time <= last.time + KEYFRAME_EPSILON) {
    throw new RangeError("Add new paint color keyframes after the final marker so Rust remains the only evaluator.");
  }
  return [...keyframes, { easing: "smooth" as const, time, value: last.value }];
}
