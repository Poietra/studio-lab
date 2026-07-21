import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LazyMotion, m, useDragControls } from "motion/react";

import {
  createClarificationContextFingerprint,
  MAX_CLARIFICATION_HISTORY,
  type PendingClarification,
} from "./ai/clarification";
import { ClarificationPanel } from "./ai/clarification-panel";
import { validateEditProgram } from "./ai/edit-program-validation";
import {
  type ClarificationOption,
  type CreateMotionSuggestion,
  type EditSuggestion,
  type EditSuggestionOperation,
  suggestEdit,
} from "./ai/edit-suggestions";
import { cn } from "./lib/cn";
import { loadManimWorkspace } from "./render-pipeline/client";
import type { ManimWorkspaceView } from "./render-pipeline/contracts";
import {
  RenderPipelinePanel,
  type RenderProgramCandidate,
} from "./render-pipeline/render-pipeline-panel";
import { DraftInspector } from "./studio/draft-inspector";
import { evaluateWorkingState, programRecord, projectProposedState } from "./studio/evaluator";
import {
  importedWorkingState,
  type ManimWorkspaceScene,
  workspaceScenes,
} from "./studio/imported-workspace";
import type { ProgramRecord, ProjectedEntity } from "./studio/model";
import { EquationContent } from "./studio/prototype-rendering";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationPositionProgram,
} from "./studio/suggestion-program";

type Shell = "Browser" | "Electron" | "Tauri";
type SuggestionStatus = "clarification" | "error" | "idle" | "loading" | "ready";
type InteractionMode = "animate" | "position";

const FRAME = { height: 360, width: 640 } as const;
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);

function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = (value % 60).toFixed(2).padStart(5, "0");
  return `${minutes}:${seconds}`;
}

function sceneAtId(scenes: readonly ManimWorkspaceScene[], id: string | null) {
  return scenes.find((scene) => scene.sceneId === id) ?? null;
}

function positionStyle(position: Readonly<{ x: number; y: number }>) {
  return {
    left: `${(position.x / FRAME.width) * 100}%`,
    top: `${(position.y / FRAME.height) * 100}%`,
  };
}

function operationHasSceneBoundary(record: ProgramRecord) {
  return record.program.operations.some((operation) => operation.kind === "InsertSceneBoundary");
}

function entityLabel(entity: ProjectedEntity) {
  return entity.content?.label ?? entity.content?.text ?? entity.id.split(":").at(-1) ?? entity.id;
}

function transitionStyle(entity: ProjectedEntity) {
  const [, shape, color] = entity.type.split(":");
  return {
    className: cn(
      "pointer-events-none absolute left-1/2 top-1/2 z-20 size-20 -translate-x-1/2 -translate-y-1/2",
      shape === "circle" && "rounded-full",
      shape === "diamond" && "rotate-45",
      shape === "hexagon" && "[clip-path:polygon(25%_6.7%,75%_6.7%,100%_50%,75%_93.3%,25%_93.3%,0%_50%)]",
      color === "black" && "bg-black",
      color === "sky" && "bg-sky-500",
      color === "white" && "bg-white",
    ),
    style: {
      opacity: entity.opacity,
      scale: 0.05 + entity.opacity * 14,
    },
  };
}

function ObjectVisual({ entity }: Readonly<{ entity: ProjectedEntity }>) {
  if (entity.type === "MathTex") {
    return <EquationContent lines={entity.content?.displayLines ?? [entityLabel(entity)]} texParts={entity.content?.texParts} />;
  }
  if (entity.type === "Text") {
    return <span className="block max-w-56 text-pretty text-center text-sm leading-5">{entity.content?.text ?? entityLabel(entity)}</span>;
  }
  if (entity.type === "Arrow" || entity.type === "Line") {
    return <span aria-hidden="true" className="block h-px w-20 bg-zinc-400" />;
  }
  if (entity.type === "Rectangle" || entity.type === "SurroundingRectangle" || entity.type === "Square") {
    return <span aria-hidden="true" className="block h-14 w-32 border border-zinc-500" />;
  }
  return <span className="block border border-zinc-600 px-3 py-2 text-xs text-zinc-300">{entityLabel(entity)}</span>;
}

export function App() {
  const shell = detectShell();
  const aiEndpointConfigured = Boolean(import.meta.env.VITE_POIETRA_AI_ENDPOINT);
  const [workspace, setWorkspace] = useState<ManimWorkspaceView | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<"error" | "loading" | "ready">("loading");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
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
  const [dragPreview, setDragPreview] = useState<Readonly<{
    delta: Readonly<{ x: number; y: number }>;
    entityId: string;
  }> | null>(null);
  const suggestionRequest = useRef<AbortController | null>(null);
  const canvasDrag = useRef<Readonly<{
    entityId: string;
    pointerId: number;
    start: Readonly<{ x: number; y: number }>;
  }> | null>(null);
  const workspaceBounds = useRef<HTMLElement | null>(null);
  const magicEditDragControls = useDragControls();

  async function refreshWorkspace(signal?: AbortSignal) {
    setWorkspaceStatus("loading");
    setWorkspaceError(null);
    try {
      const nextWorkspace = await loadManimWorkspace(signal);
      setWorkspace(nextWorkspace);
      const scenes = workspaceScenes(nextWorkspace);
      setActiveSceneId((current) => scenes.some((scene) => scene.sceneId === current)
        ? current
        : scenes.find((scene) => scene.sourcePath === "examples/relativity.py")?.sceneId ?? scenes[0]?.sceneId ?? null);
      setWorkspaceStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setWorkspaceStatus("error");
      setWorkspaceError(error instanceof Error ? error.message : "Could not import the Manim workspace.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshWorkspace(controller.signal);
    return () => controller.abort();
  }, []);

  const scenes = useMemo(() => workspace ? workspaceScenes(workspace) : [], [workspace]);
  const activeScene = sceneAtId(scenes, activeSceneId);
  const nextScene = sceneAtId(scenes, activeScene?.nextSceneId ?? null);

  useEffect(() => {
    if (!activeScene) return;
    const initialTime = activeScene.anchors.find((anchor) => Math.abs(anchor - 5) < 0.001)
      ?? activeScene.anchors[0]
      ?? 0;
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

  const workingState = activeScene ? importedWorkingState(activeScene, {
    appliedPrograms,
    playhead: currentTime,
    selection: selectedObjectIds,
    stagedPrograms: draftProgram ? [draftProgram] : [],
  }) : null;
  const proposedState = workingState ? evaluateWorkingState(workingState) : null;
  const projection = proposedState ? projectProposedState(proposedState, currentTime) : null;
  const appliedTransactionIds = new Set(appliedPrograms.map((record) => record.program.transactionId));
  const boundary = projection?.timeline.events
    .filter((event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= currentTime)
    .at(-1) ?? null;
  const incomingState = nextScene && boundary ? importedWorkingState(nextScene, {
    playhead: 0,
    selection: [],
  }) : null;
  const incomingProjection = incomingState ? projectProposedState(evaluateWorkingState(incomingState), 0) : null;
  const transitionEntities = projection?.canvas.entities.filter((entity) => entity.type.startsWith("TransitionOverlay:")) ?? [];
  const visibleEntities = boundary && incomingProjection
    ? [...incomingProjection.canvas.entities, ...transitionEntities]
    : projection?.canvas.entities ?? [];
  const editableEntities = visibleEntities.filter((entity) => !entity.type.startsWith("TransitionOverlay:"));
  const selectedSet = new Set(selectedObjectIds);
  const activeDuration = activeScene?.runtimeSceneState.duration ?? 1;
  const contextFingerprint = activeScene ? createClarificationContextFingerprint({
    entities: Object.values(activeScene.runtimeSceneState.objectGraph.entities),
    playhead: currentTime,
    selection: selectedObjectIds,
  }) : "";
  const clarificationIsStale = pendingClarification !== null
    && pendingClarification.contextFingerprint !== contextFingerprint;

  function createValidatedDraft(operation: EditSuggestionOperation, transactionId: string) {
    if (!activeScene || !proposedState) throw new Error("Choose an imported Scene first.");
    let normalizedOperation = operation;
    if (operation.kind === "edit-program") {
      const validation = validateEditProgram(operation, {
        capturedPlayhead: currentTime,
        objects: Object.values(proposedState.evaluatedScene.objectGraph.entities).map((entity) => ({
          id: entity.id,
          lifetimes: entity.lifetime,
          type: entity.type,
        })),
        sceneDuration: proposedState.evaluatedScene.duration,
        selectedObjectIds,
      });
      if (validation.kind === "invalid") throw new Error(validation.message);
      normalizedOperation = validation.program.operation;
    }
    const containsSceneTransition = normalizedOperation.kind === "create-scene-transition"
      || (normalizedOperation.kind === "edit-program" && normalizedOperation.operations.some((step) => (
        step.kind === "create-scene-transition"
      )));
    if (containsSceneTransition && !nextScene) {
      throw new Error("The active imported Scene has no next Scene. Choose another Scene or add one to the project.");
    }
    const canonical = canonicalizeSuggestionProgram(normalizedOperation, {
      capturedPlayhead: currentTime,
      origin: "remote-model",
      scene: proposedState.evaluatedScene,
      transactionId,
    });
    if (canonical.kind === "invalid") {
      const issue = canonical.issues.find((candidate) => candidate.severity === "error");
      throw new Error(issue?.message ?? "The Canonical EditProgram is invalid.");
    }
    return {
      operation: normalizedOperation,
      record: programRecord(canonical.program, canonical),
    };
  }

  function installDraft(operation: EditSuggestionOperation, transactionId: string) {
    try {
      const validated = createValidatedDraft(operation, transactionId);
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
    if (installDraft(operation, draftProgram.program.transactionId)) {
      setSuggestion((current) => current ? { ...current, operation } : current);
    }
  }

  async function requestEditSuggestion(selectedOption?: ClarificationOption) {
    if (!activeScene || !proposedState) return;
    const pending = pendingClarification;
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
        objects: Object.values(proposedState.evaluatedScene.objectGraph.entities)
          .filter((entity) => !entity.type.startsWith("TransitionOverlay:"))
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
        sceneDuration: proposedState.evaluatedScene.duration,
        selectedObjectIds,
      }, { signal: controller.signal });
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

  function submitInstruction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void requestEditSuggestion();
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
    const preview = dragPreview;
    canvasDrag.current = null;
    setDragPreview(null);
    if (!drag || drag.pointerId !== event.pointerId || !preview || !activeScene || !proposedState) return;
    if (Math.hypot(preview.delta.x, preview.delta.y) < 1) return;
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
        delta: preview.delta,
        easing: "smooth",
        end,
        kind: "create-motion",
        start: currentTime,
        targetObjectIds: targetIds,
      };
      installDraft(operation, transactionId);
      return;
    }
    const positions = Object.fromEntries(targetIds.map((entityId) => [
      entityId,
      projection?.canvas.entities.find((entity) => entity.id === entityId)?.position ?? { x: 0, y: 0 },
    ]));
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: currentTime,
      delta: preview.delta,
      positions,
      scene: proposedState.evaluatedScene,
      start: currentTime,
      targetEntityIds: targetIds,
      transactionId,
    });
    setDraftProgram(programRecord(validation.program, validation));
    setDraftOperation(null);
    setDraftError(validation.kind === "invalid" ? validation.issues[0]?.message ?? "Invalid position edit." : null);
  }

  function nudgeEntity(event: KeyboardEvent<HTMLButtonElement>, entityId: string) {
    const directions: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
      ArrowDown: { x: 0, y: 2 },
      ArrowLeft: { x: -2, y: 0 },
      ArrowRight: { x: 2, y: 0 },
      ArrowUp: { x: 0, y: -2 },
    };
    const delta = directions[event.key];
    if (!delta || !proposedState || !projection) return;
    event.preventDefault();
    const targetIds = selectedObjectIds.includes(entityId) ? selectedObjectIds : [entityId];
    const positions = Object.fromEntries(targetIds.map((targetId) => [
      targetId,
      projection.canvas.entities.find((entity) => entity.id === targetId)?.position ?? { x: 0, y: 0 },
    ]));
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: currentTime,
      delta,
      positions,
      scene: proposedState.evaluatedScene,
      start: currentTime,
      targetEntityIds: targetIds,
      transactionId: `studio-nudge-${crypto.randomUUID()}`,
    });
    setDraftProgram(programRecord(validation.program, validation));
    setDraftOperation(null);
    setDraftError(validation.kind === "invalid" ? validation.issues[0]?.message ?? "Invalid position edit." : null);
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
    sourcePath: activeScene.sourcePath,
    viewport: FRAME,
  } : null;

  const timelineEvents = projection?.timeline.events ?? [];
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
            <aside className="min-h-0 overflow-y-auto bg-zinc-950 p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-balance text-xs font-medium text-zinc-300">Imported objects</h2>
                <span className="tabular-nums text-[10px] text-zinc-600">{editableEntities.length}</span>
              </div>
              <p className="mt-1 truncate text-[10px] text-zinc-600" title={activeScene.sceneId}>{activeScene.name}</p>
              <ul className="mt-3 space-y-1">
                {editableEntities.map((entity) => {
                  const selected = selectedSet.has(entity.id);
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
                          onChange={() => setSelectedObjectIds((selection) => selected
                            ? selection.filter((id) => id !== entity.id)
                            : [...selection, entity.id])}
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
                  <dd className="tabular-nums text-zinc-400">{activeDuration.toFixed(2)}s</dd>
                  <dt className="text-zinc-600">Anchors</dt>
                  <dd className="tabular-nums text-zinc-400">{activeScene.anchors.map((anchor) => anchor.toFixed(2)).join(", ") || "none"}</dd>
                </dl>
              </section>

              <section className="mt-5 border-t border-zinc-800 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-balance text-xs font-medium text-zinc-300">Applied programs</h2>
                  {appliedPrograms.length > 0 ? (
                    <button className="text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200" onClick={undoProgram} type="button">
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

            <section className="flex min-h-0 min-w-0 flex-col bg-zinc-900">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500">Direct manipulation</span>
                  <div className="flex border border-zinc-700" role="group" aria-label="Direct manipulation meaning">
                    {(["position", "animate"] as const).map((mode) => (
                      <button
                        aria-pressed={interactionMode === mode}
                        className={cn(
                          "px-2 py-1 text-[10px]",
                          interactionMode === mode ? "bg-sky-950 text-sky-300" : "text-zinc-500 hover:bg-zinc-800",
                        )}
                        key={mode}
                        onClick={() => setInteractionMode(mode)}
                        type="button"
                      >
                        {mode === "position" ? "Set position" : "Create movement"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="truncate text-[10px] text-zinc-600" title={projection.canvas.sampleId}>{projection.canvas.sampleId}</span>
              </div>

              <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
                <div
                  className="relative aspect-video w-full max-w-5xl overflow-hidden border border-zinc-700 bg-black"
                  data-proposed-state-sample={projection.canvas.sampleId}
                  data-scene-phase={boundary ? "incoming" : "outgoing"}
                >
                  <div
                    className="absolute inset-0 origin-center"
                    style={{ scale: projection.camera.scale }}
                  >
                    <svg aria-hidden="true" className="absolute inset-0 size-full opacity-10" viewBox="0 0 640 360">
                      <g stroke="#a1a1aa" strokeWidth="1">
                        {[80, 160, 240, 320, 400, 480, 560].map((x) => <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="360" />)}
                        {[90, 180, 270].map((y) => <line key={`y-${y}`} x1="0" x2="640" y1={y} y2={y} />)}
                      </g>
                    </svg>
                    {visibleEntities.map((entity) => {
                      if (!entity.present) return null;
                      if (entity.type.startsWith("TransitionOverlay:")) {
                        const transition = transitionStyle(entity);
                        return <div className={transition.className} key={entity.id} style={transition.style} />;
                      }
                      const selected = selectedSet.has(entity.id);
                      const locked = entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId));
                      const localDelta = dragPreview?.entityId === entity.id ? dragPreview.delta : { x: 0, y: 0 };
                      const position = { x: entity.position.x + localDelta.x, y: entity.position.y + localDelta.y };
                      const opacity = draftProgram?.program.transactionId === entity.transactionId && entity.opacity === 0
                        ? 0.35
                        : entity.opacity;
                      return (
                        <button
                          aria-label={`Move ${entityLabel(entity)}`}
                          aria-pressed={selected}
                          className={cn(
                            "absolute z-10 -translate-x-1/2 -translate-y-1/2 border px-3 py-2 outline-none",
                            locked ? "pointer-events-none border-dashed border-sky-800 bg-zinc-950/70" : "cursor-grab active:cursor-grabbing",
                            selected ? "border-sky-400 bg-sky-950/60 focus-visible:ring-2 focus-visible:ring-sky-400" : "border-transparent hover:border-zinc-600",
                          )}
                          disabled={locked}
                          key={entity.id}
                          onKeyDown={(event) => nudgeEntity(event, entity.id)}
                          onPointerCancel={finishEntityDrag}
                          onPointerDown={(event) => beginEntityDrag(event, entity.id)}
                          onPointerMove={moveEntityDrag}
                          onPointerUp={finishEntityDrag}
                          style={{
                            ...positionStyle(position),
                            opacity,
                            scale: entity.scale,
                            touchAction: "none",
                          }}
                          type="button"
                        >
                          <ObjectVisual entity={entity} />
                          {selected ? (
                            <span className="absolute -top-6 left-0 max-w-56 truncate bg-sky-400 px-1.5 py-0.5 text-[10px] font-medium text-sky-950">
                              {entityLabel(entity)}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  {boundary && nextScene ? (
                    <div className="absolute bottom-2 left-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300">
                      Incoming Scene · {nextScene.name}
                    </div>
                  ) : null}
                </div>
              </div>

              <section className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center gap-3">
                  <button
                    className="w-14 border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    onClick={() => {
                      if (currentTime >= activeDuration) setCurrentTime(0);
                      setIsPlaying((playing) => !playing);
                    }}
                    type="button"
                  >
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <span className="w-24 tabular-nums text-xs text-zinc-400">{formatTime(currentTime)}</span>
                  <input
                    aria-label="Scene playhead"
                    className="min-w-0 flex-1 accent-sky-500"
                    max={activeDuration}
                    min="0"
                    onChange={(event) => {
                      setIsPlaying(false);
                      setCurrentTime(Number(event.currentTarget.value));
                    }}
                    step="0.01"
                    type="range"
                    value={currentTime}
                  />
                  <span className="w-16 text-right tabular-nums text-xs text-zinc-600">{formatTime(activeDuration)}</span>
                </div>
                <div className="relative mt-3 h-14 border border-zinc-800 bg-zinc-900">
                  {timelineEvents.filter((event) => event.interval).map((event) => {
                    const interval = event.interval!;
                    return (
                      <div
                        className={cn(
                          "absolute top-2 h-5 min-w-px border px-1 text-[9px] leading-4",
                          event.transactionId ? "border-sky-800 bg-sky-950 text-sky-300" : "border-zinc-700 bg-zinc-800 text-zinc-500",
                        )}
                        key={event.id}
                        style={{
                          left: `${(interval.start / activeDuration) * 100}%`,
                          width: `${Math.max(0.25, ((interval.end - interval.start) / activeDuration) * 100)}%`,
                        }}
                        title={`${event.label} ${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s`}
                      >
                        <span className="block truncate">{event.label}</span>
                      </div>
                    );
                  })}
                  {activeScene.anchors.map((anchor) => (
                    <button
                      aria-label={`Move playhead to source anchor ${anchor.toFixed(3)} seconds`}
                      className="absolute bottom-0 top-0 w-px bg-amber-500/70 focus-visible:w-0.5"
                      key={anchor}
                      onClick={() => {
                        setIsPlaying(false);
                        setCurrentTime(anchor);
                      }}
                      style={{ left: `${(anchor / activeDuration) * 100}%` }}
                      title={`Source anchor ${anchor.toFixed(3)}s`}
                      type="button"
                    />
                  ))}
                  <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-sky-400" style={{ left: `${(currentTime / activeDuration) * 100}%` }} />
                </div>
              </section>
            </section>

            <aside className="min-h-0 overflow-y-auto bg-zinc-950 p-3">
              {draftProgram ? (
                <DraftInspector
                  error={draftError}
                  onApply={applyDraft}
                  onDiscard={discardDraft}
                  onOperationChange={updateDraftOperation}
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
                  {appliedPrograms.length > 0 ? (
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
                onCommitted={async () => {
                  setAppliedPrograms([]);
                  setDraftProgram(null);
                  setDraftOperation(null);
                  await refreshWorkspace();
                }}
                workspace={workspace}
              />
            </aside>
          </div>
        )}

        {isMagicEditVisible ? (
          <m.section
            className="fixed right-6 top-16 z-30 w-[min(25rem,calc(100vw-2rem))] border border-zinc-700 bg-zinc-950 shadow-xl"
            drag
            dragConstraints={workspaceBounds}
            dragControls={magicEditDragControls}
            dragListener={false}
            dragMomentum={false}
            id="studio-magic-edit"
          >
            <div className="flex cursor-grab items-center justify-between border-b border-zinc-800 px-3 py-2 active:cursor-grabbing">
              <button
                aria-label="Move Magic Edit panel"
                className="min-w-0 flex-1 cursor-grab text-left active:cursor-grabbing"
                onPointerDown={(event) => magicEditDragControls.start(event)}
                type="button"
              >
                <span className="block text-balance text-xs font-medium text-zinc-200">Magic Edit</span>
                <span className="block truncate text-[10px] text-zinc-600">{activeScene?.name ?? "No Scene"} · {currentTime.toFixed(2)}s</span>
              </button>
              <button
                aria-label="Hide Magic Edit"
                className="px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => setIsMagicEditVisible(false)}
                type="button"
              >
                Hide
              </button>
            </div>
            <form className="p-3" onSubmit={submitInstruction}>
              {pendingClarification ? (
                <ClarificationPanel
                  isLoading={suggestionStatus === "loading"}
                  isStale={clarificationIsStale}
                  onEditRequest={editClarificationRequest}
                  onSelect={(option) => void requestEditSuggestion(option)}
                  pending={pendingClarification}
                />
              ) : null}
              <label className="sr-only" htmlFor="magic-edit-instruction">Describe an edit</label>
              <textarea
                aria-describedby={pendingClarification ? "magic-edit-clarification-question" : undefined}
                className="min-h-20 w-full resize-y border border-zinc-700 bg-zinc-900 p-2 text-sm leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 disabled:text-zinc-600"
                disabled={!aiEndpointConfigured || suggestionStatus === "loading" || clarificationIsStale}
                id="magic-edit-instruction"
                maxLength={2_000}
                onChange={(event) => setInstruction(event.currentTarget.value)}
                placeholder={pendingClarification ? "Answer this question…" : "Describe an edit"}
                value={instruction}
              />
              {suggestionMessage ? (
                <p className={cn(
                  "mt-2 text-pretty text-[10px] leading-4",
                  suggestionStatus === "error" ? "text-red-300" : "text-zinc-500",
                )} role={suggestionStatus === "error" ? "alert" : undefined}>
                  {suggestionMessage}
                </p>
              ) : null}
              {!aiEndpointConfigured ? (
                <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">Configure VITE_POIETRA_AI_ENDPOINT to enable remote inference.</p>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="truncate text-[10px] text-zinc-600">
                  {selectedObjectIds.length > 0 ? `${selectedObjectIds.length} selected` : "No selection · creation is available"}
                </span>
                <button
                  className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                  disabled={!aiEndpointConfigured || !instruction.trim() || suggestionStatus === "loading" || clarificationIsStale}
                  type="submit"
                >
                  {suggestionStatus === "loading" ? "Thinking…" : pendingClarification ? "Answer" : "Preview"}
                </button>
              </div>
            </form>
          </m.section>
        ) : null}
      </main>
    </LazyMotion>
  );
}
