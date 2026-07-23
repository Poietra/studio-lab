import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { LazyMotion } from "motion/react";

import { createClarificationContextFingerprint, MAX_CLARIFICATION_HISTORY } from "./ai/clarification";
import {
  type ClarificationOption,
  type CreateMotionSuggestion,
  type EditSuggestionOperation,
  suggestEdit,
} from "./ai/edit-suggestions";
import type { RenderProgramCandidate } from "./render-pipeline/render-pipeline-panel";
import type { RenderSessionView } from "./render-pipeline/contracts";
import { cn } from "./lib/cn";
import {
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  createTrimEntityLifetimeProgram,
  defaultEntityContent,
  duplicateEntityInput,
  sceneDurationTrimAvailability,
  type StudioEntityInput,
} from "./studio/authoring-commands";
import { commandForShortcut, isEditableShortcutTarget, type StudioCommandId } from "./studio/commands";
import { projectedPositions, validateSuggestionDraft, validatedProgramRecord } from "./studio/draft-validation";
import type { Point, ProgramRecord, ProposedState, RuntimeSceneState } from "./studio/model";
import {
  adjustAppliedMotionClipControl,
  appliedMotionClipReadOnlyReason,
  retimeAppliedMotionClip,
} from "./studio/motion-clip-edit";
import { projectMotionPaths, type StudioMotionPath } from "./studio/motion-paths";
import type { AppliedMotionClip, AppliedMotionClipChange } from "./studio/motion-timeline-clip";
import { programExecutionCapabilities } from "./studio/operation-registry";
import type { OperationOrigin } from "./studio/operations";
import { latestSafeSourceAnchor, sourceTimeToWorkingTime, workingTimeToSourceTime } from "./studio/program-composition";
import { samplePropertyValue } from "./studio/property-sampling";
import { projectRuntimeSceneToSourceTimeline } from "./studio/source-timeline";
import { MagicEditPanel } from "./studio/magic-edit-panel";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "./studio/suggestion-program";
import {
  type EntityDragPreview,
  type EntityScalePreview,
  entityLabel,
  STUDIO_VIEWPORT,
  StudioViewport,
} from "./studio/studio-viewport";
import type { StudioTool } from "./studio/studio-toolbar";
import { StudioInspector, WorkspaceSidebar } from "./studio/studio-sidebars";
import {
  editorProgramRecord,
  type EditorProgramRecord,
  type EditorSessionIdentity,
  useEditorController,
} from "./studio/use-editor-controller";
import { useManimWorkspace } from "./studio/use-manim-workspace";
import { WorkspaceLauncher } from "./studio/workspace-launcher";
import { isTransitionOverlay, projectStudioWorkspace } from "./studio/workspace-projection";
import { replaceAppliedProgram } from "./studio/transactions";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);
const NUDGE_DELTAS: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  ArrowDown: { x: 0, y: 2 },
  ArrowLeft: { x: -2, y: 0 },
  ArrowRight: { x: 2, y: 0 },
  ArrowUp: { x: 0, y: -2 },
};
const MAX_ENTITY_SCALE = 8;
const MIN_ENTITY_SCALE = 0.1;
type CanvasDragState = Readonly<{
  pointerId: number;
  scale: Readonly<{ x: number; y: number }>;
  sourceAnchor: number;
  start: Readonly<{ x: number; y: number }>;
  targetEntityIds: readonly string[];
}>;
type CanvasResizeState = Readonly<{
  center: Readonly<{ x: number; y: number }>;
  entityId: string;
  fromScale: number;
  pointerId: number;
  sourceAnchor: number;
  start: Readonly<{ x: number; y: number }>;
}>;
function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (window.poietraDesktop || navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function programsHaveSceneBoundary(programs: readonly ProgramRecord["program"][]) {
  return programs.some((program) => program.operations.some((operation) => operation.kind === "InsertSceneBoundary"));
}

function canvasPointerDelta(drag: CanvasDragState, point: Readonly<{ x: number; y: number }>) {
  return {
    x: (point.x - drag.start.x) * drag.scale.x,
    y: (point.y - drag.start.y) * drag.scale.y,
  };
}

function resizedEntityScale(resize: CanvasResizeState, point: Readonly<{ x: number; y: number }>) {
  const startVector = {
    x: resize.start.x - resize.center.x,
    y: resize.start.y - resize.center.y,
  };
  const pointerVector = {
    x: point.x - resize.center.x,
    y: point.y - resize.center.y,
  };
  const squaredLength = startVector.x ** 2 + startVector.y ** 2;
  const ratio =
    squaredLength > 1 ? (pointerVector.x * startVector.x + pointerVector.y * startVector.y) / squaredLength : 1;
  return clamp(resize.fromScale * ratio, MIN_ENTITY_SCALE, MAX_ENTITY_SCALE);
}

function isStudioEntityInsertion(record: ProgramRecord) {
  if (record.program.provenance.origin !== "studio-default") return false;
  const createdEntityIds = new Set(
    record.program.operations.flatMap((operation) => (operation.kind === "CreateEntity" ? [operation.entity.id] : [])),
  );
  return (
    createdEntityIds.size > 0 &&
    record.program.operations.every((operation) => {
      if (operation.kind === "CreateEntity") return true;
      if (operation.kind === "SetProperty") {
        return operation.key === "position" && createdEntityIds.has(operation.entityId);
      }
      return (
        operation.kind === "ChangePresence" &&
        operation.effect === "fade-in" &&
        createdEntityIds.has(operation.entityId)
      );
    })
  );
}

export function App() {
  const shell = detectShell();
  const aiEndpointConfigured = Boolean(import.meta.env.VITE_POIETRA_AI_ENDPOINT);
  const {
    activeScene,
    activeSceneId,
    activeProjectId,
    cancelMutation: cancelWorkspaceMutation,
    clearMutationError,
    createWorkspace,
    error: workspaceError,
    isRefreshing: workspaceIsRefreshing,
    leaveWorkspace,
    mutation: workspaceMutation,
    mutationError: workspaceMutationError,
    nextScene,
    projects,
    refresh: refreshWorkspace,
    renameWorkspace,
    scenes,
    setActiveProjectId,
    setActiveSceneId,
    status: workspaceStatus,
    unregisterWorkspace,
    workspace,
  } = useManimWorkspace();
  const {
    applyDraft,
    beginSuggestionRequest,
    cancelSuggestionRequest,
    clearProjectSessions,
    clearSession,
    discardDraft,
    editAppliedProgram: stageAppliedProgramEdit,
    finishSuggestionRequest,
    isSuggestionRequestCurrent,
    openSession,
    pruneSessions,
    redoProgram,
    resetPrograms,
    saveSession,
    setCurrentTime,
    setDurationError,
    setDraftError,
    setInsertTool,
    setInsertValue,
    setInstruction,
    setInteractionMode,
    setIsPlaying,
    setMotionDuration,
    setPendingClarification,
    setSelectedObjectIds,
    setSuggestion,
    setSuggestionMessage,
    setSuggestionStatus,
    stageDraft,
    state: {
      appliedPrograms,
      currentTime,
      durationError,
      draftError,
      draftOperation,
      draftProgram,
      editingAppliedProgram,
      insertTool,
      insertValue,
      instruction,
      interactionMode,
      isPlaying,
      motionDuration,
      pendingClarification,
      redoPrograms,
      selectedObjectIds,
      suggestion,
      suggestionMessage,
      suggestionStatus,
    },
    suspend: suspendEditor,
    undoProgram,
  } = useEditorController();
  const [renderSessions, setRenderSessions] = useState<Readonly<Record<string, RenderSessionView>>>({});
  const [isMagicEditVisible, setIsMagicEditVisible] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  const [dragPreview, setDragPreview] = useState<EntityDragPreview | null>(null);
  const [scalePreview, setScalePreview] = useState<EntityScalePreview | null>(null);
  const suggestionContext = useRef("");
  const canvasDrag = useRef<CanvasDragState | null>(null);
  const canvasResize = useRef<CanvasResizeState | null>(null);
  const studioClipboard = useRef<readonly StudioEntityInput[]>([]);
  const pasteCount = useRef(0);
  const commandHandler = useRef<(command: StudioCommandId) => boolean>(() => false);
  const workspaceBounds = useRef<HTMLElement | null>(null);
  const appliedCanonicalPrograms = appliedPrograms.map((record) => record.program);
  const sourceCurrentTime = workingTimeToSourceTime(appliedCanonicalPrograms, currentTime);
  const timelineAnchors =
    activeScene?.anchors.map((sourceTime) => ({
      sourceTime,
      workingTime: sourceTimeToWorkingTime(appliedCanonicalPrograms, sourceTime),
    })) ?? [];

  function activeEditorSessionIdentity(): EditorSessionIdentity | null {
    return activeProjectId && activeScene
      ? {
          projectId: activeProjectId,
          sceneId: activeScene.sceneId,
          sourceHash: activeScene.sourceHash,
        }
      : null;
  }

  function saveEditorSession() {
    const identity = activeEditorSessionIdentity();
    if (!identity) return;
    saveSession(identity);
  }

  useEffect(() => {
    if (workspaceStatus !== "ready") return;
    const registeredProjectIds = new Set(projects.map((project) => project.id));
    pruneSessions(registeredProjectIds);
    setRenderSessions((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([projectId]) => registeredProjectIds.has(projectId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [projects, workspaceStatus]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!activeScene || event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
      if (
        (event.key === " " || event.key === "Enter") &&
        (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
      )
        return;
      if (event.key in NUDGE_DELTAS) {
        const delta = NUDGE_DELTAS[event.key];
        const amount = event.shiftKey ? 5 : 1;
        if (delta && selectedObjectIds.length > 0) {
          event.preventDefault();
          commandHandler.current("select-tool");
          installPositionDraft(
            { x: delta.x * amount, y: delta.y * amount },
            selectedObjectIds,
            `studio-nudge-${crypto.randomUUID()}`,
          );
        }
        return;
      }
      const command = commandForShortcut(event);
      if (command && commandHandler.current(command)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!activeScene) return;
    cancelSuggestionRequest();
    canvasDrag.current = null;
    canvasResize.current = null;
    const identity = activeProjectId
      ? {
          projectId: activeProjectId,
          sceneId: activeScene.sceneId,
          sourceHash: activeScene.sourceHash,
        }
      : null;
    const initialTime = activeScene.anchors[0] ?? 0;
    const initialEntities = Object.values(activeScene.runtimeSceneState.objectGraph.entities).filter((entity) =>
      entity.lifetime.some((lifetime) => initialTime >= lifetime.start && initialTime < lifetime.end),
    );
    if (identity) {
      openSession(identity, {
        currentTime: clamp(initialTime, 0, activeScene.runtimeSceneState.duration),
        selectedObjectIds: initialEntities.slice(0, 1).map((entity) => entity.id),
      });
    }
    setDragPreview(null);
    setScalePreview(null);
  }, [activeScene?.sceneId, activeScene?.sourceHash, activeProjectId]);

  const previewReplacement =
    editingAppliedProgram && draftProgram
      ? replaceAppliedProgram(
          appliedPrograms,
          editingAppliedProgram.original.program.transactionId,
          editorProgramRecord(draftProgram, draftOperation, selectedObjectIds),
        )
      : null;
  const previewAppliedPrograms =
    previewReplacement?.kind === "replaced" ? previewReplacement.programs : appliedPrograms;
  const draftPrecedingPrograms = editingAppliedProgram
    ? appliedPrograms.slice(0, editingAppliedProgram.index)
    : appliedPrograms;
  const draftPrecedingCanonicalPrograms = draftPrecedingPrograms.map((record) => record.program);
  const workspaceProjection = activeScene
    ? projectStudioWorkspace({
        activeScene,
        appliedPrograms: previewAppliedPrograms,
        currentTime,
        draftProgram: editingAppliedProgram ? null : draftProgram,
        nextScene,
        selectedObjectIds,
      })
    : null;
  const draftBaseProjection =
    activeScene && draftProgram
      ? projectStudioWorkspace({
          activeScene,
          appliedPrograms: draftPrecedingPrograms,
          currentTime,
          draftProgram: null,
          nextScene,
          selectedObjectIds,
        })
      : workspaceProjection;
  const draftBaseState = draftBaseProjection?.proposedState ?? null;
  const draftSourceScene = draftBaseState
    ? projectRuntimeSceneToSourceTimeline(draftBaseState.evaluatedScene, draftPrecedingCanonicalPrograms)
    : null;
  const projection = workspaceProjection?.projection ?? null;
  const appliedTransactionIds = new Set(appliedPrograms.map((record) => record.program.transactionId));
  const boundary = workspaceProjection?.boundary ?? null;
  const visibleEntities = workspaceProjection?.visibleEntities ?? [];
  const editableEntities = workspaceProjection?.editableEntities ?? [];
  const selectedSet = new Set(selectedObjectIds);
  const activeDuration =
    workspaceProjection?.proposedState.evaluatedScene.duration ?? activeScene?.runtimeSceneState.duration ?? 1;
  const durationTrimAvailability = sceneDurationTrimAvailability({
    appliedPrograms,
    sceneDuration: draftBaseState?.evaluatedScene.duration ?? activeDuration,
  });
  const motionPaths = workspaceProjection
    ? projectMotionPaths(workspaceProjection.proposedState.evaluatedScene, selectedSet, currentTime)
    : [];
  const editableMotionIds = new Set(
    draftProgram?.program.operations.flatMap((operation) =>
      operation.kind === "CreateMotion" ? [operation.id] : [],
    ) ?? [],
  );
  const evaluatedProgramsByTransaction = new Map(
    workspaceProjection?.proposedState.programs.map(
      (record) => [record.program.transactionId, record.program] as const,
    ) ?? [],
  );
  const appliedMotionClips: readonly AppliedMotionClip[] = activeScene
    ? previewAppliedPrograms.flatMap((record, programIndex) => {
        const evaluatedProgram = evaluatedProgramsByTransaction.get(record.program.transactionId);
        if (!evaluatedProgram) return [];
        const precedingPrograms = previewAppliedPrograms.slice(0, programIndex).map((candidate) => candidate.program);
        const metadata = record.editorMetadata;
        return evaluatedProgram.operations.flatMap((operation) => {
          if (operation.kind !== "CreateMotion") return [];
          const sourceOperation = record.program.operations.find(
            (candidate) => candidate.kind === "CreateMotion" && candidate.id === operation.id,
          );
          if (sourceOperation?.kind !== "CreateMotion") return [];
          const metadataReason = appliedMotionClipReadOnlyReason(
            record.program,
            metadata?.operation,
            sourceOperation.id,
          );
          const busyReason =
            draftProgram && editingAppliedProgram?.original.program.transactionId !== record.program.transactionId
              ? "Apply or discard the current draft before editing this motion clip."
              : null;
          const anchors = activeScene.anchors
            .map((sourceTime) => ({
              maximumDuration: activeScene.runtimeSceneState.duration - sourceTime,
              sourceTime,
              workingTime: sourceTimeToWorkingTime(precedingPrograms, sourceTime),
            }))
            .filter((anchor) => anchor.maximumDuration >= 0.1 - 0.0005);
          return operation.targetEntityIds.map((entityId) => {
            const entity = workspaceProjection?.proposedState.evaluatedScene.objectGraph.entities[entityId];
            return {
              anchors,
              easing: sourceOperation.easing,
              entityId,
              interval: operation.interval,
              label: entity?.content?.label ?? entity?.content?.text ?? entityId.split(":").at(-1) ?? entityId,
              maximumDuration: Math.max(0.1, activeScene.runtimeSceneState.duration - sourceOperation.interval.start),
              operationId: operation.id,
              programIndex,
              readOnlyReason: busyReason ?? metadataReason,
              sourceStart: sourceOperation.interval.start,
              transactionId: record.program.transactionId,
            } satisfies AppliedMotionClip;
          });
        });
      })
    : [];
  const retainRenderSession = useCallback((session: RenderSessionView | null, projectId?: string) => {
    setRenderSessions((current) => {
      if (session) return { ...current, [session.projectId]: session };
      if (!projectId || !(projectId in current)) return current;
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }, []);

  useEffect(() => {
    setCurrentTime((time) => Math.min(time, activeDuration));
  }, [activeDuration]);

  useEffect(() => {
    if (!isPlaying || !activeScene) return;
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      setCurrentTime((time) => {
        const next = time + delta;
        if (next >= activeDuration) {
          setIsPlaying(false);
          return activeDuration;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [activeDuration, activeScene, isPlaying]);
  const contextFingerprint = draftBaseState
    ? createClarificationContextFingerprint({
        entities: Object.values(draftBaseState.evaluatedScene.objectGraph.entities),
        playhead: currentTime,
        selection: selectedObjectIds,
      })
    : "";
  const clarificationIsStale =
    pendingClarification !== null && pendingClarification.contextFingerprint !== contextFingerprint;
  suggestionContext.current = activeScene ? `${activeScene.sourceHash}:${contextFingerprint}` : "";

  function createValidatedDraft(
    operation: EditSuggestionOperation,
    transactionId: string,
    origin: OperationOrigin,
    proposedState: ProposedState | null = draftBaseState,
    capturedPlayhead = sourceCurrentTime,
    sourcePrograms: readonly ProgramRecord["program"][] = draftPrecedingCanonicalPrograms,
    validationSelection: readonly string[] = selectedObjectIds,
  ) {
    if (!activeScene || !proposedState) throw new Error("Choose an imported Scene first.");
    const validationState = {
      ...proposedState,
      evaluatedScene: projectRuntimeSceneToSourceTimeline(proposedState.evaluatedScene, sourcePrograms),
    };
    const validation = validateSuggestionDraft(operation, {
      capturedPlayhead,
      hasNextScene: nextScene !== null,
      origin,
      proposedState: validationState,
      selectedObjectIds: validationSelection,
      transactionId,
    });
    if (validation.kind === "invalid") throw new Error(validation.message);
    return validation;
  }

  function installDraft(
    operation: EditSuggestionOperation,
    transactionId: string,
    options: Readonly<{
      origin?: OperationOrigin;
      preserveDraft?: ProgramRecord | null;
      preservePlayhead?: boolean;
      proposedState?: ProposedState | null;
      capturedPlayhead?: number;
      sourcePrograms?: readonly ProgramRecord["program"][];
    }> = {},
  ) {
    try {
      const origin = options.origin ?? "remote-model";
      const basePrograms = options.sourcePrograms ?? draftPrecedingCanonicalPrograms;
      const precedingPrograms =
        options.preserveDraft &&
        !appliedPrograms.some((record) => record.program.transactionId === options.preserveDraft?.program.transactionId)
          ? [...basePrograms, options.preserveDraft.program]
          : basePrograms;
      const validated = createValidatedDraft(
        operation,
        transactionId,
        origin,
        options.proposedState,
        options.capturedPlayhead,
        precedingPrograms,
      );
      const execution = programExecutionCapabilities(validated.record.program);
      if (origin === "direct-manipulation") cancelSuggestionRequest();
      const staged = stageDraft({
        clearSuggestion: origin === "direct-manipulation",
        currentTime: options.preservePlayhead
          ? undefined
          : sourceTimeToWorkingTime(precedingPrograms, validated.record.program.anchor.resolvedSeconds),
        operation: validated.operation,
        preserveAppliedProgram: origin === "direct-manipulation" ? options.preserveDraft : null,
        record: validated.record,
      });
      return staged ? execution : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The draft could not be validated.");
      return null;
    }
  }

  function updateDraftOperation(operation: EditSuggestionOperation) {
    if (!draftProgram) return;
    const installed = installDraft(operation, draftProgram.program.transactionId, {
      capturedPlayhead: draftProgram.program.anchor.capturedPlayhead,
      origin: draftProgram.program.provenance.origin,
      preservePlayhead: true,
    });
    if (installed) {
      setSuggestion((current) => (current ? { ...current, operation } : current));
      if (draftProgram.program.provenance.origin !== "direct-manipulation") {
        setSuggestionMessage(installed.applyBlocker);
        setSuggestionStatus(installed.apply === "supported" ? "ready" : "error");
      }
    }
  }

  async function requestEditSuggestion(selectedOption?: ClarificationOption) {
    if (!activeScene || !draftBaseState) return;
    if (editingAppliedProgram) {
      setSuggestionMessage("Apply or discard the Applied Program edit before starting another Magic Edit.");
      setSuggestionStatus("error");
      return;
    }
    const pending = pendingClarification;
    const requestedContext = suggestionContext.current;
    const requestedPlayhead = sourceCurrentTime;
    const answerText = instruction.trim();
    const prompt = pending?.originalPrompt ?? answerText;
    if (!prompt || suggestionStatus === "loading") return;
    if (pending && clarificationIsStale) {
      setSuggestionMessage(
        "The Scene, playhead, or selection changed after this question. Edit the original request and try again.",
      );
      setSuggestionStatus("error");
      return;
    }
    const clarificationAnswer = pending
      ? selectedOption
        ? { kind: "option" as const, optionId: selectedOption.id }
        : { kind: "text" as const, text: answerText }
      : null;
    if (pending && !clarificationAnswer) return;
    const controller = beginSuggestionRequest();
    setIsPlaying(false);
    setSuggestionStatus("loading");
    setSuggestionMessage(null);
    setDraftError(null);
    try {
      const result = await suggestEdit(
        {
          clarification:
            pending && clarificationAnswer
              ? {
                  answer: clarificationAnswer,
                  history: pending.history,
                  options: pending.options,
                  question: pending.question,
                }
              : null,
          objects: Object.values((draftSourceScene ?? draftBaseState.evaluatedScene).objectGraph.entities)
            .filter((entity) => !isTransitionOverlay(entity))
            .map((entity) => ({
              displayName: entity.content?.label ?? entity.id,
              id: entity.id,
              lifetimes: entity.lifetime,
              mathTex:
                entity.type === "MathTex" && entity.content?.texParts
                  ? {
                      displayLines: entity.content.displayLines,
                      texParts: entity.content.texParts,
                    }
                  : null,
              type: entity.type,
            })),
          playhead: requestedPlayhead,
          prompt,
          scene: {
            id: activeScene.sceneId,
            name: activeScene.name,
            nextSceneId: activeScene.nextSceneId,
          },
          sceneDuration: draftSourceScene?.duration ?? draftBaseState.evaluatedScene.duration,
          selectedObjectIds,
        },
        { signal: controller.signal },
      );
      if (!isSuggestionRequestCurrent(controller)) return;
      if (suggestionContext.current !== requestedContext) {
        setSuggestion(null);
        setSuggestionMessage(
          "The Scene, playhead, or selection changed while Magic Edit was thinking. Try the request again in the current context.",
        );
        setSuggestionStatus("error");
        return;
      }
      if (result.kind === "clarification") {
        const history =
          pending && clarificationAnswer
            ? [
                ...pending.history,
                {
                  answer: clarificationAnswer,
                  options: pending.options,
                  question: pending.question,
                },
              ].slice(-MAX_CLARIFICATION_HISTORY)
            : [];
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
      const installed = installDraft(result.suggestion.operation, transactionId, {
        capturedPlayhead: requestedPlayhead,
      });
      if (!installed) {
        setSuggestion(null);
        setSuggestionStatus("error");
        return;
      }
      setPendingClarification(null);
      setSuggestion(result.suggestion);
      setSuggestionMessage(installed.applyBlocker);
      setSuggestionStatus(installed.apply === "supported" ? "ready" : "error");
    } catch (error) {
      if (!isSuggestionRequestCurrent(controller) || controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSuggestion(null);
      setSuggestionMessage(error instanceof Error ? error.message : "Could not generate an edit suggestion.");
      setSuggestionStatus("error");
    } finally {
      finishSuggestionRequest(controller);
    }
  }

  function editClarificationRequest() {
    if (!pendingClarification) return;
    setInstruction(pendingClarification.originalPrompt);
    setPendingClarification(null);
    setSuggestionStatus("idle");
    setSuggestionMessage(null);
  }

  function installAppliedProgramEdit(
    editorRecord: EditorProgramRecord,
    index: number,
    operation: EditSuggestionOperation,
    focusSourceTime = editorRecord.program.anchor.resolvedSeconds,
  ) {
    const transactionId = editorRecord.program.transactionId;
    const activeEdit =
      editingAppliedProgram?.original.program.transactionId === transactionId ? editingAppliedProgram : null;
    if (draftProgram && !activeEdit) {
      setDraftError("Apply or discard the current draft before editing an Applied Program.");
      return false;
    }
    const metadata = editorRecord.editorMetadata;
    if (!metadata?.operation || !activeScene) {
      setDraftError("This Program is read-only because editable Studio authoring metadata is unavailable.");
      return false;
    }
    const precedingRecords = appliedPrograms.slice(0, index);
    const precedingPrograms = precedingRecords.map((candidate) => candidate.program);
    const workingFocus = sourceTimeToWorkingTime(precedingPrograms, focusSourceTime);
    const baseProjection = projectStudioWorkspace({
      activeScene,
      appliedPrograms: precedingRecords,
      currentTime: workingFocus,
      draftProgram: null,
      nextScene,
      selectedObjectIds: metadata.selection,
    });
    try {
      const validated = createValidatedDraft(
        operation,
        transactionId,
        editorRecord.program.provenance.origin,
        baseProjection.proposedState,
        editorRecord.program.anchor.capturedPlayhead,
        precedingPrograms,
        metadata.selection,
      );
      const replacement = replaceAppliedProgram(
        appliedPrograms,
        transactionId,
        editorProgramRecord(validated.record, validated.operation, metadata.selection),
      );
      if (replacement.kind === "rejected") throw new Error(replacement.reason);
      stageAppliedProgramEdit(editorRecord, index, {
        focusSourceTime,
        operation: validated.operation,
        record: validated.record,
      });
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The applied Program edit is invalid.");
      return false;
    }
  }

  function editAppliedProgram(record: ProgramRecord, index: number) {
    const editorRecord = record as EditorProgramRecord;
    const operation = editorRecord.editorMetadata?.operation;
    if (!operation) {
      setDraftError("This Program is read-only because editable Studio authoring metadata is unavailable.");
      return;
    }
    installAppliedProgramEdit(editorRecord, index, operation);
  }

  function editAppliedMotionClip(clip: AppliedMotionClip) {
    const record = appliedPrograms[clip.programIndex];
    if (!record || record.program.transactionId !== clip.transactionId) {
      setDraftError("The motion clip no longer matches the applied Program history.");
      return;
    }
    const operation =
      editingAppliedProgram?.original.program.transactionId === clip.transactionId
        ? draftOperation
        : record.editorMetadata?.operation;
    if (!operation) {
      setDraftError(clip.readOnlyReason ?? "This motion clip is read-only.");
      return;
    }
    installAppliedProgramEdit(record, clip.programIndex, operation, clip.sourceStart);
  }

  function changeAppliedMotionClip(clip: AppliedMotionClip, change: AppliedMotionClipChange) {
    const record = appliedPrograms[clip.programIndex];
    if (!record || record.program.transactionId !== clip.transactionId) {
      setDraftError("The motion clip no longer matches the applied Program history.");
      return;
    }
    const editingThisClip = editingAppliedProgram?.original.program.transactionId === clip.transactionId;
    const operation = editingThisClip ? draftOperation : record.editorMetadata?.operation;
    const program = editingThisClip && draftProgram ? draftProgram.program : record.program;
    if (!operation) {
      setDraftError(clip.readOnlyReason ?? "This motion clip is read-only.");
      return;
    }
    const retimed = retimeAppliedMotionClip({
      duration: change.duration,
      operation,
      operationId: clip.operationId,
      program,
      start: change.sourceStart,
    });
    if (retimed.kind === "invalid") {
      setDraftError(retimed.message);
      return;
    }
    installAppliedProgramEdit(record, clip.programIndex, retimed.operation, change.sourceStart);
  }

  function installCanonicalDraft(
    record: ProgramRecord,
    selectedIds: readonly string[] = [],
    precedingPrograms: readonly ProgramRecord["program"][] = appliedCanonicalPrograms,
    preserveAppliedProgram: ProgramRecord | null = null,
  ) {
    cancelSuggestionRequest();
    return stageDraft({
      clearAppliedEdit: true,
      clearSuggestion: true,
      currentTime: sourceTimeToWorkingTime(precedingPrograms, record.program.anchor.resolvedSeconds),
      operation: null,
      preserveAppliedProgram,
      record,
      selectedObjectIds: selectedIds,
      stopPlayback: true,
    });
  }

  function insertEntitiesAt(point: Point, entities?: readonly StudioEntityInput[]) {
    if (!draftBaseState || !draftSourceScene) return false;
    const previousInsertion = draftProgram && isStudioEntityInsertion(draftProgram) ? draftProgram : null;
    if (draftProgram && !previousInsertion) {
      setDraftError("Apply or discard the current draft before inserting another object.");
      return false;
    }
    const precedingPrograms =
      previousInsertion &&
      !appliedPrograms.some((record) => record.program.transactionId === previousInsertion.program.transactionId)
        ? [...appliedCanonicalPrograms, previousInsertion.program]
        : appliedCanonicalPrograms;
    const proposedState = previousInsertion ? (workspaceProjection?.proposedState ?? null) : draftBaseState;
    if (!proposedState) return false;
    const sourceScene = previousInsertion
      ? projectRuntimeSceneToSourceTimeline(proposedState.evaluatedScene, precedingPrograms)
      : draftSourceScene;
    const inputs =
      entities ??
      (insertTool === "select"
        ? []
        : [
            {
              content: defaultEntityContent(insertTool, insertValue),
              position: point,
              type: insertTool,
            },
          ]);
    if (inputs.length === 0) return false;
    const anchor = manualAuthoringAnchor({
      action: "inserting an object",
      requireAlignedPlayhead: false,
      scene: sourceScene,
      sourcePrograms: precedingPrograms,
    });
    if (!anchor) return false;
    try {
      const result = createStudioEntitiesProgram({
        capturedPlayhead: anchor.sourceTime,
        entities: inputs,
        scene: sourceScene,
        transactionId: `studio-insert-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(result.validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      if (!installCanonicalDraft(validated.record, result.entityIds, precedingPrograms, previousInsertion))
        return false;
      setInsertTool("select");
      setInsertValue("");
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object could not be inserted.");
      return false;
    }
  }

  function changeSceneDuration(targetDuration: number) {
    if (!activeScene || !draftBaseState) return false;
    if (draftProgram) {
      const message = "Apply or discard the current draft before changing the Scene duration.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
    const appliedAnchor = appliedPrograms[0]?.program.anchor.resolvedSeconds;
    const sourceAnchor =
      appliedAnchor !== undefined &&
      appliedPrograms.every((record) => Math.abs(record.program.anchor.resolvedSeconds - appliedAnchor) < 0.0005)
        ? appliedAnchor
        : activeScene.anchors.at(-1);
    if (sourceAnchor === undefined) {
      const message = "Add a # poietra:anchor at a safe source boundary before extending this Scene.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
    try {
      const validation = createSceneDurationProgram({
        appliedPrograms,
        capturedPlayhead: sourceCurrentTime,
        scene: draftBaseState.evaluatedScene,
        sourceAnchor,
        targetDuration,
        transactionId: `studio-duration-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      installCanonicalDraft(validated.record);
      setDurationError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Scene duration could not be changed.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
  }

  function trimEntityLifetime(entityId: string, workingLifetimeStart: number, sourceAnchor: number) {
    if (!draftSourceScene) return false;
    if (draftProgram) {
      setDraftError("Apply or discard the current draft before trimming an object lifetime.");
      return false;
    }
    const anchor = timelineAnchors.find((candidate) => Math.abs(candidate.sourceTime - sourceAnchor) < 0.0005);
    if (!anchor) {
      setDraftError("The selected lifetime end is not backed by a safe .py source anchor.");
      return false;
    }
    try {
      const validation = createTrimEntityLifetimeProgram({
        entityId,
        lifetimeStart: workingTimeToSourceTime(appliedCanonicalPrograms, workingLifetimeStart),
        retainedDuration: anchor.workingTime - workingLifetimeStart,
        scene: draftSourceScene,
        sourceAnchor: anchor.sourceTime,
        transactionId: `studio-lifetime-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      installCanonicalDraft(validated.record, [entityId]);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object lifetime could not be trimmed.");
      return false;
    }
  }

  function deleteSelection() {
    if (!draftBaseState || !draftSourceScene || selectedObjectIds.length === 0) return false;
    if (draftProgram) {
      const ownsSelectedDraftEntity = selectedObjectIds.some((entityId) =>
        entityId.startsWith(`tx:${draftProgram.program.transactionId}/entity:`),
      );
      if (ownsSelectedDraftEntity) {
        discardDraft();
        setSelectedObjectIds([]);
        return true;
      }
      setDraftError("Apply or discard the current draft before deleting another object.");
      return false;
    }
    const anchor = manualAuthoringAnchor({
      action: "deletion",
      requireAlignedPlayhead: true,
      scene: draftSourceScene,
      sourcePrograms: appliedCanonicalPrograms,
      targetEntityIds: selectedObjectIds,
    });
    if (!anchor) return false;
    try {
      const validation = createRemoveEntitiesProgram({
        capturedPlayhead: anchor.sourceTime,
        entityIds: selectedObjectIds,
        scene: draftSourceScene,
        transactionId: `studio-delete-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      installCanonicalDraft(validated.record, selectedObjectIds);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The selected objects could not be deleted.");
      return false;
    }
  }

  function copySelection() {
    const copied = editableEntities.flatMap((entity) => {
      if (!selectedSet.has(entity.id) || !entity.present) return [];
      const input = duplicateEntityInput(entity, 0);
      return input ? [input] : [];
    });
    if (copied.length === 0) return false;
    studioClipboard.current = copied;
    pasteCount.current = 0;
    return true;
  }

  function pasteSelection() {
    const copied = studioClipboard.current;
    if (copied.length === 0) return false;
    pasteCount.current += 1;
    const offset = 20 * pasteCount.current;
    return insertEntitiesAt(
      { x: 320, y: 180 },
      copied.map((entity) => ({
        ...entity,
        position: { x: entity.position.x + offset, y: entity.position.y + offset },
      })),
    );
  }

  function duplicateSelection() {
    const inputs = editableEntities.flatMap((entity) => {
      if (!selectedSet.has(entity.id) || !entity.present) return [];
      const input = duplicateEntityInput(entity);
      return input ? [input] : [];
    });
    return inputs.length > 0 && insertEntitiesAt({ x: 320, y: 180 }, inputs);
  }

  function directGestureContext() {
    const previousDraft =
      !editingAppliedProgram && draftProgram?.program.provenance.origin === "direct-manipulation" ? draftProgram : null;
    const sourcePrograms = previousDraft
      ? [...appliedCanonicalPrograms, previousDraft.program]
      : appliedCanonicalPrograms;
    return {
      preserveDraft: previousDraft,
      proposedState: previousDraft ? (workspaceProjection?.proposedState ?? null) : draftBaseState,
      sourcePrograms,
    } as const;
  }

  function manualAuthoringAnchor(
    input: Readonly<{
      action: string;
      requireAlignedPlayhead: boolean;
      scene: RuntimeSceneState;
      sourcePrograms: readonly ProgramRecord["program"][];
      targetEntityIds?: readonly string[];
    }>,
  ) {
    if (!activeScene) return null;
    const anchor = latestSafeSourceAnchor(input.sourcePrograms, activeScene.anchors, currentTime);
    if (!anchor) {
      setDraftError(
        `No safe .py source anchor exists before the playhead. Move to a source anchor before ${input.action}.`,
      );
      setIsPlaying(false);
      return null;
    }
    const missingEntityId = input.targetEntityIds?.find((entityId) => {
      const entity = input.scene.objectGraph.entities[entityId];
      return (
        !entity ||
        !entity.lifetime.some(
          (interval) => anchor.sourceTime >= interval.start - 0.0005 && anchor.sourceTime < interval.end,
        )
      );
    });
    if (missingEntityId) {
      setDraftError(
        `The selected object is not present at the latest safe .py source anchor, so Studio cannot ${input.action} truthfully.`,
      );
      setIsPlaying(false);
      return null;
    }
    if (input.requireAlignedPlayhead && Math.abs(currentTime - anchor.workingTime) >= 0.0005) {
      setCurrentTime(anchor.workingTime);
      setIsPlaying(false);
      setDraftError(
        `Moved the playhead to the latest safe .py source anchor at ${anchor.workingTime.toFixed(2)}s. Repeat the ${input.action}.`,
      );
      return null;
    }
    return anchor;
  }

  function beginEntityDrag(event: PointerEvent<HTMLButtonElement>, entityId: string) {
    if (canvasDrag.current || canvasResize.current) return;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before moving another object.");
      return;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const editable =
      entity && (!entity.provisional || (entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
    if (!editable) return;
    const selectedEditableIds = selectedObjectIds.filter((selectedId) =>
      editableEntities.some(
        (candidate) =>
          candidate.id === selectedId &&
          candidate.present &&
          (!candidate.provisional || (candidate.transactionId && appliedTransactionIds.has(candidate.transactionId))),
      ),
    );
    const targetEntityIds = selectedEditableIds.includes(entityId) ? selectedEditableIds : [entityId];
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "object drag",
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds,
    });
    if (!anchor) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const canvasBounds = event.currentTarget.closest<HTMLElement>("[data-scene-phase]")?.getBoundingClientRect();
    setSelectedObjectIds(targetEntityIds);
    canvasDrag.current = {
      pointerId: event.pointerId,
      scale: {
        x: canvasBounds?.width ? STUDIO_VIEWPORT.width / canvasBounds.width : 1,
        y: canvasBounds?.height ? STUDIO_VIEWPORT.height / canvasBounds.height : 1,
      },
      sourceAnchor: anchor.sourceTime,
      start: { x: event.clientX, y: event.clientY },
      targetEntityIds,
    };
    setIsPlaying(false);
    setDragPreview({ delta: { x: 0, y: 0 }, entityIds: targetEntityIds });
  }

  function moveEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = canvasDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragPreview({
      delta: canvasPointerDelta(drag, { x: event.clientX, y: event.clientY }),
      entityIds: drag.targetEntityIds,
    });
  }

  function finishEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = canvasDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    canvasDrag.current = null;
    setDragPreview(null);
    if (!activeScene || !draftBaseState || !draftSourceScene) return;
    const delta = canvasPointerDelta(drag, { x: event.clientX, y: event.clientY });
    if (Math.hypot(delta.x, delta.y) < 1) return;
    const targetIds = drag.targetEntityIds;
    const transactionId = `studio-gesture-${crypto.randomUUID()}`;
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    if (interactionMode === "animate") {
      const end = drag.sourceAnchor + motionDuration;
      if (motionDuration < 0.1 || end > sourceScene.duration + 0.001) {
        setDraftError("The motion must be at least 0.1 seconds and fit within the current Scene duration.");
        return;
      }
      const operation: CreateMotionSuggestion = {
        anchor: { kind: "playhead", referenceSeconds: drag.sourceAnchor },
        controlOffset: { x: 0, y: 0 },
        delta,
        easing: "smooth",
        end,
        kind: "create-motion",
        start: drag.sourceAnchor,
        targetObjectIds: targetIds,
      };
      installDraft(operation, transactionId, {
        capturedPlayhead: drag.sourceAnchor,
        origin: "direct-manipulation",
        ...gestureContext,
      });
      return;
    }
    installPositionDraft(delta, targetIds, transactionId, gestureContext, drag.sourceAnchor);
  }

  function cancelEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    if (canvasDrag.current?.pointerId !== event.pointerId) return;
    canvasDrag.current = null;
    setDragPreview(null);
  }

  function beginEntityResize(event: PointerEvent<HTMLButtonElement>, entityId: string) {
    event.stopPropagation();
    if (canvasDrag.current || canvasResize.current) return;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const editable =
      entity &&
      entity.present &&
      (!entity.provisional || (entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
    if (!editable) return;
    if (entity.geometry.scale.kind === "unknown") {
      setDraftError(`Studio cannot resize ${entityLabel(entity)} safely: ${entity.geometry.scale.reason}`);
      return;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "object resize",
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor) return;
    const wrapper = event.currentTarget.closest<HTMLElement>("[data-studio-entity-wrapper]");
    const object = wrapper?.querySelector<HTMLElement>("[data-studio-entity]");
    const bounds = object?.getBoundingClientRect();
    if (!bounds) return;
    setSelectedObjectIds([entityId]);
    setIsPlaying(false);
    canvasResize.current = {
      center: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
      entityId,
      fromScale: entity.scale,
      pointerId: event.pointerId,
      sourceAnchor: anchor.sourceTime,
      start: { x: event.clientX, y: event.clientY },
    };
    setScalePreview({ entityId, scale: entity.scale });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setScalePreview({
      entityId: resize.entityId,
      scale: resizedEntityScale(resize, { x: event.clientX, y: event.clientY }),
    });
  }

  function finishEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const targetScale = resizedEntityScale(resize, { x: event.clientX, y: event.clientY });
    canvasResize.current = null;
    setScalePreview(null);
    if (Math.abs(targetScale - resize.fromScale) < 0.01) return;
    installEntityScaleDraft(
      resize.entityId,
      resize.fromScale,
      targetScale,
      interactionMode === "animate",
      `studio-resize-${crypto.randomUUID()}`,
      resize.sourceAnchor,
    );
  }

  function cancelEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (canvasResize.current?.pointerId !== event.pointerId) return;
    canvasResize.current = null;
    setScalePreview(null);
  }

  function nudgeEntityScale(event: KeyboardEvent<HTMLButtonElement>, entityId: string) {
    const direction =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return;
    const factor = event.shiftKey ? 1.25 : 1.05;
    const targetScale = clamp(
      direction > 0 ? entity.scale * factor : entity.scale / factor,
      MIN_ENTITY_SCALE,
      MAX_ENTITY_SCALE,
    );
    installEntityScaleDraft(
      entityId,
      entity.scale,
      targetScale,
      interactionMode === "animate",
      `studio-resize-key-${crypto.randomUUID()}`,
    );
  }

  function installEntityScaleDraft(
    entityId: string,
    fromScale: number,
    targetScale: number,
    animated: boolean,
    transactionId: string,
    capturedSourceAnchor?: number,
  ) {
    if (!activeScene || !draftBaseState) return false;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return false;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return false;
    if (entity.geometry.scale.kind === "unknown") {
      setDraftError(`Studio cannot resize ${entityLabel(entity)} safely: ${entity.geometry.scale.reason}`);
      return false;
    }
    if (!Number.isFinite(targetScale) || targetScale < MIN_ENTITY_SCALE || targetScale > MAX_ENTITY_SCALE) {
      setDraftError(`Scale must be between ${MIN_ENTITY_SCALE}x and ${MAX_ENTITY_SCALE}x.`);
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor =
      capturedSourceAnchor === undefined
        ? manualAuthoringAnchor({
            action: "object resize",
            requireAlignedPlayhead: true,
            scene: sourceScene,
            sourcePrograms: gestureContext.sourcePrograms,
            targetEntityIds: [entityId],
          })
        : { sourceTime: capturedSourceAnchor };
    if (!anchor) return false;
    const sampledScale = samplePropertyValue(
      sourceScene.propertyChannels[`${entityId}/scale`]?.samples ?? [],
      anchor.sourceTime,
    );
    const executionScale = typeof sampledScale === "number" ? sampledScale : fromScale;
    const end = animated ? anchor.sourceTime + motionDuration : anchor.sourceTime;
    if (animated && (motionDuration < 0.1 || end > sourceScene.duration + 0.001)) {
      setDraftError("The resize must be at least 0.1 seconds and fit within the current Scene duration.");
      return false;
    }
    try {
      const validation = createDirectManipulationScaleProgram({
        capturedPlayhead: anchor.sourceTime,
        interval: { end, start: anchor.sourceTime },
        scales: { [entityId]: { from: executionScale, to: targetScale } },
        scene: sourceScene,
        targetEntityIds: [entityId],
        transactionId,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      cancelSuggestionRequest();
      if (
        !stageDraft({
          clearAppliedEdit: true,
          clearSuggestion: true,
          currentTime: sourceTimeToWorkingTime(gestureContext.sourcePrograms, anchor.sourceTime),
          operation: null,
          preserveAppliedProgram: gestureContext.preserveDraft,
          record: validated.record,
          stopPlayback: true,
        })
      )
        return false;
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object could not be resized.");
      return false;
    }
  }

  function resizeEntityFromInspector(entityId: string, targetScale: number) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity || Math.abs(entity.scale - targetScale) < 0.001) return false;
    return installEntityScaleDraft(
      entityId,
      entity.scale,
      targetScale,
      false,
      `studio-resize-input-${crypto.randomUUID()}`,
    );
  }

  function installPositionDraft(
    delta: Readonly<{ x: number; y: number }>,
    targetIds: readonly string[],
    transactionId: string,
    gestureContext: Readonly<{
      preserveDraft: ProgramRecord | null;
      proposedState: ProposedState | null;
      sourcePrograms: readonly ProgramRecord["program"][];
    }> = directGestureContext(),
    capturedSourceAnchor?: number,
  ) {
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before moving another object.");
      return;
    }
    if (!gestureContext.proposedState || !projection) return;
    const projected = projectedPositions(projection.canvas.entities, targetIds);
    if (projected.kind === "invalid") {
      setDraftError(projected.message);
      return;
    }
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor =
      capturedSourceAnchor === undefined
        ? manualAuthoringAnchor({
            action: "object move",
            requireAlignedPlayhead: true,
            scene: sourceScene,
            sourcePrograms: gestureContext.sourcePrograms,
            targetEntityIds: targetIds,
          })
        : { sourceTime: capturedSourceAnchor };
    if (!anchor) return;
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: anchor.sourceTime,
      delta,
      positions: projected.positions,
      scene: sourceScene,
      start: anchor.sourceTime,
      targetEntityIds: targetIds,
      transactionId,
    });
    const validated = validatedProgramRecord(validation);
    if (validated.kind === "invalid") {
      setDraftError(validated.message);
      return;
    }
    cancelSuggestionRequest();
    if (
      !stageDraft({
        clearAppliedEdit: true,
        clearSuggestion: true,
        currentTime: sourceTimeToWorkingTime(gestureContext.sourcePrograms, anchor.sourceTime),
        operation: null,
        preserveAppliedProgram: gestureContext.preserveDraft,
        record: validated.record,
        stopPlayback: true,
      })
    )
      return;
  }

  function nudgeEntity(event: KeyboardEvent<HTMLButtonElement>, entityId: string) {
    const delta = NUDGE_DELTAS[event.key];
    if (!delta || !draftBaseState || !projection) return;
    event.preventDefault();
    const multiplier = event.shiftKey ? 5 : 1;
    const targetIds = selectedObjectIds.includes(entityId) ? selectedObjectIds : [entityId];
    installPositionDraft(
      { x: delta.x * multiplier, y: delta.y * multiplier },
      targetIds,
      `studio-nudge-${crypto.randomUUID()}`,
    );
  }

  function changeDraftMotionControl(path: StudioMotionPath, delta: Point) {
    if (!draftOperation || !draftProgram || !editableMotionIds.has(path.motionId)) return;
    const adjusted = adjustAppliedMotionClipControl({
      delta,
      operation: draftOperation,
      operationId: path.motionId,
      program: draftProgram.program,
    });
    if (adjusted.kind === "invalid") {
      setDraftError(adjusted.message);
      return;
    }
    updateDraftOperation(adjusted.operation);
  }

  function handleStudioCommand(command: StudioCommandId) {
    const toolByCommand: Partial<Record<StudioCommandId, StudioTool>> = {
      "insert-arrow": "Arrow",
      "insert-circle": "Circle",
      "insert-line": "Line",
      "insert-mathtex": "MathTex",
      "insert-rectangle": "Rectangle",
      "insert-text": "Text",
      "select-tool": "select",
    };
    const tool = toolByCommand[command];
    if (tool) {
      setInsertTool(tool);
      return true;
    }
    if (command === "undo") {
      if (!draftProgram && appliedPrograms.length === 0) return false;
      undoProgram();
      return true;
    }
    if (command === "redo") return redoProgram();
    if (command === "delete") return deleteSelection();
    if (command === "duplicate") return duplicateSelection();
    if (command === "copy") return copySelection();
    if (command === "paste") return pasteSelection();
    if (command === "select-all") {
      const ids = editableEntities
        .filter(
          (entity) =>
            entity.present &&
            (!entity.provisional || (entity.transactionId && appliedTransactionIds.has(entity.transactionId))),
        )
        .map((entity) => entity.id);
      if (ids.length === 0) return false;
      setSelectedObjectIds(ids);
      return true;
    }
    if (command === "play-pause") {
      if (!activeScene) return false;
      if (currentTime >= activeDuration) setCurrentTime(0);
      setIsPlaying((playing) => !playing);
      return true;
    }
    if (command === "escape") {
      if (insertTool !== "select") {
        setInsertTool("select");
        return true;
      }
      if (draftProgram) {
        discardDraft();
        return true;
      }
      if (selectedObjectIds.length > 0) {
        setSelectedObjectIds([]);
        return true;
      }
    }
    return false;
  }

  commandHandler.current = handleStudioCommand;

  const renderPrograms = editingAppliedProgram
    ? previewAppliedPrograms.map((record) => record.program)
    : [...appliedPrograms.map((record) => record.program), ...(draftProgram ? [draftProgram.program] : [])];
  const renderProgram = renderPrograms[0] ?? null;
  const renderCandidateUnavailableReason =
    "Export .py downloads the selected source unchanged. Create or apply a Canonical draft to render or export Studio edits.";
  const renderCandidate: RenderProgramCandidate | null =
    activeScene && activeProjectId && renderProgram
      ? {
          anchors: activeScene.anchors,
          destination:
            programsHaveSceneBoundary(renderPrograms) && nextScene
              ? {
                  sceneName: nextScene.name,
                  sourcePath: nextScene.sourcePath,
                }
              : null,
          program: renderProgram,
          programs: renderPrograms,
          projectId: activeProjectId,
          sceneName: activeScene.name,
          sourceBindings: Object.entries(activeScene.sourceVariables).map(([entityId, sourceVariable]) => ({
            entityId,
            sourceVariable,
          })),
          sourceHash: activeScene.sourceHash,
          sourcePath: activeScene.sourcePath,
          viewport: STUDIO_VIEWPORT,
        }
      : null;

  const selectedEntity = editableEntities.find((entity) => selectedSet.has(entity.id)) ?? null;
  const appliedProgramReadOnlyReasons = Object.fromEntries(
    appliedPrograms.map((record) => {
      const transactionId = record.program.transactionId;
      const metadata = record.editorMetadata;
      return [
        transactionId,
        metadata?.operation
          ? null
          : metadata
            ? "This canonical Program was created without editable authoring metadata."
            : "Editable Studio authoring metadata is unavailable for this Program.",
      ];
    }),
  );
  const activeWorkspaceName =
    workspace?.projectName ?? projects.find((project) => project.id === activeProjectId)?.name ?? "Workspace";

  function returnToWorkspaceLauncher() {
    saveEditorSession();
    suspendEditor();
    canvasDrag.current = null;
    canvasResize.current = null;
    setDragPreview(null);
    setScalePreview(null);
    leaveWorkspace();
  }

  async function unregisterWorkspaceAndClearSession(workspaceId: string) {
    if (!(await unregisterWorkspace(workspaceId))) return false;
    clearProjectSessions(workspaceId);
    setRenderSessions((current) => {
      if (!(workspaceId in current)) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
    return true;
  }

  if (activeProjectId === null) {
    return (
      <WorkspaceLauncher
        creationMode={shell === "Browser" ? "managed" : window.poietraDesktop ? "native-existing" : "existing"}
        error={workspaceError}
        isLoading={workspaceStatus === "loading"}
        mutation={workspaceMutation}
        mutationError={workspaceMutationError}
        onCancelMutation={cancelWorkspaceMutation}
        onClearMutationError={clearMutationError}
        onCreate={createWorkspace}
        onOpen={setActiveProjectId}
        onRename={renameWorkspace}
        onRetry={() => void refreshWorkspace()}
        onUnregister={unregisterWorkspaceAndClearSession}
        projects={projects}
      />
    );
  }

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100" ref={workspaceBounds}>
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h1 className="hidden shrink-0 text-balance text-sm font-semibold md:block">Poietra Studio Lab</h1>
            <button
              aria-label="Back to workspaces"
              className="shrink-0 border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
              onClick={returnToWorkspaceLauncher}
              type="button"
            >
              Workspaces
            </button>
            <span
              aria-label="Current workspace"
              className="hidden max-w-40 shrink-0 truncate text-xs font-medium text-zinc-400 sm:block"
              title={activeWorkspaceName}
            >
              {activeWorkspaceName}
            </span>
            {scenes.length > 0 ? (
              <select
                aria-label="Active imported Scene"
                className="h-8 min-w-0 w-full max-w-sm border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-300 outline-none focus:border-sky-500"
                onChange={(event) => {
                  saveEditorSession();
                  setActiveSceneId(event.currentTarget.value);
                }}
                value={activeSceneId ?? ""}
              >
                {scenes.map((scene) => (
                  <option key={scene.sceneId} value={scene.sceneId}>
                    {scene.sourcePath} · {scene.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs">
            <button
              className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-wait disabled:text-zinc-600"
              disabled={workspaceIsRefreshing}
              onClick={() => void refreshWorkspace()}
              type="button"
            >
              {workspaceIsRefreshing ? "Reimporting…" : "Reimport"}
            </button>
            <button
              aria-controls="studio-magic-edit"
              aria-expanded={Boolean(activeScene && isMagicEditVisible)}
              className={cn(
                "border px-2 py-1 font-medium",
                !activeScene
                  ? "cursor-wait border-zinc-800 text-zinc-600"
                  : isMagicEditVisible
                    ? "border-sky-800 bg-sky-950 text-sky-300 hover:bg-sky-900"
                    : "border-zinc-700 text-zinc-300 hover:bg-zinc-800",
              )}
              disabled={!activeScene}
              onClick={() => setIsMagicEditVisible((visible) => !visible)}
              type="button"
            >
              Magic Edit
            </button>
            <span className="hidden border border-zinc-700 px-2 py-1 text-zinc-500 xl:inline">{shell}</span>
          </div>
        </header>

        {workspaceError && activeScene ? (
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b border-red-950 bg-red-950/40 px-3 py-1.5 text-xs text-red-200"
            role="alert"
          >
            <span className="min-w-0 truncate">Reimport failed: {workspaceError}</span>
            <button
              className="shrink-0 underline underline-offset-2 hover:text-white"
              onClick={() => void refreshWorkspace()}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : null}

        {workspaceStatus === "loading" ? (
          <div
            aria-label="Importing Manim workspace"
            className="grid min-h-0 flex-1 place-items-center bg-zinc-900 p-6"
          >
            <div className="w-full max-w-sm border border-zinc-800 p-5">
              <h2 className="text-balance text-sm font-medium text-zinc-200">Importing Manim workspace</h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                Inspecting source files and checking the render adapter…
              </p>
            </div>
          </div>
        ) : workspaceStatus === "error" || !activeScene || !projection ? (
          <div className="grid flex-1 place-items-center p-6">
            <div className="max-w-md border border-zinc-800 p-5">
              <h2 className="text-balance text-sm font-medium">No imported Scene is available</h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                {workspaceError ?? "Add a Python file containing a Manim Scene under the configured project root."}
              </p>
              <button
                className="mt-4 bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950"
                onClick={() => void refreshWorkspace()}
                type="button"
              >
                Inspect workspace again
              </button>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(30rem,1fr)_auto_auto] gap-px overflow-y-auto bg-zinc-800 md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-[minmax(32rem,1fr)_auto] xl:grid-cols-[14rem_minmax(0,1fr)_21rem] xl:grid-rows-1 xl:overflow-hidden">
            <WorkspaceSidebar
              activeScene={activeScene}
              appliedProgramReadOnlyReasons={appliedProgramReadOnlyReasons}
              appliedPrograms={appliedPrograms}
              appliedTransactionIds={appliedTransactionIds}
              className="order-2 min-h-64 md:order-1 md:col-start-1 md:row-start-1 md:min-h-0"
              draftActive={draftProgram !== null}
              duration={activeDuration}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              durationError={durationError}
              durationMinimum={durationTrimAvailability.minimumDuration}
              entities={editableEntities}
              nextScene={nextScene}
              onDurationChange={(duration) => void changeSceneDuration(duration)}
              onEditAppliedProgram={editAppliedProgram}
              onRedo={() => void redoProgram()}
              onToggleEntity={(entityId, selected) =>
                setSelectedObjectIds((selection) =>
                  selected ? selection.filter((id) => id !== entityId) : [...selection, entityId],
                )
              }
              onUndo={undoProgram}
              redoCount={redoPrograms.length}
              selectedIds={selectedSet}
            />

            <StudioViewport
              anchors={timelineAnchors}
              appliedMotionClips={appliedMotionClips}
              appliedTransactionIds={appliedTransactionIds}
              boundaryActive={boundary !== null}
              className="order-1 min-h-[30rem] md:order-2 md:col-start-2 md:row-start-1 md:min-h-[32rem] xl:min-h-0"
              currentTime={currentTime}
              draftTransactionId={draftProgram?.program.transactionId ?? null}
              dragPreview={dragPreview}
              duration={activeDuration}
              editableMotionIds={editableMotionIds}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              entities={visibleEntities}
              incomingSceneName={nextScene?.name ?? null}
              insertTool={insertTool}
              insertValue={insertValue}
              interactionMode={interactionMode}
              isPlaying={isPlaying}
              lifetimeTrimDisabled={draftProgram !== null}
              motionDuration={motionDuration}
              motionPaths={motionPaths}
              onAppliedMotionClipChange={changeAppliedMotionClip}
              onAppliedMotionClipSelect={editAppliedMotionClip}
              onCanvasPlace={(point) => void insertEntitiesAt(point)}
              onEntityKeyDown={nudgeEntity}
              onEntityPointerCancel={cancelEntityDrag}
              onEntityPointerDown={beginEntityDrag}
              onEntityPointerMove={moveEntityDrag}
              onEntityPointerUp={finishEntityDrag}
              onEntityResizeCancel={cancelEntityResize}
              onEntityResizeKeyDown={nudgeEntityScale}
              onEntityResizePointerDown={beginEntityResize}
              onEntityResizePointerMove={moveEntityResize}
              onEntityResizePointerUp={finishEntityResize}
              onInteractionModeChange={setInteractionMode}
              onInsertAtCenter={() => void insertEntitiesAt({ x: 320, y: 180 })}
              onInsertToolChange={setInsertTool}
              onInsertValueChange={setInsertValue}
              onLifetimeEndChange={(entityId, lifetimeStart, sourceAnchor) => {
                void trimEntityLifetime(entityId, lifetimeStart, sourceAnchor);
              }}
              onMotionControlChange={changeDraftMotionControl}
              onMotionDurationChange={setMotionDuration}
              onSelectEntity={(entityId) => setSelectedObjectIds([entityId])}
              onTimeChange={(time) => {
                setIsPlaying(false);
                setCurrentTime(time);
              }}
              onTogglePlayback={() => {
                if (currentTime >= activeDuration) setCurrentTime(0);
                setIsPlaying((playing) => !playing);
              }}
              projection={projection}
              readOnly={boundary !== null}
              scalePreview={scalePreview}
              selectedIds={selectedSet}
            />

            <StudioInspector
              appliedProgramCount={appliedPrograms.length}
              className="order-3 min-h-96 md:col-span-2 md:col-start-1 md:row-start-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:min-h-0"
              draftError={draftError}
              draftOperation={draftOperation}
              draftProgram={draftProgram}
              onApplyDraft={applyDraft}
              onDiscardDraft={discardDraft}
              onDraftOperationChange={updateDraftOperation}
              onEntityScaleChange={(entityId, scale) => void resizeEntityFromInspector(entityId, scale)}
              onRenderSessionChange={retainRenderSession}
              onSourceChanged={async () => {
                const identity = activeEditorSessionIdentity();
                if (identity) clearSession(identity);
                resetPrograms();
                await refreshWorkspace();
              }}
              renderCandidate={renderCandidate}
              renderCandidateUnavailableReason={renderCandidateUnavailableReason}
              renderSession={activeProjectId ? (renderSessions[activeProjectId] ?? null) : null}
              replacingAppliedProgram={editingAppliedProgram !== null}
              selectedEntity={selectedEntity}
              sourceExport={
                activeProjectId && activeScene
                  ? {
                      projectId: activeProjectId,
                      sourceHash: activeScene.sourceHash,
                      sourcePath: activeScene.sourcePath,
                    }
                  : null
              }
              suggestion={suggestion}
              workspace={workspace}
            />
          </div>
        )}

        {isMagicEditVisible && activeScene ? (
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
