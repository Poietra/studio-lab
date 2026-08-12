import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
import { cn } from "../lib/cn";
import type {
  ManimWorkspaceView,
  OriginalManimSourceExportRequest,
  RenderSessionView,
} from "../render-pipeline/contracts";
import { RenderPipelinePanel } from "../render-pipeline/render-pipeline-panel";
import type { RenderProgramCandidate, RenderSourceRefreshTarget } from "../render-pipeline/render-pipeline-policy";
import { type StudioCommandId, shortcutLabel, studioCommand } from "./commands";
import { DraftInspector } from "./draft-inspector";
import { EntityInspectorEditor, entityInspectorKey } from "./entity-inspector";
import type { ManimWorkspaceScene } from "./imported-workspace";
import type { InspectorEditField, ValidatedInspectorEdits } from "./inspector-edit";
import type { ProgramRecord, ProjectedEntity } from "./model";
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
  appliedPrograms,
  appliedTransactionIds,
  authoringAvailable = true,
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
  authoringAvailable?: boolean;
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
                disabled={!authoringAvailable}
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
  draftApplyPending,
  draftError,
  draftOperation,
  draftProgram,
  onApplyDraft,
  onDiscardDraft,
  onDraftOperationChange,
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
  opacityValue,
  rotationAvailable,
  selectedEntity,
  inspectorReturnFocus,
  sourceExport,
  suggestion,
  workspace,
}: Readonly<{
  appliedProgramCount: number;
  authoringAvailable?: boolean;
  className?: string;
  draftApplyPending: boolean;
  draftError: string | null;
  draftOperation: EditSuggestionOperation | null;
  draftProgram: ProgramRecord | null;
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
  onDraftOperationChange: (operation: EditSuggestionOperation) => void;
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
  opacityValue: number | null;
  rotationAvailable: boolean;
  selectedEntity: ProjectedEntity | null;
  inspectorReturnFocus: InspectorEditField | null;
  sourceExport: OriginalManimSourceExportRequest | null;
  suggestion: EditSuggestion | null;
  workspace: ManimWorkspaceView | null;
}>) {
  const draftPosition = draftProgram ? directPositionDraft(draftProgram, selectedEntity) : null;
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
      {draftProgram ? (
        <>
          <DraftInspector
            applyLabel={replacingAppliedProgram ? "Replace program" : "Apply program"}
            editingDisabled={!authoringAvailable}
            error={draftError}
            isApplying={draftApplyPending}
            onApply={onApplyDraft}
            onDiscard={onDiscardDraft}
            onOperationChange={onDraftOperationChange}
            operation={draftOperation}
            record={draftProgram}
          />
          <fieldset className="m-0 min-w-0 border-0 p-0 disabled:opacity-60" disabled={!authoringAvailable}>
            {draftPosition && selectedEntity ? (
              <DraftPositionRefinement
                entity={selectedEntity}
                key={`${draftProgram.program.transactionId}/${draftPosition.x}/${draftPosition.y}`}
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
            <fieldset className="m-0 min-w-0 border-0 p-0 disabled:opacity-60" disabled={!authoringAvailable}>
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
                          ? "Set the source object's absolute opacity"
                          : "Opacity requires a static updater-free Runtime Trace binding at t=0"
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
                          ? `Create a ${degrees > 0 ? "+" : ""}${degrees}° source rotation draft`
                          : "Rotation requires an exact updater-free Runtime Trace binding at t=0"
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
        workspace={workspace}
      />
    </aside>
  );
}
