import { useEffect, useState } from "react";

import {
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
  type StudioScenePostEffectParameterSchemaV1,
  type StudioScenePostEffectSourceAssetV1,
} from "./scene-post-effect-source";

export type CompileStudioScenePostEffectSourceInputV1 = Readonly<{
  expectedAcceptedGeneration: number | null;
  parameterSchema: StudioScenePostEffectParameterSchemaV1;
  source: string;
}>;

export type ScenePostEffectSourceEditorProps = Readonly<{
  active: boolean;
  asset: StudioScenePostEffectSourceAssetV1 | null;
  available: boolean;
  onActivate: () => void;
  onCompile: (input: CompileStudioScenePostEffectSourceInputV1) => Promise<void> | void;
  onCreate: () => void;
  onParametersChange: (parameters: readonly number[]) => void;
  onRemove: () => void;
  parameters: readonly number[] | null;
  sourceAvailable: boolean;
}>;

function sourceByteLength(source: string) {
  return new TextEncoder().encode(source).byteLength;
}

export function ScenePostEffectSourceEditor({
  active,
  asset,
  available,
  onActivate,
  onCompile,
  onCreate,
  onParametersChange,
  onRemove,
  parameters,
  sourceAvailable,
}: ScenePostEffectSourceEditorProps) {
  const [pending, setPending] = useState(false);
  const [source, setSource] = useState(() => asset?.draft.source ?? STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [parameterDraft, setParameterDraft] = useState<readonly number[]>(() => parameters ?? []);

  useEffect(() => {
    setSource(asset?.draft.source ?? STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1);
    setSubmitError(null);
  }, [asset?.draft.source]);

  useEffect(() => {
    setParameterDraft(parameters ?? asset?.accepted?.parameterSchema.map((parameter) => parameter.default) ?? []);
  }, [asset?.accepted?.parameterSchema, parameters]);

  if (!asset) {
    return (
      <section className="mt-3 border border-zinc-800 p-2" aria-label="Custom Scene post effect">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-[10px] font-medium text-sky-200">Wave Distortion</h4>
            <p className="mt-0.5 text-pretty text-[10px] leading-4 text-zinc-500">
              Start one project-local WGSL effect that displaces the composited Scene over time.
            </p>
          </div>
          <button
            className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
            disabled={!sourceAvailable}
            onClick={onCreate}
            type="button"
          >
            Create starter
          </button>
        </div>
      </section>
    );
  }

  const accepted = asset.accepted;
  const sourceBytes = sourceByteLength(source);
  const sourceInvalid = source.length === 0 || sourceBytes > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1;
  const parameterValuesMatch =
    !active ||
    (parameters !== null &&
      parameters.length === accepted?.parameterSchema.length &&
      parameters.every((value, index) => {
        const parameter = accepted?.parameterSchema[index];
        return (
          parameter !== undefined &&
          Number.isFinite(value) &&
          value >= parameter.range.min &&
          value <= parameter.range.max
        );
      }));
  const status = asset.draft.diagnostic
    ? "Rejected draft"
    : accepted
      ? active
        ? `Active · generation ${accepted.generation}`
        : `Ready · generation ${accepted.generation}`
      : "Not compiled";

  return (
    <section className="mt-3 border border-zinc-800 p-2" aria-label="Custom Scene post effect">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-[10px] font-medium text-zinc-300">Custom WGSL</h4>
          <p className="mt-0.5 font-mono text-[9px] text-zinc-600">{PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1}</p>
        </div>
        <span className={asset.draft.diagnostic ? "text-[10px] text-red-300" : "text-[10px] text-sky-300"}>
          {status}
        </span>
      </div>

      <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
        Fixed ABI: binding 0 is viewport, sample time, and 8 scalar slots; binding 1 is the current Scene texture. The
        fullscreen vertex stage is renderer-owned.
      </p>

      {asset.draft.diagnostic ? (
        <div className="mt-2 border border-red-950 bg-red-950/20 p-2" role="alert">
          <p className="text-[10px] font-medium text-red-300">WGSL was rejected</p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[9px] leading-4 text-red-200">
            {asset.draft.diagnostic}
          </pre>
          {accepted ? (
            <p className="mt-1 text-[10px] text-zinc-500">
              Last accepted generation {accepted.generation} remains active.
            </p>
          ) : (
            <p className="mt-1 text-[10px] text-zinc-500">Compile a valid source before applying this effect.</p>
          )}
        </div>
      ) : null}

      {accepted ? (
        <div className="mt-2 flex gap-2">
          <button
            className="h-7 flex-1 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700"
            disabled={!available || active || pending}
            onClick={onActivate}
            type="button"
          >
            {active ? "Applied to Scene" : "Apply to Scene"}
          </button>
        </div>
      ) : (
        <button
          className="mt-2 h-7 w-full border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
          disabled={!sourceAvailable || pending}
          onClick={onRemove}
          type="button"
        >
          Remove uncompiled asset
        </button>
      )}

      {accepted?.parameterSchema.length ? (
        <fieldset className="mt-3 space-y-2 border border-zinc-800 p-2" aria-label="Scene post-effect parameters">
          <legend className="px-1 text-[10px] font-medium text-zinc-400">Scene parameters</legend>
          {accepted.parameterSchema.map((parameter, index) => {
            const value = parameterDraft[index] ?? parameter.default;
            return (
              <label className="block" key={parameter.name}>
                <span className="flex justify-between gap-2 text-[10px] text-zinc-500">
                  <span>{parameter.name}</span>
                  <output>{value}</output>
                </span>
                <input
                  aria-label={`${parameter.name} Scene post-effect parameter`}
                  className="mt-1 w-full accent-sky-500"
                  disabled={!available || !active || !parameterValuesMatch || pending}
                  max={parameter.range.max}
                  min={parameter.range.min}
                  onChange={(event) => {
                    const next = [...parameterDraft];
                    next[index] = event.currentTarget.valueAsNumber;
                    setParameterDraft(next);
                  }}
                  step={parameter.range.step}
                  type="range"
                  value={value}
                />
              </label>
            );
          })}
          {!parameterValuesMatch ? (
            <p className="text-pretty text-[10px] leading-4 text-red-300" role="alert">
              The active Scene reference does not match the accepted parameter schema. Reapply the effect.
            </p>
          ) : null}
          <button
            className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
            disabled={!available || !active || !parameterValuesMatch || pending}
            onClick={() => onParametersChange(parameterDraft)}
            type="button"
          >
            Update parameters
          </button>
        </fieldset>
      ) : null}

      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (sourceInvalid || pending) return;
          setPending(true);
          setSubmitError(null);
          void Promise.resolve(
            onCompile({
              expectedAcceptedGeneration: accepted?.generation ?? null,
              parameterSchema: asset.draft.parameterSchema,
              source,
            }),
          )
            .catch((caught: unknown) => {
              setSubmitError(caught instanceof Error ? caught.message : "The Rust core rejected the WGSL source.");
            })
            .finally(() => setPending(false));
        }}
      >
        <label className="block text-[10px] font-medium text-zinc-500" htmlFor="scene-post-effect-wgsl-source">
          Scene post-effect WGSL source
        </label>
        <textarea
          aria-describedby="scene-post-effect-wgsl-byte-count"
          aria-invalid={sourceInvalid ? true : undefined}
          aria-label="Scene post-effect WGSL source"
          className="mt-1 h-44 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300 outline-none focus:border-sky-500"
          disabled={!sourceAvailable || pending}
          id="scene-post-effect-wgsl-source"
          onChange={(event) => setSource(event.currentTarget.value)}
          required
          spellCheck={false}
          value={source}
        />
        <p
          className={sourceInvalid ? "mt-1 text-[10px] text-red-300" : "mt-1 text-[10px] text-zinc-600"}
          id="scene-post-effect-wgsl-byte-count"
        >
          {sourceBytes.toLocaleString()} / {MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1.toLocaleString()} UTF-8 bytes
        </p>
        {submitError ? (
          <p className="mt-1 text-pretty text-[10px] leading-4 text-red-300" role="alert">
            {submitError}
          </p>
        ) : null}
        <div className="mt-2 flex gap-2">
          <button
            className="h-8 flex-1 border border-sky-800 bg-sky-950/50 text-xs text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700"
            disabled={!sourceAvailable || pending || sourceInvalid}
            type="submit"
          >
            {pending ? "Compiling…" : "Compile & accept WGSL"}
          </button>
          <button
            className="h-8 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:text-zinc-700"
            disabled={!sourceAvailable || pending}
            onClick={() => setSource(STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1)}
            type="button"
          >
            Reset source
          </button>
        </div>
      </form>
    </section>
  );
}
