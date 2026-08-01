import { LazyMotion } from "motion/react";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountSessionBadge } from "./accounts/account-session-badge";
import type { AccountSessionActionsV1 } from "./accounts/account-session-bootstrap";
import type { AccountSessionViewV1 } from "./accounts/account-session-contract";
import { createClarificationContextFingerprint, MAX_CLARIFICATION_HISTORY } from "./ai/clarification";
import {
  type ClarificationOption,
  type CreateMotionSuggestion,
  type EditSuggestionOperation,
  suggestEdit,
} from "./ai/edit-suggestions";
import { cn } from "./lib/cn";
import { exportManimSource } from "./render-pipeline/client";
import type { RenderSessionView } from "./render-pipeline/contracts";
import type { RenderProgramCandidate } from "./render-pipeline/render-pipeline-policy";
import {
  createImportedEntityLifetimeProgram,
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioEntityLifetimeProgram,
  type StudioEntityInput,
  sceneDurationTrimAvailability,
} from "./studio/authoring-commands";
import { commandForShortcut, isEditableShortcutTarget, type StudioCommandId } from "./studio/commands";
import { projectedPositions, validatedProgramRecord, validateSuggestionDraft } from "./studio/draft-validation";
import { materializeAuthoritativeEditorProgramsV1 } from "./studio/editor-authority-state";
import {
  collaborationMutationForApplyV1,
  collaborationMutationForRedoV1,
  collaborationMutationForUndoV1,
} from "./studio/editor-collaboration-mutation";
import {
  canResolveSourceDurationMismatch,
  clampPlayheadToResolvedSourceDuration,
  EDITOR_SESSION_LOADING_BLOCKER,
  resolveEditorRevision,
  resolveEditorSourceLifecycle,
  SOURCE_TIMING_LOADING_BLOCKER,
  WORKSPACE_REIMPORT_BLOCKER,
} from "./studio/editor-revision-policy";
import { projectVerifiedSourceDuration } from "./studio/imported-workspace";
import type { InspectorEditField, ValidatedInspectorEdits } from "./studio/inspector-edit";
import {
  buildLifetimeEditControls,
  findCompetingImportedLifetimeOwner,
  findCompetingStudioLifetimeOwner,
  findImportedLifetimeEdit,
  findStudioLifetimeOwner,
  programSourceAnchorBounds,
} from "./studio/lifetime-editing";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE, magicEditCapabilities } from "./studio/magic-edit-capabilities";
import { MagicEditPanel } from "./studio/magic-edit-panel";
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
import { PoietraBrand } from "./studio/poietra-brand";
import { latestSafeSourceAnchor, sourceTimeToWorkingTime, workingTimeToSourceTime } from "./studio/program-composition";
import { samplePropertyValue } from "./studio/property-sampling";
import {
  hasShapeDimensions,
  type ResizeHandleDirection,
  resizeHandleUsesDelta,
  resizeKindForType,
  resizeShapeByViewportDelta,
  type ShapeGeometry,
  type ShapeResizeKind,
  sameShapeGeometry,
} from "./studio/shape-resize";
import { projectRuntimeSceneToSourceTimeline } from "./studio/source-timeline";
import { StudioInspector, WorkspaceSidebar } from "./studio/studio-sidebars";
import type { StudioTool } from "./studio/studio-toolbar";
import {
  type EntityDragPreview,
  type EntityGeometryPreview,
  type EntityScalePreview,
  entityLabel,
  STUDIO_VIEWPORT,
  StudioViewport,
} from "./studio/studio-viewport";
import {
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationScaleProgram,
} from "./studio/suggestion-program";
import { replaceAppliedProgram } from "./studio/transactions";
import {
  type AppliedProgramEdit,
  applyEditorDraft as applyEditorDraftTransition,
  type EditorProgramRecord,
  type EditorSessionIdentity,
  editorProgramRecord,
  useEditorController,
} from "./studio/use-editor-controller";
import { useEditorDocumentAuthorityV1 } from "./studio/use-editor-document-authority";
import { useEditorRevisionController } from "./studio/use-editor-revision-controller";
import { useManimWorkspace } from "./studio/use-manim-workspace";
import { useStudioPreviewAuthorityController } from "./studio/use-preview-authority-controller";
import { useSourceReimportController } from "./studio/use-source-reimport-controller";
import { WorkspaceLauncher } from "./studio/workspace-launcher";
import { isTransitionOverlay, projectStudioWorkspace } from "./studio/workspace-projection";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);
const NUDGE_DELTAS: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  ArrowDown: { x: 0, y: 2 },
  ArrowLeft: { x: -2, y: 0 },
  ArrowRight: { x: 2, y: 0 },
  ArrowUp: { x: 0, y: -2 },
};
type CanvasDragState = Readonly<{
  pointerId: number;
  scale: Readonly<{ x: number; y: number }>;
  sourceAnchor: number;
  start: Readonly<{ x: number; y: number }>;
  targetEntityIds: readonly string[];
}>;
type CanvasResizeBase = Readonly<{
  canvasScale: Readonly<{ x: number; y: number }>;
  direction: ResizeHandleDirection;
  entityId: string;
  pointerId: number;
  sourceAnchor: number;
  start: Readonly<{ x: number; y: number }>;
}>;
type CanvasScaleResizeState = CanvasResizeBase &
  Readonly<{
    center: Readonly<{ x: number; y: number }>;
    fromScale: number;
    mode: "scale";
  }>;
type CanvasShapeResizeState = CanvasResizeBase &
  Readonly<{
    cameraScale: number;
    frame: Readonly<{ height: number; width: number }>;
    from: ShapeGeometry;
    mode: "shape";
    scale: number;
    shape: ShapeResizeKind;
  }>;
type CanvasResizeState = CanvasScaleResizeState | CanvasShapeResizeState;
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

function resizedEntityScale(resize: CanvasScaleResizeState, point: Readonly<{ x: number; y: number }>) {
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

function resizedShapeGeometry(resize: CanvasShapeResizeState, point: Readonly<{ x: number; y: number }>) {
  return resizeShapeByViewportDelta({
    cameraScale: resize.cameraScale,
    direction: resize.direction,
    frame: resize.frame,
    from: resize.from,
    scale: resize.scale,
    shape: resize.shape,
    viewport: STUDIO_VIEWPORT,
    viewportDelta: {
      x: (point.x - resize.start.x) * resize.canvasScale.x,
      y: (point.y - resize.start.y) * resize.canvasScale.y,
    },
  });
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

export function App({
  accountActions = null,
  accountSession = null,
}: Readonly<{
  accountActions?: AccountSessionActionsV1 | null;
  accountSession?: AccountSessionViewV1 | null;
}>) {
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
  const editorController = useEditorController(
    accountSession
      ? { organizationId: accountSession.activeOrganization.id, userId: accountSession.user.id }
      : undefined,
  );
  const {
    activeSessionIdentity,
    applyDraft: applyEditorDraft,
    beginSuggestionRequest,
    cancelSuggestionRequest,
    clearProjectSessions,
    clearSession,
    discardDraft,
    editAppliedProgram: stageAppliedProgramEdit,
    finishSuggestionRequest,
    installAuthoritativePrograms,
    isSuggestionRequestCurrent,
    openSession,
    pruneSessions,
    redoProgram: redoEditorProgram,
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
    stageDraft: stageEditorDraft,
    state: editorState,
    setVerifiedSourceDurationBasis,
    suspend: suspendEditor,
    undoProgram,
  } = editorController;
  const {
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
    programUndoEntries,
    redoPrograms,
    selectedObjectIds,
    suggestion,
    suggestionMessage,
    suggestionStatus,
    verifiedSourceDurationBasis,
  } = editorState;
  const {
    reconcileRenderedSource,
    reimportWorkspace,
    setSourceMutationPending,
    sourceMutationPendingProjectId,
    sourceReimportTarget,
  } = useSourceReimportController({
    activeProjectId,
    activeSource:
      activeProjectId && activeScene
        ? {
            projectId: activeProjectId,
            sceneId: activeScene.sceneId,
            sceneName: activeScene.name,
            sourceHash: activeScene.sourceHash,
            sourcePath: activeScene.sourcePath,
          }
        : null,
    clearSession,
    refreshWorkspace,
    resetPrograms,
  });
  const [renderSessions, setRenderSessions] = useState<Readonly<Record<string, RenderSessionView>>>({});
  const [draftApplyPending, setDraftApplyPending] = useState(false);
  const [lifetimeEditMessage, setLifetimeEditMessage] = useState<string | null>(null);
  const [isMagicEditVisible, setIsMagicEditVisible] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  const [dragPreview, setDragPreview] = useState<EntityDragPreview | null>(null);
  const [geometryPreview, setGeometryPreview] = useState<EntityGeometryPreview | null>(null);
  const [scalePreview, setScalePreview] = useState<EntityScalePreview | null>(null);
  const [inspectorReturnFocus, setInspectorReturnFocus] = useState<InspectorEditField | null>(null);
  const suggestionContext = useRef("");
  const canvasDrag = useRef<CanvasDragState | null>(null);
  const canvasResize = useRef<CanvasResizeState | null>(null);
  const studioClipboard = useRef<readonly StudioEntityInput[]>([]);
  const pasteCount = useRef(0);
  const commandHandler = useRef<(command: StudioCommandId) => boolean>(() => false);
  const previewActivationDialog = useRef<HTMLDialogElement | null>(null);
  const sourceTimingResolutionDialog = useRef<HTMLDialogElement | null>(null);
  const sourceTimingResolutionTarget = useRef<string | null>(null);
  const workspaceBounds = useRef<HTMLElement | null>(null);
  const appliedCanonicalPrograms = appliedPrograms.map((record) => record.program);
  const appliedProgramTransactionIds = useMemo(
    () => appliedPrograms.map((record) => record.program.transactionId),
    [appliedPrograms],
  );
  const sourceCurrentTime = workingTimeToSourceTime(appliedCanonicalPrograms, currentTime);
  const timelineAnchors =
    activeScene?.anchors.map((sourceTime) => ({
      sourceTime,
      workingTime: sourceTimeToWorkingTime(appliedCanonicalPrograms, sourceTime),
    })) ?? [];

  useEffect(() => {
    if (draftProgram === null) setLifetimeEditMessage(null);
  }, [draftProgram]);

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
    setLifetimeEditMessage(null);
    setDragPreview(null);
    setGeometryPreview(null);
    setScalePreview(null);
    setInspectorReturnFocus(null);
  }, [activeScene?.sceneId, activeScene?.sourceHash, activeProjectId]);

  const editorDocumentIdentity = useMemo(
    () =>
      accountSession && activeProjectId && activeScene
        ? {
            organizationId: accountSession.activeOrganization.id,
            projectId: activeProjectId,
            sceneName: activeScene.name,
            sourceHash: activeScene.sourceHash,
            sourcePath: activeScene.sourcePath,
          }
        : null,
    [accountSession, activeProjectId, activeScene],
  );
  const installEditorDocumentProjection = useCallback(
    (programs: readonly ProgramRecord["program"][], reason: "open" | "remote") => {
      if (!activeScene) throw new TypeError("The authoritative Editor projection has no selected Scene.");
      installAuthoritativePrograms(
        materializeAuthoritativeEditorProgramsV1(activeScene, appliedPrograms, programs),
        reason === "remote"
          ? "This Scene changed in another editor. Local draft and Undo/Redo history were reset."
          : null,
      );
    },
    [activeScene, appliedPrograms, installAuthoritativePrograms],
  );
  const editorDocumentAuthority = useEditorDocumentAuthorityV1({
    identity: editorDocumentIdentity,
    onProjection: installEditorDocumentProjection,
  });

  const importedSceneBoundaryActive =
    activeScene?.runtimeSceneState.eventTrack.events.some(
      (event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= currentTime,
    ) ?? false;
  // Imported boundaries still gate the canvas directly. Studio-authored
  // boundaries are already fail-closed by their non-pristine revision.
  const sourceLifecycle = resolveEditorSourceLifecycle({
    activeProjectId,
    renderActionInProgress: activeProjectId !== null && renderSessions[activeProjectId]?.actionInProgress === true,
    sourceMutationPendingProjectId,
    sourceReimportTargetProjectId: sourceReimportTarget?.projectId ?? null,
    workspaceRefreshing: workspaceIsRefreshing,
  });
  const editorRevision = useMemo(
    () =>
      resolveEditorRevision({
        activeProjectId,
        appliedPrograms,
        draftProgram,
        editingAppliedProgram,
        invalidated: sourceLifecycle.invalidated,
        loadedSessionIdentity: activeSessionIdentity,
        redoPrograms,
        retainedSourceDurationBasis: verifiedSourceDurationBasis,
        scene: activeScene,
        workspaceProjectId: workspace?.projectId ?? null,
      }),
    [
      activeProjectId,
      activeScene,
      activeSessionIdentity,
      appliedPrograms,
      draftProgram,
      editingAppliedProgram,
      redoPrograms,
      sourceLifecycle.invalidated,
      verifiedSourceDurationBasis,
      workspace?.projectId,
    ],
  );
  // The retained duration adopted by the revision policy is the only value
  // allowed to reshape Studio's imported base. The provider candidate is
  // committed in a layout effect, so adapter compilation may lag metadata by
  // one render but can never compile against unadopted runtime timing.
  const projectedActiveScene = useMemo(
    () => (activeScene ? projectVerifiedSourceDuration(activeScene, editorRevision.retainedSourceDuration) : null),
    [activeScene, editorRevision.retainedSourceDuration],
  );
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
  const workspaceProjection = projectedActiveScene
    ? projectStudioWorkspace({
        activeScene: projectedActiveScene,
        appliedPrograms: previewAppliedPrograms,
        currentTime,
        draftProgram: editingAppliedProgram ? null : draftProgram,
        nextScene,
        selectedObjectIds,
      })
    : null;
  const committedPreviewState =
    draftProgram === null && editingAppliedProgram === null ? (workspaceProjection?.proposedState ?? null) : null;
  const {
    activate: activatePreviewAuthority,
    activationAllowed: previewActivationAllowed,
    activationRequested: previewRendererRequested,
    activated: previewRendererActivated,
    providerPending: previewProviderPending,
    renderer: previewRenderer,
  } = useStudioPreviewAuthorityController({
    committedProposedState: committedPreviewState,
    context: editorRevision.previewContext,
    frame: workspace?.frame ?? { height: 8, width: 14.222 },
    retainedSourceDuration: editorRevision.retainedSourceDuration,
    sampleTime: currentTime,
    transientEdit:
      dragPreview !== null || geometryPreview !== null || scalePreview !== null || importedSceneBoundaryActive,
  });
  const {
    beginRequest: beginEditorRevisionRequest,
    blockDurationAuthority,
    durationBlocked: sourceDurationBasisBlocked,
    finishRequest: finishEditorRevisionRequest,
    isRequestCurrent: isEditorRevisionRequestCurrent,
    mismatch: sourceDurationBasisMismatch,
    readDurationBlocker,
    renderPipelineLifecycleBlocker,
  } = useEditorRevisionController({
    candidate: previewRenderer?.verifiedSourceDuration ?? null,
    lifecycle: sourceLifecycle,
    metadataPhase: previewRenderer?.sourceMetadataPhase ?? null,
    providerPending: previewProviderPending,
    retained: verifiedSourceDurationBasis,
    revision: editorRevision,
    setVerifiedSourceDurationBasis,
  });
  const { sourceLifecyclePending } = sourceLifecycle;
  const studioAuthoringLocked =
    editorDocumentAuthority.authoringBlocked ||
    sourceLifecycle.studioAuthoringLocked ||
    (editorRevision.selectionAligned && !editorRevision.sessionReady);
  const sourceDurationSessionKey = editorRevision.sessionKey;
  function activatePreviewRenderer() {
    if (!activatePreviewAuthority()) return;
    previewActivationDialog.current?.close();
    cancelSuggestionRequest();
    setIsPlaying(false);
    blockDurationAuthority(SOURCE_TIMING_LOADING_BLOCKER);
  }
  useEffect(() => {
    const targetSessionKey = sourceTimingResolutionTarget.current;
    if (
      targetSessionKey !== null &&
      !canResolveSourceDurationMismatch({
        currentSessionKey: sourceDurationSessionKey,
        mismatch: sourceDurationBasisMismatch,
        targetSessionKey,
      })
    ) {
      sourceTimingResolutionTarget.current = null;
      sourceTimingResolutionDialog.current?.close();
    }
  }, [sourceDurationBasisMismatch, sourceDurationSessionKey]);
  function stageDraft(input: Parameters<typeof stageEditorDraft>[0]) {
    if (editorDocumentAuthority.enabled && input.preserveAppliedProgram) {
      setDraftError("Apply or discard the current draft before continuing this edit in shared mode.");
      setIsPlaying(false);
      return false;
    }
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker) {
      setDraftError(lifecycleBlocker);
      setIsPlaying(false);
      return false;
    }
    return stageEditorDraft(input);
  }

  function redoProgram() {
    const lifecycleBlocker = readDurationBlocker();
    const entry = redoPrograms.at(-1);
    if (!editorDocumentAuthority.enabled || entry?.kind !== "mutation") {
      return redoEditorProgram(lifecycleBlocker);
    }
    if (lifecycleBlocker || editorDocumentAuthority.authoringBlocked) {
      setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
    void commitEditorProgramMutation(collaborationMutationForRedoV1(entry.mutation), () =>
      redoEditorProgram(readDurationBlocker()),
    );
    return true;
  }

  function undoProgramCommitFirst() {
    if (!editorDocumentAuthority.enabled || draftProgram) return undoProgram();
    const mutation = programUndoEntries.at(-1);
    if (!mutation) return false;
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker || editorDocumentAuthority.authoringBlocked) {
      setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
    void commitEditorProgramMutation(collaborationMutationForUndoV1(mutation), undoProgram);
    return true;
  }

  async function commitEditorProgramMutation(
    mutation: Parameters<typeof editorDocumentAuthority.commitMutation>[0],
    applyAcceptedTransition: () => unknown,
  ) {
    setDraftError(null);
    const outcome = await editorDocumentAuthority.commitMutation(mutation);
    if (outcome === "committed") applyAcceptedTransition();
    if (outcome === "blocked") {
      setDraftError(editorDocumentAuthority.message ?? "The shared Editor mutation could not be committed.");
    }
  }

  function openSourceTimingResolution() {
    const targetSessionKey = sourceDurationSessionKey;
    if (
      !canResolveSourceDurationMismatch({
        currentSessionKey: sourceDurationSessionKey,
        mismatch: sourceDurationBasisMismatch,
        targetSessionKey,
      })
    )
      return;
    sourceTimingResolutionTarget.current = targetSessionKey;
    sourceTimingResolutionDialog.current?.showModal();
  }

  function resolveSourceTimingMismatch() {
    const targetSessionKey = sourceTimingResolutionTarget.current;
    sourceTimingResolutionTarget.current = null;
    sourceTimingResolutionDialog.current?.close();
    if (
      !canResolveSourceDurationMismatch({
        currentSessionKey: sourceDurationSessionKey,
        mismatch: sourceDurationBasisMismatch,
        targetSessionKey,
      })
    )
      return;
    if (editorDocumentAuthority.enabled && appliedPrograms.length > 0) {
      setDraftError(
        "Shared Editor history cannot be discarded by a local timing reset. Reimport the Scene source instead.",
      );
      return;
    }
    resetPrograms();
  }

  const draftBaseProjection =
    projectedActiveScene && draftProgram
      ? projectStudioWorkspace({
          activeScene: projectedActiveScene,
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
  const lifetimeControls =
    projectedActiveScene && projection
      ? buildLifetimeEditControls({
          anchors: projectedActiveScene.anchors,
          baseScene: projectedActiveScene.runtimeSceneState,
          programs: previewAppliedPrograms,
          sourceDuration: projectedActiveScene.runtimeSceneState.duration,
          tracks: projection.timeline.objectTracks,
        })
      : {};
  const appliedTransactionIds = new Set(appliedProgramTransactionIds);
  const boundary = workspaceProjection?.boundary ?? null;
  const visibleEntities = workspaceProjection?.visibleEntities ?? [];
  const editableEntities = workspaceProjection?.editableEntities ?? [];
  const selectedSet = new Set(selectedObjectIds);
  const activeDuration =
    workspaceProjection?.proposedState.evaluatedScene.duration ?? projectedActiveScene?.runtimeSceneState.duration ?? 1;
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
  const appliedMotionClips: readonly AppliedMotionClip[] = projectedActiveScene
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
          const anchors = projectedActiveScene.anchors
            .map((sourceTime) => ({
              maximumDuration: projectedActiveScene.runtimeSceneState.duration - sourceTime,
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
              maximumDuration: Math.max(
                0.1,
                projectedActiveScene.runtimeSceneState.duration - sourceOperation.interval.start,
              ),
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
    setCurrentTime((time) => clampPlayheadToResolvedSourceDuration(time, activeDuration, sourceDurationBasisBlocked));
  }, [activeDuration, sourceDurationBasisBlocked]);

  useEffect(() => {
    if (sourceDurationBasisBlocked && isPlaying) setIsPlaying(false);
  }, [isPlaying, sourceDurationBasisBlocked, setIsPlaying]);

  useEffect(() => {
    if (!isPlaying || !activeScene || sourceDurationBasisBlocked) return;
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
  }, [activeDuration, activeScene, isPlaying, sourceDurationBasisBlocked]);
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
    const initialLifecycleBlocker = readDurationBlocker();
    if (initialLifecycleBlocker) {
      setSuggestionMessage(initialLifecycleBlocker);
      setSuggestionStatus("error");
      return;
    }
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
              editCapabilities: magicEditCapabilities(
                draftSourceScene ?? draftBaseState.evaluatedScene,
                entity,
                requestedPlayhead,
              ),
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
      const resolvedLifecycleBlocker = readDurationBlocker();
      if (resolvedLifecycleBlocker) {
        setSuggestion(null);
        setSuggestionMessage(resolvedLifecycleBlocker);
        setSuggestionStatus("error");
        return;
      }
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
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker) {
      setDraftError(lifecycleBlocker);
      return false;
    }
    const transactionId = editorRecord.program.transactionId;
    const activeEdit =
      editingAppliedProgram?.original.program.transactionId === transactionId ? editingAppliedProgram : null;
    if (draftProgram && !activeEdit) {
      setDraftError("Apply or discard the current draft before editing an Applied Program.");
      return false;
    }
    const metadata = editorRecord.editorMetadata;
    if (!metadata?.operation || !projectedActiveScene) {
      setDraftError("This Program is read-only because editable Studio authoring metadata is unavailable.");
      return false;
    }
    const precedingRecords = appliedPrograms.slice(0, index);
    const precedingPrograms = precedingRecords.map((candidate) => candidate.program);
    const workingFocus = sourceTimeToWorkingTime(precedingPrograms, focusSourceTime);
    const baseProjection = projectStudioWorkspace({
      activeScene: projectedActiveScene,
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

  async function applyDraft() {
    if (!draftProgram || !renderCandidate || draftApplyPending) return;
    const initialLifecycleBlocker = readDurationBlocker();
    if (initialLifecycleBlocker) {
      setDraftError(initialLifecycleBlocker);
      return;
    }
    const revisionRequest = beginEditorRevisionRequest();
    if (revisionRequest === null) {
      setDraftError(readDurationBlocker() ?? WORKSPACE_REIMPORT_BLOCKER);
      return;
    }
    const authorityMutation = (() => {
      if (!editorDocumentAuthority.enabled) return null;
      const planned = applyEditorDraftTransition(editorState);
      const mutation = planned.programUndoEntries.at(-1);
      if (planned.programUndoEntries.length !== programUndoEntries.length + 1 || !mutation) {
        return undefined;
      }
      return collaborationMutationForApplyV1(mutation);
    })();
    if (authorityMutation === undefined) {
      setDraftError("The draft could not be projected onto the shared Editor mutation log.");
      return;
    }
    setDraftApplyPending(true);
    setDraftError(null);
    try {
      await exportManimSource(
        {
          destination: renderCandidate.destination,
          program: renderCandidate.program,
          programs: renderCandidate.programs,
          projectId: renderCandidate.projectId,
          sceneName: renderCandidate.sceneName,
          sourceBindings: renderCandidate.sourceBindings,
          sourceHash: renderCandidate.sourceHash,
          sourcePath: renderCandidate.sourcePath,
          viewport: renderCandidate.viewport,
        },
        revisionRequest.controller.signal,
      );
      if (!isEditorRevisionRequestCurrent(revisionRequest)) return;
      const resolvedLifecycleBlocker = readDurationBlocker();
      if (resolvedLifecycleBlocker) {
        setDraftError(resolvedLifecycleBlocker);
        return;
      }
      if (authorityMutation) {
        const outcome = await editorDocumentAuthority.commitMutation(authorityMutation);
        if (!isEditorRevisionRequestCurrent(revisionRequest)) return;
        if (outcome === "reconciled" || outcome === "stale") return;
        if (outcome !== "committed") {
          setDraftError(editorDocumentAuthority.message ?? "The shared Editor mutation could not be committed.");
          return;
        }
      }
      applyEditorDraft();
    } catch (error) {
      if (!isEditorRevisionRequestCurrent(revisionRequest)) return;
      setDraftError(
        error instanceof Error
          ? `Apply preflight failed: ${error.message}`
          : "Apply preflight failed because Studio could not lower the draft safely.",
      );
    } finally {
      if (finishEditorRevisionRequest(revisionRequest)) setDraftApplyPending(false);
    }
  }

  function installCanonicalDraft(
    record: ProgramRecord,
    selectedIds: readonly string[] = [],
    precedingPrograms: readonly ProgramRecord["program"][] = appliedCanonicalPrograms,
    preserveAppliedProgram: ProgramRecord | null = null,
    appliedEdit: AppliedProgramEdit | null = null,
  ) {
    cancelSuggestionRequest();
    const staged = stageDraft({
      appliedEdit,
      clearAppliedEdit: appliedEdit === null,
      clearSuggestion: true,
      currentTime: sourceTimeToWorkingTime(precedingPrograms, record.program.anchor.resolvedSeconds),
      operation: null,
      preserveAppliedProgram,
      record,
      selectedObjectIds: selectedIds,
      stopPlayback: true,
    });
    if (staged) setLifetimeEditMessage(null);
    return staged;
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

  function editEntityLifetime(
    entityId: string,
    workingLifetimeStart: number,
    target: Readonly<{ end: number; start: number }>,
  ) {
    if (!projectedActiveScene || !draftSourceScene) return false;
    if (draftProgram) {
      const message = "Apply or discard the current draft before editing an object lifetime.";
      setDraftError(message);
      setLifetimeEditMessage(message);
      return false;
    }

    const sourceSceneBefore = (index: number) => {
      const preceding = appliedPrograms.slice(0, index);
      const state = projectStudioWorkspace({
        activeScene: projectedActiveScene,
        appliedPrograms: preceding,
        currentTime,
        draftProgram: null,
        nextScene,
        selectedObjectIds,
      }).proposedState.evaluatedScene;
      return {
        canonical: preceding.map((record) => record.program),
        scene: projectRuntimeSceneToSourceTimeline(
          state,
          preceding.map((record) => record.program),
        ),
      } as const;
    };

    const assertCompatibleWithAppliedPrograms = (record: ProgramRecord, edit: Readonly<{ index: number }> | null) => {
      const programs = edit
        ? appliedPrograms.map((candidate, index) => (index === edit.index ? record : candidate))
        : [...appliedPrograms, record];
      const proposed = projectStudioWorkspace({
        activeScene: projectedActiveScene,
        appliedPrograms: programs,
        currentTime,
        draftProgram: null,
        nextScene,
        selectedObjectIds,
      }).proposedState;
      const invalid = proposed.programs.find((candidate) => candidate.validation.status === "invalid");
      if (!invalid) return;
      throw new Error(
        invalid.validation.issues.find((issue) => issue.severity === "error")?.message ??
          "The lifetime edit conflicts with another applied Program.",
      );
    };

    try {
      const owner = findStudioLifetimeOwner(appliedPrograms, entityId);
      if (owner) {
        if (findCompetingStudioLifetimeOwner(appliedPrograms, entityId, owner.index)) {
          throw new Error(
            "Another applied Program controls this object's lifetime end. Edit or remove that Program first.",
          );
        }
        const preceding = sourceSceneBefore(owner.index);
        const validation = replaceStudioEntityLifetimeProgram({
          entityId,
          owner: owner.record,
          scene: preceding.scene,
          sourceAnchorBounds: programSourceAnchorBounds(appliedPrograms, owner.index),
          sourceAnchors: projectedActiveScene.anchors,
          target,
        });
        const validated = validatedProgramRecord(validation);
        if (validated.kind === "invalid") throw new Error(validated.message);
        assertCompatibleWithAppliedPrograms(validated.record, owner);
        installCanonicalDraft(validated.record, [entityId], preceding.canonical, null, {
          index: owner.index,
          original: owner.record,
        });
        setLifetimeEditMessage(null);
        return true;
      }

      const sourceLifetimeStart = workingTimeToSourceTime(appliedCanonicalPrograms, workingLifetimeStart);
      const original = projectedActiveScene.runtimeSceneState.objectGraph.entities[entityId]?.lifetime.find(
        (interval) => Math.abs(interval.start - sourceLifetimeStart) < 0.001,
      );
      if (!original) {
        throw new Error("Studio cannot map this interval back to one imported source lifetime.");
      }
      if (Math.abs(target.start - original.start) >= 0.001) {
        throw new Error(
          "The imported lifetime start is read-only because moving its original Python creation is not safely lowerable.",
        );
      }
      const existing = findImportedLifetimeEdit(appliedPrograms, entityId, original.start);
      const currentWorkingInterval = projection?.timeline.objectTracks
        .find((track) => track.entityId === entityId)
        ?.lifetimes.find((interval) => Math.abs(interval.start - workingLifetimeStart) < 0.001);
      if (!currentWorkingInterval) {
        throw new Error("Studio cannot map the current interval back to one imported source lifetime.");
      }
      const currentSourceEnd = workingTimeToSourceTime(appliedCanonicalPrograms, currentWorkingInterval.end);
      if (
        findCompetingImportedLifetimeOwner(appliedPrograms, entityId) ||
        (!existing && currentSourceEnd < original.end - 0.001)
      ) {
        throw new Error(
          "Another applied Program controls this imported object's lifetime end. Edit or remove that Program first.",
        );
      }
      const restoring = Math.abs(target.end - original.end) < 0.001;
      const sourceAnchor = restoring ? existing?.record.program.anchor.resolvedSeconds : target.end;
      if (
        sourceAnchor === undefined ||
        !projectedActiveScene.anchors.some((anchor) => Math.abs(anchor - sourceAnchor) < 0.001)
      ) {
        throw new Error("The selected lifetime end is not backed by a safe .py source anchor.");
      }
      const preceding = existing ? sourceSceneBefore(existing.index) : null;
      const editIndex = existing?.index ?? appliedPrograms.length;
      const validation = createImportedEntityLifetimeProgram({
        entityId,
        original,
        scene: preceding?.scene ?? draftSourceScene,
        sourceAnchor,
        sourceAnchorBounds: programSourceAnchorBounds(appliedPrograms, editIndex),
        targetEnd: target.end,
        transactionId: existing?.record.program.transactionId ?? `studio-lifetime-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      assertCompatibleWithAppliedPrograms(validated.record, existing);
      installCanonicalDraft(
        validated.record,
        [entityId],
        preceding?.canonical ?? appliedCanonicalPrograms,
        null,
        existing ? { index: existing.index, original: existing.record } : null,
      );
      setLifetimeEditMessage(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The object lifetime could not be edited.";
      setDraftError(message);
      setLifetimeEditMessage(message);
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

  function acceptDirectManipulationDraft(
    validation: Parameters<typeof validatedProgramRecord>[0],
    gestureContext: ReturnType<typeof directGestureContext>,
    sourceTime: number,
  ) {
    const validated = validatedProgramRecord(validation);
    if (validated.kind === "invalid") throw new Error(validated.message);
    cancelSuggestionRequest();
    return stageDraft({
      clearAppliedEdit: true,
      clearSuggestion: true,
      currentTime: sourceTimeToWorkingTime(gestureContext.sourcePrograms, sourceTime),
      operation: null,
      preserveAppliedProgram: gestureContext.preserveDraft,
      record: validated.record,
      stopPlayback: true,
    });
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
    if (!editable) {
      // A pointer press is still a selection gesture even when no drag can
      // start from this entity (for example a line whose semantic position
      // evidence cannot support a move program).
      setSelectedObjectIds([entityId]);
      return;
    }
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
    if (!anchor) {
      setSelectedObjectIds(targetEntityIds);
      return;
    }
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

  function beginEntityResize(
    event: PointerEvent<HTMLButtonElement>,
    entityId: string,
    direction: ResizeHandleDirection,
  ) {
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
    const shape = resizeKindForType(entity.type);
    const unknownGeometry = entity.geometry.scale.kind === "unknown" ? entity.geometry.scale : null;
    if (unknownGeometry) {
      setDraftError(`Studio cannot resize ${entityLabel(entity)} safely: ${unknownGeometry.reason}`);
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
    const canvasBounds = event.currentTarget.closest<HTMLElement>("[data-scene-phase]")?.getBoundingClientRect();
    if (!bounds || !canvasBounds) return;
    setSelectedObjectIds([entityId]);
    setIsPlaying(false);
    const base = {
      canvasScale: {
        x: STUDIO_VIEWPORT.width / canvasBounds.width,
        y: STUDIO_VIEWPORT.height / canvasBounds.height,
      },
      direction,
      entityId,
      pointerId: event.pointerId,
      sourceAnchor: anchor.sourceTime,
      start: { x: event.clientX, y: event.clientY },
    } as const;
    if (
      shape &&
      entity.geometry.dimensions.kind === "known" &&
      entity.geometry.position.kind === "known" &&
      hasShapeDimensions(shape, entity.geometry.dimensions.value)
    ) {
      canvasResize.current = {
        ...base,
        cameraScale: Math.max(projection?.camera.scale ?? 1, Number.EPSILON),
        frame: workspace?.frame ?? { height: 8, width: 14.222 },
        from: { dimensions: entity.geometry.dimensions.value, position: entity.position },
        mode: "shape",
        scale: entity.scale,
        shape,
      };
      setGeometryPreview({
        dimensions: entity.geometry.dimensions.value,
        entityId,
        position: entity.position,
      });
    } else {
      canvasResize.current = {
        ...base,
        center: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
        fromScale: entity.scale,
        mode: "scale",
      };
      setScalePreview({ entityId, scale: entity.scale });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.mode === "shape") {
      const geometry = resizedShapeGeometry(resize, { x: event.clientX, y: event.clientY });
      setGeometryPreview({ ...geometry, entityId: resize.entityId });
    } else {
      setScalePreview({
        entityId: resize.entityId,
        scale: resizedEntityScale(resize, { x: event.clientX, y: event.clientY }),
      });
    }
  }

  function finishEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    canvasResize.current = null;
    setGeometryPreview(null);
    setScalePreview(null);
    if (resize.mode === "shape") {
      const target = resizedShapeGeometry(resize, { x: event.clientX, y: event.clientY });
      if (sameShapeGeometry(target, resize.from)) return;
      installEntityGeometryDraft(
        resize.entityId,
        resize.from,
        target,
        resize.shape,
        resize.scale,
        interactionMode === "animate",
        `studio-shape-resize-${crypto.randomUUID()}`,
        resize.sourceAnchor,
      );
      return;
    }
    const targetScale = resizedEntityScale(resize, { x: event.clientX, y: event.clientY });
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
    setGeometryPreview(null);
    setScalePreview(null);
  }

  function nudgeEntityResize(event: KeyboardEvent<HTMLButtonElement>, entityId: string, handle: ResizeHandleDirection) {
    const delta = NUDGE_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    if (!resizeHandleUsesDelta(handle, delta)) return;
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return;
    const shape = resizeKindForType(entity.type);
    if (
      shape &&
      entity.geometry.dimensions.kind === "known" &&
      entity.geometry.position.kind === "known" &&
      entity.geometry.scale.kind === "known" &&
      hasShapeDimensions(shape, entity.geometry.dimensions.value)
    ) {
      const amount = event.shiftKey ? 5 : 1;
      const from = { dimensions: entity.geometry.dimensions.value, position: entity.position };
      const target = resizeShapeByViewportDelta({
        cameraScale: Math.max(projection?.camera.scale ?? 1, Number.EPSILON),
        direction: handle,
        frame: workspace?.frame ?? { height: 8, width: 14.222 },
        from,
        scale: entity.scale,
        shape,
        viewport: STUDIO_VIEWPORT,
        viewportDelta: { x: delta.x * amount, y: delta.y * amount },
      });
      if (sameShapeGeometry(target, from)) return;
      installEntityGeometryDraft(
        entityId,
        from,
        target,
        shape,
        entity.scale,
        interactionMode === "animate",
        `studio-shape-resize-key-${crypto.randomUUID()}`,
      );
      return;
    }
    const direction = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
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

  function installEntityGeometryDraft(
    entityId: string,
    from: ShapeGeometry,
    target: ShapeGeometry,
    shape: ShapeResizeKind,
    scale: number,
    animated: boolean,
    transactionId: string,
    capturedSourceAnchor?: number,
  ) {
    if (!activeScene || !draftBaseState) return false;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return false;
    }
    if (
      !hasShapeDimensions(shape, target.dimensions) ||
      !Number.isFinite(target.position.x) ||
      !Number.isFinite(target.position.y)
    ) {
      setDraftError("Shape dimensions must be finite positive numbers.");
      return false;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return false;
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor =
      capturedSourceAnchor === undefined
        ? manualAuthoringAnchor({
            action: "shape resize",
            requireAlignedPlayhead: true,
            scene: sourceScene,
            sourcePrograms: gestureContext.sourcePrograms,
            targetEntityIds: [entityId],
          })
        : { sourceTime: capturedSourceAnchor };
    if (!anchor) return false;
    const end = animated ? anchor.sourceTime + motionDuration : anchor.sourceTime;
    if (animated && (motionDuration < 0.1 || end > sourceScene.duration + 0.001)) {
      setDraftError("The resize must be at least 0.1 seconds and fit within the current Scene duration.");
      return false;
    }
    try {
      const validation = createDirectManipulationResizeProgram({
        capturedPlayhead: anchor.sourceTime,
        entityId,
        from,
        interval: { end, start: anchor.sourceTime },
        scale,
        scene: sourceScene,
        shape,
        to: target,
        transactionId,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, anchor.sourceTime);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The shape could not be resized.");
      return false;
    }
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
      return acceptDirectManipulationDraft(validation, gestureContext, anchor.sourceTime);
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

  function editEntityFromInspector(entityId: string, edits: ValidatedInspectorEdits, returnFocus: InspectorEditField) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return false;
    if (edits.position && entity.geometry.position.kind === "unknown") {
      setDraftError(`Studio cannot move ${entityLabel(entity)} safely: ${entity.geometry.position.reason}`);
      return false;
    }
    if (
      edits.dimensions &&
      (entity.geometry.dimensions.kind === "unknown" ||
        entity.geometry.position.kind === "unknown" ||
        entity.geometry.scale.kind === "unknown")
    ) {
      setDraftError("Studio cannot edit this shape because its source geometry is runtime-dependent.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "Inspector edit",
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor) return false;
    try {
      const validation = createInspectorEntityEditProgram({
        capturedPlayhead: anchor.sourceTime,
        edits,
        entityId,
        from: {
          dimensions: entity.geometry.dimensions.kind === "known" ? entity.geometry.dimensions.value : undefined,
          position: entity.position,
          scale: entity.scale,
        },
        scene: sourceScene,
        transactionId: `studio-inspector-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      if (!installCanonicalDraft(validated.record, [entityId], gestureContext.sourcePrograms)) return false;
      setInspectorReturnFocus(returnFocus);
      return true;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Inspector edit could not be staged.");
      return false;
    }
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
    if (studioAuthoringLocked) {
      setDraftError(readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
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
      undoProgramCommitFirst();
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
      const lifecycleBlocker = readDurationBlocker();
      if (lifecycleBlocker) {
        setDraftError(lifecycleBlocker);
        return false;
      }
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
    setGeometryPreview(null);
    setScalePreview(null);
    setInspectorReturnFocus(null);
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
        headerAccessory={
          accountSession && accountActions ? (
            <AccountSessionBadge actions={accountActions} session={accountSession} />
          ) : null
        }
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
            <PoietraBrand nameClassName="hidden md:block" />
            <button
              aria-label="Back to workspaces"
              className="shrink-0 border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600"
              disabled={sourceLifecyclePending}
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
                disabled={studioAuthoringLocked}
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
            {accountSession && accountActions ? (
              <AccountSessionBadge actions={accountActions} compact session={accountSession} />
            ) : null}
            <button
              className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-wait disabled:text-zinc-600"
              disabled={workspaceIsRefreshing || sourceMutationPendingProjectId === activeProjectId}
              onClick={() => void reimportWorkspace()}
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
              disabled={!activeScene || studioAuthoringLocked}
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
              onClick={() => void reimportWorkspace()}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : null}

        {editorDocumentAuthority.message ? (
          <div
            className="shrink-0 border-b border-amber-950 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200"
            role="alert"
          >
            Editor sync: {editorDocumentAuthority.message}
          </div>
        ) : null}

        {previewRendererRequested && !previewRendererActivated ? (
          <section
            aria-labelledby="preview-activation-title"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-950 bg-sky-950/30 px-3 py-2"
          >
            <div className="min-w-0">
              <h2 className="text-balance text-xs font-medium text-sky-200" id="preview-activation-title">
                GPU Scene preview is off
              </h2>
              <p className="mt-0.5 text-pretty text-[10px] leading-4 text-sky-200/70">
                Enabling preview runs selected Manim Scenes through the configured producer while this tab stays open.
              </p>
            </div>
            {previewActivationAllowed ? (
              <button
                aria-haspopup="dialog"
                className="shrink-0 border border-sky-800 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                onClick={() => previewActivationDialog.current?.showModal()}
                type="button"
              >
                Enable preview…
              </button>
            ) : (
              <p className="shrink-0 text-pretty text-xs text-sky-200" role="status">
                Open Studio in a top-level tab to enable it.
              </p>
            )}
          </section>
        ) : null}

        {sourceDurationBasisMismatch ? (
          <section
            aria-labelledby="source-timing-conflict-title"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-900 bg-amber-950/30 px-3 py-2"
            role="alert"
          >
            <div className="min-w-0">
              <h2 className="text-balance text-xs font-medium text-amber-200" id="source-timing-conflict-title">
                Scene timing needs resolution
              </h2>
              <p className="mt-0.5 text-pretty text-[10px] leading-4 text-amber-200/70">
                Waiting will not resolve this conflict. Discard the current Studio edit history to adopt the verified
                Scene duration; the Python source will not change.
              </p>
            </div>
            <button
              aria-haspopup="dialog"
              className="shrink-0 border border-amber-800 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
              onClick={openSourceTimingResolution}
              type="button"
            >
              Resolve timing
            </button>
          </section>
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
                onClick={() => void reimportWorkspace()}
                type="button"
              >
                Inspect workspace again
              </button>
            </div>
          </div>
        ) : (
          <div
            aria-busy={studioAuthoringLocked}
            className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(30rem,1fr)_auto_auto] gap-px overflow-y-auto bg-zinc-800 md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-[minmax(32rem,1fr)_auto] xl:grid-cols-[14rem_minmax(0,1fr)_21rem] xl:grid-rows-1 xl:overflow-hidden"
            data-studio-editor
            inert={studioAuthoringLocked}
          >
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
              onUndo={undoProgramCommitFirst}
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
              frame={workspace?.frame ?? { height: 8, width: 14.222 }}
              geometryPreview={geometryPreview}
              incomingSceneName={nextScene?.name ?? null}
              insertTool={insertTool}
              insertValue={insertValue}
              interactionMode={interactionMode}
              isPlaying={isPlaying}
              lifetimeControls={lifetimeControls}
              lifetimeEditMessage={lifetimeEditMessage}
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
              onEntityResizeKeyDown={nudgeEntityResize}
              onEntityResizePointerDown={beginEntityResize}
              onEntityResizePointerMove={moveEntityResize}
              onEntityResizePointerUp={finishEntityResize}
              onInteractionModeChange={setInteractionMode}
              onInsertAtCenter={() => void insertEntitiesAt({ x: 320, y: 180 })}
              onInsertToolChange={setInsertTool}
              onInsertValueChange={setInsertValue}
              onLifetimeChange={(entityId, lifetimeStart, target) => {
                void editEntityLifetime(entityId, lifetimeStart, target);
              }}
              onMotionControlChange={changeDraftMotionControl}
              onMotionDurationChange={setMotionDuration}
              onSelectEntity={(entityId) => setSelectedObjectIds([entityId])}
              onTimeChange={(time) => {
                setIsPlaying(false);
                setCurrentTime(time);
              }}
              onTogglePlayback={() => {
                const lifecycleBlocker = readDurationBlocker();
                if (lifecycleBlocker) {
                  setDraftError(lifecycleBlocker);
                  return;
                }
                if (currentTime >= activeDuration) setCurrentTime(0);
                setIsPlaying((playing) => !playing);
              }}
              preview={previewRenderer}
              projection={projection}
              readOnly={boundary !== null || studioAuthoringLocked}
              scalePreview={scalePreview}
              selectedIds={selectedSet}
            />

            <StudioInspector
              appliedProgramCount={appliedPrograms.length}
              className="order-3 min-h-96 md:col-span-2 md:col-start-1 md:row-start-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:min-h-0"
              draftError={draftError}
              draftApplyPending={draftApplyPending}
              draftOperation={draftOperation}
              draftProgram={draftProgram}
              inspectorReturnFocus={inspectorReturnFocus}
              onApplyDraft={() => void applyDraft()}
              onDiscardDraft={discardDraft}
              onDraftOperationChange={updateDraftOperation}
              onEntityEdit={editEntityFromInspector}
              onEntityScaleChange={(entityId, scale) => void resizeEntityFromInspector(entityId, scale)}
              onInspectorFocusRestored={() => setInspectorReturnFocus(null)}
              onRenderSessionChange={retainRenderSession}
              onSourceChanged={reconcileRenderedSource}
              onSourceMutationPendingChange={setSourceMutationPending}
              renderCandidate={renderCandidate}
              renderCandidateLifecycleBlocker={renderPipelineLifecycleBlocker}
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

        <dialog
          aria-describedby="enable-preview-description"
          aria-labelledby="enable-preview-title"
          className="m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
          ref={previewActivationDialog}
          role="alertdialog"
        >
          <form className="p-4" method="dialog">
            <h2 className="text-balance text-sm font-medium" id="enable-preview-title">
              Run Manim Scenes for GPU preview?
            </h2>
            <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="enable-preview-description">
              Studio will execute the selected Scene, and any Scene you switch to, through the configured fast-manim
              producer. Enable this only for workspace source you trust. Permission ends when this tab reloads or
              closes.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                value="cancel"
              >
                Cancel
              </button>
              <button
                className="bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                onClick={(event) => {
                  event.preventDefault();
                  activatePreviewRenderer();
                }}
                value="confirm"
              >
                Run Scene preview
              </button>
            </div>
          </form>
        </dialog>

        <dialog
          aria-describedby="resolve-source-timing-description"
          aria-labelledby="resolve-source-timing-title"
          className="m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
          onClose={() => {
            sourceTimingResolutionTarget.current = null;
          }}
          ref={sourceTimingResolutionDialog}
          role="alertdialog"
        >
          <form className="p-4" method="dialog">
            <h2 className="text-balance text-sm font-medium" id="resolve-source-timing-title">
              Discard Studio edit history?
            </h2>
            <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="resolve-source-timing-description">
              Resolve timing removes every Studio edit, draft, undo, and redo entry for this Scene, then adopts the
              verified duration. This cannot be undone in Studio. Your Python source remains unchanged.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                value="cancel"
              >
                Cancel
              </button>
              <button
                className="bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                onClick={(event) => {
                  event.preventDefault();
                  resolveSourceTimingMismatch();
                }}
                value="confirm"
              >
                Discard and resolve
              </button>
            </div>
          </form>
        </dialog>

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
