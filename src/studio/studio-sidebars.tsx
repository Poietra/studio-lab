import type { EditSuggestion, EditSuggestionOperation } from "../ai/edit-suggestions";
import { cn } from "../lib/cn";
import type { ManimWorkspaceView } from "../render-pipeline/contracts";
import { RenderPipelinePanel, type RenderProgramCandidate } from "../render-pipeline/render-pipeline-panel";
import { DraftInspector } from "./draft-inspector";
import type { ManimWorkspaceScene } from "./imported-workspace";
import type { ProgramRecord, ProjectedEntity } from "./model";
import { entityLabel } from "./studio-viewport";

export function WorkspaceSidebar({
  activeScene,
  appliedPrograms,
  appliedTransactionIds,
  duration,
  entities,
  nextScene,
  onToggleEntity,
  onUndo,
  selectedIds,
}: Readonly<{
  activeScene: ManimWorkspaceScene;
  appliedPrograms: readonly ProgramRecord[];
  appliedTransactionIds: ReadonlySet<string>;
  duration: number;
  entities: readonly ProjectedEntity[];
  nextScene: ManimWorkspaceScene | null;
  onToggleEntity: (entityId: string, selected: boolean) => void;
  onUndo: () => void;
  selectedIds: ReadonlySet<string>;
}>) {
  return (
    <aside className="min-h-0 overflow-y-auto bg-zinc-950 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-balance text-xs font-medium text-zinc-300">Imported objects</h2>
        <span className="tabular-nums text-[10px] text-zinc-600">{entities.length}</span>
      </div>
      <p className="mt-1 truncate text-[10px] text-zinc-600" title={activeScene.sceneId}>{activeScene.name}</p>
      <ul className="mt-3 space-y-1">
        {entities.map((entity) => {
          const selected = selectedIds.has(entity.id);
          const locked = entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId));
          return (
            <li key={entity.id}>
              <label className={cn(
                "flex items-center gap-2 px-2 py-1.5 text-xs",
                locked ? "cursor-not-allowed text-zinc-600" : "cursor-pointer",
                selected ? "bg-sky-950 text-sky-200" : "text-zinc-400 hover:bg-zinc-900",
              )}>
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
          <dd className="tabular-nums text-zinc-400">{duration.toFixed(2)}s</dd>
          <dt className="text-zinc-600">Anchors</dt>
          <dd className="tabular-nums text-zinc-400">{activeScene.anchors.map((anchor) => anchor.toFixed(2)).join(", ") || "none"}</dd>
        </dl>
      </section>

      <section className="mt-5 border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-balance text-xs font-medium text-zinc-300">Applied programs</h2>
          {appliedPrograms.length > 0 ? (
            <button className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200" onClick={onUndo} type="button">
              Undo last
            </button>
          ) : null}
        </div>
        {appliedPrograms.length > 0 ? (
          <ol className="mt-2 space-y-1">
            {appliedPrograms.map((record, index) => (
              <li className="truncate border border-zinc-800 px-2 py-1.5 font-mono text-[10px] text-zinc-500" key={record.program.transactionId}>
                {index + 1}. {record.program.intentCount} intents · {record.program.transactionId}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-zinc-600">Apply a draft to add it to the Scene working state.</p>
        )}
      </section>
    </aside>
  );
}

export function StudioInspector({
  appliedProgramCount,
  draftError,
  draftOperation,
  draftProgram,
  onApplyDraft,
  onDiscardDraft,
  onDraftOperationChange,
  onSourceChanged,
  renderCandidate,
  selectedEntity,
  suggestion,
  workspace,
}: Readonly<{
  appliedProgramCount: number;
  draftError: string | null;
  draftOperation: EditSuggestionOperation | null;
  draftProgram: ProgramRecord | null;
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
  onDraftOperationChange: (operation: EditSuggestionOperation) => void;
  onSourceChanged: () => void | Promise<void>;
  renderCandidate: RenderProgramCandidate | null;
  selectedEntity: ProjectedEntity | null;
  suggestion: EditSuggestion | null;
  workspace: ManimWorkspaceView | null;
}>) {
  return (
    <aside className="min-h-0 overflow-y-auto bg-zinc-950 p-3">
      {draftProgram ? (
        <DraftInspector
          error={draftError}
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
              <dd className="tabular-nums text-zinc-300">{selectedEntity.position.x.toFixed(1)}, {selectedEntity.position.y.toFixed(1)}</dd>
            </dl>
          ) : (
            <div className="mt-3 border border-dashed border-zinc-700 p-3">
              <p className="text-pretty text-xs leading-5 text-zinc-500">Select an imported object, drag it, or describe an edit with Magic Edit.</p>
            </div>
          )}
          {appliedProgramCount > 0 ? (
            <p className="mt-3 text-pretty text-[10px] leading-4 text-zinc-600">
              The last applied program remains available for rendered validation until another draft is created.
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
              {suggestion.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          ) : null}
        </section>
      ) : null}

      <RenderPipelinePanel
        candidate={renderCandidate}
        candidateUnavailableReason="Create or apply a Canonical draft to enable rendered validation."
        onSourceChanged={onSourceChanged}
        workspace={workspace}
      />
    </aside>
  );
}
