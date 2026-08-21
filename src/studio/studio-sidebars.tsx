import { type DragEvent, useEffect, useRef, useState } from "react";
import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
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
import { DraftInspector } from "./draft-inspector";
import { EntityInspectorEditor, entityInspectorKey } from "./entity-inspector";
import type {
  StudioFragmentMaterialParameterSchemaV1,
  StudioFragmentMaterialParameterValueV1,
  StudioFragmentMaterialPresetId,
  StudioFragmentMaterialRemovalResolution,
} from "./fragment-material-authoring";
import { FragmentMaterialEditor, type FragmentMaterialEditorItem } from "./fragment-material-editor";
import type { InspectorEditField, ValidatedInspectorEdits } from "./inspector-edit";
import type { StudioLayerEntry, StudioLayerOrderDirection } from "./layer-order";
import type { ProgramRecord, ProjectedEntity } from "./model";
import type { StudioNativeImageAssetV1 } from "./studio-image-assets";
import type { AuthorableWorkspaceScene } from "./studio-native-workspace";
import { entityLabel } from "./studio-viewport";

const SIDEBAR_SHORTCUTS: readonly StudioCommandId[] = [
  "select-tool",
  "insert-text",
  "insert-mathtex",
  "insert-rectangle",
  "insert-circle",
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
      <img alt={asset.label} className="size-full object-contain" src={source ?? undefined} />
    </div>
  );
}

function dimensionSummary(entity: ProjectedEntity) {
  if (entity.geometry.dimensions.kind === "unknown") return "Runtime-dependent";
  const { height, radius, width } = entity.geometry.dimensions.value;
  const values = [
    radius === undefined ? null : `r ${radius}`,
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
  appliedProgramReadOnlyReasons,
  appliedEdits,
  appliedTransactionIds,
  authoringAvailable = true,
  className,
  draftActive,
  duration,
  editingAppliedTransactionId,
  durationError,
  durationMinimum,
  entities,
  groupUnavailableReason = "Select at least two contiguous Studio-created objects.",
  imageAssets = [],
  imageImportError = null,
  imageImportPending = false,
  layers,
  lockToggleDisabled = false,
  lockedEntityIds = new Set(),
  nextScene,
  onGroup,
  onImportImageFiles,
  onDurationChange,
  onAddImageAsset,
  onEditAppliedProgram,
  onLayerGroupOrder,
  onLayerGroupReorder,
  onLayerOrder,
  onLayerReorder,
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
  selectedIds,
  selectedGroupId = null,
  sourceImportOutcomes,
  undoAvailable = appliedEdits.length > 0,
}: Readonly<{
  activeScene: AuthorableWorkspaceScene;
  appliedProgramReadOnlyReasons: Readonly<Record<string, string | null>>;
  appliedEdits: readonly ProgramRecord[];
  appliedTransactionIds: ReadonlySet<string>;
  authoringAvailable?: boolean;
  className?: string;
  draftActive: boolean;
  duration: number;
  editingAppliedTransactionId: string | null;
  durationError: string | null;
  durationMinimum: number;
  entities: readonly ProjectedEntity[];
  groupUnavailableReason?: string | null;
  imageAssets?: readonly StudioNativeImageAssetV1[];
  imageImportError?: string | null;
  imageImportPending?: boolean;
  layers?: readonly StudioLayerEntry[];
  lockToggleDisabled?: boolean;
  lockedEntityIds?: ReadonlySet<string>;
  nextScene: AuthorableWorkspaceScene | null;
  onGroup?: () => void;
  onImportImageFiles?: (files: readonly File[]) => void;
  onDurationChange: (duration: number) => void;
  onAddImageAsset?: (asset: StudioNativeImageAssetV1) => void;
  onEditAppliedProgram: (record: ProgramRecord, index: number) => void;
  onLayerGroupOrder?: (groupId: string, direction: StudioLayerOrderDirection) => void;
  onLayerGroupReorder?: (groupId: string, frontFirstIndex: number) => void;
  onLayerOrder?: (entityId: string, direction: StudioLayerOrderDirection) => void;
  onLayerReorder?: (entityId: string, frontFirstIndex: number) => void;
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
  selectedIds: ReadonlySet<string>;
  selectedGroupId?: string | null;
  sourceImportOutcomes: readonly ManimSourceImportOutcome[];
  undoAvailable?: boolean;
}>) {
  const imageFileInput = useRef<HTMLInputElement | null>(null);
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
  return (
    <aside className={cn("min-h-0 overflow-y-auto bg-zinc-950 p-3", className)}>
      <section className="mb-4 border-b border-zinc-800 pb-4" aria-labelledby="studio-assets-heading">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-balance text-xs font-medium text-zinc-300" id="studio-assets-heading">
            Assets
          </h2>
          <div className="flex items-center gap-2">
            <span className="tabular-nums text-[10px] text-zinc-600">{imageAssets.length}</span>
            {onImportImageFiles ? (
              <>
                <input
                  accept="image/png,.png"
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
                  {imageImportPending ? "Importing…" : "+ Import PNG"}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <h3 className="mt-2 text-[10px] font-medium text-zinc-500">Images</h3>
        {imageAssets.length === 0 ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
            No verified project image is available in this Scene.
          </p>
        ) : (
          <ul className="mt-2 space-y-1" aria-label="Project images">
            {imageAssets.map((asset) => (
              <li
                className="border border-zinc-800 p-2"
                key={`${asset.image.asset.assetId}:${asset.image.asset.sha256}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <NativeImageThumbnail asset={asset} />
                    <div className="min-w-0">
                      <p className="truncate text-xs text-zinc-300">{asset.label}</p>
                      <p className="mt-0.5 tabular-nums text-[10px] text-zinc-600">
                        {asset.pixelWidth} × {asset.pixelHeight}
                      </p>
                    </div>
                  </div>
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
            ))}
          </ul>
        )}
        <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">
          Studio-native Images use canonical Preview and MP4 export. Manim source export is unsupported.
        </p>
        {imageImportError ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-red-300" role="alert">
            {imageImportError}
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
                aria-describedby={durationError ? "scene-duration-error" : "scene-duration-hint"}
                disabled={!authoringAvailable}
                min="0.1"
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
            {durationError ? (
              <p className="mt-1 text-pretty text-[10px] leading-4 text-red-300" id="scene-duration-error" role="alert">
                {durationError}
              </p>
            ) : null}
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
  onApplyDraft,
  onDiscardDraft,
  onDraftOperationChange,
  onEntityColorChange,
  onEntityEdit,
  onEntityOpacityChange,
  onEntityRotate,
  onEntityScaleChange,
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
  inspectorReturnFocus,
  sourceExport,
  sourceExportBlocker = null,
  strokeColorValue,
  suggestion,
  workspace,
}: Readonly<{
  appliedProgramCount: number;
  authoringAvailable?: boolean;
  className?: string;
  colorAvailable: boolean;
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
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
  onDraftOperationChange: (operation: EditSuggestionOperation) => void;
  onEntityColorChange: (entityId: string, property: "fillColor" | "strokeColor", color: string) => void;
  onEntityEdit: (entityId: string, edits: ValidatedInspectorEdits, returnFocus: InspectorEditField) => boolean;
  onEntityOpacityChange: (entityId: string, opacity: number) => void;
  onEntityRotate: (entityId: string, angleRadians: number) => void;
  onEntityScaleChange: (entityId: string, scale: number) => void;
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
  inspectorReturnFocus: InspectorEditField | null;
  sourceExport: OriginalManimSourceExportRequest | null;
  sourceExportBlocker?: string | null;
  strokeColorValue: string | null;
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
                {selectedEntity.type === "Circle" || selectedEntity.type === "Rectangle"
                  ? (
                      [
                        ["Fill", "fillColor", fillColorValue],
                        ["Stroke", "strokeColor", strokeColorValue],
                      ] as const
                    ).map(([label, property, value]) => (
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
                                    ? "Set a solid fill color and enable the shape fill"
                                    : "Set the shape stroke color"
                                  : "Color editing currently requires a Studio-created circle or rectangle at its creation time"
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
                    ))
                  : null}
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
                onCreateDraft={onEntityEdit}
                onFocusRestored={onInspectorFocusRestored}
                restoreFocus={inspectorReturnFocus}
              />
            </fieldset>
          ) : (
            <div className="mt-3 border border-dashed border-zinc-700 p-3">
              <p className="text-pretty text-xs leading-5 text-zinc-500">
                Select an imported object, drag it, or describe an edit with Magic Edit.
              </p>
            </div>
          )}
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
