import { useState } from "react";

import {
  MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES,
  MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS,
  type ScenePostEffectParameterTrack,
} from "./scene-edit-contract";
import {
  insertScenePostEffectParameterKeyframe,
  removeScenePostEffectParameterKeyframe,
  replaceScenePostEffectParameterKeyframe,
  type ScenePostEffectParameterKeyframe,
  type ScenePostEffectRgbParameterKeyframe,
  type ScenePostEffectRgbParameterTrack,
  scenePostEffectRgbParameterTrackFromScalarTracks,
} from "./scene-post-effect-parameter-keyframe-edit";
import {
  scenePostEffectHexColorToRgbV1,
  scenePostEffectRgbToHexColorV1,
} from "./scene-post-effect-parameter-schema-draft";
import {
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  type StudioScenePostEffectF32ParameterV1,
  type StudioScenePostEffectParameterSchemaV1,
  type StudioScenePostEffectRgbParameterV1,
  type StudioScenePostEffectRgbV1,
  studioScenePostEffectParameterLayoutV1,
} from "./scene-post-effect-source";

export type ScenePostEffectParameterTrackChange =
  | Readonly<{
      assetRevision: number;
      keyframes: readonly ScenePostEffectParameterKeyframe[];
      kind: "f32";
      name: string;
      parameterIndex: number;
      range: Readonly<{ max: number; min: number }>;
    }>
  | Readonly<{
      assetRevision: number;
      keyframes: readonly ScenePostEffectRgbParameterKeyframe[];
      kind: "rgb";
      name: string;
      parameterIndex: number;
    }>;

export type ScenePostEffectParameterAnimationEditorProps = Readonly<{
  assetRevision: number;
  available: boolean;
  duration: number;
  onChange: (input: ScenePostEffectParameterTrackChange) => void;
  parameterSchema: StudioScenePostEffectParameterSchemaV1;
  parameters: readonly number[];
  parameterTracks: readonly ScenePostEffectParameterTrack[];
  playhead: number;
}>;

type SelectedParameterTrackEditorProps = Readonly<{
  activeTrack: ScenePostEffectParameterTrack | null;
  assetRevision: number;
  available: boolean;
  duration: number;
  onChange: (input: ScenePostEffectParameterTrackChange) => void;
  parameter: StudioScenePostEffectF32ParameterV1;
  parameterIndex: number;
  parameters: readonly number[];
  playhead: number;
  trackLimitReached: boolean;
}>;

function SelectedParameterTrackEditor({
  activeTrack,
  assetRevision,
  available,
  duration,
  onChange,
  parameter,
  parameterIndex,
  parameters,
  playhead,
  trackLimitReached,
}: SelectedParameterTrackEditorProps) {
  const [draft, setDraft] = useState<ScenePostEffectParameterTrack | null>(activeTrack);
  const draftIsValid = (() => {
    if (!draft || draft.keyframes.length < 2) return false;
    const range = parameter.range;
    return (
      draft.keyframes.length <= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES &&
      draft.keyframes.every(
        ({ time, value }) =>
          Number.isFinite(time) &&
          time >= 0 &&
          time <= duration &&
          Number.isFinite(value) &&
          value >= range.min &&
          value <= range.max,
      ) &&
      draft.keyframes.slice(1).every((keyframe, index) => keyframe.time > draft.keyframes[index]!.time + 0.0005)
    );
  })();

  if (!draft) {
    const targetTime = Math.min(duration, Math.max(playhead, Math.min(duration, 1)));
    return (
      <div className="space-y-2" data-scene-post-effect-parameter-track-empty={parameterIndex}>
        <p className="text-pretty text-[10px] leading-4 text-zinc-500">
          {parameter.name} uses its static value until you add an animation.
        </p>
        {trackLimitReached ? (
          <p className="text-pretty text-[10px] leading-4 text-amber-300" role="status">
            Remove another animation before adding a new one. The Scene stack supports at most{" "}
            {MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS} parameter tracks.
          </p>
        ) : null}
        <button
          className="h-7 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:text-zinc-700"
          disabled={!available || trackLimitReached || duration <= 0.0005}
          onClick={() => {
            const baseValue = parameters[parameterIndex] ?? parameter.default;
            setDraft({
              keyframes: [
                { easing: "smooth", time: 0, value: baseValue },
                { easing: "smooth", time: targetTime, value: baseValue },
              ],
              name: parameter.name,
              parameterIndex,
              revision: assetRevision,
              shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
            });
          }}
          type="button"
        >
          Animate from 0s to {targetTime.toFixed(2)}s
        </button>
      </div>
    );
  }

  return (
    <div
      className="space-y-2"
      data-scene-post-effect-parameter-index={parameterIndex}
      data-scene-post-effect-parameter-track={parameter.name}
    >
      <p className="text-[10px] tabular-nums text-zinc-500">
        {draft.name} · {draft.keyframes.length} keyframes
      </p>
      <div className="space-y-2">
        {draft.keyframes.map((keyframe, index) => (
          <div className="grid grid-cols-[4rem_1fr_5.5rem_auto] items-end gap-1" key={`${keyframe.time}/${index}`}>
            <label className="text-[9px] text-zinc-600">
              Time
              <input
                aria-label={`${draft.name} keyframe ${index + 1} time`}
                className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] tabular-nums text-zinc-300"
                disabled={!available}
                max={duration}
                min={0}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, {
                      time: event.currentTarget.valueAsNumber,
                    }),
                  })
                }
                step={0.05}
                type="number"
                value={keyframe.time}
              />
            </label>
            <label className="text-[9px] text-zinc-600">
              Value
              <input
                aria-label={`${draft.name} keyframe ${index + 1} value`}
                className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] tabular-nums text-zinc-300 disabled:text-zinc-600"
                disabled={!available || index === 0}
                max={parameter.range.max}
                min={parameter.range.min}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, {
                      value: event.currentTarget.valueAsNumber,
                    }),
                  })
                }
                step={parameter.range.step}
                type="number"
                value={keyframe.value}
              />
            </label>
            <label className="text-[9px] text-zinc-600">
              Easing
              <select
                aria-label={`${draft.name} keyframe ${index + 1} easing`}
                className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] text-zinc-300"
                disabled={!available || index === draft.keyframes.length - 1}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, {
                      easing: event.currentTarget.value as ScenePostEffectParameterKeyframe["easing"],
                    }),
                  })
                }
                value={keyframe.easing}
              >
                <option value="smooth">Smooth</option>
                <option value="linear">Linear</option>
                <option value="ease-in">Ease in</option>
                <option value="ease-out">Ease out</option>
                <option value="ease-in-out">Ease in &amp; out</option>
              </select>
            </label>
            <button
              aria-label={`Remove ${draft.name} keyframe ${index + 1}`}
              className="h-7 border border-zinc-700 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
              disabled={!available || index === 0 || draft.keyframes.length <= 2}
              onClick={() =>
                setDraft({
                  ...draft,
                  keyframes: removeScenePostEffectParameterKeyframe(draft.keyframes, index),
                })
              }
              type="button"
            >
              −
            </button>
          </div>
        ))}
      </div>
      {!draftIsValid ? (
        <p className="text-pretty text-[10px] leading-4 text-red-300" role="alert">
          Keep at least two ordered keyframes inside the Scene and parameter range.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <button
          className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
          disabled={
            !available ||
            draft.keyframes.length >= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES ||
            playhead < 0 ||
            playhead > duration ||
            draft.keyframes.some((keyframe) => Math.abs(keyframe.time - playhead) <= 0.0005)
          }
          onClick={() => {
            setDraft({
              ...draft,
              keyframes: insertScenePostEffectParameterKeyframe(
                draft.keyframes,
                playhead,
                parameters[parameterIndex] ?? parameter.default,
              ),
            });
          }}
          type="button"
        >
          Add at {playhead.toFixed(2)}s
        </button>
        <button
          className="h-7 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:text-zinc-700"
          disabled={!available || !draftIsValid}
          onClick={() =>
            onChange({
              assetRevision,
              keyframes: draft.keyframes,
              kind: "f32",
              name: parameter.name,
              parameterIndex,
              range: parameter.range,
            })
          }
          type="button"
        >
          {activeTrack ? "Update animation" : "Add animation"}
        </button>
        <button
          aria-label={activeTrack ? `Remove ${parameter.name} animation` : `Cancel ${parameter.name} animation`}
          className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-red-200 disabled:text-zinc-700"
          disabled={!available}
          onClick={() =>
            activeTrack
              ? onChange({
                  assetRevision,
                  keyframes: [],
                  kind: "f32",
                  name: parameter.name,
                  parameterIndex,
                  range: parameter.range,
                })
              : setDraft(null)
          }
          type="button"
        >
          {activeTrack ? "Remove animation" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

type SelectedRgbParameterTrackEditorProps = Readonly<{
  activeTrack: ScenePostEffectRgbParameterTrack | null;
  assetRevision: number;
  available: boolean;
  duration: number;
  onChange: (input: ScenePostEffectParameterTrackChange) => void;
  parameter: StudioScenePostEffectRgbParameterV1;
  parameterIndex: number;
  parameters: readonly number[];
  playhead: number;
  trackLimitReached: boolean;
}>;

function rgbParameterValue(
  parameters: readonly number[],
  parameterIndex: number,
  fallback: StudioScenePostEffectRgbV1,
): StudioScenePostEffectRgbV1 {
  const value = parameters.slice(parameterIndex, parameterIndex + 3);
  return value.length === 3 &&
    value.every((component) => Number.isFinite(component) && component >= 0 && component <= 1)
    ? [value[0]!, value[1]!, value[2]!]
    : fallback;
}

function SelectedRgbParameterTrackEditor({
  activeTrack,
  assetRevision,
  available,
  duration,
  onChange,
  parameter,
  parameterIndex,
  parameters,
  playhead,
  trackLimitReached,
}: SelectedRgbParameterTrackEditorProps) {
  const [draft, setDraft] = useState<ScenePostEffectRgbParameterTrack | null>(activeTrack);
  const draftIsValid =
    draft !== null &&
    draft.keyframes.length >= 2 &&
    draft.keyframes.length <= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES &&
    draft.keyframes.every(
      ({ time, value }) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= duration &&
        value.length === 3 &&
        value.every((component) => Number.isFinite(component) && component >= 0 && component <= 1),
    ) &&
    draft.keyframes.slice(1).every((keyframe, index) => keyframe.time > draft.keyframes[index]!.time + 0.0005);

  if (!draft) {
    const targetTime = Math.min(duration, Math.max(playhead, Math.min(duration, 1)));
    return (
      <div className="space-y-2" data-scene-post-effect-rgb-parameter-track-empty={parameterIndex}>
        <p className="text-pretty text-[10px] leading-4 text-zinc-500">
          {parameter.name} uses its static color until you add an animation.
        </p>
        {trackLimitReached ? (
          <p className="text-pretty text-[10px] leading-4 text-amber-300" role="status">
            Remove another animation before adding this color animation. It uses three of the{" "}
            {MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS} scalar tracks.
          </p>
        ) : null}
        <button
          className="h-7 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:text-zinc-700"
          disabled={!available || trackLimitReached || duration <= 0.0005}
          onClick={() => {
            const baseValue = rgbParameterValue(parameters, parameterIndex, parameter.default);
            setDraft({
              keyframes: [
                { easing: "smooth", time: 0, value: baseValue },
                { easing: "smooth", time: targetTime, value: baseValue },
              ],
              name: parameter.name,
              parameterIndex,
              revision: assetRevision,
              shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
            });
          }}
          type="button"
        >
          Animate color from 0s to {targetTime.toFixed(2)}s
        </button>
      </div>
    );
  }

  return (
    <div
      className="space-y-2"
      data-scene-post-effect-parameter-index={parameterIndex}
      data-scene-post-effect-rgb-parameter-track={parameter.name}
    >
      <p className="text-[10px] tabular-nums text-zinc-500">
        {draft.name} · {draft.keyframes.length} color keyframes
      </p>
      <div className="space-y-2">
        {draft.keyframes.map((keyframe, index) => (
          <div className="grid grid-cols-[4rem_1fr_5.5rem_auto] items-end gap-1" key={`${keyframe.time}/${index}`}>
            <label className="text-[9px] text-zinc-600">
              Time
              <input
                aria-label={`${draft.name} color keyframe ${index + 1} time`}
                className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] tabular-nums text-zinc-300"
                disabled={!available}
                max={duration}
                min={0}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, {
                      time: event.currentTarget.valueAsNumber,
                    }),
                  })
                }
                step={0.05}
                type="number"
                value={keyframe.time}
              />
            </label>
            <label className="text-[9px] text-zinc-600">
              Color
              <input
                aria-label={`${draft.name} color keyframe ${index + 1} value`}
                className="mt-1 h-7 w-full cursor-pointer border border-zinc-700 bg-zinc-950 p-1 disabled:cursor-not-allowed"
                disabled={!available || index === 0}
                onChange={(event) => {
                  const value = scenePostEffectHexColorToRgbV1(event.currentTarget.value);
                  if (!value) return;
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, { value }),
                  });
                }}
                type="color"
                value={scenePostEffectRgbToHexColorV1(keyframe.value)}
              />
            </label>
            <label className="text-[9px] text-zinc-600">
              Easing
              <select
                aria-label={`${draft.name} color keyframe ${index + 1} easing`}
                className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] text-zinc-300"
                disabled={!available || index === draft.keyframes.length - 1}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    keyframes: replaceScenePostEffectParameterKeyframe(draft.keyframes, index, {
                      easing: event.currentTarget.value as ScenePostEffectRgbParameterKeyframe["easing"],
                    }),
                  })
                }
                value={keyframe.easing}
              >
                <option value="smooth">Smooth</option>
                <option value="linear">Linear</option>
                <option value="ease-in">Ease in</option>
                <option value="ease-out">Ease out</option>
                <option value="ease-in-out">Ease in &amp; out</option>
              </select>
            </label>
            <button
              aria-label={`Remove ${draft.name} color keyframe ${index + 1}`}
              className="h-7 border border-zinc-700 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
              disabled={!available || index === 0 || draft.keyframes.length <= 2}
              onClick={() =>
                setDraft({
                  ...draft,
                  keyframes: removeScenePostEffectParameterKeyframe(draft.keyframes, index),
                })
              }
              type="button"
            >
              −
            </button>
          </div>
        ))}
      </div>
      {!draftIsValid ? (
        <p className="text-pretty text-[10px] leading-4 text-red-300" role="alert">
          Keep at least two ordered color keyframes inside the Scene.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <button
          className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
          disabled={
            !available ||
            draft.keyframes.length >= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_KEYFRAMES ||
            playhead < 0 ||
            playhead > duration ||
            draft.keyframes.some((keyframe) => Math.abs(keyframe.time - playhead) <= 0.0005)
          }
          onClick={() =>
            setDraft({
              ...draft,
              keyframes: insertScenePostEffectParameterKeyframe(
                draft.keyframes,
                playhead,
                rgbParameterValue(parameters, parameterIndex, parameter.default),
              ),
            })
          }
          type="button"
        >
          Add at {playhead.toFixed(2)}s
        </button>
        <button
          className="h-7 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:text-zinc-700"
          disabled={!available || !draftIsValid}
          onClick={() =>
            onChange({
              assetRevision,
              keyframes: draft.keyframes,
              kind: "rgb",
              name: parameter.name,
              parameterIndex,
            })
          }
          type="button"
        >
          {activeTrack ? "Update color animation" : "Add color animation"}
        </button>
        <button
          aria-label={activeTrack ? `Remove ${parameter.name} animation` : `Cancel ${parameter.name} animation`}
          className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-red-200 disabled:text-zinc-700"
          disabled={!available}
          onClick={() =>
            activeTrack
              ? onChange({
                  assetRevision,
                  keyframes: [],
                  kind: "rgb",
                  name: parameter.name,
                  parameterIndex,
                })
              : setDraft(null)
          }
          type="button"
        >
          {activeTrack ? "Remove animation" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

export function ScenePostEffectParameterAnimationEditor({
  assetRevision,
  available,
  duration,
  onChange,
  parameterSchema,
  parameters,
  parameterTracks,
  playhead,
}: ScenePostEffectParameterAnimationEditorProps) {
  const effectTracks = parameterTracks.filter(
    (track) => track.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 && track.revision === assetRevision,
  );
  const parameterEntries = studioScenePostEffectParameterLayoutV1(parameterSchema).entries;
  const trackStates = parameterEntries.map((entry) => {
    if (entry.parameter.type === "f32") {
      const activeTrack = effectTracks.find((track) => track.parameterIndex === entry.offset) ?? null;
      return { activeTrack, entry, invalidReason: null } as const;
    }
    try {
      const activeTrack = scenePostEffectRgbParameterTrackFromScalarTracks(effectTracks, {
        baseline: rgbParameterValue(parameters, entry.offset, entry.parameter.default),
        name: entry.parameter.name,
        parameterIndex: entry.offset,
        revision: assetRevision,
        shaderId: PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
      });
      return { activeTrack, entry, invalidReason: null } as const;
    } catch (error) {
      return {
        activeTrack: null,
        entry,
        invalidReason: error instanceof Error ? error.message : "The stored RGB animation is incomplete or misaligned.",
      } as const;
    }
  });
  const [parameterIndex, setParameterIndex] = useState(
    trackStates.find(({ activeTrack }) => activeTrack !== null)?.entry.offset ?? parameterEntries[0]?.offset ?? 0,
  );
  const selectedState = trackStates.find(({ entry }) => entry.offset === parameterIndex) ?? trackStates[0];
  const selectedEntry = selectedState?.entry;
  const selectedParameterIndex = selectedEntry?.offset ?? 0;
  const selectedParameter = selectedEntry?.parameter;
  const activeTrack = selectedState?.activeTrack ?? null;
  const requiredTrackCount = selectedParameter?.type === "rgb" ? 3 : 1;
  const trackLimitReached =
    activeTrack === null && parameterTracks.length + requiredTrackCount > MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS;

  if (!selectedParameter) return null;

  return (
    <fieldset aria-label="Scene post-effect parameter animation" className="mt-3 space-y-2 border border-zinc-800 p-2">
      <legend className="px-1 text-[10px] font-medium text-zinc-400">Parameter animation</legend>
      <p className="text-[10px] tabular-nums text-zinc-500">
        {trackStates.filter(({ activeTrack }) => activeTrack !== null).length} / {trackStates.length} parameters
        animated
      </p>
      <label className="block text-[10px] text-zinc-500">
        Parameter
        <select
          aria-label="Scene effect parameter to animate"
          className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300"
          disabled={!available}
          onChange={(event) => setParameterIndex(Number(event.currentTarget.value))}
          value={selectedParameterIndex}
        >
          {trackStates.map(({ activeTrack: candidateTrack, entry, invalidReason }) => {
            const { offset, parameter } = entry;
            return (
              <option key={`${offset}/${parameter.name}`} value={offset}>
                {parameter.name}
                {invalidReason ? " · invalid animation" : candidateTrack ? " · animated" : ""}
              </option>
            );
          })}
        </select>
      </label>
      {selectedState?.invalidReason ? (
        <p className="text-pretty text-[10px] leading-4 text-red-300" role="alert">
          {selectedState.invalidReason} Remove or repair the stored component tracks before editing this color.
        </p>
      ) : selectedParameter.type === "rgb" ? (
        <SelectedRgbParameterTrackEditor
          activeTrack={activeTrack as ScenePostEffectRgbParameterTrack | null}
          assetRevision={assetRevision}
          available={available}
          duration={duration}
          key={`${assetRevision}/${selectedParameterIndex}/${activeTrack ? JSON.stringify(activeTrack) : "new"}`}
          onChange={onChange}
          parameter={selectedParameter}
          parameterIndex={selectedParameterIndex}
          parameters={parameters}
          playhead={playhead}
          trackLimitReached={trackLimitReached}
        />
      ) : (
        <SelectedParameterTrackEditor
          activeTrack={activeTrack as ScenePostEffectParameterTrack | null}
          assetRevision={assetRevision}
          available={available}
          duration={duration}
          key={`${assetRevision}/${selectedParameterIndex}/${activeTrack ? JSON.stringify(activeTrack) : "new"}`}
          onChange={onChange}
          parameter={selectedParameter}
          parameterIndex={selectedParameterIndex}
          parameters={parameters}
          playhead={playhead}
          trackLimitReached={trackLimitReached}
        />
      )}
    </fieldset>
  );
}
