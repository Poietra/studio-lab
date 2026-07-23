import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
import { cn } from "../lib/cn";
import type {
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  RenderSessionView,
} from "../render-pipeline/contracts";
import { RenderPipelinePanel, type RenderProgramCandidate } from "../render-pipeline/render-pipeline-panel";
import { DraftInspector } from "./draft-inspector";
import type { ManimWorkspaceScene } from "./imported-workspace";
import type { EntityDimensions, ProgramRecord, ProjectedEntity } from "./model";
import { shortcutLabel, studioCommand, type StudioCommandId } from "./commands";
import { entityLabel } from "./studio-viewport";

const SIDEBAR_SHORTCUTS: readonly StudioCommandId[] = [
  "select-tool",
  "insert-text",
  "insert-mathtex",
  "insert-rectangle",
  "insert-circle",
  "insert-line",
  "insert-arrow",
  "undo",
  "redo",
  "duplicate",
  "delete",
  "copy",
  "paste",
  "select-all",
  "play-pause",
];

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

export function WorkspaceSidebar({
  activeScene,
  appliedProgramReadOnlyReasons,
  appliedPrograms,
  appliedTransactionIds,
  className,
  draftActive,
  duration,
  editingAppliedTransactionId,
  durationError,
  durationMinimum,
  entities,
  nextScene,
  onDurationChange,
  onEditAppliedProgram,
  onRedo,
  onToggleEntity,
  onUndo,
  redoCount,
  selectedIds,
}: Readonly<{
  activeScene: ManimWorkspaceScene;
  appliedProgramReadOnlyReasons: Readonly<Record<string, string | null>>;
  appliedPrograms: readonly ProgramRecord[];
  appliedTransactionIds: ReadonlySet<string>;
  className?: string;
  draftActive: boolean;
  duration: number;
  editingAppliedTransactionId: string | null;
  durationError: string | null;
  durationMinimum: number;
  entities: readonly ProjectedEntity[];
  nextScene: ManimWorkspaceScene | null;
  onDurationChange: (duration: number) => void;
  onEditAppliedProgram: (record: ProgramRecord, index: number) => void;
  onRedo: () => void;
  onToggleEntity: (entityId: string, selected: boolean) => void;
  onUndo: () => void;
  redoCount: number;
  selectedIds: ReadonlySet<string>;
}>) {
  return (
    <aside className={cn("min-h-0 overflow-y-auto bg-zinc-950 p-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-balance text-xs font-medium text-zinc-300">Objects</h2>
        <span className="tabular-nums text-[10px] text-zinc-600">{entities.length}</span>
      </div>
      <p className="mt-1 truncate text-[10px] text-zinc-600" title={activeScene.sceneId}>
        {activeScene.name}
      </p>
      <ul className="mt-3 space-y-1">
        {entities.map((entity) => {
          const selected = selectedIds.has(entity.id);
          const locked =
            entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId));
          return (
            <li key={entity.id}>
              <label
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 text-xs",
                  locked ? "cursor-not-allowed text-zinc-600" : "cursor-pointer",
                  selected ? "bg-sky-950 text-sky-200" : "text-zinc-400 hover:bg-zinc-900",
                )}
              >
                <input
                  aria-label={`Select ${entityLabel(entity)}`}
                  checked={selected}
                  className="size-3.5 accent-sky-400"
                  disabled={locked || !entity.present}
                  onChange={() => onToggleEntity(entity.id, selected)}
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 truncate">{entityLabel(entity)}</span>
                <span className="shrink-0 text-[10px] text-zinc-600">{entity.type}</span>
              </label>
            </li>
          );
        })}
      </ul>

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
                min="0.1"
                name="duration"
                step="0.1"
                type="number"
              />
              <button
                className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
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
            {appliedPrograms.length > 0 ? (
              <button
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
                aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
                className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200"
                onClick={onRedo}
                type="button"
              >
                Redo
              </button>
            ) : null}
          </div>
        </div>
        {appliedPrograms.length > 0 ? (
          <ol className="mt-2 space-y-1">
            {appliedPrograms.map((record, index) => {
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
                        disabled={draftActive}
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
  className,
  draftApplyPending,
  draftError,
  draftOperation,
  draftProgram,
  onApplyDraft,
  onDiscardDraft,
  onDraftOperationChange,
  onEntityDimensionsChange,
  onEntityScaleChange,
  onRenderSessionChange,
  onSourceChanged,
  renderCandidate,
  renderCandidateUnavailableReason,
  renderSession,
  replacingAppliedProgram,
  selectedEntity,
  sourceExport,
  suggestion,
  workspace,
}: Readonly<{
  appliedProgramCount: number;
  className?: string;
  draftApplyPending: boolean;
  draftError: string | null;
  draftOperation: EditSuggestionOperation | null;
  draftProgram: ProgramRecord | null;
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
  onDraftOperationChange: (operation: EditSuggestionOperation) => void;
  onEntityDimensionsChange: (entityId: string, dimensions: EntityDimensions) => void;
  onEntityScaleChange: (entityId: string, scale: number) => void;
  onRenderSessionChange: (session: RenderSessionView | null, projectId?: string) => void;
  onSourceChanged: () => void | Promise<void>;
  renderCandidate: RenderProgramCandidate | null;
  renderCandidateUnavailableReason: string;
  renderSession: RenderSessionView | null;
  replacingAppliedProgram: boolean;
  selectedEntity: ProjectedEntity | null;
  sourceExport: OriginalManimSourceExportRequest | null;
  suggestion: EditSuggestion | null;
  workspace: ManimWorkspaceView | null;
}>) {
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
  const editableDimensions = selectedEntity?.geometry.dimensions.kind === "known"
    && selectedEntity.geometry.position.kind === "known"
    && selectedEntity.geometry.scale.kind === "known"
    && (selectedEntity.type === "Circle" || selectedEntity.type === "Rectangle")
    ? selectedEntity.geometry.dimensions.value
    : null;
  return (
    <aside className={cn("min-h-0 overflow-y-auto bg-zinc-950 p-3", className)}>
      {draftProgram ? (
        <DraftInspector
          applyLabel={replacingAppliedProgram ? "Replace program" : "Apply program"}
          error={draftError}
          isApplying={draftApplyPending}
          onApply={onApplyDraft}
          onDiscard={onDiscardDraft}
          onOperationChange={onDraftOperationChange}
          operation={draftOperation}
          record={draftProgram}
        />
      ) : (
        <section>
          <h2 className="text-balance text-sm font-medium text-zinc-100">Inspector</h2>
          {selectedEntity ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-2 text-xs">
              <dt className="text-zinc-600">Object</dt>
              <dd className="truncate text-zinc-300">{entityLabel(selectedEntity)}</dd>
              <dt className="text-zinc-600">Type</dt>
              <dd className="text-zinc-300">{selectedEntity.type}</dd>
              <dt className="text-zinc-600">Source</dt>
              <dd className="truncate font-mono text-[10px] text-zinc-400">
                {selectedEntity.sourceIdentity.kind === "known" ? selectedEntity.sourceIdentity.value : "not committed"}
              </dd>
              <dt className="text-zinc-600">Position</dt>
              <dd className="tabular-nums text-zinc-300">
                {selectedEntity.geometry.position.kind === "unknown" ? "≈ " : ""}
                {selectedEntity.position.x.toFixed(1)}, {selectedEntity.position.y.toFixed(1)}
              </dd>
              <dt className="text-zinc-600">Dimensions</dt>
              <dd className="text-zinc-300">
                {editableDimensions ? (
                  <form
                    className="flex flex-wrap items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      onEntityDimensionsChange(selectedEntity.id, selectedEntity.type === "Circle"
                        ? { radius: Number(data.get("radius")) }
                        : { height: Number(data.get("height")), width: Number(data.get("width")) });
                    }}
                  >
                    {selectedEntity.type === "Circle" ? (
                      <input
                        aria-label={`Radius of ${entityLabel(selectedEntity)}`}
                        className="h-7 w-20 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
                        defaultValue={editableDimensions.radius?.toFixed(2)}
                        key={`${selectedEntity.id}/radius/${editableDimensions.radius}`}
                        min="0.1"
                        name="radius"
                        required
                        step="0.1"
                        type="number"
                      />
                    ) : (
                      <>
                        <input
                          aria-label={`Width of ${entityLabel(selectedEntity)}`}
                          className="h-7 w-16 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
                          defaultValue={editableDimensions.width?.toFixed(2)}
                          key={`${selectedEntity.id}/width/${editableDimensions.width}`}
                          min="0.1"
                          name="width"
                          required
                          step="0.1"
                          type="number"
                        />
                        <input
                          aria-label={`Height of ${entityLabel(selectedEntity)}`}
                          className="h-7 w-16 border border-zinc-700 bg-zinc-950 px-1.5 tabular-nums text-xs text-zinc-300 outline-none focus:border-sky-500"
                          defaultValue={editableDimensions.height?.toFixed(2)}
                          key={`${selectedEntity.id}/height/${editableDimensions.height}`}
                          min="0.1"
                          name="height"
                          required
                          step="0.1"
                          type="number"
                        />
                      </>
                    )}
                    <button
                      className="h-7 border border-zinc-700 px-1.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                      type="submit"
                    >
                      Set
                    </button>
                  </form>
                ) : dimensionSummary(selectedEntity)}
              </dd>
              <dt className="text-zinc-600">Style</dt>
              <dd className="truncate text-zinc-300" title={styleSummary(selectedEntity)}>
                {styleSummary(selectedEntity)}
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
            </dl>
          ) : (
            <div className="mt-3 border border-dashed border-zinc-700 p-3">
              <p className="text-pretty text-xs leading-5 text-zinc-500">
                Select an imported object, drag it, or describe an edit with Magic Edit.
              </p>
            </div>
          )}
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
        candidateUnavailableReason={renderCandidateUnavailableReason}
        onSessionChange={onRenderSessionChange}
        onSourceChanged={onSourceChanged}
        session={renderSession}
        sourceExport={sourceExport}
        workspace={workspace}
      />
    </aside>
  );
}
