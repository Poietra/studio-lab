import { MAX_FINITE_F32 } from "../engine/primitives";
import type { StudioPropertyKeyframeEasing, StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import { replaceStudioScenePostEffectProgram } from "./authoring-commands";
import type { ProgramRecord, RuntimeSceneState } from "./model";
import type { SceneEditValidationResult } from "./program-validation";
import {
  MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES,
  type SceneEdit,
  type ScenePostEffectParameterTrack,
  type StudioScenePostEffectV1,
} from "./scene-edit-contract";
import { sourceTimeToWorkingTime, workingTimeToSourceTime } from "./timeline-projection";

const KEYFRAME_EPSILON = 0.0005;

export type ScenePostEffectParameterKeyframe = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: number;
}>;

function scenePostEffectOperation(program: SceneEdit) {
  const operation = program.operations[0];
  return program.operations.length === 1 && operation?.kind === "SetScenePostEffect" ? operation : null;
}

function sameTarget(
  track: Pick<ScenePostEffectParameterTrack, "parameterIndex" | "revision" | "shaderId">,
  target: Pick<ScenePostEffectParameterTrack, "parameterIndex" | "revision" | "shaderId">,
) {
  return (
    track.shaderId === target.shaderId &&
    track.revision === target.revision &&
    track.parameterIndex === target.parameterIndex
  );
}

function validKeyframes(keyframes: readonly ScenePostEffectParameterKeyframe[], duration: number) {
  return (
    keyframes.length >= 2 &&
    keyframes.length <= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= duration &&
        Number.isFinite(value) &&
        Math.abs(value) <= MAX_FINITE_F32,
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

export function replaceScenePostEffectParameterKeyframeProgram(
  input: Readonly<{
    keyframes: readonly ScenePostEffectParameterKeyframe[];
    name: string;
    owner: ProgramRecord;
    parameterIndex: number;
    range: Readonly<{ max: number; min: number }>;
    revision: number;
    scene: RuntimeSceneState;
    shaderId: string;
  }>,
): SceneEditValidationResult {
  const operation = scenePostEffectOperation(input.owner.program);
  if (!operation || input.owner.program.loweringStatus !== "unsupported") {
    throw new TypeError("Only one canonical Scene post-effect Program can own a parameter track.");
  }
  const effect = operation.effects.find(
    (candidate) => candidate.shaderId === input.shaderId && candidate.revision === input.revision,
  );
  const baseValue = effect?.parameters[input.parameterIndex];
  if (baseValue === undefined || !Number.isFinite(baseValue)) {
    throw new TypeError("The selected Scene post-effect parameter no longer exists.");
  }
  if (
    !Number.isFinite(input.range.min) ||
    !Number.isFinite(input.range.max) ||
    input.range.min > baseValue ||
    input.range.max < baseValue ||
    input.range.max <= input.range.min
  ) {
    throw new TypeError("The Scene post-effect parameter range no longer contains its static value.");
  }
  if (
    input.keyframes.length > 0 &&
    (!validKeyframes(input.keyframes, input.scene.duration) ||
      input.keyframes.some(({ value }) => value < input.range.min || value > input.range.max))
  ) {
    throw new TypeError(
      "Scene effect keyframes must be ordered, distinct, inside the Scene, and inside the parameter range.",
    );
  }
  if (input.keyframes[0] && Math.abs(input.keyframes[0].value - baseValue) > KEYFRAME_EPSILON) {
    throw new TypeError("The first Scene effect keyframe must preserve the static parameter value.");
  }
  const target = {
    parameterIndex: input.parameterIndex,
    revision: input.revision,
    shaderId: input.shaderId,
  };
  if (input.keyframes.length > 0 && operation.parameterTrack && !sameTarget(operation.parameterTrack, target)) {
    throw new TypeError("Remove the current Scene effect parameter track before selecting another parameter.");
  }
  const parameterTrack =
    input.keyframes.length === 0
      ? null
      : {
          ...target,
          keyframes: input.keyframes,
          name: input.name,
        };
  return replaceStudioScenePostEffectProgram({
    effects: operation.effects,
    owner: input.owner,
    parameterTrack,
    scene: input.scene,
  });
}

export function insertScenePostEffectParameterKeyframe(
  keyframes: readonly ScenePostEffectParameterKeyframe[],
  time: number,
  baseValue: number,
) {
  if (!Number.isFinite(time) || time < 0) throw new RangeError("The Scene effect keyframe time must be finite.");
  if (keyframes.some((keyframe) => Math.abs(keyframe.time - time) <= KEYFRAME_EPSILON)) {
    throw new RangeError("A Scene effect keyframe already exists at the playhead.");
  }
  const insertionIndex = keyframes.findIndex((keyframe) => keyframe.time > time);
  const resolvedIndex = insertionIndex === -1 ? keyframes.length : insertionIndex;
  const value = keyframes[resolvedIndex - 1]?.value ?? keyframes[resolvedIndex]?.value ?? baseValue;
  return [
    ...keyframes.slice(0, resolvedIndex),
    { easing: "smooth" as const, time, value },
    ...keyframes.slice(resolvedIndex),
  ];
}

export function replaceScenePostEffectParameterKeyframe(
  keyframes: readonly ScenePostEffectParameterKeyframe[],
  index: number,
  patch: Partial<ScenePostEffectParameterKeyframe>,
) {
  if (!keyframes[index]) throw new RangeError("The selected Scene effect keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function removeScenePostEffectParameterKeyframe(
  keyframes: readonly ScenePostEffectParameterKeyframe[],
  index: number,
) {
  if (!keyframes[index]) throw new RangeError("The selected Scene effect keyframe no longer exists.");
  if (index === 0 && keyframes.length > 1) {
    throw new RangeError("The first Scene effect keyframe preserves the static value and cannot be removed alone.");
  }
  return keyframes.filter((_, candidate) => candidate !== index);
}

export function scenePostEffectParameterTrackMatchesEffects(
  track: ScenePostEffectParameterTrack | null,
  effects: readonly StudioScenePostEffectV1[],
) {
  if (!track) return true;
  const effect = effects.find(
    (candidate) => candidate.shaderId === track.shaderId && candidate.revision === track.revision,
  );
  const baseValue = effect?.parameters[track.parameterIndex];
  const firstValue = track.keyframes[0]?.value;
  return baseValue !== undefined && firstValue !== undefined && Math.abs(baseValue - firstValue) <= KEYFRAME_EPSILON;
}

export function scenePostEffectParameterTrackToWorkingTime(
  track: ScenePostEffectParameterTrack,
  transforms: StudioTimelineProjectionV1["transforms"],
): ScenePostEffectParameterTrack {
  return {
    ...track,
    keyframes: track.keyframes.map((keyframe) => ({
      ...keyframe,
      time: sourceTimeToWorkingTime(transforms, keyframe.time),
    })),
  };
}

export function scenePostEffectParameterKeyframesToSourceTime(
  keyframes: readonly ScenePostEffectParameterKeyframe[],
  transforms: StudioTimelineProjectionV1["transforms"],
): readonly ScenePostEffectParameterKeyframe[] {
  return keyframes.map((keyframe) => ({
    ...keyframe,
    time: workingTimeToSourceTime(transforms, keyframe.time),
  }));
}
