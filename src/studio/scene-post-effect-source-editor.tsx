import { useEffect, useState } from "react";
import { MAX_SCENE_POST_EFFECTS_V1 } from "../engine/scene-post-effect-registry";
import type { ScenePostEffectParameterTrack } from "./scene-edit-contract";
import { ScenePostEffectParameterAnimationEditor } from "./scene-post-effect-parameter-animation-editor";
import type { ScenePostEffectParameterKeyframe } from "./scene-post-effect-parameter-keyframe-edit";

import {
  MAX_PROJECT_SCENE_POST_EFFECT_ASSETS,
  MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
  STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1,
  type StudioScenePostEffectParameterSchemaV1,
  type StudioScenePostEffectSourceAssetV1,
  type StudioScenePostEffectSourceLanguageV1,
  type StudioScenePostEffectTextureV1,
} from "./scene-post-effect-source";
import type { StudioNativeImageAssetV1 } from "./studio-image-assets";

export type CompileStudioScenePostEffectSourceInputV1 = Readonly<{
  assetRevision: number;
  expectedAcceptedGeneration: number | null;
  parameterSchema: StudioScenePostEffectParameterSchemaV1;
  source: string;
  sourceLanguage: StudioScenePostEffectSourceLanguageV1;
  textureSlot?: "texture2d";
}>;

export type ScenePostEffectSourceEditorProps = Readonly<{
  activeRevisions: readonly number[];
  assets: readonly StudioScenePostEffectSourceAssetV1[];
  available: boolean;
  duration: number;
  imageAssets: readonly StudioNativeImageAssetV1[];
  onAddToStack: (assetRevision: number, texture?: StudioScenePostEffectTextureV1) => void;
  onCompile: (input: CompileStudioScenePostEffectSourceInputV1) => Promise<void> | void;
  onCreate: (name: string) => boolean;
  onParametersChange: (assetRevision: number, parameters: readonly number[]) => void;
  onParameterTrackChange: (input: {
    assetRevision: number;
    keyframes: readonly ScenePostEffectParameterKeyframe[];
    name: string;
    parameterIndex: number;
    range: Readonly<{ max: number; min: number }>;
  }) => void;
  onRemove: (assetRevision: number) => void;
  onSelect: (assetRevision: number) => void;
  onTextureChange: (assetRevision: number, texture: StudioScenePostEffectTextureV1) => void;
  parameterAnimationAvailable: boolean;
  parameters: readonly number[] | null;
  parameterTracks: readonly ScenePostEffectParameterTrack[];
  playhead: number;
  selectedRevision: number | null;
  sourceAvailable: boolean;
  texture: StudioScenePostEffectTextureV1 | null;
}>;

function sourceByteLength(source: string) {
  return new TextEncoder().encode(source).byteLength;
}

type StudioScenePostEffectGlslFileV1 = Pick<File, "arrayBuffer" | "name" | "size">;

export async function readStudioScenePostEffectGlslFileV1(file: StudioScenePostEffectGlslFileV1) {
  if (!/\.(?:frag|glsl)$/iu.test(file.name)) throw new Error("Choose a .frag or .glsl file.");
  if (file.size > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1) {
    throw new Error(`GLSL accepts at most ${MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes.`);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1) {
    throw new Error(`GLSL accepts at most ${MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes.`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The GLSL file must be readable UTF-8 text.");
  }
  if (source.length === 0) throw new Error("The GLSL file must not be empty.");
  return source;
}

export function ScenePostEffectSourceEditor({
  activeRevisions,
  assets,
  available,
  duration,
  imageAssets,
  onAddToStack,
  onCompile,
  onCreate,
  onParametersChange,
  onParameterTrackChange,
  onRemove,
  onSelect,
  onTextureChange,
  parameterAnimationAvailable,
  parameters,
  parameterTracks,
  playhead,
  selectedRevision,
  sourceAvailable,
  texture,
}: ScenePostEffectSourceEditorProps) {
  const [newAssetName, setNewAssetName] = useState("Wave Distortion");
  const [pending, setPending] = useState(false);
  const [filePending, setFilePending] = useState(false);
  const asset =
    assets.find(({ revision }) => revision === selectedRevision) ??
    assets.find(({ revision }) => activeRevisions.includes(revision)) ??
    assets[0] ??
    null;
  const active = asset !== null && activeRevisions.includes(asset.revision);
  const [source, setSource] = useState(() => asset?.draft.source ?? STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1);
  const [sourceLanguage, setSourceLanguage] = useState<StudioScenePostEffectSourceLanguageV1>(
    () => asset?.draft.sourceLanguage ?? "wgsl",
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [parameterDraft, setParameterDraft] = useState<readonly number[]>(() => parameters ?? []);
  const [textureSlot, setTextureSlot] = useState(() => asset?.draft.textureSlot === "texture2d");
  const [textureDraft, setTextureDraft] = useState<StudioScenePostEffectTextureV1 | null>(() => texture);

  useEffect(() => {
    setSource(asset?.draft.source ?? STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1);
    setSourceLanguage(asset?.draft.sourceLanguage ?? "wgsl");
    setTextureSlot(asset?.draft.textureSlot === "texture2d");
    setSubmitError(null);
  }, [asset?.draft.source, asset?.draft.sourceLanguage, asset?.draft.textureSlot, asset?.revision]);

  useEffect(() => {
    setParameterDraft(
      (active ? parameters : null) ?? asset?.accepted?.parameterSchema.map((parameter) => parameter.default) ?? [],
    );
  }, [active, asset?.accepted?.parameterSchema, parameters]);

  useEffect(() => {
    setTextureDraft(
      (active ? texture : null) ??
        (imageAssets[0]
          ? {
              asset: imageAssets[0].image.asset,
              sampler: imageAssets[0].image.sampler,
            }
          : null),
    );
  }, [active, imageAssets, texture]);

  const accepted = asset?.accepted ?? null;
  const sourceBusy = pending || filePending;
  const activeParameterTracks = asset
    ? parameterTracks.filter(
        (track) => track.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1 && track.revision === asset.revision,
      )
    : [];
  const animatedParameterIndices = new Set(activeParameterTracks.map((track) => track.parameterIndex));
  const acceptedUsesTexture = accepted?.textureSlot === "texture2d";
  const declaredTextureSlot = accepted ? acceptedUsesTexture : textureSlot;
  const sourceLanguageLabel = sourceLanguage === "glsl" ? "GLSL" : "WGSL";
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
  const status = asset
    ? asset.draft.diagnostic
      ? "Rejected draft"
      : accepted
        ? active
          ? `Active · generation ${accepted.generation}`
          : `Ready · generation ${accepted.generation}`
        : "Not compiled"
    : null;

  return (
    <section className="mt-3 border border-zinc-800 p-2" aria-label="Custom Scene post effect">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-[10px] font-medium text-sky-200">Effect library</h4>
          <p className="mt-0.5 text-[10px] text-zinc-600">
            {assets.length} / {MAX_PROJECT_SCENE_POST_EFFECT_ASSETS} project effects
          </p>
        </div>
      </div>
      <form
        className="mt-2 flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newAssetName.trim();
          if (!name) return;
          if (onCreate(name)) setNewAssetName(`Wave Distortion ${assets.length + 2}`);
        }}
      >
        <input
          aria-label="New Scene effect name"
          className="h-7 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-1.5 text-[10px] text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
          disabled={!sourceAvailable || sourceBusy || assets.length >= MAX_PROJECT_SCENE_POST_EFFECT_ASSETS}
          maxLength={80}
          onChange={(event) => setNewAssetName(event.currentTarget.value)}
          value={newAssetName}
        />
        <button
          className="shrink-0 border border-sky-800 bg-sky-950/50 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-700"
          disabled={
            !sourceAvailable ||
            sourceBusy ||
            assets.length >= MAX_PROJECT_SCENE_POST_EFFECT_ASSETS ||
            newAssetName.trim().length === 0
          }
          type="submit"
        >
          {assets.length === 0 ? "Create starter" : "Add effect"}
        </button>
      </form>
      {assets.length > 0 ? (
        <div aria-label="Project Scene effect assets" className="mt-2 grid gap-1">
          {assets.map((candidate) => {
            const selected = candidate.revision === asset?.revision;
            const candidateActive = activeRevisions.includes(candidate.revision);
            return (
              <button
                aria-label={`Edit Scene effect ${candidate.name}, revision ${candidate.revision}`}
                aria-pressed={selected}
                className={
                  selected
                    ? "flex min-w-0 items-center justify-between gap-2 border border-sky-800 bg-sky-950/40 px-2 py-1 text-left text-[10px] text-sky-200"
                    : "flex min-w-0 items-center justify-between gap-2 border border-zinc-800 px-2 py-1 text-left text-[10px] text-zinc-400 hover:bg-zinc-900"
                }
                data-scene-post-effect-asset-revision={candidate.revision}
                disabled={sourceBusy}
                key={candidate.revision}
                onClick={() => onSelect(candidate.revision)}
                type="button"
              >
                <span className="truncate">{candidate.name}</span>
                <span className={candidateActive ? "shrink-0 text-sky-300" : "shrink-0 text-zinc-600"}>
                  {candidateActive
                    ? `In stack · #${candidate.revision}`
                    : candidate.accepted
                      ? `Ready · #${candidate.revision}`
                      : `Draft · #${candidate.revision}`}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-500">
          Create a WGSL starter, then paste or import Vulkan GLSL 450 when needed.
        </p>
      )}

      {asset ? (
        <>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-zinc-800 pt-2">
            <div>
              <h4 className="text-[10px] font-medium text-zinc-300">
                {asset.name} · {sourceLanguageLabel}
              </h4>
              <p className="mt-0.5 font-mono text-[9px] text-zinc-600">
                {PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1}@{asset.revision}
              </p>
            </div>
            <span className={asset.draft.diagnostic ? "text-[10px] text-red-300" : "text-[10px] text-sky-300"}>
              {status}
            </span>
          </div>

          {sourceLanguage === "glsl" ? (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
              Vulkan GLSL 450 fragment profile: entry point main; set 0 binding 0 is the host uniform, binding 1 is the
              current Scene texture, and binding 2 is the fixed linear clamp sampler. A declared project image uses
              binding 3 with its sampler at binding 4. The fullscreen vertex stage is renderer-owned.
            </p>
          ) : (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
              Fixed ABI: binding 0 is viewport, sample time, and 8 scalar slots; binding 1 is the current Scene texture;
              binding 2 is the fixed linear clamp sampler. A declared project image uses binding 3 with its sampler at
              binding 4. The fullscreen vertex stage is renderer-owned.
            </p>
          )}

          <label
            className="mt-2 block text-[10px] font-medium text-zinc-500"
            htmlFor="scene-post-effect-source-language"
          >
            Source language
          </label>
          <select
            aria-label="Scene post-effect source language"
            className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
            disabled={!sourceAvailable || sourceBusy}
            id="scene-post-effect-source-language"
            onChange={(event) => {
              setSourceLanguage(event.currentTarget.value as StudioScenePostEffectSourceLanguageV1);
              setSubmitError(null);
            }}
            value={sourceLanguage}
          >
            <option value="wgsl">WGSL</option>
            <option value="glsl">Vulkan GLSL 450</option>
          </select>

          <label className="mt-2 flex items-start gap-2 text-[10px] text-zinc-400">
            <input
              aria-label="Declare auxiliary Scene effect texture"
              checked={declaredTextureSlot}
              className="mt-0.5 accent-sky-500"
              disabled={!sourceAvailable || sourceBusy || accepted !== null}
              onChange={(event) => {
                setTextureSlot(event.currentTarget.checked);
                setSubmitError(null);
              }}
              type="checkbox"
            />
            <span>
              Use one project PNG at binding 3 and its linear or nearest sampler at binding 4.
              {accepted ? " Create a new effect to change this accepted binding contract." : ""}
            </span>
          </label>

          {sourceLanguage === "glsl" ? (
            <>
              <label className="mt-2 block text-[10px] font-medium text-zinc-500" htmlFor="scene-post-effect-glsl-file">
                Local .frag/.glsl file
              </label>
              <input
                accept=".frag,.glsl"
                className="mt-1 block w-full text-[10px] text-zinc-500 file:mr-2 file:border file:border-zinc-700 file:bg-zinc-950 file:px-2 file:py-1 file:text-zinc-300 hover:file:bg-zinc-800 disabled:opacity-50"
                disabled={!sourceAvailable || sourceBusy}
                id="scene-post-effect-glsl-file"
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  input.value = "";
                  if (!file) return;
                  setFilePending(true);
                  setSubmitError(null);
                  void readStudioScenePostEffectGlslFileV1(file)
                    .then((loaded) => setSource(loaded))
                    .catch((caught: unknown) => {
                      setSubmitError(caught instanceof Error ? caught.message : "The GLSL file could not be read.");
                    })
                    .finally(() => setFilePending(false));
                }}
                type="file"
              />
            </>
          ) : null}

          {asset.draft.diagnostic ? (
            <div className="mt-2 border border-red-950 bg-red-950/20 p-2" role="alert">
              <p className="text-[10px] font-medium text-red-300">{sourceLanguageLabel} was rejected</p>
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

          {acceptedUsesTexture ? (
            <fieldset className="mt-3 space-y-2 border border-zinc-800 p-2" aria-label="Auxiliary Scene effect texture">
              <legend className="px-1 text-[10px] font-medium text-zinc-400">Project image texture</legend>
              {imageAssets.length === 0 ? (
                <p className="text-pretty text-[10px] leading-4 text-amber-300">
                  Import a PNG into this project before adding the effect to the Scene stack.
                </p>
              ) : (
                <>
                  <label className="block text-[10px] text-zinc-500">
                    Image
                    <select
                      aria-label="Auxiliary Scene effect image"
                      className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
                      disabled={!available || sourceBusy}
                      onChange={(event) => {
                        const selected = imageAssets.find(
                          ({ image }) => image.asset.assetId === event.currentTarget.value,
                        );
                        if (active && !selected) return;
                        setTextureDraft(
                          selected
                            ? {
                                asset: selected.image.asset,
                                sampler: textureDraft?.sampler ?? selected.image.sampler,
                              }
                            : null,
                        );
                      }}
                      value={textureDraft?.asset.assetId ?? ""}
                    >
                      {active ? null : <option value="">Choose a project PNG</option>}
                      {imageAssets.map((image) => (
                        <option
                          key={`${image.image.asset.assetId}/${image.image.asset.sha256}`}
                          value={image.image.asset.assetId}
                        >
                          {image.label} · {image.pixelWidth}×{image.pixelHeight}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[10px] text-zinc-500">
                    Sampler
                    <select
                      aria-label="Auxiliary Scene effect sampler"
                      className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:text-zinc-700"
                      disabled={!available || sourceBusy || textureDraft === null}
                      onChange={(event) => {
                        if (!textureDraft) return;
                        setTextureDraft({
                          ...textureDraft,
                          sampler: event.currentTarget.value as "linear" | "nearest",
                        });
                      }}
                      value={textureDraft?.sampler ?? "linear"}
                    >
                      <option value="linear">Linear</option>
                      <option value="nearest">Nearest</option>
                    </select>
                  </label>
                  {active ? (
                    <button
                      className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
                      disabled={!available || sourceBusy || textureDraft === null}
                      onClick={() => {
                        if (textureDraft) onTextureChange(asset.revision, textureDraft);
                      }}
                      type="button"
                    >
                      Update auxiliary texture
                    </button>
                  ) : null}
                </>
              )}
            </fieldset>
          ) : null}

          {accepted ? (
            <div className="mt-2 flex gap-2">
              <button
                className="h-7 flex-1 border border-sky-800 px-2 text-[10px] text-sky-200 hover:bg-sky-950/50 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700"
                disabled={
                  !available ||
                  active ||
                  sourceBusy ||
                  activeRevisions.length >= MAX_SCENE_POST_EFFECTS_V1 ||
                  (acceptedUsesTexture && textureDraft === null)
                }
                onClick={() =>
                  onAddToStack(asset.revision, acceptedUsesTexture ? (textureDraft ?? undefined) : undefined)
                }
                type="button"
              >
                {active
                  ? "In Scene stack"
                  : activeRevisions.length >= MAX_SCENE_POST_EFFECTS_V1
                    ? "Stack is full"
                    : "Add to stack"}
              </button>
            </div>
          ) : (
            <button
              className="mt-2 h-7 w-full border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
              disabled={!sourceAvailable || sourceBusy}
              onClick={() => onRemove(asset.revision)}
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
                      disabled={
                        !available ||
                        !active ||
                        !parameterValuesMatch ||
                        sourceBusy ||
                        animatedParameterIndices.has(index)
                      }
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
              {activeParameterTracks.length > 0 ? (
                <p className="text-pretty text-[10px] leading-4 text-sky-300">
                  Animated parameters keep their static baseline locked. You can still update the other parameters.
                </p>
              ) : null}
              <button
                className="h-7 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-700"
                disabled={
                  !available ||
                  !active ||
                  !parameterValuesMatch ||
                  sourceBusy ||
                  accepted.parameterSchema.every((_, index) => animatedParameterIndices.has(index))
                }
                onClick={() => onParametersChange(asset.revision, parameterDraft)}
                type="button"
              >
                Update parameters
              </button>
            </fieldset>
          ) : null}

          {accepted?.parameterSchema.length && active && parameters ? (
            <ScenePostEffectParameterAnimationEditor
              assetRevision={asset.revision}
              available={available && parameterAnimationAvailable && !sourceBusy}
              duration={duration}
              key={asset.revision}
              onChange={onParameterTrackChange}
              parameterSchema={accepted.parameterSchema}
              parameters={parameters}
              parameterTracks={parameterTracks}
              playhead={playhead}
            />
          ) : null}

          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (sourceInvalid || sourceBusy) return;
              setPending(true);
              setSubmitError(null);
              void Promise.resolve(
                onCompile({
                  assetRevision: asset.revision,
                  expectedAcceptedGeneration: accepted?.generation ?? null,
                  parameterSchema: asset.draft.parameterSchema,
                  source,
                  sourceLanguage,
                  ...(declaredTextureSlot ? { textureSlot: "texture2d" as const } : {}),
                }),
              )
                .catch((caught: unknown) => {
                  setSubmitError(
                    caught instanceof Error
                      ? caught.message
                      : `The Rust core rejected the ${sourceLanguageLabel} source.`,
                  );
                })
                .finally(() => setPending(false));
            }}
          >
            <label className="block text-[10px] font-medium text-zinc-500" htmlFor="scene-post-effect-source">
              Scene post-effect {sourceLanguageLabel} source
            </label>
            <textarea
              aria-describedby="scene-post-effect-wgsl-byte-count"
              aria-invalid={sourceInvalid ? true : undefined}
              aria-label={`Scene post-effect ${sourceLanguageLabel} source`}
              className="mt-1 h-44 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300 outline-none focus:border-sky-500"
              disabled={!sourceAvailable || sourceBusy}
              id="scene-post-effect-source"
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
                disabled={!sourceAvailable || sourceBusy || sourceInvalid}
                type="submit"
              >
                {pending ? "Compiling…" : `Compile & accept ${sourceLanguageLabel}`}
              </button>
              <button
                className="h-8 border border-zinc-700 px-2 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:text-zinc-700"
                disabled={!sourceAvailable || sourceBusy}
                onClick={() => setSource(sourceLanguage === "wgsl" ? STUDIO_WAVE_DISTORTION_POST_EFFECT_SOURCE_V1 : "")}
                type="button"
              >
                {sourceLanguage === "wgsl" ? "Reset source" : "Clear source"}
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
