import { type DragEvent, useEffect, useRef, useState } from "react";
import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
import {
  MAX_SCENE_POST_EFFECTS_V1,
  PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1,
} from "../engine/scene-post-effect-registry";
import { cn } from "../lib/cn";
import type {
  ManimSourceImportOutcome,
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  RenderSessionView,
} from "../render-pipeline/contracts";
import { RenderPipelinePanel } from "../render-pipeline/render-pipeline-panel";
import type { RenderProgramCandidate, RenderSourceRefreshTarget } from "../render-pipeline/render-pipeline-policy";
import { type StudioCommandId, shortcutLabel, studioCommand } from "./commands";
import { DataPlotEditor, type DataPlotInspectorAuthoring, dataPlotEditorAuthorityKey } from "./data-plot-editor";
import { DraftInspector } from "./draft-inspector";
import {
  type CameraInspectorAuthoring,
  CameraInspectorEditor,
  type ContentTransformInspectorAuthoring,
  EntityInspectorEditor,
  entityInspectorKey,
  type ShapeTransformInspectorAuthoring,
} from "./entity-inspector";
import type {
  StudioFragmentMaterialParameterSchemaV1,
  StudioFragmentMaterialParameterValueV1,
  StudioFragmentMaterialPresetId,
  StudioFragmentMaterialRemovalResolution,
} from "./fragment-material-authoring";
import { FragmentMaterialEditor, type FragmentMaterialEditorItem } from "./fragment-material-editor";
import type { InspectorEditField, ValidatedInspectorEdits } from "./inspector-edit";
import type { StudioLayerEntry, StudioLayerOrderDirection } from "./layer-order";
import type { ProgramRecord, ProjectedEntity, StrokeDash, StrokeJoin } from "./model";
import { NATIVE_PROJECT_IMAGE_FILE_ACCEPT_V1 } from "./native-project-assets";
import {
  type ProjectAudioMixSettings,
  type ProjectAudioTimingSeconds,
  type ProjectAudioTrack,
  projectAudioMixSettings,
  projectAudioTimingSeconds,
} from "./project-audio-track";
import {
  type StudioScenePostEffectV1,
  studioEntityTypeSupportsStrokeCap,
  studioEntityTypeSupportsStrokeWidth,
} from "./scene-edit-contract";
import { DEFAULT_RGB_SPLIT_POST_EFFECT_V1 } from "./scene-post-effect-authoring";
import { ScenePostEffectSourceEditor, type ScenePostEffectSourceEditorProps } from "./scene-post-effect-source-editor";
import {
  STUDIO_IMAGE_ASSET_DRAG_TYPE,
  type StudioNativeImageAssetV1,
  studioImageAssetDragPayload,
  studioImageAssetsMatchingQuery,
} from "./studio-image-assets";
import type { AuthorableWorkspaceScene } from "./studio-native-workspace";
import { type StudioSvgPathAsset, studioSvgPathAssetsMatchingQuery } from "./studio-svg-assets";
import { entityLabel } from "./studio-viewport";

const SIDEBAR_SHORTCUTS: readonly StudioCommandId[] = [
  "select-tool",
  "insert-text",
  "insert-mathtex",
  "insert-rectangle",
  "insert-circle",
  "insert-ellipse",
  "insert-arc",
  "insert-sector",
  "insert-number-line",
  "insert-axes",
  "insert-number-plane",
  "insert-triangle",
  "insert-regular-polygon",
  "insert-line",
  "insert-arrow",
  "align-left",
  "align-horizontal-center",
  "align-right",
  "align-top",
  "align-vertical-middle",
  "align-bottom",
  "distribute-horizontal",
  "distribute-vertical",
  "undo",
  "redo",
  "group",
  "ungroup",
  "duplicate",
  "delete",
  "copy",
  "paste",
  "select-all",
  "play-pause",
];

function NativeImageThumbnail({ asset }: Readonly<{ asset: StudioNativeImageAssetV1 }>) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([asset.bytes], { type: "image/png" }));
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [asset.bytes]);
  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden border border-zinc-800 bg-zinc-900">
      <img alt={asset.label} className="size-full object-contain" draggable={false} src={source ?? undefined} />
    </div>
  );
}

const RGB_SPLIT_PARAMETER_CONTROLS = [
  { label: "Base offset", max: 32, min: 0, step: 0.5, unit: "px" },
  { label: "Amplitude", max: 32, min: 0, step: 0.5, unit: "px" },
  { label: "Speed", max: 5, min: 0, step: 0.1, unit: "Hz" },
  { label: "Phase", max: Math.PI * 2, min: -Math.PI * 2, step: 0.1, unit: "rad" },
] as const;

function ScenePostEffectControls({
  available,
  effectNames,
  effects,
  onChange,
  unavailableReason,
}: Readonly<{
  available: boolean;
  effectNames: Readonly<Record<number, string>>;
  effects: readonly StudioScenePostEffectV1[];
  onChange?: (effects: readonly StudioScenePostEffectV1[]) => void;
  unavailableReason: string | null;
}>) {
  const rgbSplitIndex = effects.findIndex(
    (effect) =>
      effect.shaderId === DEFAULT_RGB_SPLIT_POST_EFFECT_V1.shaderId &&
      effect.revision === DEFAULT_RGB_SPLIT_POST_EFFECT_V1.revision &&
      effect.parameters.length === DEFAULT_RGB_SPLIT_POST_EFFECT_V1.parameters.length,
  );
  const rgbSplitEffect = rgbSplitIndex < 0 ? null : (effects[rgbSplitIndex] ?? null);
  const [parameters, setParameters] = useState<[number, number, number, number]>([
    ...(rgbSplitEffect?.parameters ?? DEFAULT_RGB_SPLIT_POST_EFFECT_V1.parameters),
  ] as [number, number, number, number]);
  useEffect(() => {
    setParameters([...(rgbSplitEffect?.parameters ?? DEFAULT_RGB_SPLIT_POST_EFFECT_V1.parameters)] as [
      number,
      number,
      number,
      number,
    ]);
  }, [rgbSplitEffect]);
  const disabled = !available || !onChange;
  const effectLabel = (effect: StudioScenePostEffectV1) =>
    effect.shaderId === DEFAULT_RGB_SPLIT_POST_EFFECT_V1.shaderId
      ? "RGB split"
      : effect.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1
        ? (effectNames[effect.revision] ?? `Custom #${effect.revision}`)
        : `${effect.shaderId}@${effect.revision}`;
  const replaceAt = (index: number, effect: StudioScenePostEffectV1) =>
    effects.map((candidate, candidateIndex) => (candidateIndex === index ? effect : candidate));
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= effects.length) return;
    const next = [...effects];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange?.(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-zinc-500">Ordered passes</p>
        <span className="tabular-nums text-[10px] text-zinc-600">
          {effects.length} / {MAX_SCENE_POST_EFFECTS_V1}
        </span>
      </div>
      {effects.some((effect) => effect.shaderId === PROJECT_SCENE_POST_EFFECT_SHADER_ID_V1) ? (
        <p className="text-[10px] text-sky-400">Custom Scene effect active</p>
      ) : null}
      {effects.length === 0 ? <p className="text-[10px] text-zinc-600">No Scene effects.</p> : null}
      <ol aria-label="Scene effect stack" className="space-y-1">
        {effects.map((effect, index) => (
          <li
            className="flex items-center gap-1 border border-zinc-800 px-1.5 py-1"
            key={`${effect.shaderId}/${effect.revision}`}
          >
            <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300">
              {index + 1}. {effectLabel(effect)}
            </span>
            <button
              aria-label={`Move ${effectLabel(effect)} effect up`}
              className="size-6 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              title={unavailableReason ?? undefined}
              type="button"
            >
              ↑
            </button>
            <button
              aria-label={`Move ${effectLabel(effect)} effect down`}
              className="size-6 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
              disabled={disabled || index === effects.length - 1}
              onClick={() => move(index, 1)}
              title={unavailableReason ?? undefined}
              type="button"
            >
              ↓
            </button>
            <button
              aria-label={`Remove ${effectLabel(effect)} effect from stack`}
              className="h-6 px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
              disabled={disabled}
              onClick={() => onChange?.(effects.filter((_, candidateIndex) => candidateIndex !== index))}
              title={unavailableReason ?? undefined}
              type="button"
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      {rgbSplitEffect ? (
        <form
          className="space-y-2 border border-zinc-800 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            onChange?.(replaceAt(rgbSplitIndex, { ...rgbSplitEffect, parameters }));
          }}
        >
          <p className="text-[10px] text-sky-400">RGB split parameters</p>
          {RGB_SPLIT_PARAMETER_CONTROLS.map((control, index) => (
            <label className="block" key={control.label}>
              <span className="flex justify-between gap-2 text-[10px] text-zinc-500">
                <span>{control.label}</span>
                <span className="tabular-nums">
                  {parameters[index].toFixed(1)} {control.unit}
                </span>
              </span>
              <input
                aria-label={`RGB split ${control.label}`}
                className="mt-1 block w-full accent-sky-500 disabled:opacity-50"
                disabled={disabled}
                max={control.max}
                min={control.min}
                onChange={(event) => {
                  const next = [...parameters] as [number, number, number, number];
                  next[index] = event.currentTarget.valueAsNumber;
                  setParameters(next);
                }}
                step={control.step}
                type="range"
                value={parameters[index]}
              />
            </label>
          ))}
          <button
            className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
            disabled={disabled}
            title={unavailableReason ?? undefined}
            type="submit"
          >
            Update RGB split
          </button>
        </form>
      ) : (
        <button
          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          disabled={disabled || effects.length >= MAX_SCENE_POST_EFFECTS_V1}
          onClick={() => onChange?.([...effects, DEFAULT_RGB_SPLIT_POST_EFFECT_V1])}
          title={unavailableReason ?? undefined}
          type="button"
        >
          Add RGB split
        </button>
      )}
    </div>
  );
}

function dimensionSummary(entity: ProjectedEntity) {
  if (entity.geometry.dimensions.kind === "unknown") return "Runtime-dependent";
  const { angles, coordinateSystem, height, radius, sides, width } = entity.geometry.dimensions.value;
  const values = [
    radius === undefined ? null : `r ${radius}`,
    angles === undefined ? null : `start ${Math.round((angles.start * 180) / Math.PI)}°`,
    angles === undefined ? null : `sweep ${Math.round((angles.sweep * 180) / Math.PI)}°`,
    coordinateSystem === undefined
      ? null
      : `x ${coordinateSystem.x.minimum}…${coordinateSystem.x.maximum} / ${coordinateSystem.x.step}`,
    coordinateSystem?.y === undefined
      ? null
      : `y ${coordinateSystem.y.minimum}…${coordinateSystem.y.maximum} / ${coordinateSystem.y.step}`,
    sides === undefined ? null : `${sides} sides`,
    width === undefined ? null : `w ${width}`,
    height === undefined ? null : `h ${height}`,
  ].filter((value): value is string => value !== null);
  return values.join(" · ") || "Manim defaults";
}

function styleSummary(entity: ProjectedEntity) {
  if (entity.geometry.style.kind === "unknown") return "Runtime-dependent";
  const { color, fillColor, strokeColor } = entity.geometry.style.value;
  return [color, fillColor, strokeColor].filter(Boolean).join(" · ") || "Manim defaults";
}

function colorInputValue(value: string | null) {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#ffffff";
}

const IMPORT_OUTCOME_LABELS: Readonly<Record<ManimSourceImportOutcome["kind"], string>> = {
  "runtime-only": "Runtime",
  "source-preserved": "Read-only",
  unsupported: "Unsupported",
};

const IMPORT_OUTCOME_DETAILS: Readonly<Record<ManimSourceImportOutcome["reason"], string>> = {
  "ambiguous-binding": "This source name has more than one binding.",
  "constructor-not-supported": "Studio preserves this constructor but cannot edit or preview it yet.",
  "dynamic-control-flow": "This binding depends on Python control flow at runtime.",
  "runtime-constructor": "This constructor is resolved from another local binding at runtime.",
  "source-analysis-unavailable": "Studio could not classify this Scene with the static source analyzer.",
  "unsupported-binding-form": "This source binding cannot be edited safely.",
};

function directPositionDraft(record: ProgramRecord, entity: ProjectedEntity | null) {
  const operation = record.program.operations[0];
  if (
    !entity ||
    record.program.provenance.origin !== "direct-manipulation" ||
    record.program.operations.length !== 1 ||
    operation?.kind !== "SetProperty" ||
    operation.key !== "position" ||
    operation.entityId !== entity.id ||
    typeof operation.value !== "object" ||
    operation.value === null ||
    !("x" in operation.value) ||
    !("y" in operation.value) ||
    typeof operation.value.x !== "number" ||
    typeof operation.value.y !== "number"
  ) {
    return null;
  }
  return operation.value;
}

function DraftPositionRefinement({
  entity,
  onSubmit,
  position,
}: Readonly<{
  entity: ProjectedEntity;
  onSubmit: (position: Readonly<{ x: number; y: number }>) => void;
  position: Readonly<{ x: number; y: number }>;
}>) {
  return (
    <form
      aria-label={`Refine draft position of ${entityLabel(entity)}`}
      className="mt-3 border border-zinc-800 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const x = Number(data.get("x"));
        const y = Number(data.get("y"));
        if (Number.isFinite(x) && Number.isFinite(y)) onSubmit({ x, y });
      }}
    >
      <p className="text-xs font-medium text-zinc-300">Refine position</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {(["x", "y"] as const).map((axis) => (
          <label className="text-[10px] uppercase text-zinc-500" key={axis}>
            {axis}
            <input
              aria-label={`${axis.toUpperCase()} draft position of ${entityLabel(entity)}`}
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
              defaultValue={position[axis]}
              name={axis}
              required
              step="any"
              type="number"
            />
          </label>
        ))}
      </div>
      <button className="mt-2 h-8 w-full border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800" type="submit">
        Update draft position
      </button>
    </form>
  );
}

export function WorkspaceSidebar({
  activeScene,
  audioImportError = null,
  audioImportPending = false,
  audioTrack = null,
  appliedProgramReadOnlyReasons,
  appliedEdits,
  appliedTransactionIds,
  authoringAvailable = true,
  className,
  draftActive,
  duration,
  durationBlocker = null,
  editingAppliedTransactionId,
  durationError,
  durationMinimum,
  entities,
  groupLifetimeTrimUnavailableReason = null,
  groupUnavailableReason = "Select at least two contiguous Studio-created objects.",
  imageAssets = [],
  imageAssetDragAvailable = false,
  imageImportError = null,
  imageImportPending = false,
  svgAssets = [],
  svgImportError = null,
  svgImportPending = false,
  layers,
  lockToggleDisabled = false,
  lockedEntityIds = new Set(),
  nextScene,
  onGroup,
  onImportAudioFile,
  onAudioMixChange,
  onAudioTimingChange,
  onImportImageFiles,
  onImportSvgFiles,
  onRemoveAudioTrack,
  onDurationChange,
  onSceneBackgroundChange,
  onScenePostEffectsChange,
  onAddImageAsset,
  onAddSvgAsset,
  onEditAppliedProgram,
  onLayerGroupOrder,
  onLayerGroupReorder,
  onLayerOrder,
  onLayerReorder,
  onTrimLayerGroupLifetime,
  onToggleLayerGroup,
  onToggleLayerGroupLock,
  onToggleLayerGroupVisibility,
  onToggleEntityLock,
  onToggleEntityVisibility,
  onUngroup,
  onRedo,
  onToggleEntity,
  onUndo,
  redoCount,
  sceneBackgroundAvailable = false,
  sceneBackgroundColor = "#000000",
  sceneBackgroundUnavailableReason = null,
  scenePostEffectNames = {},
  scenePostEffects = [],
  scenePostEffectAvailable = false,
  scenePostEffectSourceEditor,
  scenePostEffectUnavailableReason = null,
  selectedIds,
  selectedGroupId = null,
  sourceImportOutcomes,
  undoAvailable = appliedEdits.length > 0,
}: Readonly<{
  activeScene: AuthorableWorkspaceScene;
  audioImportError?: string | null;
  audioImportPending?: boolean;
  audioTrack?: ProjectAudioTrack | null;
  appliedProgramReadOnlyReasons: Readonly<Record<string, string | null>>;
  appliedEdits: readonly ProgramRecord[];
  appliedTransactionIds: ReadonlySet<string>;
  authoringAvailable?: boolean;
  className?: string;
  draftActive: boolean;
  duration: number;
  durationBlocker?: string | null;
  editingAppliedTransactionId: string | null;
  durationError: string | null;
  durationMinimum: number;
  entities: readonly ProjectedEntity[];
  groupLifetimeTrimUnavailableReason?: string | null;
  groupUnavailableReason?: string | null;
  imageAssets?: readonly StudioNativeImageAssetV1[];
  imageAssetDragAvailable?: boolean;
  imageImportError?: string | null;
  imageImportPending?: boolean;
  svgAssets?: readonly StudioSvgPathAsset[];
  svgImportError?: string | null;
  svgImportPending?: boolean;
  layers?: readonly StudioLayerEntry[];
  lockToggleDisabled?: boolean;
  lockedEntityIds?: ReadonlySet<string>;
  nextScene: AuthorableWorkspaceScene | null;
  onGroup?: () => void;
  onAudioMixChange?: (mix: ProjectAudioMixSettings) => void;
  onAudioTimingChange?: (timing: ProjectAudioTimingSeconds) => void;
  onImportAudioFile?: (file: File) => void;
  onImportImageFiles?: (files: readonly File[]) => void;
  onImportSvgFiles?: (files: readonly File[]) => void;
  onRemoveAudioTrack?: () => void;
  onDurationChange: (duration: number) => void;
  onSceneBackgroundChange?: (color: string) => void;
  onScenePostEffectsChange?: (effects: readonly StudioScenePostEffectV1[]) => void;
  onAddImageAsset?: (asset: StudioNativeImageAssetV1) => void;
  onAddSvgAsset?: (asset: StudioSvgPathAsset) => void;
  onEditAppliedProgram: (record: ProgramRecord, index: number) => void;
  onLayerGroupOrder?: (groupId: string, direction: StudioLayerOrderDirection) => void;
  onLayerGroupReorder?: (groupId: string, frontFirstIndex: number) => void;
  onLayerOrder?: (entityId: string, direction: StudioLayerOrderDirection) => void;
  onLayerReorder?: (entityId: string, frontFirstIndex: number) => void;
  onTrimLayerGroupLifetime?: (groupId: string) => void;
  onToggleLayerGroup?: (childEntityIds: readonly string[], selected: boolean) => void;
  onToggleLayerGroupLock?: (childEntityIds: readonly string[]) => void;
  onToggleLayerGroupVisibility?: (groupId: string, visible: boolean) => void;
  onToggleEntityLock?: (entityId: string) => void;
  onToggleEntityVisibility?: (entityId: string, visible: boolean) => void;
  onUngroup?: (groupId: string) => void;
  onRedo: () => void;
  onToggleEntity: (entityId: string, selected: boolean) => void;
  onUndo: () => void;
  redoCount: number;
  sceneBackgroundAvailable?: boolean;
  sceneBackgroundColor?: string;
  sceneBackgroundUnavailableReason?: string | null;
  scenePostEffectNames?: Readonly<Record<number, string>>;
  scenePostEffects?: readonly StudioScenePostEffectV1[];
  scenePostEffectAvailable?: boolean;
  scenePostEffectSourceEditor?: ScenePostEffectSourceEditorProps;
  scenePostEffectUnavailableReason?: string | null;
  selectedIds: ReadonlySet<string>;
  selectedGroupId?: string | null;
  sourceImportOutcomes: readonly ManimSourceImportOutcome[];
  undoAvailable?: boolean;
}>) {
  const audioFileInput = useRef<HTMLInputElement | null>(null);
  const imageFileInput = useRef<HTMLInputElement | null>(null);
  const svgFileInput = useRef<HTMLInputElement | null>(null);
  const [imageAssetSearchQuery, setImageAssetSearchQuery] = useState("");
  const [svgAssetSearchQuery, setSvgAssetSearchQuery] = useState("");
  const [layerDrag, setLayerDrag] = useState<Readonly<{
    boundary: number;
    id: string;
    kind: "entity" | "group";
  }> | null>(null);
  const layerEntries: readonly StudioLayerEntry[] =
    layers ??
    entities.map((entity) => ({
      canMove: { back: false, backward: false, forward: false, front: false },
      entity,
      readOnlyReason: null,
      sceneOrder: null,
      sourceAnchor: null,
      sourceZIndex: null,
      visibilityReadOnlyReason: null,
      visible: true,
    }));
  const rootLayerEntries = layerEntries.filter(({ isGroup, parentGroupId }) => isGroup || !parentGroupId);
  const matchingImageAssets = studioImageAssetsMatchingQuery(imageAssets, imageAssetSearchQuery);
  const matchingSvgAssets = studioSvgPathAssetsMatchingQuery(svgAssets, svgAssetSearchQuery);
  return (
    <aside className={cn("min-h-0 overflow-y-auto bg-zinc-950 p-3", className)}>
      <section
        className="mb-4 border-b border-zinc-800 pb-4"
        aria-labelledby="studio-assets-heading"
        onDragOver={(event) => {
          const fileItems = Array.from(event.dataTransfer.items).filter((item) => item.kind === "file");
          if (!onImportImageFiles || !authoringAvailable || draftActive || imageImportPending || fileItems.length === 0)
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          if (!onImportImageFiles || !authoringAvailable || draftActive || imageImportPending) return;
          const files = Array.from(event.dataTransfer.files).filter(
            (file) => file.type.startsWith("image/") || /[.](?:jpe?g|png|webp)$/iu.test(file.name),
          );
          if (files.length === 0) return;
          event.preventDefault();
          onImportImageFiles(files);
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-balance text-xs font-medium text-zinc-300" id="studio-assets-heading">
            Assets
          </h2>
          <div className="flex items-center gap-2">
            <span className="tabular-nums text-[10px] text-zinc-600">
              {imageAssets.length + svgAssets.length + (audioTrack ? 1 : 0)}
            </span>
            {onImportImageFiles ? (
              <>
                <input
                  accept={NATIVE_PROJECT_IMAGE_FILE_ACCEPT_V1}
                  aria-label="Project image files"
                  className="sr-only"
                  disabled={!authoringAvailable || draftActive || imageImportPending}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    if (files.length > 0) onImportImageFiles(files);
                  }}
                  multiple
                  ref={imageFileInput}
                  type="file"
                />
                <button
                  className="h-7 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                  disabled={!authoringAvailable || draftActive || imageImportPending}
                  onClick={() => imageFileInput.current?.click()}
                  type="button"
                >
                  {imageImportPending ? "Importing…" : "+ Import image"}
                </button>
              </>
            ) : null}
            {onImportSvgFiles ? (
              <>
                <input
                  accept="image/svg+xml,.svg"
                  className="sr-only"
                  disabled={!authoringAvailable || draftActive || svgImportPending}
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    if (files.length > 0) onImportSvgFiles(files);
                  }}
                  multiple
                  ref={svgFileInput}
                  type="file"
                />
                <button
                  className="h-7 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                  disabled={!authoringAvailable || draftActive || svgImportPending}
                  onClick={() => svgFileInput.current?.click()}
                  type="button"
                >
                  {svgImportPending ? "Importing…" : "+ Import SVG"}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {onImportAudioFile || audioTrack ? (
          <div className="mt-3 border border-zinc-800 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-[10px] font-medium text-zinc-500">Audio</h3>
                <p className="mt-1 truncate text-[10px] text-zinc-400" title={audioTrack?.fileName}>
                  {audioTrack?.fileName ?? "No project audio"}
                </p>
              </div>
              {onImportAudioFile ? (
                <>
                  <input
                    accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg,audio/mp3"
                    aria-label="Project audio file"
                    className="sr-only"
                    disabled={!authoringAvailable || draftActive || audioImportPending}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) onImportAudioFile(file);
                    }}
                    ref={audioFileInput}
                    type="file"
                  />
                  <button
                    className="h-7 shrink-0 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                    disabled={!authoringAvailable || draftActive || audioImportPending}
                    onClick={() => audioFileInput.current?.click()}
                    type="button"
                  >
                    {audioImportPending ? "Importing…" : audioTrack ? "Replace audio" : "+ Import audio"}
                  </button>
                </>
              ) : null}
              {audioTrack && onRemoveAudioTrack ? (
                <button
                  aria-label={`Remove audio ${audioTrack.fileName}`}
                  className="h-7 shrink-0 border border-zinc-800 px-2 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                  disabled={!authoringAvailable || draftActive || audioImportPending}
                  onClick={onRemoveAudioTrack}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </div>
            {audioTrack && onAudioTimingChange ? (
              <form
                className="mt-2 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-2"
                key={`${audioTrack.timelineOffsetSampleFrames}:${audioTrack.trimStartSampleFrames}:${audioTrack.trimEndSampleFrames ?? "end"}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const offset = Number(data.get("audioOffset"));
                  const trimStart = Number(data.get("audioTrimStart"));
                  const trimEndValue = String(data.get("audioTrimEnd") ?? "").trim();
                  const trimEnd = trimEndValue === "" ? null : Number(trimEndValue);
                  if (
                    Number.isFinite(offset) &&
                    Number.isFinite(trimStart) &&
                    (trimEnd === null || Number.isFinite(trimEnd))
                  ) {
                    onAudioTimingChange({ offset, trimEnd, trimStart });
                  }
                }}
              >
                {(
                  [
                    ["Offset", "audioOffset", projectAudioTimingSeconds(audioTrack).offset],
                    ["Trim in", "audioTrimStart", projectAudioTimingSeconds(audioTrack).trimStart],
                    ["Trim out", "audioTrimEnd", projectAudioTimingSeconds(audioTrack).trimEnd ?? ""],
                  ] as const
                ).map(([label, name, value]) => (
                  <label className="text-[9px] text-zinc-500" key={name}>
                    {label} (s)
                    <input
                      aria-label={`Audio ${label.toLowerCase()} seconds`}
                      className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1.5 text-[10px] tabular-nums text-zinc-300 outline-none focus:border-sky-500"
                      defaultValue={value}
                      disabled={!authoringAvailable || draftActive || audioImportPending}
                      min="0"
                      name={name}
                      placeholder={name === "audioTrimEnd" ? "End" : undefined}
                      required={name !== "audioTrimEnd"}
                      step="0.01"
                      type="number"
                    />
                  </label>
                ))}
                <button
                  className="col-span-3 h-7 border border-zinc-700 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                  disabled={!authoringAvailable || draftActive || audioImportPending}
                  type="submit"
                >
                  Apply audio timing
                </button>
              </form>
            ) : null}
            {audioTrack && onAudioMixChange ? (
              <form
                className="mt-2 grid grid-cols-3 gap-2"
                key={`${audioTrack.volumePercent}:${audioTrack.fadeInSampleFrames}:${audioTrack.fadeOutSampleFrames}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  const volumePercent = Number(data.get("audioVolumePercent"));
                  const fadeIn = Number(data.get("audioFadeIn"));
                  const fadeOut = Number(data.get("audioFadeOut"));
                  if (
                    Number.isSafeInteger(volumePercent) &&
                    volumePercent >= 0 &&
                    volumePercent <= 100 &&
                    Number.isFinite(fadeIn) &&
                    fadeIn >= 0 &&
                    Number.isFinite(fadeOut) &&
                    fadeOut >= 0
                  ) {
                    onAudioMixChange({ fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut, volumePercent });
                  }
                }}
              >
                {(
                  [
                    ["Volume", "audioVolumePercent", projectAudioMixSettings(audioTrack).volumePercent, "1"],
                    ["Fade in", "audioFadeIn", projectAudioMixSettings(audioTrack).fadeInSeconds, "0.01"],
                    ["Fade out", "audioFadeOut", projectAudioMixSettings(audioTrack).fadeOutSeconds, "0.01"],
                  ] as const
                ).map(([label, name, value, step]) => (
                  <label className="min-w-0 text-[9px] text-zinc-500" key={name}>
                    {label} {name === "audioVolumePercent" ? "(%)" : "(s)"}
                    <input
                      aria-label={`Audio ${label.toLowerCase()} ${name === "audioVolumePercent" ? "percent" : "seconds"}`}
                      className="mt-1 h-7 w-full border border-zinc-700 bg-zinc-950 px-1.5 text-[10px] tabular-nums text-zinc-300 outline-none focus:border-sky-500"
                      defaultValue={value}
                      disabled={!authoringAvailable || draftActive || audioImportPending}
                      max={name === "audioVolumePercent" ? "100" : undefined}
                      min="0"
                      name={name}
                      required
                      step={step}
                      type="number"
                    />
                  </label>
                ))}
                <button
                  className="col-span-3 h-7 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                  disabled={!authoringAvailable || draftActive || audioImportPending}
                  type="submit"
                >
                  Apply audio mix
                </button>
              </form>
            ) : null}
            {audioImportError ? (
              <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300" role="alert">
                {audioImportError}
              </p>
            ) : null}
          </div>
        ) : null}
        <h3 className="mt-2 text-[10px] font-medium text-zinc-500">Images</h3>
        {imageAssets.length === 0 ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
            No verified project image is available in this Scene.
          </p>
        ) : (
          <>
            <label className="mt-2 block text-[10px] font-medium text-zinc-500" htmlFor="studio-image-asset-search">
              Project images
            </label>
            <input
              aria-controls="studio-project-images"
              aria-describedby="studio-image-asset-search-status"
              aria-label="Search project images"
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
              id="studio-image-asset-search"
              onChange={(event) => setImageAssetSearchQuery(event.currentTarget.value)}
              placeholder="Search by name or dimensions"
              type="search"
              value={imageAssetSearchQuery}
            />
            <p className="mt-1 text-[10px] text-zinc-600" id="studio-image-asset-search-status" role="status">
              {imageAssetSearchQuery.trim().length === 0
                ? `${imageAssets.length} project image${imageAssets.length === 1 ? "" : "s"}`
                : matchingImageAssets.length === 0
                  ? `No images match “${imageAssetSearchQuery.trim()}”.`
                  : `${matchingImageAssets.length} matching image${matchingImageAssets.length === 1 ? "" : "s"}`}
            </p>
            <ul className="mt-2 space-y-1" aria-label="Project images" id="studio-project-images">
              {matchingImageAssets.map((asset) => {
                const imageAssetDraggable =
                  imageAssetDragAvailable && authoringAvailable && !draftActive && onAddImageAsset !== undefined;
                return (
                  <li
                    className="border border-zinc-800 p-2"
                    key={`${asset.image.asset.assetId}:${asset.image.asset.sha256}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        aria-label={`Add ${asset.label} at canvas center`}
                        className={cn(
                          "flex min-w-0 items-center gap-2 text-left disabled:cursor-not-allowed",
                          imageAssetDraggable ? "cursor-grab active:cursor-grabbing" : null,
                        )}
                        disabled={!authoringAvailable || draftActive || onAddImageAsset === undefined}
                        draggable={imageAssetDraggable}
                        onClick={() => onAddImageAsset?.(asset)}
                        onDragStart={(event) => {
                          if (!imageAssetDraggable) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.effectAllowed = "copy";
                          event.dataTransfer.setData(STUDIO_IMAGE_ASSET_DRAG_TYPE, studioImageAssetDragPayload(asset));
                        }}
                        title={imageAssetDraggable ? "Drag to place on the canvas, or use Add." : undefined}
                        type="button"
                      >
                        <NativeImageThumbnail asset={asset} />
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-zinc-300">{asset.label}</span>
                          <span className="mt-0.5 block tabular-nums text-[10px] text-zinc-600">
                            {asset.pixelWidth} × {asset.pixelHeight}
                          </span>
                        </span>
                      </button>
                      <button
                        className="h-7 shrink-0 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                        disabled={!authoringAvailable || draftActive || onAddImageAsset === undefined}
                        onClick={() => onAddImageAsset?.(asset)}
                        type="button"
                      >
                        + Add
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          PNG, JPEG, and WebP are stored as canonical PNG for Preview and MP4 export. Manim source export is
          unsupported.
        </p>
        {imageImportError ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-red-300" role="alert">
            {imageImportError}
          </p>
        ) : null}
        <h3 className="mt-4 text-[10px] font-medium text-zinc-500">Vector paths</h3>
        {svgAssets.length === 0 ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
            Import a finite-viewBox SVG containing one supported path.
          </p>
        ) : (
          <>
            <label className="mt-2 block text-[10px] font-medium text-zinc-500" htmlFor="studio-svg-asset-search">
              Project vectors
            </label>
            <input
              aria-controls="studio-project-vectors"
              aria-label="Search project vectors"
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
              id="studio-svg-asset-search"
              onChange={(event) => setSvgAssetSearchQuery(event.currentTarget.value)}
              placeholder="Search by name"
              type="search"
              value={svgAssetSearchQuery}
            />
            <ul className="mt-2 space-y-1" aria-label="Project vectors" id="studio-project-vectors">
              {matchingSvgAssets.map((asset) => (
                <li className="flex items-center justify-between gap-2 border border-zinc-800 p-2" key={asset.id}>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex size-11 shrink-0 items-center justify-center border border-zinc-800 bg-zinc-900 text-[10px] font-semibold text-sky-300">
                      SVG
                    </div>
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-zinc-300">{asset.label}</span>
                      <span className="mt-0.5 block tabular-nums text-[10px] text-zinc-600">
                        {asset.subpathCount} subpath{asset.subpathCount === 1 ? "" : "s"} · {asset.segmentCount}{" "}
                        segments
                      </span>
                    </span>
                  </div>
                  <button
                    className="h-7 shrink-0 border border-zinc-700 px-2 text-[10px] font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                    disabled={!authoringAvailable || draftActive || onAddSvgAsset === undefined}
                    onClick={() => onAddSvgAsset?.(asset)}
                    type="button"
                  >
                    + Add
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          SVG paths stay vector-native in Preview and local MP4 export. CSS, masks, filters, and unsupported elements
          are rejected.
        </p>
        {svgImportError ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-red-300" role="alert">
            {svgImportError}
          </p>
        ) : null}
      </section>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-balance text-xs font-medium text-zinc-300">Layers</h2>
        <div className="flex items-center gap-1">
          <button
            aria-keyshortcuts="Control+G Meta+G"
            className="border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!onGroup || groupUnavailableReason !== null}
            onClick={onGroup}
            title={groupUnavailableReason ?? "Group selected objects · Mod+G"}
            type="button"
          >
            Group
          </button>
          <button
            aria-keyshortcuts="Control+Shift+G Meta+Shift+G"
            className="border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!onUngroup || selectedGroupId === null}
            onClick={() => selectedGroupId && onUngroup?.(selectedGroupId)}
            title={selectedGroupId ? "Ungroup selected group · Mod+Shift+G" : "Select one group row to ungroup."}
            type="button"
          >
            Ungroup
          </button>
          <span className="ml-1 tabular-nums text-[10px] text-zinc-600">{layerEntries.length}</span>
        </div>
      </div>
      <p className="mt-1 truncate text-[10px] text-zinc-600" title={activeScene.sceneId}>
        {activeScene.name}
      </p>
      <ul className="mt-3 space-y-1">
        {layerEntries.map((layer) => {
          const rootLayerIndex = rootLayerEntries.indexOf(layer);
          const updateDropBoundary = (event: DragEvent<HTMLLIElement>) => {
            if (!layerDrag || rootLayerIndex < 0) return null;
            const bounds = event.currentTarget.getBoundingClientRect();
            const boundary = rootLayerIndex + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setLayerDrag((current) => (current && current.boundary !== boundary ? { ...current, boundary } : current));
            return boundary;
          };
          const completeDrop = (event: DragEvent<HTMLLIElement>) => {
            const boundary = updateDropBoundary(event) ?? layerDrag?.boundary;
            if (!layerDrag || boundary === undefined) return;
            const sourceIndex = rootLayerEntries.findIndex((entry) =>
              layerDrag.kind === "group"
                ? entry.isGroup && entry.groupId === layerDrag.id
                : !entry.isGroup && entry.entity.id === layerDrag.id,
            );
            const frontFirstIndex = boundary > sourceIndex ? boundary - 1 : boundary;
            if (sourceIndex >= 0 && frontFirstIndex !== sourceIndex) {
              if (layerDrag.kind === "group") onLayerGroupReorder?.(layerDrag.id, frontFirstIndex);
              else onLayerReorder?.(layerDrag.id, frontFirstIndex);
            }
            setLayerDrag(null);
          };
          if (layer.isGroup && layer.groupId && layer.childEntityIds) {
            const selected =
              layer.childEntityIds.length > 0 &&
              layer.childEntityIds.length === selectedIds.size &&
              layer.childEntityIds.every((entityId) => selectedIds.has(entityId));
            const groupLocked =
              layer.childEntityIds.length > 0 &&
              layer.childEntityIds.every((entityId) => lockedEntityIds.has(entityId));
            const groupHasLockedChild = layer.childEntityIds.some((entityId) => lockedEntityIds.has(entityId));
            const groupOrderUnavailableReason =
              onLayerGroupOrder === undefined
                ? "Group layer order is unavailable."
                : !authoringAvailable
                  ? "Wait for the canonical preview before changing this group order."
                  : groupHasLockedChild
                    ? "Unlock every grouped object before changing group order."
                    : layer.orderingReadOnlyReason;
            const groupDragUnavailableReason =
              onLayerGroupReorder === undefined
                ? "Group drag reordering is unavailable."
                : !authoringAvailable
                  ? "Wait for the canonical preview before reordering this group."
                  : groupHasLockedChild
                    ? "Unlock every grouped object before reordering this group."
                    : layer.orderingReadOnlyReason;
            const groupLifetimeUnavailableReason =
              onTrimLayerGroupLifetime === undefined
                ? "Group lifetime editing is unavailable."
                : !authoringAvailable
                  ? "Wait for the canonical preview before trimming this group lifetime."
                  : draftActive
                    ? "Apply or discard the current draft before trimming this group lifetime."
                    : groupHasLockedChild
                      ? "Unlock every grouped object before trimming this group lifetime."
                      : groupLifetimeTrimUnavailableReason;
            const groupDraggable = groupDragUnavailableReason === null;
            const visibilityUnavailableReason =
              onToggleLayerGroupVisibility === undefined
                ? "Group visibility is unavailable."
                : layer.childEntityIds.some((entityId) => lockedEntityIds.has(entityId))
                  ? "Unlock every grouped object before changing group visibility."
                  : layer.visibilityReadOnlyReason;
            return (
              <li
                className={cn(
                  "border border-zinc-800 bg-zinc-900/50",
                  layerDrag?.boundary === rootLayerIndex && "border-t-sky-400",
                  layerDrag?.boundary === rootLayerEntries.length && rootLayerIndex === rootLayerEntries.length - 1
                    ? "border-b-sky-400"
                    : null,
                )}
                key={layer.groupId}
                onDragOver={updateDropBoundary}
                onDrop={completeDrop}
              >
                <div
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs",
                    selected ? "bg-sky-950 text-sky-200" : "text-zinc-300 hover:bg-zinc-900",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn("text-zinc-500", groupDraggable ? "cursor-grab" : "opacity-40")}
                    draggable={groupDraggable}
                    onDragEnd={() => setLayerDrag(null)}
                    onDragStart={(event) => {
                      if (!groupDraggable) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", layer.groupId!);
                      setLayerDrag({ boundary: rootLayerIndex, id: layer.groupId!, kind: "group" });
                    }}
                    title={groupDragUnavailableReason ?? "Drag to reorder this group"}
                  >
                    ⧉
                  </span>
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      aria-label={`Select group of ${layer.childEntityIds.length} objects`}
                      checked={selected}
                      className="size-3.5 accent-sky-400"
                      onChange={() => onToggleLayerGroup?.(layer.childEntityIds!, selected)}
                      type="checkbox"
                    />
                    <span className="min-w-0 flex-1 truncate">Group</span>
                  </label>
                  <button
                    aria-label={`${layer.visible ? "Hide" : "Show"} group of ${layer.childEntityIds.length} objects`}
                    aria-pressed={!layer.visible}
                    className="size-6 shrink-0 border border-transparent text-[11px] text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:border-transparent disabled:hover:bg-transparent"
                    disabled={visibilityUnavailableReason !== null}
                    onClick={(event) => {
                      event.preventDefault();
                      onToggleLayerGroupVisibility?.(layer.groupId!, !layer.visible);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={visibilityUnavailableReason ?? (layer.visible ? "Hide group" : "Show group")}
                    type="button"
                  >
                    <span aria-hidden="true">{layer.visible ? "◉" : "○"}</span>
                  </button>
                  {onToggleLayerGroupLock ? (
                    <button
                      aria-label={`${groupLocked ? "Unlock" : "Lock"} group of ${layer.childEntityIds.length} objects`}
                      aria-pressed={groupLocked}
                      className="size-6 shrink-0 border border-transparent text-[11px] text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:border-transparent disabled:hover:bg-transparent"
                      disabled={lockToggleDisabled}
                      onClick={(event) => {
                        event.preventDefault();
                        onToggleLayerGroupLock(layer.childEntityIds!);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      title={
                        lockToggleDisabled
                          ? "Apply or discard the current draft before changing layer locks"
                          : groupLocked
                            ? "Unlock every object in this group"
                            : "Lock every object in this group"
                      }
                      type="button"
                    >
                      <span aria-hidden="true">{groupLocked ? "🔒" : "🔓"}</span>
                    </button>
                  ) : null}
                  <span className="tabular-nums text-[10px] text-zinc-600">{layer.childEntityIds.length}</span>
                </div>
                {selected && onLayerGroupOrder ? (
                  <div className="grid grid-cols-4 border-t border-zinc-800" role="group" aria-label="Order group">
                    {(
                      [
                        ["back", "Back", "⇤"],
                        ["backward", "Backward", "←"],
                        ["forward", "Forward", "→"],
                        ["front", "Front", "⇥"],
                      ] as const
                    ).map(([direction, label, glyph]) => (
                      <button
                        aria-label={`${label} group of ${layer.childEntityIds!.length} objects`}
                        className="h-7 border-r border-zinc-800 text-[11px] text-zinc-400 last:border-r-0 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                        disabled={groupOrderUnavailableReason !== null || !layer.canMove[direction]}
                        key={direction}
                        onClick={() => onLayerGroupOrder(layer.groupId!, direction)}
                        title={groupOrderUnavailableReason ?? label}
                        type="button"
                      >
                        {glyph}
                      </button>
                    ))}
                  </div>
                ) : null}
                {selected && onTrimLayerGroupLifetime ? (
                  <button
                    aria-label={`End lifetime for group of ${layer.childEntityIds.length} objects at playhead`}
                    className="h-7 w-full border-t border-zinc-800 px-2 text-left text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                    disabled={groupLifetimeUnavailableReason !== null}
                    onClick={() => onTrimLayerGroupLifetime(layer.groupId!)}
                    title={groupLifetimeUnavailableReason ?? "Trim every grouped object lifetime at the playhead"}
                    type="button"
                  >
                    End group at playhead
                  </button>
                ) : null}
              </li>
            );
          }
          const entity = layer.entity;
          const selected = selectedIds.has(entity.id);
          const provisionalLocked =
            entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId));
          const authoringLocked = lockedEntityIds.has(entity.id);
          const orderingReadOnlyReason = layer.orderingReadOnlyReason ?? layer.readOnlyReason;
          const visibilityUnavailableReason =
            onToggleEntityVisibility === undefined
              ? "Layer visibility is unavailable."
              : provisionalLocked
                ? "Apply this provisional object before changing its visibility."
                : authoringLocked
                  ? "Unlock this object before changing its visibility."
                  : layer.visibilityReadOnlyReason;
          const dragUnavailableReason =
            onLayerReorder === undefined
              ? "Layer drag reordering is unavailable."
              : !authoringAvailable
                ? "Wait for the canonical preview before reordering layers."
                : provisionalLocked
                  ? "Apply this provisional object before reordering it."
                  : authoringLocked
                    ? "Unlock this object before reordering it."
                    : !entity.present
                      ? "This object is not present at the current time."
                      : orderingReadOnlyReason;
          const draggable = onLayerReorder !== undefined && dragUnavailableReason === null;
          return (
            <li
              className={cn(
                layerDrag?.boundary === rootLayerIndex && "border-t border-sky-400",
                layerDrag?.boundary === rootLayerEntries.length && rootLayerIndex === rootLayerEntries.length - 1
                  ? "border-b border-sky-400"
                  : null,
              )}
              key={entity.id}
              onDragOver={updateDropBoundary}
              onDrop={completeDrop}
            >
              <div
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 text-xs",
                  layer.depth === 1 && "ml-4 border-l border-zinc-800",
                  selected ? "bg-sky-950 text-sky-200" : "text-zinc-400 hover:bg-zinc-900",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn("shrink-0 text-zinc-600", draggable ? "cursor-grab" : "opacity-40")}
                  draggable={draggable}
                  onDragEnd={() => setLayerDrag(null)}
                  onDragStart={(event) => {
                    if (!draggable) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", entity.id);
                    setLayerDrag({ boundary: rootLayerIndex, id: entity.id, kind: "entity" });
                  }}
                  title={dragUnavailableReason ?? "Drag to reorder this layer"}
                >
                  ⠿
                </span>
                <label
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2",
                    provisionalLocked ? "cursor-not-allowed text-zinc-600" : "cursor-pointer",
                  )}
                >
                  <input
                    aria-label={`Select ${entityLabel(entity)}`}
                    checked={selected}
                    className="size-3.5 accent-sky-400"
                    disabled={provisionalLocked || !entity.present}
                    onChange={() => onToggleEntity(entity.id, selected)}
                    type="checkbox"
                  />
                  <span className="min-w-0 flex-1 truncate">{entityLabel(entity)}</span>
                </label>
                {onToggleEntityVisibility ? (
                  <button
                    aria-label={`${layer.visible ? "Hide" : "Show"} ${entityLabel(entity)}`}
                    aria-pressed={!layer.visible}
                    className="size-6 shrink-0 border border-transparent text-[11px] text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:border-transparent disabled:hover:bg-transparent"
                    disabled={visibilityUnavailableReason !== null}
                    draggable={false}
                    onClick={(event) => {
                      event.preventDefault();
                      onToggleEntityVisibility(entity.id, !layer.visible);
                    }}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={visibilityUnavailableReason ?? (layer.visible ? "Hide object" : "Show object")}
                    type="button"
                  >
                    <span aria-hidden="true">{layer.visible ? "◉" : "○"}</span>
                  </button>
                ) : null}
                {onToggleEntityLock ? (
                  <button
                    aria-label={`${authoringLocked ? "Unlock" : "Lock"} ${entityLabel(entity)}`}
                    aria-pressed={authoringLocked}
                    className="size-6 shrink-0 border border-transparent text-[11px] text-zinc-500 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:border-transparent disabled:hover:bg-transparent"
                    disabled={provisionalLocked || lockToggleDisabled}
                    draggable={false}
                    onDragStart={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      onToggleEntityLock(entity.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={
                      lockToggleDisabled
                        ? "Apply or discard the current draft before changing layer locks"
                        : authoringLocked
                          ? "Unlock object editing"
                          : "Lock object editing"
                    }
                    type="button"
                  >
                    <span aria-hidden="true">{authoringLocked ? "🔒" : "🔓"}</span>
                  </button>
                ) : null}
                <span className="shrink-0 text-[10px] text-zinc-600" title={layer.readOnlyReason ?? undefined}>
                  {authoringLocked
                    ? "Locked"
                    : !layer.visible
                      ? "Hidden"
                      : layer.readOnlyReason
                        ? "Read-only"
                        : entity.type}
                </span>
              </div>
              {selected && onLayerOrder ? (
                <div
                  className="grid grid-cols-4 border-x border-b border-zinc-800"
                  role="group"
                  aria-label={`Order ${entityLabel(entity)}`}
                >
                  {(
                    [
                      ["back", "Back", "⇤"],
                      ["backward", "Backward", "←"],
                      ["forward", "Forward", "→"],
                      ["front", "Front", "⇥"],
                    ] as const
                  ).map(([direction, label, glyph]) => (
                    <button
                      aria-label={`${label} ${entityLabel(entity)}`}
                      className="h-7 border-r border-zinc-800 text-[11px] text-zinc-400 last:border-r-0 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                      disabled={
                        !authoringAvailable ||
                        authoringLocked ||
                        orderingReadOnlyReason !== null ||
                        !layer.canMove[direction]
                      }
                      key={direction}
                      onClick={() => onLayerOrder(entity.id, direction)}
                      title={orderingReadOnlyReason ?? label}
                      type="button"
                    >
                      {glyph}
                    </button>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {sourceImportOutcomes.length > 0 ? (
        <section className="mt-4 border-t border-zinc-900 pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[10px] font-medium text-zinc-500">Source-only bindings</h3>
            <span className="tabular-nums text-[10px] text-zinc-700">{sourceImportOutcomes.length}</span>
          </div>
          <ul aria-label="Read-only source bindings" className="mt-1 space-y-1">
            {sourceImportOutcomes.map((outcome) => (
              <li
                className="flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-500"
                key={outcome.bindingId}
                title={IMPORT_OUTCOME_DETAILS[outcome.reason]}
              >
                <span aria-hidden="true" className="size-3.5 shrink-0 text-center text-[10px] text-zinc-600">
                  —
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {outcome.sourceVariable ?? "Scene source"}
                  <span className="ml-1 text-[10px] text-zinc-700">line {outcome.sourceLine}</span>
                </span>
                <span className="shrink-0 text-[10px] text-amber-700">{IMPORT_OUTCOME_LABELS[outcome.kind]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-5 border-t border-zinc-800 pt-4">
        <h2 className="text-balance text-xs font-medium text-zinc-300">Scene graph</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
          <dt className="text-zinc-600">Active</dt>
          <dd className="truncate text-zinc-400">{activeScene.name}</dd>
          <dt className="text-zinc-600">Next</dt>
          <dd className="truncate text-zinc-400">{nextScene?.name ?? "none"}</dd>
          <dt className="text-zinc-600">Duration</dt>
          <dd>
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                onDurationChange(Number(data.get("duration")));
              }}
            >
              <input
                aria-label="Scene duration in seconds"
                className="h-7 min-w-0 w-20 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-[10px] text-zinc-300 outline-none focus:border-sky-500"
                defaultValue={duration.toFixed(2)}
                key={`${activeScene.sceneId}/${duration.toFixed(3)}`}
                aria-describedby={[
                  "scene-duration-hint",
                  durationBlocker ? "scene-duration-blocker" : null,
                  durationError ? "scene-duration-error" : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!authoringAvailable}
                min={durationMinimum}
                name="duration"
                step="0.1"
                type="number"
              />
              <button
                className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                disabled={!authoringAvailable}
                type="submit"
              >
                Update
              </button>
            </form>
            <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600" id="scene-duration-hint">
              Shortest safe: <span className="tabular-nums">{durationMinimum.toFixed(2)}s</span>
            </p>
            {durationBlocker ? (
              <p className="mt-1 text-pretty text-[10px] leading-4 text-amber-600" id="scene-duration-blocker">
                {durationBlocker}
              </p>
            ) : null}
            {durationError ? (
              <p className="mt-1 text-pretty text-[10px] leading-4 text-red-300" id="scene-duration-error" role="alert">
                {durationError}
              </p>
            ) : null}
          </dd>
          <dt className="text-zinc-600">Background</dt>
          <dd>
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const color = new FormData(event.currentTarget).get("background");
                if (typeof color === "string") onSceneBackgroundChange?.(color);
              }}
            >
              <input
                aria-label="Scene background color"
                className="size-7 border border-zinc-700 bg-zinc-950 p-0.5 outline-none focus:border-sky-500 disabled:opacity-50"
                defaultValue={sceneBackgroundColor}
                disabled={!authoringAvailable || !sceneBackgroundAvailable || !onSceneBackgroundChange}
                key={`${activeScene.sceneId}/${sceneBackgroundColor}`}
                name="background"
                title={sceneBackgroundUnavailableReason ?? undefined}
                type="color"
              />
              <button
                className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                disabled={!authoringAvailable || !sceneBackgroundAvailable || !onSceneBackgroundChange}
                title={sceneBackgroundUnavailableReason ?? undefined}
                type="submit"
              >
                Update
              </button>
            </form>
          </dd>
          <dt className="text-zinc-600">Post effect</dt>
          <dd>
            <ScenePostEffectControls
              available={scenePostEffectAvailable}
              effectNames={scenePostEffectNames}
              effects={scenePostEffects}
              onChange={onScenePostEffectsChange}
              unavailableReason={scenePostEffectUnavailableReason}
            />
            {scenePostEffectSourceEditor ? <ScenePostEffectSourceEditor {...scenePostEffectSourceEditor} /> : null}
          </dd>
          <dt className="text-zinc-600">Anchors</dt>
          <dd className="tabular-nums text-zinc-400">
            {activeScene.anchors.map((anchor) => anchor.toFixed(2)).join(", ") || "none"}
          </dd>
        </dl>
      </section>

      <section className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-balance text-xs font-medium text-zinc-300">Applied programs</h2>
          <div className="flex items-center gap-2">
            {undoAvailable ? (
              <button
                aria-label="Undo latest editor action"
                aria-keyshortcuts="Control+Z Meta+Z"
                className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200"
                onClick={onUndo}
                type="button"
              >
                Undo
              </button>
            ) : null}
            {redoCount > 0 ? (
              <button
                aria-label="Redo latest editor action"
                aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200"
                disabled={!authoringAvailable}
                onClick={onRedo}
                type="button"
              >
                Redo
              </button>
            ) : null}
          </div>
        </div>
        {appliedEdits.length > 0 ? (
          <ol className="mt-2 space-y-1">
            {appliedEdits.map((record, index) => {
              const transactionId = record.program.transactionId;
              const readOnlyReason = appliedProgramReadOnlyReasons[transactionId];
              const editing = editingAppliedTransactionId === transactionId;
              return (
                <li
                  className={cn(
                    "border px-2 py-1.5 text-[10px]",
                    editing ? "border-sky-900 bg-sky-950/40" : "border-zinc-800",
                  )}
                  key={transactionId}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-zinc-500">
                      {index + 1}. {record.program.intentCount} intents · {transactionId}
                    </span>
                    {readOnlyReason ? (
                      <span className="shrink-0 text-zinc-600">Read-only</span>
                    ) : (
                      <button
                        aria-label={`Edit applied program ${index + 1}`}
                        className="shrink-0 border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-600"
                        disabled={draftActive || !authoringAvailable}
                        onClick={() => onEditAppliedProgram(record, index)}
                        title={
                          editing
                            ? "This Program is being edited."
                            : draftActive
                              ? "Apply or discard the current draft first."
                              : undefined
                        }
                        type="button"
                      >
                        {editing ? "Editing" : "Edit"}
                      </button>
                    )}
                  </div>
                  {readOnlyReason ? <p className="mt-1 text-pretty leading-4 text-zinc-600">{readOnlyReason}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
            Apply a draft to add it to the Scene working state.
          </p>
        )}
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          Imported .py operations are read-only because they do not have a Studio-owned transaction that can be replaced
          safely.
        </p>
      </section>

      <details className="mt-5 border-t border-zinc-800 pt-4 text-[10px]">
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">Keyboard shortcuts</summary>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          {SIDEBAR_SHORTCUTS.map((id) => {
            const command = studioCommand(id);
            return (
              <div className="contents" key={id}>
                <dt className="text-zinc-600">{command.label}</dt>
                <dd className="font-mono text-zinc-400">{shortcutLabel(command.shortcut, navigator.platform)}</dd>
              </div>
            );
          })}
          <div className="contents">
            <dt className="text-zinc-600">Nudge / coarse nudge</dt>
            <dd className="font-mono text-zinc-400">Arrow / Shift+Arrow</dd>
          </div>
        </dl>
      </details>
    </aside>
  );
}

export function StudioInspector({
  appliedProgramCount,
  authoringAvailable = true,
  className,
  colorAvailable,
  cubicBezierClosed,
  dataPlotAuthoring,
  cameraAuthoring,
  draftApplyPending,
  draftError,
  draftOperation,
  draftEdit,
  fillColorValue,
  fragmentMaterial = {
    active: false,
    assignedParameters: null,
    assignedShaderId: null,
    assignedTexture: null,
    available: false,
    compileError: null,
    materials: [],
    onAssign: () => undefined,
    onCreate: () => null,
    onCreatePreset: () => null,
    onCreateTexturePreset: () => null,
    onDuplicate: () => null,
    onImportGlsl: async () => undefined,
    onRemoveAsset: async () => false,
    onRename: () => undefined,
    onUpdateParameterSchema: () => null,
    onUpdateSource: () => undefined,
    onUpdateParameter: () => undefined,
    onUpdateTexture: () => undefined,
    textureAssets: [],
  },
  contentTransform,
  onApplyDraft,
  onDiscardDraft,
  onDraftOperationChange,
  onEntityColorChange,
  onEntityEdit,
  onEntityOpacityChange,
  onEntityRotate,
  onEntityScaleChange,
  onEntityStrokeCapChange,
  onEntityStrokeDashChange,
  onEntityStrokeJoinChange,
  onEntityStrokeWidthChange,
  onInspectorFocusRestored,
  onRenderSessionChange,
  onSourceChanged,
  onSourceMutationPendingChange,
  renderCandidate,
  renderCandidateLifecycleBlocker,
  renderCandidateUnavailableReason,
  renderSession,
  replacingAppliedProgram,
  opacityAvailable,
  opacityUnavailableReason = null,
  opacityValue,
  rotationAvailable,
  selectedEntity,
  selectedEntityLocked = false,
  shapeTransform,
  inspectorReturnFocus,
  sourceExport,
  sourceExportBlocker = null,
  strokeColorValue,
  strokeCapAvailable,
  strokeCapValue,
  strokeDashUnavailableReason,
  strokeDashValue,
  strokeDashVisible,
  strokeJoinUnavailableReason,
  strokeJoinValue,
  strokeJoinVisible,
  strokeWidthAvailable,
  strokeWidthValue,
  suggestion,
  workspace,
}: Readonly<{
  appliedProgramCount: number;
  authoringAvailable?: boolean;
  className?: string;
  colorAvailable: boolean;
  cubicBezierClosed: boolean;
  dataPlotAuthoring?: DataPlotInspectorAuthoring;
  cameraAuthoring?: CameraInspectorAuthoring;
  draftApplyPending: boolean;
  draftError: string | null;
  draftOperation: EditSuggestionOperation | null;
  draftEdit: ProgramRecord | null;
  fillColorValue: string | null;
  fragmentMaterial?: Readonly<{
    active: boolean;
    assignedParameters: readonly number[] | null;
    assignedShaderId: string | null;
    assignedTexture: Readonly<{
      asset: Readonly<{ assetId: string; sha256: string }>;
      sampler: "linear" | "nearest";
    }> | null;
    available: boolean;
    compileError: string | null;
    materials: readonly FragmentMaterialEditorItem[];
    onAssign: (shaderId: string | null) => void;
    onCreate: (name: string) => string | null;
    onCreatePreset: (preset: StudioFragmentMaterialPresetId) => string | null;
    onCreateTexturePreset: () => string | null;
    onDuplicate: (shaderId: string) => string | null;
    onImportGlsl: (shaderId: string, input: Readonly<{ entryPoint: "main"; source: string }>) => Promise<void>;
    onRemoveAsset: (shaderId: string, resolution: StudioFragmentMaterialRemovalResolution) => Promise<boolean>;
    onRename: (shaderId: string, name: string) => void;
    onUpdateParameterSchema: (
      shaderId: string,
      parameterSchema: StudioFragmentMaterialParameterSchemaV1,
    ) => string | null;
    onUpdateSource: (shaderId: string, source: string) => void;
    onUpdateParameter: (name: string, value: StudioFragmentMaterialParameterValueV1) => void;
    onUpdateTexture: (assetId: string, sampler: "linear" | "nearest") => void;
    textureAssets: readonly Readonly<{ assetId: string; label: string }>[];
  }>;
  contentTransform?: ContentTransformInspectorAuthoring;
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
  onDraftOperationChange: (operation: EditSuggestionOperation) => void;
  onEntityColorChange: (entityId: string, property: "fillColor" | "strokeColor", color: string) => void;
  onEntityEdit: (entityId: string, edits: ValidatedInspectorEdits, returnFocus: InspectorEditField) => boolean;
  onEntityOpacityChange: (entityId: string, opacity: number) => void;
  onEntityRotate: (entityId: string, angleRadians: number) => void;
  onEntityScaleChange: (entityId: string, scale: number) => void;
  onEntityStrokeCapChange: (entityId: string, strokeCap: "butt" | "round" | "square") => void;
  onEntityStrokeDashChange: (entityId: string, strokeDash: StrokeDash | null) => void;
  onEntityStrokeJoinChange: (entityId: string, strokeJoin: StrokeJoin) => void;
  onEntityStrokeWidthChange: (entityId: string, strokeWidth: number) => void;
  onInspectorFocusRestored: () => void;
  onRenderSessionChange: (session: RenderSessionView | null, projectId?: string) => void;
  onSourceChanged: (target: RenderSourceRefreshTarget) => void | Promise<void>;
  onSourceMutationPendingChange: (projectId: string, pending: boolean) => void;
  renderCandidate: RenderProgramCandidate | null;
  renderCandidateLifecycleBlocker: string | null;
  renderCandidateUnavailableReason: string;
  renderSession: RenderSessionView | null;
  replacingAppliedProgram: boolean;
  opacityAvailable: boolean;
  opacityUnavailableReason?: string | null;
  opacityValue: number | null;
  rotationAvailable: boolean;
  selectedEntity: ProjectedEntity | null;
  selectedEntityLocked?: boolean;
  shapeTransform?: ShapeTransformInspectorAuthoring;
  inspectorReturnFocus: InspectorEditField | null;
  sourceExport: OriginalManimSourceExportRequest | null;
  sourceExportBlocker?: string | null;
  strokeColorValue: string | null;
  strokeCapAvailable: boolean;
  strokeCapValue: "butt" | "round" | "square" | null;
  strokeDashUnavailableReason: string | null;
  strokeDashValue: StrokeDash | null;
  strokeDashVisible: boolean;
  strokeJoinUnavailableReason: string | null;
  strokeJoinValue: StrokeJoin | null;
  strokeJoinVisible: boolean;
  strokeWidthAvailable: boolean;
  strokeWidthValue: number | null;
  suggestion: EditSuggestion | null;
  workspace: ManimWorkspaceView | null;
}>) {
  const draftPosition = draftEdit ? directPositionDraft(draftEdit, selectedEntity) : null;
  const geometryUnknowns = selectedEntity
    ? (
        [
          ["Position", selectedEntity.geometry.position],
          ["Scale", selectedEntity.geometry.scale],
          ["Dimensions", selectedEntity.geometry.dimensions],
          ["Style", selectedEntity.geometry.style],
        ] as const
      ).flatMap(([label, knowledge]) => (knowledge.kind === "unknown" ? [{ label, reason: knowledge.reason }] : []))
    : [];
  const scaleUnknown = selectedEntity?.geometry.scale.kind === "unknown";
  const shapeColorProperties: readonly Readonly<
    [label: string, property: "fillColor" | "strokeColor", value: string | null]
  >[] =
    selectedEntity &&
    [
      "Arc",
      "Arrow",
      "Axes",
      "Circle",
      "CubicBezier",
      "DataPlot",
      "Ellipse",
      "Line",
      "MathTex",
      "NumberLine",
      "NumberPlane",
      "Rectangle",
      "RegularPolygon",
      "Sector",
      "Text",
      "Triangle",
    ].includes(selectedEntity.type)
      ? selectedEntity.type === "Text" || selectedEntity.type === "MathTex"
        ? [["Fill", "fillColor", fillColorValue]]
        : selectedEntity.type === "CubicBezier" && cubicBezierClosed
          ? [
              ["Fill", "fillColor", fillColorValue],
              ["Stroke", "strokeColor", strokeColorValue],
            ]
          : ["Arc", "Arrow", "Axes", "CubicBezier", "DataPlot", "Line", "NumberLine", "NumberPlane"].includes(
                selectedEntity.type,
              )
            ? [["Stroke", "strokeColor", strokeColorValue]]
            : [
                ["Fill", "fillColor", fillColorValue],
                ["Stroke", "strokeColor", strokeColorValue],
              ]
      : [];
  return (
    <aside className={cn("min-h-0 overflow-y-auto bg-zinc-950 p-3", className)}>
      {draftEdit ? (
        <>
          <DraftInspector
            applyLabel={replacingAppliedProgram ? "Replace program" : "Apply program"}
            editingDisabled={!authoringAvailable || selectedEntityLocked}
            error={draftError}
            isApplying={draftApplyPending}
            onApply={onApplyDraft}
            onDiscard={onDiscardDraft}
            onOperationChange={onDraftOperationChange}
            operation={draftOperation}
            record={draftEdit}
          />
          <fieldset
            className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
            disabled={!authoringAvailable || selectedEntityLocked}
          >
            {draftPosition && selectedEntity ? (
              <DraftPositionRefinement
                entity={selectedEntity}
                key={`${draftEdit.program.transactionId}/${draftPosition.x}/${draftPosition.y}`}
                onSubmit={(position) => {
                  onEntityEdit(selectedEntity.id, { position }, "x");
                }}
                position={draftPosition}
              />
            ) : null}
          </fieldset>
        </>
      ) : (
        <section>
          <h2 className="text-balance text-sm font-medium text-zinc-100">Inspector</h2>
          {selectedEntity ? (
            <fieldset
              className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
              disabled={!authoringAvailable || selectedEntityLocked}
            >
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-2 text-xs">
                <dt className="text-zinc-600">Object</dt>
                <dd className="truncate text-zinc-300">{entityLabel(selectedEntity)}</dd>
                <dt className="text-zinc-600">Type</dt>
                <dd className="text-zinc-300">{selectedEntity.type}</dd>
                <dt className="text-zinc-600">Source</dt>
                <dd className="truncate font-mono text-[10px] text-zinc-400">
                  {selectedEntity.sourceIdentity.kind === "known"
                    ? selectedEntity.sourceIdentity.value
                    : "not committed"}
                </dd>
                <dt className="text-zinc-600">Position</dt>
                <dd className="tabular-nums text-zinc-300">
                  {selectedEntity.geometry.position.kind === "unknown" ? "≈ " : ""}
                  {selectedEntity.position.x.toFixed(1)}, {selectedEntity.position.y.toFixed(1)}
                </dd>
                <dt className="text-zinc-600">Dimensions</dt>
                <dd className="tabular-nums text-zinc-300">{dimensionSummary(selectedEntity)}</dd>
                <dt className="text-zinc-600">Style</dt>
                <dd className="truncate text-zinc-300" title={styleSummary(selectedEntity)}>
                  {styleSummary(selectedEntity)}
                </dd>
                {shapeColorProperties.map(([label, property, value]) => (
                  <div className="contents" key={property}>
                    <dt className="self-center text-zinc-600">{label}</dt>
                    <dd>
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          onEntityColorChange(selectedEntity.id, property, String(data.get("color")));
                        }}
                      >
                        <input
                          aria-label={`${label} color ${entityLabel(selectedEntity)}`}
                          className="h-7 w-10 cursor-pointer border border-zinc-700 bg-zinc-950 p-0.5 disabled:cursor-not-allowed"
                          defaultValue={colorInputValue(value)}
                          disabled={!colorAvailable}
                          key={`${selectedEntity.id}/${property}/${value ?? "unset"}`}
                          name="color"
                          title={
                            colorAvailable
                              ? property === "fillColor"
                                ? "Set a solid fill color and enable the object fill"
                                : "Set the object stroke color"
                              : "Color editing currently requires a supported Studio-created object at its creation time"
                          }
                          type="color"
                        />
                        <button
                          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                          disabled={!colorAvailable}
                          type="submit"
                        >
                          Set
                        </button>
                      </form>
                    </dd>
                  </div>
                ))}
                {studioEntityTypeSupportsStrokeCap(selectedEntity.type) ? (
                  <div className="contents">
                    <dt className="self-center text-zinc-600">Stroke cap</dt>
                    <dd>
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const cap = new FormData(event.currentTarget).get("strokeCap");
                          if (cap === "butt" || cap === "round" || cap === "square") {
                            onEntityStrokeCapChange(selectedEntity.id, cap);
                          }
                        }}
                      >
                        <select
                          aria-label={`Stroke cap ${entityLabel(selectedEntity)}`}
                          className="h-7 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                          defaultValue={strokeCapValue ?? "butt"}
                          disabled={!strokeCapAvailable}
                          key={`${selectedEntity.id}/strokeCap/${strokeCapValue ?? "butt"}`}
                          name="strokeCap"
                          title={
                            strokeCapAvailable
                              ? "Set the path endpoint style"
                              : "Stroke cap editing requires a supported Studio-created open path at its creation time"
                          }
                        >
                          <option value="butt">Butt</option>
                          <option value="round">Round</option>
                          <option value="square">Square</option>
                        </select>
                        <button
                          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                          disabled={!strokeCapAvailable}
                          type="submit"
                        >
                          Set
                        </button>
                      </form>
                    </dd>
                  </div>
                ) : null}
                {strokeJoinVisible ? (
                  <div className="contents">
                    <dt className="self-center text-zinc-600">Stroke join</dt>
                    <dd>
                      <form
                        className="flex flex-wrap items-center gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const join = new FormData(event.currentTarget).get("strokeJoin");
                          if (join === "bevel" || join === "miter" || join === "round") {
                            onEntityStrokeJoinChange(selectedEntity.id, join);
                          }
                        }}
                      >
                        <select
                          aria-label="Stroke join Pen"
                          className="h-7 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-1.5 text-xs text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                          defaultValue={strokeJoinValue ?? "round"}
                          disabled={strokeJoinUnavailableReason !== null}
                          key={`${selectedEntity.id}/strokeJoin/${strokeJoinValue ?? "round"}`}
                          name="strokeJoin"
                          title={strokeJoinUnavailableReason ?? "Set the Pen segment join style"}
                        >
                          <option value="miter">Miter</option>
                          <option value="round">Round</option>
                          <option value="bevel">Bevel</option>
                        </select>
                        <button
                          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                          disabled={strokeJoinUnavailableReason !== null}
                          type="submit"
                        >
                          Set
                        </button>
                        {strokeJoinUnavailableReason ? (
                          <p className="basis-full text-[10px] leading-4 text-amber-500/80">
                            {strokeJoinUnavailableReason}
                          </p>
                        ) : null}
                      </form>
                    </dd>
                  </div>
                ) : null}
                {studioEntityTypeSupportsStrokeWidth(selectedEntity.type) ? (
                  <div className="contents">
                    <dt className="self-center text-zinc-600">Stroke width</dt>
                    <dd>
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          onEntityStrokeWidthChange(selectedEntity.id, Number(data.get("strokeWidth")));
                        }}
                      >
                        <input
                          aria-label={`Stroke width ${entityLabel(selectedEntity)}`}
                          className="h-7 min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-xs text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                          defaultValue={strokeWidthValue ?? 0.04}
                          disabled={!strokeWidthAvailable}
                          key={`${selectedEntity.id}/strokeWidth/${strokeWidthValue ?? 0.04}`}
                          max="0.5"
                          min="0.005"
                          name="strokeWidth"
                          step="0.005"
                          title={
                            strokeWidthAvailable
                              ? "Set the object stroke width in scene units"
                              : "Stroke width editing requires a supported Studio-created object at its creation time"
                          }
                          type="number"
                        />
                        <button
                          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                          disabled={!strokeWidthAvailable}
                          type="submit"
                        >
                          Set
                        </button>
                      </form>
                    </dd>
                  </div>
                ) : null}
                {strokeDashVisible ? (
                  <div className="contents">
                    <dt className="self-center text-zinc-600">Dash pattern</dt>
                    <dd>
                      <form
                        className="grid grid-cols-2 gap-1"
                        key={`${selectedEntity.id}/strokeDash/${strokeDashValue?.dashLength ?? "solid"}/${strokeDashValue?.gapLength ?? "solid"}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          onEntityStrokeDashChange(selectedEntity.id, {
                            dashLength: Number(data.get("dashLength")),
                            gapLength: Number(data.get("gapLength")),
                          });
                        }}
                      >
                        <input
                          aria-label={`Dash length ${entityLabel(selectedEntity)}`}
                          className="h-7 min-w-0 border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-xs text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                          defaultValue={strokeDashValue?.dashLength ?? 0.25}
                          disabled={strokeDashUnavailableReason !== null}
                          max="2"
                          min="0.02"
                          name="dashLength"
                          required
                          step="0.01"
                          title={strokeDashUnavailableReason ?? "Set the dash length in scene units"}
                          type="number"
                        />
                        <input
                          aria-label={`Gap length ${entityLabel(selectedEntity)}`}
                          className="h-7 min-w-0 border border-zinc-700 bg-zinc-950 px-1.5 font-mono text-xs text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-700"
                          defaultValue={strokeDashValue?.gapLength ?? 0.15}
                          disabled={strokeDashUnavailableReason !== null}
                          max="2"
                          min="0.02"
                          name="gapLength"
                          required
                          step="0.01"
                          title={strokeDashUnavailableReason ?? "Set the gap length in scene units"}
                          type="number"
                        />
                        <button
                          aria-label="Set dashed stroke"
                          className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                          disabled={strokeDashUnavailableReason !== null}
                          title={strokeDashUnavailableReason ?? "Apply this dash pattern"}
                          type="submit"
                        >
                          Set dashed
                        </button>
                        {strokeDashValue ? (
                          <button
                            aria-label="Use solid stroke"
                            className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                            disabled={strokeDashUnavailableReason !== null}
                            onClick={() => onEntityStrokeDashChange(selectedEntity.id, null)}
                            title={strokeDashUnavailableReason ?? "Remove the dash pattern"}
                            type="button"
                          >
                            Use solid
                          </button>
                        ) : null}
                        {strokeDashUnavailableReason ? (
                          <p className="col-span-2 text-[10px] leading-4 text-amber-500/80">
                            {strokeDashUnavailableReason}
                          </p>
                        ) : null}
                      </form>
                    </dd>
                  </div>
                ) : null}
                <dt className="self-center text-zinc-600">Opacity</dt>
                <dd>
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      onEntityOpacityChange(selectedEntity.id, Number(data.get("opacity")));
                    }}
                  >
                    <input
                      aria-label={`Opacity ${entityLabel(selectedEntity)}`}
                      className="h-7 min-w-0 w-20 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
                      defaultValue={opacityValue ?? undefined}
                      disabled={!opacityAvailable}
                      key={`${selectedEntity.id}/${opacityValue ?? "mixed"}`}
                      max="1"
                      min="0"
                      name="opacity"
                      placeholder={opacityAvailable && opacityValue === null ? "Mixed" : undefined}
                      required
                      step="0.05"
                      title={
                        opacityAvailable
                          ? "Set the object's absolute opacity"
                          : (opacityUnavailableReason ??
                            "Opacity requires a Studio-created object or a static updater-free source binding")
                      }
                      type="number"
                    />
                    <button
                      className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                      disabled={!opacityAvailable}
                      type="submit"
                    >
                      Set
                    </button>
                  </form>
                </dd>
                <dt className="self-center text-zinc-600">Scale</dt>
                <dd>
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      onEntityScaleChange(selectedEntity.id, Number(data.get("scale")));
                    }}
                  >
                    <input
                      aria-label={`Scale ${entityLabel(selectedEntity)}`}
                      className="h-7 min-w-0 w-20 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
                      defaultValue={selectedEntity.scale.toFixed(2)}
                      disabled={scaleUnknown}
                      key={`${selectedEntity.id}/${selectedEntity.scale.toFixed(4)}`}
                      max="8"
                      min="0.1"
                      name="scale"
                      step="0.05"
                      type="number"
                    />
                    <button
                      className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                      disabled={scaleUnknown}
                      type="submit"
                    >
                      Set
                    </button>
                  </form>
                </dd>
                <dt className="self-center text-zinc-600">Rotate</dt>
                <dd className="flex gap-1">
                  {([-15, 15] as const).map((degrees) => (
                    <button
                      aria-label={`Rotate ${entityLabel(selectedEntity)} ${degrees > 0 ? "counterclockwise" : "clockwise"} by ${Math.abs(degrees)} degrees`}
                      className="h-7 border border-zinc-700 px-2 text-[10px] tabular-nums text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-700 disabled:hover:bg-transparent"
                      disabled={!rotationAvailable}
                      key={degrees}
                      onClick={() => onEntityRotate(selectedEntity.id, (degrees * Math.PI) / 180)}
                      title={
                        rotationAvailable
                          ? `Create a ${degrees > 0 ? "+" : ""}${degrees}° rotation draft`
                          : "Rotation requires a Studio-created object without move, resize, scale, or motion edits, or an exact updater-free source binding"
                      }
                      type="button"
                    >
                      {degrees > 0 ? "+" : ""}
                      {degrees}°
                    </button>
                  ))}
                </dd>
              </dl>
              <EntityInspectorEditor
                entity={selectedEntity}
                key={entityInspectorKey(selectedEntity)}
                contentTransform={contentTransform}
                onCreateDraft={onEntityEdit}
                onFocusRestored={onInspectorFocusRestored}
                restoreFocus={inspectorReturnFocus}
                shapeTransform={shapeTransform}
              />
              {dataPlotAuthoring ? (
                <DataPlotEditor authoring={dataPlotAuthoring} key={dataPlotEditorAuthorityKey(dataPlotAuthoring)} />
              ) : null}
            </fieldset>
          ) : (
            <div className="mt-3 border border-dashed border-zinc-700 p-3">
              <p className="text-pretty text-xs leading-5 text-zinc-500">
                Select an imported object, drag it, or describe an edit with Magic Edit.
              </p>
            </div>
          )}
          {cameraAuthoring ? <CameraInspectorEditor authoring={cameraAuthoring} /> : null}
          {selectedEntityLocked ? (
            <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-500" role="status">
              Unlock this object in Layers before editing it.
            </p>
          ) : null}
          <FragmentMaterialEditor {...fragmentMaterial} objectEditingDisabled={selectedEntityLocked} />
          {geometryUnknowns.length > 0 ? (
            <section
              className="mt-3 border border-amber-950 bg-amber-950/20 p-2"
              aria-label="Approximate source geometry"
            >
              <h3 className="text-balance text-[10px] font-medium text-amber-300">Approximate source geometry</h3>
              <ul className="mt-1.5 space-y-1.5">
                {geometryUnknowns.map((unknownGeometry) => (
                  <li className="text-pretty text-[10px] leading-4 text-amber-200/70" key={unknownGeometry.label}>
                    <span className="font-medium text-amber-200">{unknownGeometry.label}:</span>{" "}
                    {unknownGeometry.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {appliedProgramCount > 0 ? (
            <p className="mt-3 text-pretty text-[10px] leading-4 text-zinc-600">
              Applied programs at the same source anchor are exported and rendered in their Studio order.
            </p>
          ) : null}
          {draftError ? (
            <p
              className="mt-3 border border-red-950 bg-red-950/30 p-2 text-pretty text-xs leading-5 text-red-300"
              role="alert"
            >
              {draftError}
            </p>
          ) : null}
        </section>
      )}

      {suggestion ? (
        <section className="mt-4 border-t border-zinc-800 pt-4">
          <h3 className="text-balance text-xs font-medium text-zinc-300">AI interpretation</h3>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400">{suggestion.summary}</p>
          {suggestion.assumptions.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] leading-4 text-zinc-600">
              {suggestion.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <RenderPipelinePanel
        candidate={renderCandidate}
        candidateLifecycleBlocker={renderCandidateLifecycleBlocker}
        candidateUnavailableReason={renderCandidateUnavailableReason}
        onSessionChange={onRenderSessionChange}
        onSourceChanged={onSourceChanged}
        onSourceMutationPendingChange={onSourceMutationPendingChange}
        session={renderSession}
        sourceExport={sourceExport}
        sourceExportBlocker={sourceExportBlocker}
        workspace={workspace}
      />
    </aside>
  );
}
