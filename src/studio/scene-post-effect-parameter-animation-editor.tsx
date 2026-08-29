import { useEffect, useState } from "react";

import type { ScenePostEffectParameterTrack } from "./scene-edit-contract";
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
  parameterTrack: ScenePostEffectParameterTrack | null;
  playhead: number;
}>;

export function ScenePostEffectParameterAnimationEditor({
  assetRevision,
  available,
  duration,
  onChange,
  parameterSchema,
  parameters,
  parameterTrack,
  playhead,
}: ScenePostEffectParameterAnimationEditorProps) {
  const [parameterIndex, setParameterIndex] = useState(parameterTrack?.parameterIndex ?? 0);
  const [draft, setDraft] = useState<ScenePostEffectParameterTrack | null>(parameterTrack);

  useEffect(() => {
    setParameterIndex(parameterTrack?.parameterIndex ?? 0);
    setDraft(parameterTrack);
  }, [assetRevision, parameterTrack]);

  const activeTrack =
    parameterTrack?.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 && parameterTrack.revision === assetRevision
      ? parameterTrack
      : null;
  const editableTrack =
    draft?.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 && draft.revision === assetRevision ? draft : null;
  const selectedParameter = editableTrack ? parameterSchema[editableTrack.parameterIndex] : null;
  const draftIsValid = (() => {
    if (!editableTrack || !selectedParameter || editableTrack.keyframes.length < 2) return false;
    const range = selectedParameter.range;
    return (
      editableTrack.keyframes.every(
        ({ time, value }) =>
          Number.isFinite(time) &&
          time >= 0 &&
          time <= duration &&
          Number.isFinite(value) &&
          value >= range.min &&
          value <= range.max,
      ) &&
      editableTrack.keyframes
        .slice(1)
        .every((keyframe, index) => keyframe.time > editableTrack.keyframes[index]!.time + 0.0005)
    );
  })();

  return (
    <fieldset aria-label="Scene post-effect parameter animation" className="mt-3 space-y-2 border border-zinc-800 p-2">
      <legend className="px-1 text-[10px] font-medium text-zinc-400">Parameter animation</legend>
      {parameterTrack && !activeTrack ? (
        <p className="text-pretty text-[10px] leading-4 text-amber-300">
          Another Scene effect already owns the current parameter track. Remove it before animating this effect.
        </p>
      ) : editableTrack && selectedParameter ? (
        <>
          <p className="text-[10px] text-zinc-500">
            {editableTrack.name} · {editableTrack.keyframes.length} keyframes
          </p>
          <div className="space-y-2">
            {editableTrack.keyframes.map((keyframe, index) => (
              <div className="grid grid-cols-[4rem_1fr_5.5rem_auto] items-end gap-1" key={`${keyframe.time}/${index}`}>
                <label className="text-[9px] text-zinc-600">
                  Time
                  <input
                    aria-label={`${editableTrack.name} keyframe ${index + 1} time`}
                    className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] text-zinc-300"
                    disabled={!available}
                    max={duration}
                    min={0}
                    onChange={(event) =>
                      setDraft({
                        ...editableTrack,
                        keyframes: replaceScenePostEffectParameterKeyframe(editableTrack.keyframes, index, {
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
                    aria-label={`${editableTrack.name} keyframe ${index + 1} value`}
                    className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] text-zinc-300 disabled:text-zinc-600"
                    disabled={!available || index === 0}
                    max={selectedParameter.range.max}
                    min={selectedParameter.range.min}
                    onChange={(event) =>
                      setDraft({
                        ...editableTrack,
                        keyframes: replaceScenePostEffectParameterKeyframe(editableTrack.keyframes, index, {
                          value: event.currentTarget.valueAsNumber,
                        }),
                      })
                    }
                    step={selectedParameter.range.step}
                    type="number"
                    value={keyframe.value}
                  />
                </label>
                <label className="text-[9px] text-zinc-600">
                  Easing
                  <select
                    aria-label={`${editableTrack.name} keyframe ${index + 1} easing`}
                    className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1 text-[10px] text-zinc-300"
                    disabled={!available || index === editableTrack.keyframes.length - 1}
                    onChange={(event) =>
                      setDraft({
                        ...editableTrack,
                        keyframes: replaceScenePostEffectParameterKeyframe(editableTrack.keyframes, index, {
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
                  aria-label={`Remove ${editableTrack.name} keyframe ${index + 1}`}
                  className="h-7 border border-zinc-700 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
                  disabled={!available || index === 0 || editableTrack.keyframes.length <= 2}
                  onClick={() =>
                    setDraft({
                      ...editableTrack,
                      keyframes: removeScenePostEffectParameterKeyframe(editableTrack.keyframes, index),
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
                editableTrack.keyframes.length >= 32 ||
                playhead > duration ||
                editableTrack.keyframes.some((keyframe) => Math.abs(keyframe.time - playhead) <= 0.0005)
              }
              onClick={() => {
                setDraft({
                  ...editableTrack,
                  keyframes: insertScenePostEffectParameterKeyframe(
                    editableTrack.keyframes,
                    playhead,
                    parameters[editableTrack.parameterIndex] ?? 0,
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
                  keyframes: editableTrack.keyframes,
                  name: selectedParameter.name,
                  parameterIndex: editableTrack.parameterIndex,
                  range: selectedParameter.range,
                })
              }
              type="button"
            >
              Update animation
            </button>
            <button
              className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-red-200 disabled:text-zinc-700"
              disabled={!available}
              onClick={() =>
                activeTrack
                  ? onChange({
                      assetRevision,
                      keyframes: [],
                      name: selectedParameter.name,
                      parameterIndex: editableTrack.parameterIndex,
                      range: selectedParameter.range,
                    })
                  : setDraft(null)
              }
              type="button"
            >
              {activeTrack ? "Remove animation" : "Cancel"}
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="block text-[10px] text-zinc-500">
            Parameter
            <select
              aria-label="Scene effect parameter to animate"
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300"
              disabled={!available || parameterTrack !== null}
              onChange={(event) => setParameterIndex(Number(event.currentTarget.value))}
              value={parameterIndex}
            >
              {parameterSchema.map((parameter, index) => (
                <option key={parameter.name} value={index}>
                  {parameter.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="h-7 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:text-zinc-700"
            disabled={!available || parameterTrack !== null || duration <= 0.0005}
            onClick={() => {
              const parameter = parameterSchema[parameterIndex];
              const baseValue = parameters[parameterIndex] ?? parameter?.default;
              if (!parameter || baseValue === undefined) return;
              const targetTime = Math.min(duration, Math.max(playhead, Math.min(duration, 1)));
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
            Animate from 0s to {Math.min(duration, Math.max(playhead, Math.min(duration, 1))).toFixed(2)}s
          </button>
        </>
      )}
    </fieldset>
  );
}
