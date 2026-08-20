import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import type { RuntimeSceneState } from "./model";
import { operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const OPACITY_KEYFRAME_EPSILON = 0.0005;
const MAX_OPACITY_KEYFRAMES = 32;
const POST_FADE_OPACITY = 1;

export type OpacityKeyframeEasing = StudioPropertyKeyframeEasing;

export type OpacityKeyframe = Readonly<{
  easing: OpacityKeyframeEasing;
  time: number;
  value: number;
}>;

export type OpacityKeyframeTrack = Readonly<{
  entityId: string;
  keyframes: readonly OpacityKeyframe[];
  programIndex: number;
  transactionId: string;
}>;

function validKeyframes(keyframes: readonly OpacityKeyframe[], duration: number) {
  return (
    keyframes.length > 0 &&
    keyframes.length <= MAX_OPACITY_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) =>
        Number.isFinite(time) && time >= 0 && time <= duration && Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + OPACITY_KEYFRAME_EPSILON)
  );
}

function opacityOperations(
  entityId: string,
  keyframes: readonly OpacityKeyframe[],
  transactionId: string,
): readonly SceneEditOperation[] {
  if (keyframes.length === 1) {
    const keyframe = keyframes[0]!;
    return [
      {
        dependsOn: [],
        easing: keyframe.easing,
        entityId,
        from: keyframe.value,
        id: operationId(transactionId, "opacity-keyframe-0"),
        interval: { end: keyframe.time, start: keyframe.time },
        key: "appearance",
        kind: "AnimateProperty",
        provenance: {
          evidence: ["Studio opacity property track", "single keyframe"],
          origin: "direct-manipulation",
        },
        to: keyframe.value,
      },
    ];
  }
  return keyframes.slice(0, -1).map((from, index): SceneEditOperation => {
    const to = keyframes[index + 1]!;
    return {
      dependsOn: [],
      easing: from.easing,
      entityId,
      from: from.value,
      id: operationId(transactionId, `opacity-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: "appearance",
      kind: "AnimateProperty",
      provenance: {
        evidence: ["Studio opacity property track", "absolute opacity segment"],
        origin: "direct-manipulation",
      },
      to: to.value,
    };
  });
}

export function replaceOpacityKeyframeProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    entityId: string;
    keyframes: readonly OpacityKeyframe[];
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const targetCreate = input.baseProgram.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.id === input.entityId,
  );
  if (!targetCreate || targetCreate.kind !== "CreateEntity") {
    throw new TypeError("Opacity keyframes currently support only objects created by this Studio Program.");
  }
  if (input.keyframes.length > 0 && !validKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError("Opacity keyframes must be ordered, distinct, inside the Scene, and use values from 0 to 1.");
  }
  if (input.keyframes[0] && Math.abs(input.keyframes[0].value - POST_FADE_OPACITY) > OPACITY_KEYFRAME_EPSILON) {
    throw new TypeError("The first opacity keyframe must preserve the object's post-fade opacity of 1.");
  }
  const fadeEnd = Math.max(
    targetCreate.entity.lifetime.start,
    ...input.baseProgram.operations.flatMap((operation) =>
      operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === input.entityId
        ? [operation.interval.end]
        : [],
    ),
  );
  if (input.keyframes[0] && input.keyframes[0].time <= fadeEnd + OPACITY_KEYFRAME_EPSILON) {
    throw new TypeError("The first opacity keyframe must be after the object's initial fade.");
  }
  const existingTrack = opacityKeyframeTrackFromProgram(input.baseProgram, 0);
  if (existingTrack && existingTrack.entityId !== input.entityId) {
    throw new TypeError("A shared creation Program can currently own an opacity track for only one object.");
  }
  const retainedOperations = input.baseProgram.operations
    .filter(
      (operation) =>
        !(
          operation.kind === "AnimateProperty" &&
          operation.key === "appearance" &&
          operation.materialParameter === undefined &&
          operation.entityId === input.entityId
        ),
    )
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const opacity = opacityOperations(input.entityId, input.keyframes, input.baseProgram.transactionId);
  const operations = [...retainedOperations, ...opacity];
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: "supported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: [
          ...new Set([
            ...input.baseProgram.provenance.evidence,
            "Studio-created object opacity keyframes",
            "canonical Rust evaluation",
          ]),
        ],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}

function opacityTrackOperations(program: SceneEdit) {
  if (
    program.provenance.origin !== "direct-manipulation" ||
    program.requestedExecution !== "sequence" ||
    program.operations.length === 0 ||
    !program.operations.some(
      (operation) =>
        operation.kind === "CreateEntity" && operation.entity.id.startsWith(`tx:${program.transactionId}/`),
    )
  ) {
    return null;
  }
  const appearanceAnimations = program.operations.filter(
    (operation) =>
      operation.kind === "AnimateProperty" &&
      operation.key === "appearance" &&
      operation.materialParameter === undefined,
  );
  const opacityOperations = appearanceAnimations.filter(
    (
      operation,
    ): operation is Extract<SceneEditOperation, { kind: "AnimateProperty" }> & Readonly<{ from: number; to: number }> =>
      operation.kind === "AnimateProperty" &&
      operation.key === "appearance" &&
      operation.materialParameter === undefined &&
      typeof operation.from === "number" &&
      typeof operation.to === "number",
  );
  if (opacityOperations.length === 0 || opacityOperations.length !== appearanceAnimations.length) {
    return null;
  }
  return opacityOperations;
}

export function opacityKeyframeTrackFromProgram(program: SceneEdit, programIndex: number): OpacityKeyframeTrack | null {
  const operations = opacityTrackOperations(program);
  const first = operations?.[0];
  if (!operations || !first) return null;
  const entityId = first.entityId;
  if (operations.some((operation) => operation.entityId !== entityId)) return null;
  if (!program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId)) {
    return null;
  }
  if (operations.length === 1 && first.interval.start === first.interval.end) {
    if (Math.abs(first.from - first.to) > OPACITY_KEYFRAME_EPSILON) return null;
    return {
      entityId,
      keyframes: [{ easing: first.easing, time: first.interval.start, value: first.to }],
      programIndex,
      transactionId: program.transactionId,
    };
  }
  const keyframes: OpacityKeyframe[] = [{ easing: first.easing, time: first.interval.start, value: first.from }];
  for (const [index, operation] of operations.entries()) {
    const previous = operations[index - 1];
    if (
      operation.interval.end <= operation.interval.start + OPACITY_KEYFRAME_EPSILON ||
      (previous &&
        (Math.abs(previous.interval.end - operation.interval.start) > OPACITY_KEYFRAME_EPSILON ||
          Math.abs(previous.to - operation.from) > OPACITY_KEYFRAME_EPSILON))
    ) {
      return null;
    }
    keyframes.push({
      easing: operations[index + 1]?.easing ?? "smooth",
      time: operation.interval.end,
      value: operation.to,
    });
  }
  return { entityId, keyframes, programIndex, transactionId: program.transactionId };
}

export function replaceOpacityKeyframe(
  keyframes: readonly OpacityKeyframe[],
  index: number,
  patch: Partial<OpacityKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected opacity keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}
