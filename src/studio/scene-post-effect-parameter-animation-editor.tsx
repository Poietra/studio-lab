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
} from "./scene-post-effect-parameter-keyframe-edit";
import {
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  type StudioScenePostEffectParameterSchemaV1,
} from "./scene-post-effect-source";

type ParameterTrackChange = Readonly<{
  assetRevision: number;
  keyframes: readonly ScenePostEffectParameterKeyframe[];
  name: string;
  parameterIndex: number;
  range: Readonly<{ max: number; min: number }>;
}>;

export type ScenePostEffectParameterAnimationEditorProps = Readonly<{
  assetRevision: number;
  available: boolean;
  duration: number;
  onChange: (input: ParameterTrackChange) => void;
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
  onChange: (input: ParameterTrackChange) => void;
  parameter: StudioScenePostEffectParameterSchemaV1[number];
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
  const [parameterIndex, setParameterIndex] = useState(effectTracks[0]?.parameterIndex ?? 0);
  const selectedParameterIndex = parameterSchema[parameterIndex] ? parameterIndex : 0;
  const selectedParameter = parameterSchema[selectedParameterIndex];
  const activeTrack = effectTracks.find((track) => track.parameterIndex === selectedParameterIndex) ?? null;
  const trackLimitReached =
    activeTrack === null && parameterTracks.length >= MAX_STUDIO_SCENE_POST_EFFECT_PARAMETER_TRACKS;

  if (!selectedParameter) return null;

  return (
    <fieldset aria-label="Scene post-effect parameter animation" className="mt-3 space-y-2 border border-zinc-800 p-2">
      <legend className="px-1 text-[10px] font-medium text-zinc-400">Parameter animation</legend>
      <p className="text-[10px] tabular-nums text-zinc-500">
        {effectTracks.length} / {parameterSchema.length} parameters animated
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
          {parameterSchema.map((parameter, index) => {
            const animated = effectTracks.some((track) => track.parameterIndex === index);
            return (
              <option key={`${index}/${parameter.name}`} value={index}>
                {parameter.name}
                {animated ? " · animated" : ""}
              </option>
            );
          })}
        </select>
      </label>
      <SelectedParameterTrackEditor
        activeTrack={activeTrack}
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
    </fieldset>
  );
}
