import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { LazyMotion } from "motion/react";

import {
  createClarificationContextFingerprint,
  MAX_CLARIFICATION_HISTORY,
  type PendingClarification,
} from "./ai/clarification";
import {
  type ClarificationOption,
  type CreateMotionSuggestion,
  type EditSuggestion,
  type EditSuggestionOperation,
  suggestEdit,
} from "./ai/edit-suggestions";
import type { RenderProgramCandidate } from "./render-pipeline/render-pipeline-panel";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./studio/draft-validation";
import type { ProgramRecord } from "./studio/model";
import type { OperationOrigin } from "./studio/operations";
import { MagicEditPanel, type SuggestionStatus } from "./studio/magic-edit-panel";
import {
  createDirectManipulationPositionProgram,
} from "./studio/suggestion-program";
import {
  type EntityDragPreview,
  type InteractionMode,
  STUDIO_VIEWPORT,
  StudioViewport,
} from "./studio/studio-viewport";
import { StudioInspector, WorkspaceSidebar } from "./studio/studio-sidebars";
import { useManimWorkspace } from "./studio/use-manim-workspace";
import { isTransitionOverlay, projectStudioWorkspace } from "./studio/workspace-projection";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);
const NUDGE_DELTAS: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  ArrowDown: { x: 0, y: 2 },
  ArrowLeft: { x: -2, y: 0 },
  ArrowRight: { x: 2, y: 0 },
  ArrowUp: { x: 0, y: -2 },
};

function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function operationHasSceneBoundary(record: ProgramRecord) {
  return record.program.operations.some((operation) => operation.kind === "InsertSceneBoundary");
}

export function App() {
  const shell = detectShell();
  const aiEndpointConfigured = Boolean(import.meta.env.VITE_POIETRA_AI_ENDPOINT);
  const {
    activeScene,
    activeSceneId,
    error: workspaceError,
    nextScene,
    refresh: refreshWorkspace,
    scenes,
    setActiveSceneId,
    status: workspaceStatus,
    workspace,
  } = useManimWorkspace();
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("animate");
  const [selectedObjectIds, setSelectedObjectIds] = useState<readonly string[]>([]);
  const [appliedPrograms, setAppliedPrograms] = useState<readonly ProgramRecord[]>([]);
  const [draftProgram, setDraftProgram] = useState<ProgramRecord | null>(null);
  const [draftOperation, setDraftOperation] = useState<EditSuggestionOperation | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<EditSuggestion | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState<SuggestionStatus>("idle");
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [pendingClarification, setPendingClarification] = useState<PendingClarification | null>(null);
  const [isMagicEditVisible, setIsMagicEditVisible] = useState(true);
  const [dragPreview, setDragPreview] = useState<EntityDragPreview | null>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const suggestionContext = useRef("");
  const canvasDrag = useRef<Readonly<{
    entityId: string;
    pointerId: number;
    start: Readonly<{ x: number; y: number }>;
  }> | null>(null);
  const workspaceBounds = useRef<HTMLElement | null>(null);

  useEffect(() => () => suggestionRequest.current?.abort(), []);

  useEffect(() => {
    if (!activeScene) return;
    suggestionRequest.current?.abort();
    suggestionRequest.current = null;
    const initialTime = activeScene.anchors[0] ?? 0;
    const initialEntities = Object.values(activeScene.runtimeSceneState.objectGraph.entities)
      .filter((entity) => entity.lifetime.some((lifetime) => initialTime >= lifetime.start && initialTime < lifetime.end));
    setCurrentTime(clamp(initialTime, 0, activeScene.runtimeSceneState.duration));
    setSelectedObjectIds(initialEntities.slice(0, 1).map((entity) => entity.id));
    setAppliedPrograms([]);
    setDraftProgram(null);
    setDraftOperation(null);
    setDraftError(null);
    setSuggestion(null);
    setPendingClarification(null);
    setSuggestionStatus("idle");
    setSuggestionMessage(null);
    setIsPlaying(false);
  }, [activeScene?.sceneId, activeScene?.sourceHash]);

  useEffect(() => {
    if (!isPlaying || !activeScene) return;
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setCurrentTime((time) => {
        const next = time + delta;
        if (next >= activeScene.runtimeSceneState.duration) {
          setIsPlaying(false);
          return activeScene.runtimeSceneState.duration;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [activeScene, isPlaying]);

  const workspaceProjection = activeScene ? projectStudioWorkspace({
    activeScene,
    appliedPrograms,
    currentTime,
    draftProgram,
    nextScene,
    selectedObjectIds,
  }) : null;
  const draftBaseProjection = activeScene && draftProgram ? projectStudioWorkspace({
    activeScene,
    appliedPrograms,
    currentTime,
    draftProgram: null,
    nextScene,
    selectedObjectIds,
  }) : workspaceProjection;
  const draftBaseState = draftBaseProjection?.proposedState ?? null;
  const projection = workspaceProjection?.projection ?? null;
  const appliedTransactionIds = new Set(appliedPrograms.map((record) => record.program.transactionId));
  const boundary = workspaceProjection?.boundary ?? null;
  const visibleEntities = workspaceProjection?.visibleEntities ?? [];
  const editableEntities = workspaceProjection?.editableEntities ?? [];
  const selectedSet = new Set(selectedObjectIds);
  const activeDuration = activeScene?.runtimeSceneState.duration ?? 1;
  const contextFingerprint = draftBaseState ? createClarificationContextFingerprint({
    entities: Object.values(draftBaseState.evaluatedScene.objectGraph.entities),
    playhead: currentTime,
    selection: selectedObjectIds,
  }) : "";
  const clarificationIsStale = pendingClarification !== null
    && pendingClarification.contextFingerprint !== contextFingerprint;
  suggestionContext.current = activeScene ? `${activeScene.sourceHash}:${contextFingerprint}` : "";

  function createValidatedDraft(
    operation: EditSuggestionOperation,
    transactionId: string,
    origin: OperationOrigin,
  ) {
    if (!activeScene || !draftBaseState) throw new Error("Choose an imported Scene first.");
    const validation = validateSuggestionDraft(operation, {
      capturedPlayhead: currentTime,
      hasNextScene: nextScene !== null,
      origin,
      proposedState: draftBaseState,
      selectedObjectIds,
      transactionId,
    });
    if (validation.kind === "invalid") throw new Error(validation.message);
    return validation;
  }

  function installDraft(
    operation: EditSuggestionOperation,
    transactionId: string,
    origin: OperationOrigin = "remote-model",
  ) {
    try {
      const validated = createValidatedDraft(operation, transactionId, origin);
      setDraftOperation(validated.operation);
      setDraftProgram(validated.record);
      setDraftError(null);
      setCurrentTime(validated.record.program.anchor.resolvedSeconds);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The draft could not be validated.");
      return false;
    }
  }

  function updateDraftOperation(operation: EditSuggestionOperation) {
    if (!draftProgram) return;
    if (installDraft(operation, draftProgram.program.transactionId, draftProgram.program.provenance.origin)) {
      setSuggestion((current) => current ? { ...current, operation } : current);
    }
  }

  async function requestEditSuggestion(selectedOption?: ClarificationOption) {
    if (!activeScene || !draftBaseState) return;
    const pending = pendingClarification;
    const requestedContext = suggestionContext.current;
    const answerText = instruction.trim();
    const prompt = pending?.originalPrompt ?? answerText;
    if (!prompt || suggestionStatus === "loading") return;
    if (pending && clarificationIsStale) {
      setSuggestionMessage("The Scene, playhead, or selection changed after this question. Edit the original request and try again.");
      setSuggestionStatus("error");
      return;
    }
    const clarificationAnswer = pending
      ? selectedOption
        ? { kind: "option" as const, optionId: selectedOption.id }
        : { kind: "text" as const, text: answerText }
      : null;
    if (pending && !clarificationAnswer) return;
    suggestionRequest.current?.abort();
    const controller = new AbortController();
    suggestionRequest.current = controller;
    setIsPlaying(false);
    setSuggestionStatus("loading");
    setSuggestionMessage(null);
    setDraftError(null);
    try {
      const result = await suggestEdit({
        clarification: pending && clarificationAnswer ? {
          answer: clarificationAnswer,
          history: pending.history,
          options: pending.options,
          question: pending.question,
        } : null,
        objects: Object.values(draftBaseState.evaluatedScene.objectGraph.entities)
          .filter((entity) => !isTransitionOverlay(entity))
          .map((entity) => ({
            displayName: entity.content?.label ?? entity.id,
            id: entity.id,
            lifetimes: entity.lifetime,
            mathTex: entity.type === "MathTex" && entity.content?.texParts ? {
              displayLines: entity.content.displayLines,
              texParts: entity.content.texParts,
            } : null,
            type: entity.type,
          })),
        playhead: currentTime,
        prompt,
        scene: {
          id: activeScene.sceneId,
          name: activeScene.name,
          nextSceneId: activeScene.nextSceneId,
        },
        sceneDuration: draftBaseState.evaluatedScene.duration,
        selectedObjectIds,
      }, { signal: controller.signal });
      if (suggestionContext.current !== requestedContext) {
        setSuggestion(null);
        setSuggestionMessage("The Scene, playhead, or selection changed while Magic Edit was thinking. Try the request again in the current context.");
        setSuggestionStatus("error");
        return;
      }
      if (result.kind === "clarification") {
        const history = pending && clarificationAnswer ? [...pending.history, {
          answer: clarificationAnswer,
          options: pending.options,
          question: pending.question,
        }].slice(-MAX_CLARIFICATION_HISTORY) : [];
        setPendingClarification({
          contextFingerprint,
          history,
          options: result.options,
          originalPrompt: pending?.originalPrompt ?? prompt,
          question: result.message,
        });
        setInstruction("");
        setSuggestion(null);
        setSuggestionMessage(result.message);
        setSuggestionStatus("clarification");
        return;
      }
      const transactionId = `studio-edit-${crypto.randomUUID()}`;
      const installed = installDraft(result.suggestion.operation, transactionId);
      if (!installed) {
        setSuggestion(null);
        setSuggestionStatus("error");
        return;
      }
      setPendingClarification(null);
      setSuggestion(result.suggestion);
      setSuggestionMessage(null);
      setSuggestionStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSuggestion(null);
      setSuggestionMessage(error instanceof Error ? error.message : "Could not generate an edit suggestion.");
      setSuggestionStatus("error");
    } finally {
      if (suggestionRequest.current === controller) suggestionRequest.current = null;
    }
  }

  function editClarificationRequest() {
    if (!pendingClarification) return;
    setInstruction(pendingClarification.originalPrompt);
    setPendingClarification(null);
    setSuggestionStatus("idle");
    setSuggestionMessage(null);
  }

  function discardDraft() {
    setDraftProgram(null);
    setDraftOperation(null);
    setDraftError(null);
    setSuggestion(null);
    setSuggestionMessage(null);
    setSuggestionStatus("idle");
  }

  function applyDraft() {
    if (!draftProgram) return;
    setAppliedPrograms((programs) => [...programs, draftProgram]);
    setDraftProgram(null);
    setDraftOperation(null);
    setDraftError(null);
    setSuggestion(null);
    setSuggestionStatus("idle");
  }

  function undoProgram() {
    setAppliedPrograms((programs) => programs.slice(0, -1));
    setSelectedObjectIds([]);
  }

  function beginEntityDrag(event: PointerEvent<HTMLButtonElement>, entityId: string) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const editable = entity && (!entity.provisional || (entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
    if (!editable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedObjectIds((selection) => selection.includes(entityId) ? selection : [entityId]);
    canvasDrag.current = {
      entityId,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
    };
    setDragPreview({ delta: { x: 0, y: 0 }, entityId });
  }

  function moveEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = canvasDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragPreview({
      delta: { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y },
      entityId: drag.entityId,
    });
  }

  function finishEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = canvasDrag.current;
    canvasDrag.current = null;
    setDragPreview(null);
    if (!drag || drag.pointerId !== event.pointerId || !activeScene || !draftBaseState) return;
    const delta = { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y };
    if (Math.hypot(delta.x, delta.y) < 1) return;
    const targetIds = selectedObjectIds.includes(drag.entityId) ? selectedObjectIds : [drag.entityId];
    const transactionId = `studio-gesture-${crypto.randomUUID()}`;
    if (interactionMode === "animate") {
      const end = Math.min(activeDuration, currentTime + 1.5);
      if (end - currentTime < 0.1) {
        setDraftError("Move the playhead earlier to create a movement of at least 0.1 seconds.");
        return;
      }
      const operation: CreateMotionSuggestion = {
        anchor: { kind: "playhead", referenceSeconds: currentTime },
        controlOffset: { x: 0, y: 0 },
        delta,
        easing: "smooth",
        end,
        kind: "create-motion",
        start: currentTime,
        targetObjectIds: targetIds,
      };
      installDraft(operation, transactionId, "direct-manipulation");
      return;
    }
    installPositionDraft(delta, targetIds, transactionId);
  }

  function cancelEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    if (canvasDrag.current?.pointerId !== event.pointerId) return;
    canvasDrag.current = null;
    setDragPreview(null);
  }

  function installPositionDraft(
    delta: Readonly<{ x: number; y: number }>,
    targetIds: readonly string[],
    transactionId: string,
  ) {
    if (!draftBaseState || !projection) return;
    const projected = projectedPositions(projection.canvas.entities, targetIds);
    if (projected.kind === "invalid") {
      setDraftError(projected.message);
      return;
    }
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: currentTime,
      delta,
      positions: projected.positions,
      scene: draftBaseState.evaluatedScene,
      start: currentTime,
      targetEntityIds: targetIds,
      transactionId,
    });
    const validated = validatedProgramRecord(validation);
    if (validated.kind === "invalid") {
      setDraftError(validated.message);
      return;
    }
    setDraftProgram(validated.record);
    setDraftOperation(null);
    setDraftError(null);
  }

  function nudgeEntity(event: KeyboardEvent<HTMLButtonElement>, entityId: string) {
    const delta = NUDGE_DELTAS[event.key];
    if (!delta || !draftBaseState || !projection) return;
    event.preventDefault();
    const targetIds = selectedObjectIds.includes(entityId) ? selectedObjectIds : [entityId];
    installPositionDraft(delta, targetIds, `studio-nudge-${crypto.randomUUID()}`);
  }

  const renderRecord = draftProgram ?? appliedPrograms.at(-1) ?? null;
  const renderCandidate: RenderProgramCandidate | null = activeScene && renderRecord ? {
    anchors: activeScene.anchors,
    destination: operationHasSceneBoundary(renderRecord) && nextScene ? {
      sceneName: nextScene.name,
      sourcePath: nextScene.sourcePath,
    } : null,
    program: renderRecord.program,
    sceneName: activeScene.name,
    sourceBindings: Object.entries(activeScene.sourceVariables).map(([entityId, sourceVariable]) => ({
      entityId,
      sourceVariable,
    })),
    sourceHash: activeScene.sourceHash,
    sourcePath: activeScene.sourcePath,
    viewport: STUDIO_VIEWPORT,
  } : null;

  const selectedEntity = editableEntities.find((entity) => selectedSet.has(entity.id)) ?? null;

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-zinc-950 text-zinc-100" ref={workspaceBounds}>
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="shrink-0 text-balance text-sm font-semibold">Poietra Studio Lab</h1>
            {scenes.length > 0 ? (
              <select
                aria-label="Active imported Scene"
                className="h-8 min-w-0 max-w-sm border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
                onChange={(event) => setActiveSceneId(event.currentTarget.value)}
                value={activeSceneId ?? ""}
              >
                {scenes.map((scene) => (
                  <option key={scene.sceneId} value={scene.sceneId}>{scene.sourcePath} · {scene.name}</option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <button
              className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              onClick={() => void refreshWorkspace()}
              type="button"
            >
              Reimport source
            </button>
            <button
              aria-controls="studio-magic-edit"
              aria-expanded={isMagicEditVisible}
              className="border border-zinc-700 px-2 py-1 font-medium text-zinc-300 hover:bg-zinc-800"
              onClick={() => setIsMagicEditVisible((visible) => !visible)}
              type="button"
            >
              {isMagicEditVisible ? "Hide Magic Edit" : "Show Magic Edit"}
            </button>
            <span className="border border-zinc-700 px-2 py-1 text-zinc-500">{shell}</span>
          </div>
        </header>

        {workspaceStatus === "loading" ? (
          <div aria-label="Importing Manim workspace" className="grid min-h-0 flex-1 grid-cols-[14rem_1fr_20rem] gap-px bg-zinc-800">
            <div className="bg-zinc-950 p-3"><div className="h-8 bg-zinc-900" /></div>
            <div className="bg-zinc-900 p-6"><div className="mx-auto aspect-video max-w-4xl bg-zinc-950" /></div>
            <div className="bg-zinc-950 p-3"><div className="h-24 bg-zinc-900" /></div>
          </div>
        ) : workspaceStatus === "error" || !activeScene || !projection ? (
          <div className="grid flex-1 place-items-center p-6">
            <div className="max-w-md border border-zinc-800 p-5">
              <h2 className="text-balance text-sm font-medium">No imported Scene is available</h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                {workspaceError ?? "Add a Python file containing a Manim Scene under the configured project root."}
              </p>
              <button className="mt-4 bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950" onClick={() => void refreshWorkspace()} type="button">
                Inspect workspace again
              </button>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[14rem_minmax(0,1fr)_21rem] gap-px bg-zinc-800">
            <WorkspaceSidebar
              activeScene={activeScene}
              appliedPrograms={appliedPrograms}
              appliedTransactionIds={appliedTransactionIds}
              duration={activeDuration}
              entities={editableEntities}
              nextScene={nextScene}
              onToggleEntity={(entityId, selected) => setSelectedObjectIds((selection) => selected
                ? selection.filter((id) => id !== entityId)
                : [...selection, entityId])}
              onUndo={undoProgram}
              selectedIds={selectedSet}
            />

            <StudioViewport
              anchors={activeScene.anchors}
              appliedTransactionIds={appliedTransactionIds}
              boundaryActive={boundary !== null}
              currentTime={currentTime}
              draftTransactionId={draftProgram?.program.transactionId ?? null}
              dragPreview={dragPreview}
              duration={activeDuration}
              entities={visibleEntities}
              incomingSceneName={nextScene?.name ?? null}
              interactionMode={interactionMode}
              isPlaying={isPlaying}
              onEntityKeyDown={nudgeEntity}
              onEntityPointerCancel={cancelEntityDrag}
              onEntityPointerDown={beginEntityDrag}
              onEntityPointerMove={moveEntityDrag}
              onEntityPointerUp={finishEntityDrag}
              onInteractionModeChange={setInteractionMode}
              onTimeChange={(time) => {
                setIsPlaying(false);
                setCurrentTime(time);
              }}
              onTogglePlayback={() => {
                if (currentTime >= activeDuration) setCurrentTime(0);
                setIsPlaying((playing) => !playing);
              }}
              projection={projection}
              selectedIds={selectedSet}
            />

            <StudioInspector
              appliedProgramCount={appliedPrograms.length}
              draftError={draftError}
              draftOperation={draftOperation}
              draftProgram={draftProgram}
              onApplyDraft={applyDraft}
              onDiscardDraft={discardDraft}
              onDraftOperationChange={updateDraftOperation}
              onSourceChanged={async () => {
                setAppliedPrograms([]);
                setDraftProgram(null);
                setDraftOperation(null);
                await refreshWorkspace();
              }}
              renderCandidate={renderCandidate}
              selectedEntity={selectedEntity}
              suggestion={suggestion}
              workspace={workspace}
            />
          </div>
        )}

        {isMagicEditVisible ? (
          <MagicEditPanel
            aiEndpointConfigured={aiEndpointConfigured}
            clarificationIsStale={clarificationIsStale}
            currentTime={currentTime}
            instruction={instruction}
            message={suggestionMessage}
            onEditRequest={editClarificationRequest}
            onHide={() => setIsMagicEditVisible(false)}
            onInstructionChange={setInstruction}
            onRequest={() => void requestEditSuggestion()}
            onSelect={(option) => void requestEditSuggestion(option)}
            pendingClarification={pendingClarification}
            sceneName={activeScene?.name ?? null}
            selectedCount={selectedObjectIds.length}
            status={suggestionStatus}
            workspaceBounds={workspaceBounds}
          />
        ) : null}
      </main>
    </LazyMotion>
  );
}
