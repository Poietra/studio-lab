import { MAX_FINITE_F32, MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 } from "../engine/primitives";
import type { StudioPropertyKeyframeEasing, StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import { replaceStudioScenePostEffectProgram } from "./authoring-commands";
import type { ProgramRecord, RuntimeSceneState } from "./model";
import {
  sourceTimeToWorkingTime as sourceTimeToWorkingTimeWithoutTimeline,
  workingTimeToSourceTime as workingTimeToSourceTimeWithoutTimeline,
} from "./program-composition";
import type { SceneEditValidationResult } from "./program-validation";
import {
  MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES,
  type SceneEdit,
  type ScenePostEffectParameterTrack,
  type StudioScenePostEffectV1,
} from "./scene-edit-contract";
import { programsWithoutScenePostEffectV1 } from "./scene-post-effect-authoring";
import type { StudioScenePostEffectRgbV1 } from "./scene-post-effect-source";
import {
  sourceTimeToWorkingTime as sourceTimeToWorkingTimeFromProjection,
  workingTimeToSourceTime as workingTimeToSourceTimeFromProjection,
} from "./timeline-projection";

const KEYFRAME_EPSILON = 0.0005;

type ScenePostEffectParameterKeyframeValue<Value> = Readonly<{
  easing: StudioPropertyKeyframeEasing;
  time: number;
  value: Value;
}>;

export type ScenePostEffectParameterKeyframe = ScenePostEffectParameterKeyframeValue<number>;

export type ScenePostEffectRgbParameterKeyframe = ScenePostEffectParameterKeyframeValue<StudioScenePostEffectRgbV1>;

export type ScenePostEffectRgbParameterTrack = Readonly<{
  keyframes: readonly ScenePostEffectRgbParameterKeyframe[];
  name: string;
  parameterIndex: number;
  revision: number;
  shaderId: string;
}>;

export type ScenePostEffectRgbParameterTarget = Readonly<{
  baseline: StudioScenePostEffectRgbV1;
  name: string;
  parameterIndex: number;
  revision: number;
  shaderId: string;
}>;

type ScenePostEffectParameterTimeAuthority = Readonly<{
  programs: readonly SceneEdit[];
  timelineTransforms: StudioTimelineProjectionV1["transforms"] | null;
}>;

function scenePostEffectParameterTimeMappers(authority: ScenePostEffectParameterTimeAuthority) {
  const programs = programsWithoutScenePostEffectV1(authority.programs);
  const transforms = authority.timelineTransforms;
  return transforms
    ? {
        toSourceTime: (time: number) => workingTimeToSourceTimeFromProjection(transforms, time),
        toWorkingTime: (time: number) => sourceTimeToWorkingTimeFromProjection(transforms, time),
      }
    : {
        toSourceTime: (time: number) => workingTimeToSourceTimeWithoutTimeline(programs, time),
        toWorkingTime: (time: number) => sourceTimeToWorkingTimeWithoutTimeline(programs, time),
      };
}

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

function validRgbValue(value: unknown): value is StudioScenePostEffectRgbV1 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => Number.isFinite(component) && component >= 0 && component <= 1)
  );
}

function requireRgbTarget(target: ScenePostEffectRgbParameterTarget) {
  if (
    !Number.isInteger(target.parameterIndex) ||
    target.parameterIndex < 0 ||
    target.parameterIndex + 2 >= MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 ||
    !validRgbValue(target.baseline)
  ) {
    throw new TypeError("An RGB Scene effect parameter requires three consecutive finite unit-color components.");
  }
}

function rgbComponentTarget(target: ScenePostEffectRgbParameterTarget, component: number) {
  return {
    parameterIndex: target.parameterIndex + component,
    revision: target.revision,
    shaderId: target.shaderId,
  };
}

function validRgbKeyframes(keyframes: readonly ScenePostEffectRgbParameterKeyframe[], duration: number) {
  return (
    keyframes.length >= 2 &&
    keyframes.length <= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES &&
    keyframes.every(
      ({ time, value }) => Number.isFinite(time) && time >= 0 && time <= duration && validRgbValue(value),
    ) &&
    keyframes.slice(1).every((keyframe, index) => keyframe.time > keyframes[index]!.time + KEYFRAME_EPSILON)
  );
}

/** Reconstructs one logical color track from exactly three aligned scalar tracks. */
export function scenePostEffectRgbParameterTrackFromScalarTracks(
  tracks: readonly ScenePostEffectParameterTrack[],
  target: ScenePostEffectRgbParameterTarget,
): ScenePostEffectRgbParameterTrack | null {
  requireRgbTarget(target);
  const components = [0, 1, 2].map((component) =>
    tracks.filter((track) => sameTarget(track, rgbComponentTarget(target, component))),
  );
  if (components.every((matches) => matches.length === 0)) return null;
  if (components.some((matches) => matches.length !== 1)) {
    throw new TypeError("An RGB Scene effect parameter track requires exactly three complete scalar component tracks.");
  }
  const [red, green, blue] = components.map((matches) => matches[0]!);
  if ([red, green, blue].some((track) => track.name !== target.name)) {
    throw new TypeError("RGB Scene effect component tracks must share the declared parameter name.");
  }
  if (
    green.keyframes.length !== red.keyframes.length ||
    blue.keyframes.length !== red.keyframes.length ||
    red.keyframes.some((keyframe, index) =>
      [green.keyframes[index], blue.keyframes[index]].some(
        (component) => component?.time !== keyframe.time || component.easing !== keyframe.easing,
      ),
    )
  ) {
    throw new TypeError("RGB Scene effect component tracks must use identical keyframe times and easing.");
  }
  const keyframes = red.keyframes.map((keyframe, index): ScenePostEffectRgbParameterKeyframe => {
    const value = [keyframe.value, green.keyframes[index]!.value, blue.keyframes[index]!.value];
    if (!validRgbValue(value)) {
      throw new TypeError("RGB Scene effect component keyframes must contain finite unit-color values.");
    }
    return { easing: keyframe.easing, time: keyframe.time, value };
  });
  if (
    keyframes[0] &&
    keyframes[0].value.some((component, index) => Math.abs(component - target.baseline[index]!) > KEYFRAME_EPSILON)
  ) {
    throw new TypeError("The first RGB Scene effect keyframe must preserve the static parameter value.");
  }
  return {
    keyframes,
    name: target.name,
    parameterIndex: target.parameterIndex,
    revision: target.revision,
    shaderId: target.shaderId,
  };
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
    throw new TypeError("Only one canonical Scene post-effect Program can own parameter tracks.");
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
  const nextTrack = {
    ...target,
    keyframes: input.keyframes,
    name: input.name,
  };
  const targetExists = operation.parameterTracks.some((track) => sameTarget(track, target));
  const parameterTracks =
    input.keyframes.length === 0
      ? operation.parameterTracks.filter((track) => !sameTarget(track, target))
      : targetExists
        ? operation.parameterTracks.map((track) => (sameTarget(track, target) ? nextTrack : track))
        : [...operation.parameterTracks, nextTrack];
  return replaceStudioScenePostEffectProgram({
    effects: operation.effects,
    owner: input.owner,
    parameterTracks,
    scene: input.scene,
  });
}

/** Atomically replaces one logical RGB track as three existing scalar tracks. */
export function replaceScenePostEffectRgbParameterKeyframeProgram(
  input: Readonly<{
    keyframes: readonly ScenePostEffectRgbParameterKeyframe[];
    name: string;
    owner: ProgramRecord;
    parameterIndex: number;
    revision: number;
    scene: RuntimeSceneState;
    shaderId: string;
  }>,
): SceneEditValidationResult {
  const operation = scenePostEffectOperation(input.owner.program);
  if (!operation || input.owner.program.loweringStatus !== "unsupported") {
    throw new TypeError("Only one canonical Scene post-effect Program can own parameter tracks.");
  }
  const effect = operation.effects.find(
    (candidate) => candidate.shaderId === input.shaderId && candidate.revision === input.revision,
  );
  const baseline = effect?.parameters.slice(input.parameterIndex, input.parameterIndex + 3);
  if (!validRgbValue(baseline)) {
    throw new TypeError("The selected RGB Scene post-effect parameter no longer exists.");
  }
  const target = {
    baseline,
    name: input.name,
    parameterIndex: input.parameterIndex,
    revision: input.revision,
    shaderId: input.shaderId,
  } satisfies ScenePostEffectRgbParameterTarget;
  const existing = scenePostEffectRgbParameterTrackFromScalarTracks(operation.parameterTracks, target);
  if (input.keyframes.length > 0 && !validRgbKeyframes(input.keyframes, input.scene.duration)) {
    throw new TypeError("RGB Scene effect keyframes must be ordered, distinct, finite unit colors inside the Scene.");
  }
  if (
    input.keyframes[0] &&
    input.keyframes[0].value.some((component, index) => Math.abs(component - baseline[index]!) > KEYFRAME_EPSILON)
  ) {
    throw new TypeError("The first RGB Scene effect keyframe must preserve the static parameter value.");
  }

  const replacements = [0, 1, 2].map(
    (component): ScenePostEffectParameterTrack => ({
      keyframes: input.keyframes.map(({ easing, time, value }) => ({ easing, time, value: value[component]! })),
      name: input.name,
      parameterIndex: input.parameterIndex + component,
      revision: input.revision,
      shaderId: input.shaderId,
    }),
  );
  const parameterTracks: ScenePostEffectParameterTrack[] = [];
  let inserted = false;
  for (const track of operation.parameterTracks) {
    const component = [0, 1, 2].find((candidate) => sameTarget(track, rgbComponentTarget(target, candidate)));
    if (component === undefined) {
      parameterTracks.push(track);
      continue;
    }
    if (!inserted && input.keyframes.length > 0) {
      parameterTracks.push(...replacements);
      inserted = true;
    }
  }
  if (existing === null && input.keyframes.length > 0) parameterTracks.push(...replacements);

  return replaceStudioScenePostEffectProgram({
    effects: operation.effects,
    owner: input.owner,
    parameterTracks,
    scene: input.scene,
  });
}

export function insertScenePostEffectParameterKeyframe<Value>(
  keyframes: readonly ScenePostEffectParameterKeyframeValue<Value>[],
  time: number,
  baseValue: NoInfer<Value>,
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

export function replaceScenePostEffectParameterKeyframe<Value>(
  keyframes: readonly ScenePostEffectParameterKeyframeValue<Value>[],
  index: number,
  patch: Partial<ScenePostEffectParameterKeyframeValue<Value>>,
) {
  if (!keyframes[index]) throw new RangeError("The selected Scene effect keyframe no longer exists.");
  return keyframes.map((keyframe, candidate) => (candidate === index ? { ...keyframe, ...patch } : keyframe));
}

export function removeScenePostEffectParameterKeyframe<Value>(
  keyframes: readonly ScenePostEffectParameterKeyframeValue<Value>[],
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

export function scenePostEffectParameterTracksMatchEffects(
  tracks: readonly ScenePostEffectParameterTrack[],
  effects: readonly StudioScenePostEffectV1[],
) {
  return tracks.every((track) => scenePostEffectParameterTrackMatchesEffects(track, effects));
}

export function scenePostEffectParameterTrackToWorkingTime(
  track: ScenePostEffectParameterTrack,
  authority: ScenePostEffectParameterTimeAuthority,
): ScenePostEffectParameterTrack {
  const { toWorkingTime } = scenePostEffectParameterTimeMappers(authority);
  return {
    ...track,
    keyframes: track.keyframes.map((keyframe) => ({
      ...keyframe,
      time: toWorkingTime(keyframe.time),
    })),
  };
}

export function scenePostEffectParameterTracksToWorkingTime(
  tracks: readonly ScenePostEffectParameterTrack[],
  authority: ScenePostEffectParameterTimeAuthority,
): readonly ScenePostEffectParameterTrack[] {
  return tracks.map((track) => scenePostEffectParameterTrackToWorkingTime(track, authority));
}

function scenePostEffectKeyframesToSourceTime<T extends Readonly<{ time: number }>>(
  keyframes: readonly T[],
  authority: ScenePostEffectParameterTimeAuthority,
): readonly T[] {
  const { toSourceTime, toWorkingTime } = scenePostEffectParameterTimeMappers(authority);
  return keyframes.map((keyframe) => {
    const sourceTime = toSourceTime(keyframe.time);
    if (Math.abs(toWorkingTime(sourceTime) - keyframe.time) > KEYFRAME_EPSILON) {
      throw new RangeError(
        "A Scene effect keyframe inside inserted timeline time cannot be saved without moving. Move it outside the inserted interval.",
      );
    }
    return { ...keyframe, time: sourceTime };
  });
}

export function scenePostEffectParameterKeyframesToSourceTime(
  keyframes: readonly ScenePostEffectParameterKeyframe[],
  authority: ScenePostEffectParameterTimeAuthority,
): readonly ScenePostEffectParameterKeyframe[] {
  return scenePostEffectKeyframesToSourceTime(keyframes, authority);
}

export function scenePostEffectRgbParameterKeyframesToSourceTime(
  keyframes: readonly ScenePostEffectRgbParameterKeyframe[],
  authority: ScenePostEffectParameterTimeAuthority,
): readonly ScenePostEffectRgbParameterKeyframe[] {
  return scenePostEffectKeyframesToSourceTime(keyframes, authority);
}
