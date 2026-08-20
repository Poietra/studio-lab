import type { RuntimeSceneState } from "./model";
import { operationId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const KEYFRAME_EPSILON = 0.0005;
const MAX_KEYFRAMES = 32;

export type RotationKeyframe = Readonly<{
  easing: "linear" | "smooth";
  time: number;
  value: number;
}>;

export type RotationKeyframeTrack = Readonly<{
  entityId: string;
  keyframes: readonly RotationKeyframe[];
  programIndex: number;
  transactionId: string;
}>;

function validKeyframes(keyframes: readonly RotationKeyframe[], duration: number) {
  return (
    keyframes.length > 0 &&
    keyframes.length <= MAX_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) => Number.isFinite(time) && time >= 0 && time <= duration && Number.isFinite(value),
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

function rotationOperations(
  entityId: string,
  keyframes: readonly RotationKeyframe[],
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
        id: operationId(transactionId, "rotation-keyframe-0"),
        interval: { end: keyframe.time, start: keyframe.time },
        key: "rotation",
        kind: "AnimateProperty",
        provenance: { evidence: ["Studio rotation property track"], origin: "direct-manipulation" },
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
      id: operationId(transactionId, `rotation-segment-${index}`),
      interval: { end: to.time, start: from.time },
      key: "rotation",
      kind: "AnimateProperty",
      provenance: { evidence: ["Studio rotation property track"], origin: "direct-manipulation" },
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

export function replaceRotationKeyframeProgram(
  input: Readonly<{
    baseProgram: SceneEdit;
    baseline: number;
    entityId: string;
    keyframes: readonly RotationKeyframe[];
    scene: RuntimeSceneState;
  }>,
): SceneEditValidationResult {
  const targetCreate = input.baseProgram.operations.find(
    (operation) => operation.kind === "CreateEntity" && operation.entity.id === input.entityId,
  );
  if (!targetCreate || targetCreate.kind !== "CreateEntity") {
    throw new TypeError("Rotation keyframes support only Studio-created objects.");
  }
  if (!Number.isFinite(input.baseline)) {
    throw new TypeError("The Studio-created object's baseline rotation is unavailable.");
  }
  if (input.keyframes.length > 0 && !validKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError("Rotation keyframes must be finite, ordered, distinct, and inside the Scene.");
  }
  if (input.keyframes[0] && Math.abs(input.keyframes[0].value - input.baseline) > KEYFRAME_EPSILON) {
    throw new TypeError("The first rotation keyframe must preserve the object's baseline rotation.");
  }
  const fadeEnd = Math.max(
    targetCreate.entity.lifetime.start,
    ...input.baseProgram.operations.flatMap((operation) =>
      operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === input.entityId
        ? [operation.interval.end]
        : [],
    ),
  );
  if (input.keyframes[0] && input.keyframes[0].time <= fadeEnd + KEYFRAME_EPSILON) {
    throw new TypeError("The first rotation keyframe must be after the object's initial fade.");
  }
  const existing = rotationKeyframeTrackFromProgram(input.baseProgram, 0);
  if (existing && existing.entityId !== input.entityId) {
    throw new TypeError("A Studio creation Program can currently own a rotation track for only one object.");
  }
  const hasCompetingTransform = input.baseProgram.operations.some(
    (operation) =>
      operation.kind === "AnimateProperty" &&
      (operation.key === "scale" || (operation.key === "rotation" && operation.timelineTrack !== true)),
  );
  if (input.keyframes.length > 0 && hasCompetingTransform) {
    throw new TypeError("Remove the object's existing scale or rotation edit before adding rotation keyframes.");
  }
  const retained = input.baseProgram.operations
    .filter(
      (operation) =>
        !(operation.kind === "AnimateProperty" && operation.key === "rotation" && operation.timelineTrack === true),
    )
    .map((operation) => ({
      ...operation,
      provenance: { ...operation.provenance, origin: "direct-manipulation" as const },
    }));
  const rotation = rotationOperations(input.entityId, input.keyframes, input.baseProgram.transactionId);
  const operations = [...retained, ...rotation];
  const evidence = input.baseProgram.provenance.evidence.filter((entry) => entry !== "Studio rotation keyframes");
  return validateAndScheduleProgram(
    {
      ...input.baseProgram,
      loweringStatus: hasClientOnlyTrack(operations) ? "unsupported" : "supported",
      operations,
      provenance: {
        ...input.baseProgram.provenance,
        evidence: rotation.length === 0 ? evidence : [...new Set([...evidence, "Studio rotation keyframes"])],
        origin: "direct-manipulation",
      },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    },
    input.scene,
  );
}

export function rotationKeyframeTrackFromProgram(
  program: SceneEdit,
  programIndex: number,
): RotationKeyframeTrack | null {
  if (program.provenance.origin !== "direct-manipulation" || program.requestedExecution !== "sequence") return null;
  const operations = program.operations.filter(
    (
      operation,
    ): operation is Extract<SceneEditOperation, { kind: "AnimateProperty" }> &
      Readonly<{ from: number; timelineTrack: true; to: number }> =>
      operation.kind === "AnimateProperty" &&
      operation.key === "rotation" &&
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
  const keyframes: RotationKeyframe[] = [{ easing: first.easing, time: first.interval.start, value: first.from }];
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

export function rotationKeyframeTransformConflictEntity(
  programs: readonly SceneEdit[],
  targetEntityIds: readonly string[],
) {
  const targets = new Set(targetEntityIds);
  for (const [programIndex, program] of programs.entries()) {
    const track = rotationKeyframeTrackFromProgram(program, programIndex);
    if (track && targets.has(track.entityId)) return track.entityId;
  }
  return null;
}

export function replaceRotationKeyframe(
  keyframes: readonly RotationKeyframe[],
  index: number,
  patch: Partial<RotationKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected rotation keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function appendRotationKeyframe(keyframes: readonly RotationKeyframe[], time: number, baseline: number) {
  const last = keyframes.at(-1);
  if (last && time <= last.time + KEYFRAME_EPSILON) {
    throw new RangeError("Add new rotation keyframes after the final marker so no client-side evaluator is required.");
  }
  return [...keyframes, { easing: "smooth" as const, time, value: last?.value ?? baseline }];
}
