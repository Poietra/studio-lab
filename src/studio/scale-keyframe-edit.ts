import type { StudioPropertyKeyframeEasing } from "../engine/scene-authoring";
import type { RuntimeSceneState } from "./model";
import { initialAppearanceEnd, operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const KEYFRAME_EPSILON = 0.0005;
const MAX_KEYFRAMES = 32;
export const MIN_TIMELINE_SCALE = 0.1;
export const MAX_TIMELINE_SCALE = 8;

export type ScaleKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: number;
}>;

export type ScaleKeyframeTrack = Readonly<{
  entityId: string;
  keyframes: readonly ScaleKeyframe[];
  programIndex: number;
  transactionId: string;
}>;

function validKeyframes(keyframes: readonly ScaleKeyframe[], duration: number) {
  return (
    keyframes.length > 0 &&
    keyframes.length <= MAX_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= duration &&
        Number.isFinite(value) &&
        value >= MIN_TIMELINE_SCALE &&
        value <= MAX_TIMELINE_SCALE,
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

function scaleOperations(
  entityId: string,
  keyframes: readonly ScaleKeyframe[],
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
        id: operationId(transactionId, "scale-keyframe-0"),
        interval: { end: keyframe.time, start: keyframe.time },
        key: "scale",
        kind: "AnimateProperty",
        provenance: { evidence: ["Studio uniform scale property track"], origin: "direct-manipulation" },
        timelineTrack: true,
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
      id: operationId(transactionId, `scale-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: "scale",
      kind: "AnimateProperty",
      provenance: { evidence: ["Studio uniform scale property track"], origin: "direct-manipulation" },
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

export function replaceScaleKeyframeProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    baseline: number;
    entityId: string;
    keyframes: readonly ScaleKeyframe[];
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const targetCreate = input.baseProgram.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.id === input.entityId,
  );
  if (!targetCreate || targetCreate.kind !== "CreateEntity") {
    throw new TypeError("Scale keyframes support only Studio-created objects.");
  }
  if (!Number.isFinite(input.baseline) || input.baseline < MIN_TIMELINE_SCALE || input.baseline > MAX_TIMELINE_SCALE) {
    throw new TypeError("The Studio-created object's baseline scale is unavailable.");
  }
  if (input.keyframes.length > 0 && !validKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError(
      `Scale keyframes must be ordered, distinct, inside the Scene, and between ${MIN_TIMELINE_SCALE} and ${MAX_TIMELINE_SCALE}.`,
    );
  }
  if (input.keyframes[0] && Math.abs(input.keyframes[0].value - input.baseline) > KEYFRAME_EPSILON) {
    throw new TypeError("The first scale keyframe must preserve the object's baseline scale.");
  }
  const entranceEnd = initialAppearanceEnd(
    input.baseProgram.operations,
    input.entityId,
    targetCreate.entity.lifetime.start,
  );
  if (input.keyframes[0] && input.keyframes[0].time <= entranceEnd + KEYFRAME_EPSILON) {
    throw new TypeError("The first scale keyframe must be after the object's initial entrance.");
  }
  const existing = scaleKeyframeTrackFromProgram(input.baseProgram, 0);
  if (existing && existing.entityId !== input.entityId) {
    throw new TypeError("A Studio creation Program can currently own a scale track for only one object.");
  }
  const hasCompetingTransform = input.baseProgram.operations.some(
    (operation) =>
      operation.kind === "AnimateProperty" &&
      (operation.key === "rotation" || (operation.key === "scale" && operation.timelineTrack !== true)),
  );
  if (input.keyframes.length > 0 && hasCompetingTransform) {
    throw new TypeError("Remove the object's existing scale or rotation edit before adding scale keyframes.");
  }
  const retained = input.baseProgram.operations
    .filter(
      (operation) =>
        !(operation.kind === "AnimateProperty" && operation.key === "scale" && operation.timelineTrack === true),
    )
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const scale = scaleOperations(input.entityId, input.keyframes, input.baseProgram.transactionId);
  const operations = [...retained, ...scale];
  const evidence = input.baseProgram.provenance.evidence.filter((entry) => entry !== "Studio uniform scale keyframes");
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: hasClientOnlyTrack(operations) ? "unsupported" : "supported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: scale.length === 0 ? evidence : [...new Set([...evidence, "Studio uniform scale keyframes"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}

export function scaleKeyframeTrackFromProgram(program: SceneEdit, programIndex: number): ScaleKeyframeTrack | null {
  if (program.provenance.origin !== "direct-manipulation" || program.requestedExecution !== "sequence") return null;
  const operations = program.operations.filter(
    (
      operation,
    ): operation is Extract<SceneEditOperation, { kind: "AnimateProperty" }> &
      Readonly<{ from: number; timelineTrack: true; to: number }> =>
      operation.kind === "AnimateProperty" &&
      operation.key === "scale" &&
      operation.timelineTrack === true &&
      typeof operation.from === "number" &&
      typeof operation.to === "number",
  );
  const first = operations[0];
  if (
    !first ||
    !program.operations.some(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === first.entityId,
    ) ||
    operations.some((operation) => operation.entityId !== first.entityId)
  ) {
    return null;
  }
  if (operations.length === 1 && first.interval.start === first.interval.end) {
    if (Math.abs(first.from - first.to) > KEYFRAME_EPSILON) return null;
    return {
      entityId: first.entityId,
      keyframes: [{ easing: first.easing, time: first.interval.start, value: first.to }],
      programIndex,
      transactionId: program.transactionId,
    };
  }
  const keyframes: ScaleKeyframe[] = [{ easing: first.easing, time: first.interval.start, value: first.from }];
  for (const [index, operation] of operations.entries()) {
    const previous = operations[index - 1];
    if (
      operation.interval.end <= operation.interval.start + KEYFRAME_EPSILON ||
      (previous &&
        (Math.abs(previous.interval.end - operation.interval.start) > KEYFRAME_EPSILON ||
          Math.abs(previous.to - operation.from) > KEYFRAME_EPSILON))
    ) {
      return null;
    }
    keyframes.push({
      easing: operations[index + 1]?.easing ?? "smooth",
      time: operation.interval.end,
      value: operation.to,
    });
  }
  return { entityId: first.entityId, keyframes, programIndex, transactionId: program.transactionId };
}

export function scaleKeyframeTransformConflictEntity(
  programs: readonly SceneEdit[],
  targetEntityIds: readonly string[],
) {
  const targets = new Set(targetEntityIds);
  for (const [programIndex, program] of programs.entries()) {
    const track = scaleKeyframeTrackFromProgram(program, programIndex);
    if (track && targets.has(track.entityId)) return track.entityId;
  }
  return null;
}

export function replaceScaleKeyframe(
  keyframes: readonly ScaleKeyframe[],
  index: number,
  patch: Partial<ScaleKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected scale keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function appendScaleKeyframe(keyframes: readonly ScaleKeyframe[], time: number, baseline: number) {
  const last = keyframes.at(-1);
  if (last && time <= last.time + KEYFRAME_EPSILON) {
    throw new RangeError("Add new scale keyframes after the final marker so no client-side evaluator is required.");
  }
  return [...keyframes, { easing: "smooth" as const, time, value: last?.value ?? baseline }];
}
