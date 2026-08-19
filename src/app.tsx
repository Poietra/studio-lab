import { LazyMotion } from "motion/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
import type { EditorDocumentAuthorityOpenOutcomeV1 } from "./collaboration/editor-document-authority";
import {
  MAX_EDITOR_LIVE_PLAYHEAD_SECONDS_V1,
  MAX_EDITOR_LIVE_SELECTED_ENTITY_IDS_V1,
} from "./collaboration/editor-live-contract";
import { compileFragmentMaterialGlsl } from "./engine/fragment-material-glsl";
import { cn } from "./lib/cn";
import { exportManimSource } from "./render-pipeline/client";
import type { RenderSessionView } from "./render-pipeline/contracts";
import { type RenderProgramCandidate, renderCandidateRequest } from "./render-pipeline/render-pipeline-policy";
import {
  createImportedEntityLifetimeProgram,
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
  createStudioEntitiesProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioEntityLifetimeProgram,
  replaceStudioTextContentProgram,
  type StudioEntityInput,
} from "./studio/authoring-commands";
import { canvasDragTargetEntityIds, toggleCanvasEntitySelection } from "./studio/canvas-selection";
import { commandForShortcut, isEditableShortcutTarget, type StudioCommandId } from "./studio/commands";
import { projectedPositions, validatedProgramRecord, validateSuggestionDraft } from "./studio/draft-validation";
import {
  editorProgramsMatchAuthorityV1,
  materializeAuthoritativeEditorProgramsV1,
} from "./studio/editor-authority-state";
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
import {
  assignStudioFragmentMaterialV1,
  createStudioFragmentMaterialV1,
  createStudioTextureFragmentMaterialPresetV1,
  createStudioWaveFragmentMaterialPresetV1,
  duplicateStudioFragmentMaterialV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  listStudioFragmentMaterialsV1,
  type ProjectFragmentMaterialStateV1,
  projectFragmentMaterialsForSceneV1,
  recordStudioFragmentMaterialGlslDiagnosticV1,
  removeStudioFragmentMaterialAssetV1,
  removeStudioFragmentMaterialV1,
  renameStudioFragmentMaterialV1,
  sceneHasFragmentMaterialAssignmentsV1,
  studioFragmentMaterialAssignmentCountV1,
  studioFragmentMaterialCompileErrorV1,
  updateStudioFragmentMaterialFromGlslV1,
  updateStudioFragmentMaterialParameterV1,
  updateStudioFragmentMaterialSourceV1,
  updateStudioFragmentMaterialTextureV1,
} from "./studio/fragment-material-authoring";
import {
  type FrameSnapBasis,
  type PreparedMoveSnapBasis,
  snapViewportDragToFrame,
} from "./studio/frame-alignment-snap";
import { importedWorkingState, projectVerifiedSourceDuration } from "./studio/imported-workspace";
import {
  type InspectorEditField,
  initialInspectorEditValues,
  type ValidatedInspectorEdits,
  validateInspectorEdits,
} from "./studio/inspector-edit";
import { planStudioLayerOrder, projectStudioLayers, type StudioLayerOrderDirection } from "./studio/layer-order";
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
import type { Point, ProgramRecord, ProjectedEntity, ProposedState, RuntimeSceneState } from "./studio/model";
import {
  adjustAppliedMotionClipControl,
  appliedMotionClipReadOnlyReason,
  retimeAppliedMotionClip,
} from "./studio/motion-clip-edit";
import { projectMotionPaths, type StudioMotionPath } from "./studio/motion-paths";
import type { AppliedMotionClip, AppliedMotionClipChange } from "./studio/motion-timeline-clip";
import { programExecutionCapabilities } from "./studio/operation-registry";
import { isSceneDurationOperation, type OperationOrigin } from "./studio/operations";
import { PoietraBrand } from "./studio/poietra-brand";
import {
  projectStudioPreviewRuntimeTraceEntityPresence,
  projectStudioPreviewRuntimeTraceValidationScene,
  studioPreviewRuntimeTraceEditBaseCenter,
  studioPreviewRuntimeTraceEditTargetIsPresent,
} from "./studio/preview-temporal-rebase";
import {
  latestSafeSourceAnchor,
  sourceTimeToWorkingTime as sourceTimeToWorkingTimeWithoutTimeline,
  workingTimeToSourceTime as workingTimeToSourceTimeWithoutTimeline,
} from "./studio/program-composition";
import { samplePropertyValue } from "./studio/property-sampling";
import { isExactStudioMathTexTransformProgramBatch } from "./studio/scene-authoring-wire";
import type { SceneEdit } from "./studio/scene-edit-contract";
import {
  createSelectionResizeGesture,
  groupResizeEligibleCreationEntityIds,
  type PreparedSelectionResizeBasis,
  resizeSelectionAtPoint,
  type SelectionResizeGesture,
  selectionResizeCommandTargets,
  selectionResizePreviewAtFactor,
} from "./studio/selection-resize-gesture";
import {
  createSelectionRotationGesture,
  latestCreationPositionForEntity,
  type SelectionRotationGesture,
  selectionRotationCommandTargets,
  selectionRotationPreviewAtAngle,
} from "./studio/selection-rotation-gesture";
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
import { projectRuntimeSceneToSourceTimeline as projectRuntimeSceneToSourceTimelineWithProjection } from "./studio/source-timeline";
import { StudioExportControl } from "./studio/studio-export-control";
import { resolveStudioExportPublicationAvailabilityV1 } from "./studio/studio-export-publication";
import { createStudioGesturePreviewStore } from "./studio/studio-gesture-preview-store";
import type { StudioInlineTextEditorSession } from "./studio/studio-inline-text-editor";
import { StudioPreviewControl } from "./studio/studio-preview-control";
import { StudioInspector, WorkspaceSidebar } from "./studio/studio-sidebars";
import { StudioThumbnailControl } from "./studio/studio-thumbnail-control";
import type { StudioTool } from "./studio/studio-toolbar";
import { entityLabel, STUDIO_VIEWPORT, StudioViewport } from "./studio/studio-viewport";
import { clientPointToViewport, rotationDeltaFromClientPoints } from "./studio/studio-viewport-geometry";
import { STUDIO_STYLE_PROFILE } from "./studio/style-profile";
import {
  createDirectManipulationColorProgram,
  createDirectManipulationGroupResizeProgram,
  createDirectManipulationGroupRotationProgram,
  createDirectManipulationLayerOrderProgram,
  createDirectManipulationOpacityProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationRotationProgram,
  createDirectManipulationScaleProgram,
} from "./studio/suggestion-program";
import {
  isSceneDurationProgramBatch,
  sceneDurationTrimAvailabilityFromProjection,
  selectTimelineProgramBatchProjection,
  sourceTimeToWorkingTime as sourceTimeToWorkingTimeFromProjection,
  workingTimeToSourceTime as workingTimeToSourceTimeFromProjection,
} from "./studio/timeline-projection";
import { replaceAppliedProgram } from "./studio/transactions";
import {
  type AppliedProgramEdit,
  applyEditorDraft as applyEditorDraftTransition,
  createInitialEditorState,
  draftEditorProgramRecord,
  type EditorControllerState,
  type EditorProgramRecord,
  type EditorSessionIdentity,
  editorProgramRecord,
  initializeEditorScene,
  installAuthoritativeEditorPrograms,
  installCloudEditorSessionSnapshotV1,
  redoEditorProgram as redoEditorProgramTransition,
  snapshotCloudEditorSessionV1,
  undoEditorProgram as undoEditorProgramTransition,
  useEditorController,
} from "./studio/use-editor-controller";
import {
  editorDocumentSessionFlushAllowsTransitionV1,
  useEditorDocumentAuthorityV1,
} from "./studio/use-editor-document-authority";
import { useEditorRevisionController } from "./studio/use-editor-revision-controller";
import { useManimWorkspace } from "./studio/use-manim-workspace";
import { useStudioPreviewAuthorityController } from "./studio/use-preview-authority-controller";
import { useSourceReimportController } from "./studio/use-source-reimport-controller";
import { WorkspaceLauncher } from "./studio/workspace-launcher";
import {
  isTransitionOverlay,
  projectStudioWorkspace,
  selectBoundEntityProjection,
  selectCreationProjection,
  selectMathTexTransformProjection,
  selectMotionProjection,
  selectPersistentRemoveProjection,
  selectStaticRootProjection,
  selectStudioWorkspaceEditAuthority,
} from "./studio/workspace-projection";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);
const NUDGE_DELTAS: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  ArrowDown: { x: 0, y: 2 },
  ArrowLeft: { x: -2, y: 0 },
  ArrowRight: { x: 2, y: 0 },
  ArrowUp: { x: 0, y: -2 },
};

type CanvasDragState = Readonly<{
  cameraScale: number;
  pointerId: number;
  pressedEntityId: string;
  scale: Readonly<{ x: number; y: number }>;
  snapBasis: FrameSnapBasis | null;
  sourceAnchor: number | null;
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
type CanvasRotationState = Readonly<{
  center: Point;
  entityId: string;
  pointerId: number;
  start: Point;
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

function resolvedCanvasDrag(drag: CanvasDragState, point: Readonly<{ x: number; y: number }>, disableSnap: boolean) {
  return snapViewportDragToFrame({
    basis: drag.snapBasis,
    cameraScale: drag.cameraScale,
    disabled: disableSnap,
    viewportDelta: canvasPointerDelta(drag, point),
    viewportUnitsPerCssPixel: drag.scale,
  });
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
    clearMigratedLocalSession,
    clearProjectSessions,
    clearSession,
    discardDraft,
    editAppliedProgram: stageAppliedProgramEdit,
    finishSuggestionRequest,
    installAcceptedState,
    isSuggestionRequestCurrent,
    loadProjectFragmentMaterials,
    markSessionCloudManaged,
    openSession,
    pruneSessions,
    readLocalSessionForCloudMigration,
    redoProgram: redoEditorProgram,
    resetPrograms,
    saveSession,
    saveProjectFragmentMaterials,
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
    appliedPrograms: appliedEdits,
    currentTime,
    durationError,
    draftError,
    draftOperation,
    draftProgram: draftEdit,
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
  const cloudEditorSessionSnapshot = useMemo(
    () => (accountSession ? snapshotCloudEditorSessionV1(editorState) : null),
    [accountSession, editorState],
  );
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
  const [projectFragmentMaterials, setProjectFragmentMaterials] = useState<
    Readonly<Record<string, ProjectFragmentMaterialStateV1>>
  >({});
  const [draftApplyPending, setDraftApplyPending] = useState(false);
  const [lifetimeEditMessage, setLifetimeEditMessage] = useState<string | null>(null);
  const [isMagicEditVisible, setIsMagicEditVisible] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  const gesturePreviewStore = useMemo(createStudioGesturePreviewStore, []);
  const readGesturePreviewKind = useCallback(() => gesturePreviewStore.getSnapshot().kind, [gesturePreviewStore]);
  const gesturePreviewKind = useSyncExternalStore(
    gesturePreviewStore.subscribe,
    readGesturePreviewKind,
    readGesturePreviewKind,
  );
  const [inspectorReturnFocus, setInspectorReturnFocus] = useState<InspectorEditField | null>(null);
  const [inlineTextEditor, setInlineTextEditor] = useState<StudioInlineTextEditorSession | null>(null);
  const [sessionTransitionPending, setSessionTransitionPending] = useState(false);
  const suggestionContext = useRef("");
  const canvasDrag = useRef<CanvasDragState | null>(null);
  const canvasGroupRotation = useRef<SelectionRotationGesture | null>(null);
  const canvasGroupResize = useRef<SelectionResizeGesture | null>(null);
  const canvasResize = useRef<CanvasResizeState | null>(null);
  const canvasRotation = useRef<CanvasRotationState | null>(null);
  const studioClipboard = useRef<readonly StudioEntityInput[]>([]);
  const pasteCount = useRef(0);
  const commandHandler = useRef<(command: StudioCommandId) => boolean>(() => false);
  const previewActivationDialog = useRef<HTMLDialogElement | null>(null);
  const sessionTransitionInFlight = useRef(false);
  const sourceTimingResolutionDialog = useRef<HTMLDialogElement | null>(null);
  const sourceTimingResolutionTarget = useRef<string | null>(null);
  const workspaceBounds = useRef<HTMLElement | null>(null);
  const appliedSceneEdits = appliedEdits.map((record) => record.program);
  const appliedProgramTransactionIds = useMemo(
    () => appliedEdits.map((record) => record.program.transactionId),
    [appliedEdits],
  );
  useEffect(() => {
    if (draftEdit === null) setLifetimeEditMessage(null);
  }, [draftEdit]);
  useEffect(() => setInlineTextEditor(null), [activeProjectId, activeSceneId]);

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
    setProjectFragmentMaterials((current) => {
      const next = Object.fromEntries(
        projects.flatMap((project) => {
          const retained = current[project.id];
          if (retained) return [[project.id, retained] as const];
          const restored = loadProjectFragmentMaterials(project.id);
          return restored &&
            (restored.registry.materials.length > 0 || Object.keys(restored.assignmentsByScene).length > 0)
            ? [[project.id, restored] as const]
            : [];
        }),
      );
      const entries = Object.entries(next);
      return entries.length === Object.keys(current).length &&
        entries.every(([projectId, state]) => current[projectId] === state)
        ? current
        : next;
    });
  }, [loadProjectFragmentMaterials, projects, workspaceStatus]);

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
          if (!commandHandler.current("select-tool")) return;
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
    canvasGroupRotation.current = null;
    canvasGroupResize.current = null;
    canvasResize.current = null;
    canvasRotation.current = null;
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
    gesturePreviewStore.clear();
    setInspectorReturnFocus(null);
  }, [activeScene?.sceneId, activeScene?.sourceHash, activeProjectId, gesturePreviewStore]);

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
  const editorDocumentIdentityKey = editorDocumentIdentity
    ? [
        accountSession?.user.id ?? "",
        editorDocumentIdentity.organizationId,
        editorDocumentIdentity.projectId,
        editorDocumentIdentity.sourcePath,
        editorDocumentIdentity.sceneName,
        editorDocumentIdentity.sourceHash,
      ].join("\0")
    : null;
  const editorDocumentIdentityKeyRef = useRef(editorDocumentIdentityKey);
  editorDocumentIdentityKeyRef.current = editorDocumentIdentityKey;
  const installEditorDocumentProjection = useCallback(
    async (programs: readonly ProgramRecord["program"][], reason: "open" | "remote") => {
      const projectionIdentityKey = editorDocumentIdentityKey;
      if (!activeScene || projectionIdentityKey === null) {
        throw new TypeError("The authoritative Editor projection has no selected Scene.");
      }
      const authoritativeEdits = await materializeAuthoritativeEditorProgramsV1(activeScene, appliedEdits, programs);
      if (editorDocumentIdentityKeyRef.current !== projectionIdentityKey) return;
      installAcceptedState(
        installAuthoritativeEditorPrograms(
          editorState,
          authoritativeEdits,
          reason === "remote"
            ? "This Scene changed in another editor. Local draft and Undo/Redo history were reset."
            : null,
        ),
      );
    },
    [activeScene, appliedEdits, editorDocumentIdentityKey, editorState, installAcceptedState],
  );
  const bootstrapEditorDocumentSession = useCallback(
    async (outcome: EditorDocumentAuthorityOpenOutcomeV1) => {
      const bootstrapIdentityKey = editorDocumentIdentityKey;
      if (!activeProjectId || !activeScene || bootstrapIdentityKey === null) {
        throw new TypeError("The private Editor session has no selected Scene.");
      }
      const identity = {
        projectId: activeProjectId,
        sceneId: activeScene.sceneId,
        sourceHash: activeScene.sourceHash,
      };
      const initialTime = activeScene.anchors[0] ?? 0;
      const initialEntities = Object.values(activeScene.runtimeSceneState.objectGraph.entities).filter((entity) =>
        entity.lifetime.some((lifetime) => initialTime >= lifetime.start && initialTime < lifetime.end),
      );
      const authoritativeEdits = await materializeAuthoritativeEditorProgramsV1(activeScene, [], outcome.programs);
      if (editorDocumentIdentityKeyRef.current !== bootstrapIdentityKey) {
        throw new DOMException("The selected Editor document changed while opening.", "AbortError");
      }
      const cleanState = installAuthoritativeEditorPrograms(
        initializeEditorScene(createInitialEditorState(), {
          currentTime: clamp(initialTime, 0, activeScene.runtimeSceneState.duration),
          selectedObjectIds: initialEntities.slice(0, 1).map((entity) => entity.id),
        }),
        authoritativeEdits,
      );
      if (outcome.session !== null) {
        const installed = installCloudEditorSessionSnapshotV1(cleanState, authoritativeEdits, outcome.session);
        if (installed.kind !== "installed") {
          throw new TypeError(`The private Editor session could not be installed (${installed.kind}).`);
        }
        installAcceptedState(installed.state);
        return {
          onCloudReady: () => {
            if (!markSessionCloudManaged(identity)) {
              throw new TypeError("The private Editor session identity could not be marked cloud-managed.");
            }
          },
          persist: false,
          snapshot: outcome.session,
        } as const;
      }

      const localCandidate =
        outcome.sessionGeneration === "0" ? readLocalSessionForCloudMigration(identity, authoritativeEdits) : null;
      if (localCandidate !== null) {
        const installed = installCloudEditorSessionSnapshotV1(cleanState, authoritativeEdits, localCandidate);
        if (installed.kind !== "installed") {
          throw new TypeError(`The local Editor session could not be migrated (${installed.kind}).`);
        }
        installAcceptedState(installed.state);
        return {
          onCloudReady: () => {
            if (!clearMigratedLocalSession(identity)) {
              throw new TypeError("The migrated local Editor session could not be cleared.");
            }
          },
          persist: true,
          snapshot: localCandidate,
        } as const;
      }

      installAcceptedState(cleanState);
      return {
        onCloudReady: () => {
          if (!markSessionCloudManaged(identity)) {
            throw new TypeError("The private Editor session identity could not be marked cloud-managed.");
          }
        },
        persist: true,
        snapshot: snapshotCloudEditorSessionV1(cleanState),
      } as const;
    },
    [
      activeProjectId,
      activeScene,
      clearMigratedLocalSession,
      editorDocumentIdentityKey,
      installAcceptedState,
      markSessionCloudManaged,
      readLocalSessionForCloudMigration,
    ],
  );
  const editorDocumentAuthority = useEditorDocumentAuthorityV1({
    identity: editorDocumentIdentity,
    onOpen: bootstrapEditorDocumentSession,
    onProjection: installEditorDocumentProjection,
    ownerKey: accountSession?.user.id ?? null,
    sessionSnapshot: cloudEditorSessionSnapshot,
  });
  async function runAfterEditorSessionFlush(
    transition: () => unknown | Promise<unknown>,
    transitionKind: "account" | "document" = "document",
  ) {
    if (sessionTransitionInFlight.current) return false;
    sessionTransitionInFlight.current = true;
    setSessionTransitionPending(true);
    cancelSuggestionRequest();
    setIsPlaying(false);
    saveEditorSession();
    try {
      const flushOutcome = await editorDocumentAuthority.flushSession();
      if (!editorDocumentSessionFlushAllowsTransitionV1(flushOutcome, transitionKind)) return false;
      await transition();
      return true;
    } finally {
      sessionTransitionInFlight.current = false;
      setSessionTransitionPending(false);
    }
  }

  const flushedAccountActions: AccountSessionActionsV1 | null = accountActions
    ? {
        actionError: accountActions.actionError,
        logout: () => {
          void runAfterEditorSessionFlush(accountActions.logout, "account");
        },
        refresh: accountActions.refresh,
        switchOrganization: (organizationId) => {
          void runAfterEditorSessionFlush(() => accountActions.switchOrganization(organizationId), "account");
        },
      }
    : null;

  function reimportWorkspaceAfterSessionFlush() {
    void runAfterEditorSessionFlush(() => {
      void reimportWorkspace();
    });
  }

  function discardPendingCloudSession() {
    if (editorDocumentAuthority.discardPendingSession()) window.location.reload();
  }
  const editorPresenceSessionAligned =
    activeScene !== null &&
    activeSessionIdentity?.projectId === activeProjectId &&
    activeSessionIdentity.sceneId === activeScene.sceneId &&
    activeSessionIdentity.sourceHash === activeScene.sourceHash;
  const updateEditorPresence = editorDocumentAuthority.updatePresence;
  useEffect(() => {
    updateEditorPresence({
      playheadSeconds: editorPresenceSessionAligned
        ? Math.min(MAX_EDITOR_LIVE_PLAYHEAD_SECONDS_V1, Math.max(0, Number.isFinite(currentTime) ? currentTime : 0))
        : 0,
      selectedEntityIds: editorPresenceSessionAligned
        ? [...new Set(selectedObjectIds)].slice(0, MAX_EDITOR_LIVE_SELECTED_ENTITY_IDS_V1)
        : [],
    });
  }, [currentTime, editorDocumentIdentity, editorPresenceSessionAligned, selectedObjectIds, updateEditorPresence]);
  const editorDocumentPresentationReady = editorDocumentAuthority.presentationReady;

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
        appliedEdits,
        draftEdit,
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
      appliedEdits,
      draftEdit,
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
    editingAppliedProgram && draftEdit
      ? replaceAppliedProgram(
          appliedEdits,
          editingAppliedProgram.original.program.transactionId,
          draftEditorProgramRecord(draftEdit, draftOperation, selectedObjectIds),
        )
      : null;
  const previewAppliedEdits = previewReplacement?.kind === "replaced" ? previewReplacement.programs : appliedEdits;
  const draftPrecedingEdits = editingAppliedProgram ? appliedEdits.slice(0, editingAppliedProgram.index) : appliedEdits;
  const draftPrecedingSceneEdits = draftPrecedingEdits.map((record) => record.program);
  const previewWorkingState =
    editorDocumentPresentationReady && projectedActiveScene
      ? importedWorkingState(projectedActiveScene, {
          appliedEdits: previewAppliedEdits,
          playhead: currentTime,
          selection: selectedObjectIds,
          stagedEdits: editingAppliedProgram || !draftEdit ? [] : [draftEdit],
        })
      : null;
  const activeProjectFragmentMaterials = activeProjectId
    ? (projectFragmentMaterials[activeProjectId] ?? EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1)
    : EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1;
  const activeProjectNamedFragmentMaterials = useMemo(
    () =>
      listStudioFragmentMaterialsV1(activeProjectFragmentMaterials).map((material) => ({
        ...material,
        assignmentCount: studioFragmentMaterialAssignmentCountV1(activeProjectFragmentMaterials, material.shaderId),
      })),
    [activeProjectFragmentMaterials],
  );
  const activeSceneFragmentMaterials = useMemo(
    () => projectFragmentMaterialsForSceneV1(activeProjectFragmentMaterials, activeScene?.sceneId ?? null),
    [activeProjectFragmentMaterials, activeScene?.sceneId],
  );
  const {
    activate: activatePreviewAuthority,
    activationAllowed: previewActivationAllowed,
    awaitingConsent: previewAwaitingConsent,
    providerPending: previewProviderPending,
    renderer: previewRenderer,
    retry: retryPreviewAuthority,
  } = useStudioPreviewAuthorityController({
    context: editorDocumentPresentationReady ? editorRevision.previewContext : null,
    frame: workspace?.frame ?? { height: 8, width: 14.222 },
    sceneFragmentMaterials: activeSceneFragmentMaterials,
    retainedSourceDuration: editorRevision.retainedSourceDuration,
    sampleTime: currentTime,
    sceneBoundaryActive: importedSceneBoundaryActive,
    sourceEvents: projectedActiveScene?.runtimeSceneState.eventTrack.events ?? [],
    workingState: previewWorkingState,
  });
  const studioExportSource = previewRenderer?.canonicalScene ?? null;
  const activeFragmentMaterialTextureAssets = studioExportSource?.bundle.assets.assets ?? [];
  const studioExportPublication = resolveStudioExportPublicationAvailabilityV1({
    exportSource: studioExportSource,
    lineage: editorDocumentAuthority.exportLineage,
    organizationId: accountSession?.activeOrganization.id ?? null,
  });

  function timelineProjectionForPrograms(programs: readonly SceneEdit[]) {
    if (!programs.some((program) => program.operations.some(isSceneDurationOperation))) return null;
    if (!projectedActiveScene || !previewRenderer?.timelineProjection || !isSceneDurationProgramBatch(programs)) {
      return undefined;
    }
    try {
      return selectTimelineProgramBatchProjection(
        projectedActiveScene.runtimeSceneState.duration,
        programs,
        previewRenderer.timelineProjection,
      ).projection;
    } catch {
      // A previous asynchronous preview result must never authorize the
      // current Program batch. The renderer will replace it for this revision.
      return undefined;
    }
  }
  function timelineProjectionForRecords(records: readonly ProgramRecord[]) {
    return timelineProjectionForPrograms(records.map((record) => record.program));
  }
  function persistentRemoveProjectionForPrograms(programs: readonly SceneEdit[]) {
    if (programs.some((program) => program.operations.some(({ kind }) => kind === "CreateEntity"))) return null;
    const containsPersistentRemove = programs.some((program) =>
      program.operations.some(
        (operation) => operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent,
      ),
    );
    if (!containsPersistentRemove) return null;
    if (!previewRenderer?.persistentRemoveProjection) return undefined;
    try {
      return selectPersistentRemoveProjection(programs, previewRenderer.persistentRemoveProjection);
    } catch {
      return undefined;
    }
  }
  function persistentRemoveProjectionForRecords(records: readonly ProgramRecord[]) {
    return persistentRemoveProjectionForPrograms(records.map((record) => record.program));
  }
  function mathTexTransformProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    if (!isExactStudioMathTexTransformProgramBatch(programs)) return null;
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "rust-authorized-batch") return null;
    if (!projectedActiveScene || !previewRenderer?.mathTexTransformProjection) return undefined;
    try {
      return selectMathTexTransformProjection(
        projectedActiveScene.runtimeSceneState.duration,
        programs,
        previewRenderer.mathTexTransformProjection,
      );
    } catch {
      return undefined;
    }
  }
  function creationProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    if (!programs.some((program) => program.operations.some(({ kind }) => kind === "CreateEntity"))) return null;
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "rust-authorized-batch") return null;
    if (!projectedActiveScene || !previewRenderer?.creationProjection) return undefined;
    try {
      return selectCreationProjection(
        projectedActiveScene.runtimeSceneState.duration,
        programs,
        previewRenderer.creationProjection,
      );
    } catch {
      return undefined;
    }
  }
  function motionProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    if (programs.some((program) => program.operations.some(({ kind }) => kind === "CreateEntity"))) return null;
    if (!programs.some((program) => program.operations.some(({ kind }) => kind === "CreateMotion"))) return null;
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "rust-authorized-batch" && authority !== "static-imported-root") return null;
    if (!projectedActiveScene || !previewRenderer?.motionProjection) return undefined;
    try {
      return selectMotionProjection(
        projectedActiveScene.runtimeSceneState.duration,
        programs,
        previewRenderer.motionProjection,
      );
    } catch {
      return undefined;
    }
  }
  function sourceTimeToWorkingTime(programs: readonly SceneEdit[], sourceTime: number) {
    const timelineProjection = timelineProjectionForPrograms(programs);
    if (timelineProjection === undefined) {
      throw new Error("Wait for the Rust timeline projection before resolving this source timestamp.");
    }
    return timelineProjection
      ? sourceTimeToWorkingTimeFromProjection(timelineProjection.transforms, sourceTime)
      : sourceTimeToWorkingTimeWithoutTimeline(programs, sourceTime);
  }
  function workingTimeToSourceTime(programs: readonly SceneEdit[], workingTime: number) {
    const timelineProjection = timelineProjectionForPrograms(programs);
    if (timelineProjection === undefined) {
      throw new Error("Wait for the Rust timeline projection before resolving this working timestamp.");
    }
    return timelineProjection
      ? workingTimeToSourceTimeFromProjection(timelineProjection.transforms, workingTime)
      : workingTimeToSourceTimeWithoutTimeline(programs, workingTime);
  }
  function projectRuntimeSceneToSourceTimeline(scene: RuntimeSceneState, programs: readonly SceneEdit[]) {
    const timelineProjection = timelineProjectionForPrograms(programs);
    if (timelineProjection === undefined) {
      throw new Error("Wait for the Rust timeline projection before mapping this Scene to source time.");
    }
    return projectRuntimeSceneToSourceTimelineWithProjection(scene, programs, timelineProjection);
  }
  const previewEditRecords = [...previewAppliedEdits, ...(editingAppliedProgram || !draftEdit ? [] : [draftEdit])];
  function workspaceEditAuthorityForRecords(records: readonly ProgramRecord[]) {
    return selectStudioWorkspaceEditAuthority(records, previewEditRecords, previewRenderer?.editAuthority ?? null);
  }
  function boundEntityProjectionForRecords(records: readonly ProgramRecord[]) {
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "source-bound-endpoint") return null;
    if (!previewRenderer?.boundEntityProjection) return undefined;
    try {
      return selectBoundEntityProjection(
        records.map((record) => record.program),
        previewRenderer.boundEntityProjection,
      );
    } catch {
      return undefined;
    }
  }
  function staticRootProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "static-imported-root") return null;
    if (!previewRenderer?.staticRootProjection) return undefined;
    try {
      return selectStaticRootProjection(programs, previewRenderer.staticRootProjection) ?? null;
    } catch {
      return undefined;
    }
  }
  const workspaceTimelineProjection = timelineProjectionForRecords(previewEditRecords);
  const workspaceBoundEntityProjection = boundEntityProjectionForRecords(previewEditRecords);
  const workspaceCreationProjection = creationProjectionForRecords(previewEditRecords);
  const workspaceMathTexTransformProjection = mathTexTransformProjectionForRecords(previewEditRecords);
  const workspaceMotionProjection = motionProjectionForRecords(previewEditRecords);
  const workspacePersistentRemoveProjection = persistentRemoveProjectionForRecords(previewEditRecords);
  const workspaceEditAuthority = workspaceEditAuthorityForRecords(previewEditRecords);
  const workspaceStaticRootProjection = staticRootProjectionForRecords(previewEditRecords);
  const workspaceProjection =
    editorDocumentPresentationReady &&
    projectedActiveScene &&
    workspaceBoundEntityProjection !== undefined &&
    workspaceCreationProjection !== undefined &&
    workspaceTimelineProjection !== undefined &&
    workspaceMathTexTransformProjection !== undefined &&
    workspaceMotionProjection !== undefined &&
    workspacePersistentRemoveProjection !== undefined &&
    workspaceEditAuthority !== undefined &&
    workspaceStaticRootProjection !== undefined
      ? projectStudioWorkspace({
          activeScene: projectedActiveScene,
          appliedEdits: previewAppliedEdits,
          boundEntityProjection: workspaceBoundEntityProjection,
          creationProjection: workspaceCreationProjection,
          currentTime,
          draftEdit: editingAppliedProgram ? null : draftEdit,
          mathTexTransformProjection: workspaceMathTexTransformProjection,
          motionProjection: workspaceMotionProjection,
          nextScene,
          persistentRemoveProjection: workspacePersistentRemoveProjection,
          editAuthority: workspaceEditAuthority,
          selectedObjectIds,
          staticRootProjection: workspaceStaticRootProjection,
          timelineProjection: workspaceTimelineProjection,
        })
      : null;
  const previewAppliedSceneEdits = previewAppliedEdits.map((record) => record.program);
  const appliedTimelineProjection = timelineProjectionForPrograms(previewAppliedSceneEdits);
  const sourceCurrentTime =
    appliedTimelineProjection === undefined
      ? currentTime
      : appliedTimelineProjection
        ? workingTimeToSourceTimeFromProjection(appliedTimelineProjection.transforms, currentTime)
        : workingTimeToSourceTimeWithoutTimeline(previewAppliedSceneEdits, currentTime);
  const timelineAnchors =
    activeScene?.anchors.map((sourceTime) => ({
      sourceTime,
      workingTime:
        appliedTimelineProjection === undefined
          ? sourceTime
          : appliedTimelineProjection
            ? sourceTimeToWorkingTimeFromProjection(appliedTimelineProjection.transforms, sourceTime)
            : sourceTimeToWorkingTimeWithoutTimeline(previewAppliedSceneEdits, sourceTime),
    })) ?? [];
  const previewSelectionOnly = previewRenderer?.interactionAuthority.kind === "selection-only";
  const runtimeTraceEditCandidates = previewRenderer?.runtimeTraceEditCandidates ?? [];
  const runtimeTraceEditCandidateFor = (entityId: string | null | undefined) =>
    entityId == null
      ? null
      : (runtimeTraceEditCandidates.find(({ studioEntityId }) => studioEntityId === entityId) ?? null);
  const runtimeTraceEditCandidateAt = (entityId: string | null | undefined, sourceAnchor: number) => {
    const candidate = runtimeTraceEditCandidateFor(entityId);
    return candidate && Math.abs(candidate.sourceAnchor - sourceAnchor) < 0.0005 ? candidate : null;
  };
  const studioCreationProjectionEntityFor = (entityId: string | null | undefined) =>
    entityId == null
      ? null
      : (workspaceCreationProjection?.entities.find((entity) => entity.entityId === entityId) ?? null);
  const studioCreationAppearanceAuthorityFor = (entityId: string | null | undefined) => {
    const entity = studioCreationProjectionEntityFor(entityId);
    if (!entity) return null;
    const creationProgram = previewEditRecords.find(
      ({ program }) => program.transactionId === entity.transactionId,
    )?.program;
    if (!creationProgram) return null;
    const rotationBlocked = previewEditRecords.some(({ program }) =>
      program.operations.some((operation) => {
        if (operation.kind === "CreateMotion") return operation.targetEntityIds.includes(entity.entityId);
        if (!("entityId" in operation) || operation.entityId !== entity.entityId) return false;
        if (
          program.transactionId === entity.transactionId &&
          operation.kind === "SetProperty" &&
          operation.key === "position"
        )
          return false;
        return (
          operation.kind === "ResizeEntity" ||
          (operation.kind === "SetProperty" && operation.key === "position") ||
          (operation.kind === "AnimateProperty" && operation.key === "scale")
        );
      }),
    );
    return {
      entity,
      rotationAvailable: !rotationBlocked,
      sourceAnchor: creationProgram.anchor.resolvedSeconds,
    };
  };
  const boundedRuntimeEditTargetIds = new Set(runtimeTraceEditCandidates.map(({ studioEntityId }) => studioEntityId));
  const boundedRuntimeMutationIsLocked = (entityId: string) =>
    boundedRuntimeEditTargetIds.size > 0 &&
    !boundedRuntimeEditTargetIds.has(entityId) &&
    studioCreationProjectionEntityFor(entityId) === null;
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
    sessionTransitionPending ||
    sourceLifecycle.studioAuthoringLocked ||
    (editorRevision.selectionAligned && !editorRevision.sessionReady);
  const previewPaintAvailable = previewRenderer?.state.phase === "presented";
  const previewMutationAvailable = previewPaintAvailable && !previewSelectionOnly;
  const canvasInteractionLocked = studioAuthoringLocked || !previewPaintAvailable;
  const sourceDurationSessionKey = editorRevision.sessionKey;
  function startPreviewRenderer(action: () => boolean) {
    if (!action()) return;
    previewActivationDialog.current?.close();
    cancelSuggestionRequest();
    setIsPlaying(false);
    blockDurationAuthority(SOURCE_TIMING_LOADING_BLOCKER);
  }
  function activatePreviewRenderer() {
    startPreviewRenderer(activatePreviewAuthority);
  }
  function retryPreviewRenderer() {
    startPreviewRenderer(retryPreviewAuthority);
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
  function rejectSelectionOnlyPreviewMutation() {
    if (!previewSelectionOnly) return false;
    setDraftError("This verified preview is selection-only and cannot authorize source changes.");
    setIsPlaying(false);
    return true;
  }

  function stageDraft(input: Parameters<typeof stageEditorDraft>[0]) {
    // This is the common authoring boundary for pointer, Inspector, timeline,
    // keyboard, Magic Edit, and insertion drafts. Selection-only mappings are
    // presentation evidence and can never authorize a Program.
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview before editing the Scene.");
      setIsPlaying(false);
      return false;
    }
    if (rejectSelectionOnlyPreviewMutation()) return false;
    if (editorDocumentAuthority.enabled && !editorDocumentAuthority.canAuthor()) {
      setDraftError(editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      setIsPlaying(false);
      return false;
    }
    if (editorDocumentAuthority.enabled && input.preserveAppliedProgram) {
      setDraftError("Apply or discard the current draft before continuing this edit in shared mode.");
      setIsPlaying(false);
      return false;
    }
    const preservedAnchor = input.preserveAppliedProgram?.program.anchor.resolvedSeconds;
    if (
      preservedAnchor !== undefined &&
      !activeScene?.anchors.some((anchor) => Math.abs(anchor - preservedAnchor) < 0.0005)
    ) {
      setDraftError("Discard the preview-only draft before starting another edit.");
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
    const entry = redoPrograms.at(-1);
    if (draftEdit || !entry) return false;
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview before editing the Scene.");
      return false;
    }
    if (rejectSelectionOnlyPreviewMutation()) return false;
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker) return redoEditorProgram(lifecycleBlocker);
    const planned = redoEditorProgramTransition(editorState);
    if (!editorDocumentAuthority.enabled || entry.kind !== "mutation") {
      return redoEditorProgram();
    }
    if (!editorDocumentAuthority.canAuthor()) {
      setDraftError(editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
    void commitEditorProgramMutation(collaborationMutationForRedoV1(entry.mutation), planned);
    return true;
  }

  function undoProgramCommitFirst() {
    if (!editorDocumentAuthority.enabled || draftEdit) return undoProgram();
    const mutation = programUndoEntries.at(-1);
    if (!mutation) return false;
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker || !editorDocumentAuthority.canAuthor()) {
      setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
    const planned = undoEditorProgramTransition(editorState);
    void commitEditorProgramMutation(collaborationMutationForUndoV1(mutation), planned);
    return true;
  }

  async function commitEditorProgramMutation(
    mutation: Parameters<typeof editorDocumentAuthority.commitMutation>[0],
    planned: EditorControllerState,
  ) {
    const revisionRequest = beginEditorRevisionRequest();
    if (revisionRequest === null) {
      setDraftError(readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER);
      return;
    }
    cancelSuggestionRequest();
    setIsPlaying(false);
    setDraftError(null);
    const accepted = { ...planned, isPlaying: false };
    try {
      const outcome = await editorDocumentAuthority.commitMutation(mutation, snapshotCloudEditorSessionV1(accepted));
      if (outcome.kind === "stale") return;
      if (outcome.kind === "blocked") {
        setDraftError(editorDocumentAuthority.message ?? "The shared Editor mutation could not be committed.");
        return;
      }
      if (outcome.kind === "reconciled") return;
      if (
        !isEditorRevisionRequestCurrent(revisionRequest) ||
        !editorProgramsMatchAuthorityV1(accepted.appliedPrograms, outcome.snapshot.programs)
      ) {
        await installEditorDocumentProjection(outcome.snapshot.programs, "remote");
        return;
      }
      installAcceptedState(accepted);
    } finally {
      finishEditorRevisionRequest(revisionRequest);
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
    if (editorDocumentAuthority.enabled && appliedEdits.length > 0) {
      setDraftError(
        "Shared Editor history cannot be discarded by a local timing reset. Reimport the Scene source instead.",
      );
      return;
    }
    resetPrograms();
  }

  const draftBaseTimelineProjection = timelineProjectionForRecords(draftPrecedingEdits);
  const draftBaseBoundEntityProjection = boundEntityProjectionForRecords(draftPrecedingEdits);
  const draftBaseCreationProjection = creationProjectionForRecords(draftPrecedingEdits);
  const draftBaseMathTexTransformProjection = mathTexTransformProjectionForRecords(draftPrecedingEdits);
  const draftBaseMotionProjection = motionProjectionForRecords(draftPrecedingEdits);
  const draftBasePersistentRemoveProjection = persistentRemoveProjectionForRecords(draftPrecedingEdits);
  const draftBaseEditAuthority = workspaceEditAuthorityForRecords(draftPrecedingEdits);
  const draftBaseStaticRootProjection = staticRootProjectionForRecords(draftPrecedingEdits);
  const draftBaseProjection =
    editorDocumentPresentationReady && projectedActiveScene && draftEdit
      ? draftBaseTimelineProjection === undefined ||
        draftBaseBoundEntityProjection === undefined ||
        draftBaseCreationProjection === undefined ||
        draftBaseMathTexTransformProjection === undefined ||
        draftBaseMotionProjection === undefined ||
        draftBasePersistentRemoveProjection === undefined ||
        draftBaseEditAuthority === undefined ||
        draftBaseStaticRootProjection === undefined
        ? null
        : projectStudioWorkspace({
            activeScene: projectedActiveScene,
            appliedEdits: draftPrecedingEdits,
            boundEntityProjection: draftBaseBoundEntityProjection,
            creationProjection: draftBaseCreationProjection,
            currentTime,
            draftEdit: null,
            mathTexTransformProjection: draftBaseMathTexTransformProjection,
            motionProjection: draftBaseMotionProjection,
            nextScene,
            persistentRemoveProjection: draftBasePersistentRemoveProjection,
            editAuthority: draftBaseEditAuthority,
            selectedObjectIds,
            staticRootProjection: draftBaseStaticRootProjection,
            timelineProjection: draftBaseTimelineProjection,
          })
      : workspaceProjection;
  const draftBaseState = draftBaseProjection?.proposedState ?? null;
  const draftSourceScene = draftBaseState
    ? projectRuntimeSceneToSourceTimeline(draftBaseState.evaluatedScene, draftPrecedingSceneEdits)
    : null;
  const projection = workspaceProjection?.projection ?? null;
  const lifetimeControls =
    projectedActiveScene && projection && appliedTimelineProjection === null
      ? buildLifetimeEditControls({
          anchors: projectedActiveScene.anchors,
          baseScene: projectedActiveScene.runtimeSceneState,
          programs: previewAppliedEdits,
          sourceDuration: projectedActiveScene.runtimeSceneState.duration,
          tracks: projection.timeline.objectTracks,
        })
      : {};
  const appliedTransactionIds = new Set(appliedProgramTransactionIds);
  const boundary = workspaceProjection?.boundary ?? null;
  const runtimeTraceProjectionAuthorities = runtimeTraceEditCandidates;
  const runtimeTraceProjectionAuthorityFor = (entityId: string | null | undefined) =>
    entityId == null
      ? null
      : (runtimeTraceProjectionAuthorities.find(({ studioEntityId }) => studioEntityId === entityId) ?? null);
  const retainedRuntimeTraceGestureAuthorities =
    gesturePreviewKind === "drag" || gesturePreviewKind === "rotation" || gesturePreviewKind === "scale"
      ? runtimeTraceProjectionAuthorities
      : [];
  const presentedRuntimeTraceAuthorities =
    previewRenderer?.state.phase === "presented" && previewRenderer.runtimeTraceEditAnchor !== null
      ? runtimeTraceProjectionAuthorities
      : retainedRuntimeTraceGestureAuthorities;
  const runtimeTraceInteractionGeometry =
    previewRenderer?.interactionGeometry ??
    (retainedRuntimeTraceGestureAuthorities.length > 0
      ? new Map(retainedRuntimeTraceGestureAuthorities.map(({ runtimeEntityId }) => [runtimeEntityId, null]))
      : null);
  const sourceProjectedVisibleEntities = presentedRuntimeTraceAuthorities.reduce<readonly ProjectedEntity[]>(
    (entities, authority) =>
      projectStudioPreviewRuntimeTraceEntityPresence(
        entities,
        authority,
        runtimeTraceInteractionGeometry,
        currentTime,
        workspaceBoundEntityProjection ?? null,
      ),
    workspaceProjection?.visibleEntities ?? [],
  );
  const sourceProjectedVisibleEntityIds = new Set(sourceProjectedVisibleEntities.map(({ id }) => id));
  const runtimeTraceOpaqueSelectionEntities = (previewRenderer?.runtimeTraceOpaqueSelectionEntities ?? []).filter(
    ({ id }) => !sourceProjectedVisibleEntityIds.has(id),
  );
  const visibleEntities = [
    // Runtime-only groups such as NumberPlane can span the full frame. Keep
    // their selection-only hit targets below source-backed edit targets so the
    // editable grid_title remains directly draggable at the same timestamp.
    ...runtimeTraceOpaqueSelectionEntities,
    ...sourceProjectedVisibleEntities,
  ];
  const editableEntities = presentedRuntimeTraceAuthorities.reduce<readonly ProjectedEntity[]>(
    (entities, authority) =>
      projectStudioPreviewRuntimeTraceEntityPresence(
        entities,
        authority,
        runtimeTraceInteractionGeometry,
        currentTime,
        workspaceBoundEntityProjection ?? null,
      ),
    workspaceProjection?.editableEntities ?? [],
  );
  const creationSourceAnchors = new Map(
    (workspaceCreationProjection?.entities ?? []).flatMap((entity) => {
      const owner = previewEditRecords.find(({ program }) => program.transactionId === entity.transactionId);
      return owner ? ([[entity.entityId, owner.program.anchor.resolvedSeconds]] as const) : [];
    }),
  );
  const studioLayers = projectStudioLayers({
    canonicalEntities: previewRenderer?.canonicalScene?.bundle.scene.entities ?? null,
    creationSourceAnchors,
    entities: editableEntities,
    sourceRuntimeIdentity: previewRenderer?.sourceRuntimeIdentity ?? null,
  });
  const selectedSet = new Set(selectedObjectIds);
  const activeDuration =
    workspaceProjection?.proposedState.evaluatedScene.duration ?? projectedActiveScene?.runtimeSceneState.duration ?? 1;
  const durationTrimAvailability = appliedTimelineProjection
    ? sceneDurationTrimAvailabilityFromProjection(appliedTimelineProjection)
    : {
        anchor: null,
        blocker:
          appliedTimelineProjection === undefined
            ? "Wait for the Rust timeline projection before shortening the Scene."
            : "Only a Studio-added trailing Scene duration wait can be shortened; imported or animated content is never truncated.",
        minimumDuration: draftBaseState?.evaluatedScene.duration ?? activeDuration,
        removableDuration: 0,
        waitOperationIds: [],
      };
  const motionPaths = workspaceProjection
    ? projectMotionPaths(workspaceProjection.proposedState.evaluatedScene, selectedSet, currentTime)
    : [];
  const editableMotionIds = new Set(
    draftEdit?.program.operations.flatMap((operation) => (operation.kind === "CreateMotion" ? [operation.id] : [])) ??
      [],
  );
  const evaluatedProgramsByTransaction = new Map(
    workspaceProjection?.proposedState.programs.map(
      (record) => [record.program.transactionId, record.program] as const,
    ) ?? [],
  );
  const appliedMotionClips: readonly AppliedMotionClip[] = projectedActiveScene
    ? previewAppliedEdits.flatMap((record, programIndex) => {
        const evaluatedProgram = evaluatedProgramsByTransaction.get(record.program.transactionId);
        if (!evaluatedProgram) return [];
        const precedingPrograms = previewAppliedEdits.slice(0, programIndex).map((candidate) => candidate.program);
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
            draftEdit && editingAppliedProgram?.original.program.transactionId !== record.program.transactionId
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
    sourcePrograms: readonly ProgramRecord["program"][] = draftPrecedingSceneEdits,
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
      const basePrograms = options.sourcePrograms ?? draftPrecedingSceneEdits;
      const precedingPrograms =
        options.preserveDraft &&
        !appliedEdits.some((record) => record.program.transactionId === options.preserveDraft?.program.transactionId)
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
    if (!draftEdit) return;
    const installed = installDraft(operation, draftEdit.program.transactionId, {
      capturedPlayhead: draftEdit.program.anchor.capturedPlayhead,
      origin: draftEdit.program.provenance.origin,
      preservePlayhead: true,
    });
    if (installed) {
      setSuggestion((current) => (current ? { ...current, operation } : current));
      if (draftEdit.program.provenance.origin !== "direct-manipulation") {
        setSuggestionMessage(installed.applyBlocker);
        setSuggestionStatus(installed.apply === "supported" ? "ready" : "error");
      }
    }
  }

  async function requestEditSuggestion(selectedOption?: ClarificationOption) {
    if (!activeScene || !draftBaseState) return;
    if (!previewPaintAvailable) {
      setSuggestionMessage("Wait for the canonical WebGPU preview before requesting an edit.");
      setSuggestionStatus("error");
      return;
    }
    if (!previewMutationAvailable) {
      setSuggestionMessage("This verified preview does not authorize Scene edits.");
      setSuggestionStatus("error");
      return;
    }
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
          styleProfile: STUDIO_STYLE_PROFILE,
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
    if (draftEdit && !activeEdit) {
      setDraftError("Apply or discard the current draft before editing an Applied Program.");
      return false;
    }
    const metadata = editorRecord.editorMetadata;
    if (!metadata?.operation || !projectedActiveScene) {
      setDraftError("This Program is read-only because editable Studio authoring metadata is unavailable.");
      return false;
    }
    const precedingRecords = appliedEdits.slice(0, index);
    const precedingPrograms = precedingRecords.map((candidate) => candidate.program);
    const precedingTimelineProjection = timelineProjectionForRecords(precedingRecords);
    const precedingBoundEntityProjection = boundEntityProjectionForRecords(precedingRecords);
    const precedingCreationProjection = creationProjectionForRecords(precedingRecords);
    const precedingMathTexTransformProjection = mathTexTransformProjectionForRecords(precedingRecords);
    const precedingMotionProjection = motionProjectionForRecords(precedingRecords);
    const precedingPersistentRemoveProjection = persistentRemoveProjectionForRecords(precedingRecords);
    const precedingEditAuthority = workspaceEditAuthorityForRecords(precedingRecords);
    const precedingStaticRootProjection = staticRootProjectionForRecords(precedingRecords);
    if (
      precedingTimelineProjection === undefined ||
      precedingBoundEntityProjection === undefined ||
      precedingCreationProjection === undefined ||
      precedingMathTexTransformProjection === undefined ||
      precedingMotionProjection === undefined ||
      precedingPersistentRemoveProjection === undefined ||
      precedingEditAuthority === undefined ||
      precedingStaticRootProjection === undefined
    ) {
      setDraftError("Wait for the Rust authoring projection before editing this Program.");
      return false;
    }
    const workingFocus = sourceTimeToWorkingTime(precedingPrograms, focusSourceTime);
    const baseProjection = projectStudioWorkspace({
      activeScene: projectedActiveScene,
      appliedEdits: precedingRecords,
      boundEntityProjection: precedingBoundEntityProjection,
      creationProjection: precedingCreationProjection,
      currentTime: workingFocus,
      draftEdit: null,
      mathTexTransformProjection: precedingMathTexTransformProjection,
      motionProjection: precedingMotionProjection,
      nextScene,
      persistentRemoveProjection: precedingPersistentRemoveProjection,
      editAuthority: precedingEditAuthority,
      selectedObjectIds: metadata.selection,
      staticRootProjection: precedingStaticRootProjection,
      timelineProjection: precedingTimelineProjection,
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
        appliedEdits,
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
    const editorRecord = appliedEdits[index];
    if (!editorRecord || editorRecord.program.transactionId !== record.program.transactionId) {
      setDraftError("The selected Program no longer matches the applied edit history.");
      return;
    }
    const operation = editorRecord.editorMetadata?.operation;
    if (!operation) {
      setDraftError("This Program is read-only because editable Studio authoring metadata is unavailable.");
      return;
    }
    installAppliedProgramEdit(editorRecord, index, operation);
  }

  function editAppliedMotionClip(clip: AppliedMotionClip) {
    const record = appliedEdits[clip.programIndex];
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
    const record = appliedEdits[clip.programIndex];
    if (!record || record.program.transactionId !== clip.transactionId) {
      setDraftError("The motion clip no longer matches the applied Program history.");
      return;
    }
    const editingThisClip = editingAppliedProgram?.original.program.transactionId === clip.transactionId;
    const operation = editingThisClip ? draftOperation : record.editorMetadata?.operation;
    const program = editingThisClip && draftEdit ? draftEdit.program : record.program;
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
    if (!draftEdit || draftApplyPending) return;
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview or discard this draft.");
      return;
    }
    // A draft may predate preview activation; the correlated Rust compilation
    // below remains the final source-export boundary.
    if (previewSelectionOnly && rejectSelectionOnlyPreviewMutation()) return;
    if (!renderCandidate) return;
    const initialLifecycleBlocker = readDurationBlocker();
    if (initialLifecycleBlocker) {
      setDraftError(initialLifecycleBlocker);
      return;
    }
    const plannedAuthorityState = editorDocumentAuthority.enabled ? applyEditorDraftTransition(editorState) : null;
    const authorityMutation = (() => {
      if (!plannedAuthorityState) return null;
      const mutation = plannedAuthorityState.programUndoEntries.at(-1);
      if (plannedAuthorityState.programUndoEntries.length !== programUndoEntries.length + 1 || !mutation) {
        return undefined;
      }
      return collaborationMutationForApplyV1(mutation);
    })();
    if (authorityMutation === undefined) {
      setDraftError("The draft could not be projected onto the shared Editor mutation log.");
      return;
    }
    const revisionRequest = beginEditorRevisionRequest();
    if (revisionRequest === null) {
      setDraftError(readDurationBlocker() ?? WORKSPACE_REIMPORT_BLOCKER);
      return;
    }
    setDraftApplyPending(true);
    setDraftError(null);
    try {
      await exportManimSource(renderCandidateRequest(renderCandidate), revisionRequest.controller.signal);
      if (!isEditorRevisionRequestCurrent(revisionRequest)) return;
      const resolvedLifecycleBlocker = readDurationBlocker();
      if (resolvedLifecycleBlocker) {
        setDraftError(resolvedLifecycleBlocker);
        return;
      }
      if (authorityMutation) {
        cancelSuggestionRequest();
        const accepted = { ...plannedAuthorityState!, isPlaying: false };
        const outcome = await editorDocumentAuthority.commitMutation(
          authorityMutation,
          snapshotCloudEditorSessionV1(accepted),
        );
        if (outcome.kind === "stale") return;
        if (outcome.kind === "blocked") {
          setDraftError(editorDocumentAuthority.message ?? "The shared Editor mutation could not be committed.");
          return;
        }
        if (outcome.kind === "reconciled") return;
        if (
          !isEditorRevisionRequestCurrent(revisionRequest) ||
          !editorProgramsMatchAuthorityV1(accepted.appliedPrograms, outcome.snapshot.programs)
        ) {
          await installEditorDocumentProjection(outcome.snapshot.programs, "remote");
          return;
        }
        installAcceptedState(accepted);
        return;
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
    precedingPrograms: readonly ProgramRecord["program"][] = appliedSceneEdits,
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
    if (previewRenderer?.state.phase !== "presented") {
      setDraftError("Wait for the canonical WebGPU preview before inserting an object.");
      return false;
    }
    const previousInsertion = draftEdit && isStudioEntityInsertion(draftEdit) ? draftEdit : null;
    if (draftEdit && !previousInsertion) {
      setDraftError("Apply or discard the current draft before inserting another object.");
      return false;
    }
    const precedingPrograms =
      previousInsertion &&
      !appliedEdits.some((record) => record.program.transactionId === previousInsertion.program.transactionId)
        ? [...appliedSceneEdits, previousInsertion.program]
        : appliedSceneEdits;
    const proposedState = previousInsertion ? (workspaceProjection?.proposedState ?? null) : draftBaseState;
    if (!proposedState) return false;
    const sourceScene = previousInsertion
      ? projectRuntimeSceneToSourceTimeline(proposedState.evaluatedScene, precedingPrograms)
      : draftSourceScene;
    try {
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

  function beginInlineTextCreation(point: Point) {
    setIsPlaying(false);
    setInlineTextEditor({ initialValue: insertValue, kind: "create", point });
  }

  function beginInlineTextEdit(entityId: string, point: Point) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    if (!entity || entity.type !== "Text") return;
    const initialValue = initialInspectorEditValues(entity).content;
    if (initialValue === null) return;
    setSelectedObjectIds([entityId]);
    setInsertTool("select");
    setIsPlaying(false);
    setInlineTextEditor({ entityId, initialValue, kind: "edit", point });
  }

  function cancelInlineTextEdit() {
    if (inlineTextEditor?.kind === "create") setInsertTool("select");
    setInlineTextEditor(null);
  }

  function commitInlineTextEdit(text: string) {
    const session = inlineTextEditor;
    if (!session) return false;
    if (session.kind === "create") {
      if (text.trim().length === 0) {
        setDraftError("Enter text content before committing the inline editor.");
        return false;
      }
      try {
        const inserted = insertEntitiesAt(session.point, [
          { content: defaultEntityContent("Text", text), position: session.point, type: "Text" },
        ]);
        if (inserted) setInlineTextEditor(null);
        return inserted;
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : "The inline Text could not be inserted.");
        return false;
      }
    }
    const entity = editableEntities.find((candidate) => candidate.id === session.entityId);
    if (!entity || entity.type !== "Text") {
      setInlineTextEditor(null);
      return false;
    }
    const validation = validateInspectorEdits(entity, {
      ...initialInspectorEditValues(entity),
      content: text,
    });
    if (validation.kind === "invalid") {
      setDraftError(validation.errors.content ?? "The inline Text edit is invalid.");
      return false;
    }
    if (!validation.edits.content) {
      setInlineTextEditor(null);
      return true;
    }
    const installed = editEntityFromInspector(entity.id, validation.edits, "content");
    if (installed) setInlineTextEditor(null);
    return installed;
  }

  function changeSceneDuration(targetDuration: number) {
    if (!activeScene || !draftBaseState) return false;
    if (draftEdit) {
      const message = "Apply or discard the current draft before changing the Scene duration.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
    const sourceAnchor = durationTrimAvailability.anchor ?? activeScene.anchors.at(-1);
    if (sourceAnchor === undefined) {
      const message = "Add a # poietra:anchor at a safe source boundary before extending this Scene.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
    try {
      const validation = createSceneDurationProgram({
        capturedPlayhead: sourceCurrentTime,
        scene: draftBaseState.evaluatedScene,
        sourceAnchor,
        targetDuration,
        transactionId: `studio-duration-${crypto.randomUUID()}`,
        trimAvailability: durationTrimAvailability,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      if (!installCanonicalDraft(validated.record)) return false;
      setDurationError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Scene duration could not be changed.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
  }

  function sourceSceneBeforeAppliedProgram(index: number) {
    if (!projectedActiveScene) throw new Error("The active Scene is unavailable.");
    const preceding = appliedEdits.slice(0, index);
    const timelineProjection = timelineProjectionForRecords(preceding);
    const boundEntityProjection = boundEntityProjectionForRecords(preceding);
    const creationProjection = creationProjectionForRecords(preceding);
    const mathTexTransformProjection = mathTexTransformProjectionForRecords(preceding);
    const motionProjection = motionProjectionForRecords(preceding);
    const persistentRemoveProjection = persistentRemoveProjectionForRecords(preceding);
    const editAuthority = workspaceEditAuthorityForRecords(preceding);
    const staticRootProjection = staticRootProjectionForRecords(preceding);
    if (
      timelineProjection === undefined ||
      boundEntityProjection === undefined ||
      creationProjection === undefined ||
      mathTexTransformProjection === undefined ||
      motionProjection === undefined ||
      persistentRemoveProjection === undefined ||
      editAuthority === undefined ||
      staticRootProjection === undefined
    ) {
      throw new Error("Wait for the Rust authoring projection before replacing an applied Program.");
    }
    const state = projectStudioWorkspace({
      activeScene: projectedActiveScene,
      appliedEdits: preceding,
      boundEntityProjection,
      creationProjection,
      currentTime,
      draftEdit: null,
      mathTexTransformProjection,
      motionProjection,
      nextScene,
      persistentRemoveProjection,
      editAuthority,
      selectedObjectIds,
      staticRootProjection,
      timelineProjection,
    }).proposedState.evaluatedScene;
    const canonical = preceding.map((record) => record.program);
    return {
      canonical,
      scene: projectRuntimeSceneToSourceTimeline(state, canonical),
    } as const;
  }

  function editEntityLifetime(
    entityId: string,
    workingLifetimeStart: number,
    target: Readonly<{ end: number; start: number }>,
  ) {
    if (rejectSelectionOnlyPreviewMutation()) return false;
    if (!projectedActiveScene || !draftSourceScene) return false;
    if (draftEdit) {
      const message = "Apply or discard the current draft before editing an object lifetime.";
      setDraftError(message);
      setLifetimeEditMessage(message);
      return false;
    }

    // A new lifetime edit has no Rust projection until it is staged under its
    // new working revision. The correlated preview gates Apply after staging.
    try {
      const owner = findStudioLifetimeOwner(appliedEdits, entityId);
      if (owner) {
        if (findCompetingStudioLifetimeOwner(appliedEdits, entityId, owner.index)) {
          throw new Error(
            "Another applied Program controls this object's lifetime end. Edit or remove that Program first.",
          );
        }
        const preceding = sourceSceneBeforeAppliedProgram(owner.index);
        const validation = replaceStudioEntityLifetimeProgram({
          entityId,
          owner: owner.record,
          scene: preceding.scene,
          sourceAnchorBounds: programSourceAnchorBounds(appliedEdits, owner.index),
          sourceAnchors: projectedActiveScene.anchors,
          target,
        });
        const validated = validatedProgramRecord(validation);
        if (validated.kind === "invalid") throw new Error(validated.message);
        if (
          !installCanonicalDraft(validated.record, [entityId], preceding.canonical, null, {
            index: owner.index,
            original: owner.record,
          })
        ) {
          return false;
        }
        setLifetimeEditMessage(null);
        return true;
      }

      const sourceLifetimeStart = workingTimeToSourceTime(appliedSceneEdits, workingLifetimeStart);
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
      const existing = findImportedLifetimeEdit(appliedEdits, entityId, original.start);
      const currentWorkingInterval = projection?.timeline.objectTracks
        .find((track) => track.entityId === entityId)
        ?.lifetimes.find((interval) => Math.abs(interval.start - workingLifetimeStart) < 0.001);
      if (!currentWorkingInterval) {
        throw new Error("Studio cannot map the current interval back to one imported source lifetime.");
      }
      const currentSourceEnd = workingTimeToSourceTime(appliedSceneEdits, currentWorkingInterval.end);
      if (
        findCompetingImportedLifetimeOwner(appliedEdits, entityId) ||
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
      const preceding = existing ? sourceSceneBeforeAppliedProgram(existing.index) : null;
      const editIndex = existing?.index ?? appliedEdits.length;
      const validation = createImportedEntityLifetimeProgram({
        entityId,
        original,
        scene: preceding?.scene ?? draftSourceScene,
        sourceAnchor,
        sourceAnchorBounds: programSourceAnchorBounds(appliedEdits, editIndex),
        targetEnd: target.end,
        transactionId: existing?.record.program.transactionId ?? `studio-lifetime-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      if (
        !installCanonicalDraft(
          validated.record,
          [entityId],
          preceding?.canonical ?? appliedSceneEdits,
          null,
          existing ? { index: existing.index, original: existing.record } : null,
        )
      ) {
        return false;
      }
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
    if (rejectSelectionOnlyPreviewMutation()) return false;
    if (!draftBaseState || !draftSourceScene || selectedObjectIds.length === 0) return false;
    if (draftEdit) {
      const ownsSelectedDraftEntity = selectedObjectIds.some((entityId) =>
        entityId.startsWith(`tx:${draftEdit.program.transactionId}/entity:`),
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
      sourcePrograms: appliedSceneEdits,
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
      return installCanonicalDraft(validated.record, selectedObjectIds);
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
    const offset = STUDIO_STYLE_PROFILE.spacingUnitPx * pasteCount.current;
    return insertEntitiesAt(
      { x: 320, y: 180 },
      copied.map((entity) => ({
        ...entity,
        position: { x: entity.position.x + offset, y: entity.position.y + offset },
      })),
    );
  }

  function duplicateSelection() {
    if (rejectSelectionOnlyPreviewMutation()) return false;
    const inputs = editableEntities.flatMap((entity) => {
      if (!selectedSet.has(entity.id) || !entity.present) return [];
      const input = duplicateEntityInput(entity);
      return input ? [input] : [];
    });
    return inputs.length > 0 && insertEntitiesAt({ x: 320, y: 180 }, inputs);
  }

  function directGestureContext() {
    const previousDraft =
      !editingAppliedProgram && draftEdit?.program.provenance.origin === "direct-manipulation" ? draftEdit : null;
    // A source-bound endpoint admits one direct-manipulation draft. Replacing
    // that transient draft is UI bookkeeping; Rust owns whether the new
    // complete Program is semantically admissible.
    const replacesRuntimeTraceEdit = previousDraft !== null && runtimeTraceEditCandidates.length > 0;
    const sourcePrograms =
      previousDraft && !replacesRuntimeTraceEdit ? [...appliedSceneEdits, previousDraft.program] : appliedSceneEdits;
    return {
      preserveDraft: replacesRuntimeTraceEdit ? null : previousDraft,
      proposedState: previousDraft ? (workspaceProjection?.proposedState ?? null) : draftBaseState,
      replacesDraft: replacesRuntimeTraceEdit,
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

  function changeLayerOrder(entityId: string, direction: StudioLayerOrderDirection) {
    const plan = planStudioLayerOrder(studioLayers, entityId, direction);
    if (plan.kind === "unavailable") {
      setDraftError(plan.reason);
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    try {
      const validation = createDirectManipulationLayerOrderProgram({
        capturedPlayhead: plan.sourceAnchor,
        entityId,
        scene: sourceScene,
        sourceZIndex: plan.sourceZIndex,
        start: plan.sourceAnchor,
        transactionId: `studio-layer-order-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, plan.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The layer order could not be changed.");
      return false;
    }
  }

  function manualAuthoringAnchor(
    input: Readonly<{
      action: string;
      allowSyntheticPreviewAnchor?: boolean;
      requireAlignedPlayhead: boolean;
      scene: RuntimeSceneState;
      sourcePrograms: readonly ProgramRecord["program"][];
      targetEntityIds?: readonly string[];
    }>,
  ) {
    if (!activeScene) return null;
    const timelineProjection = timelineProjectionForPrograms(input.sourcePrograms);
    if (timelineProjection !== null) {
      setDraftError(
        timelineProjection === undefined
          ? "Wait for the Rust timeline projection before authoring another edit."
          : "Apply timeline-only duration edits separately before authoring another operation family.",
      );
      setIsPlaying(false);
      return null;
    }
    const sourceAnchor = latestSafeSourceAnchor(input.sourcePrograms, activeScene.anchors, currentTime);
    const runtimePresenceAuthority = input.allowSyntheticPreviewAnchor
      ? runtimeTraceEditCandidateFor(input.targetEntityIds?.length === 1 ? input.targetEntityIds[0] : null)
      : null;
    const verifiedSourceAnchor = runtimePresenceAuthority?.sourceAnchor;
    const anchor =
      verifiedSourceAnchor === undefined
        ? sourceAnchor
        : {
            sourceTime: verifiedSourceAnchor,
            workingTime: sourceTimeToWorkingTime(input.sourcePrograms, verifiedSourceAnchor),
          };
    if (!anchor) {
      setDraftError(
        `No safe .py source anchor exists before the playhead. Move to a source anchor before ${input.action}.`,
      );
      setIsPlaying(false);
      return null;
    }
    const missingEntityId = input.targetEntityIds?.find((entityId) => {
      return !studioPreviewRuntimeTraceEditTargetIsPresent(
        input.scene,
        entityId,
        anchor.sourceTime,
        runtimePresenceAuthority,
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

  function beginEntityDrag(
    event: PointerEvent<HTMLButtonElement>,
    entityId: string,
    preparedSnapBasis: PreparedMoveSnapBasis | null,
  ) {
    if (
      canvasDrag.current ||
      canvasGroupResize.current ||
      canvasGroupRotation.current ||
      canvasResize.current ||
      canvasRotation.current
    )
      return;
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) {
      setSelectedObjectIds([entityId]);
      return;
    }
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before moving another object.");
      return;
    }
    if (runtimeTraceEditCandidateFor(entityId) && interactionMode !== "position") {
      setSelectedObjectIds([entityId]);
      setDraftError("This Runtime Trace endpoint supports direct edits, not a new motion clip.");
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
    const targetEntityIds = canvasDragTargetEntityIds(
      selectedEditableIds,
      entityId,
      boundedRuntimeEditTargetIds.has(entityId),
    );
    event.currentTarget.setPointerCapture(event.pointerId);
    const canvasBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    const snapTargetIds = new Set(preparedSnapBasis?.entityIds ?? []);
    const snapBasisMatchesTargets =
      preparedSnapBasis !== null &&
      snapTargetIds.size === targetEntityIds.length &&
      targetEntityIds.every((targetEntityId) => snapTargetIds.has(targetEntityId));
    setSelectedObjectIds(targetEntityIds);
    canvasDrag.current = {
      cameraScale: Math.max(projection?.camera.scale ?? 1, Number.EPSILON),
      pointerId: event.pointerId,
      pressedEntityId: entityId,
      scale: {
        x: canvasBounds?.width ? STUDIO_VIEWPORT.width / canvasBounds.width : 1,
        y: canvasBounds?.height ? STUDIO_VIEWPORT.height / canvasBounds.height : 1,
      },
      snapBasis:
        interactionMode === "position" && snapBasisMatchesTargets
          ? {
              frame: { bottom: STUDIO_VIEWPORT.height, left: 0, right: STUDIO_VIEWPORT.width, top: 0 },
              selection: preparedSnapBasis.bounds,
            }
          : null,
      sourceAnchor: null,
      start: { x: event.clientX, y: event.clientY },
      targetEntityIds,
    };
    setIsPlaying(false);
  }

  function moveEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    let drag = canvasDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = { x: event.clientX, y: event.clientY };
    const rawDelta = canvasPointerDelta(drag, point);
    if (drag.sourceAnchor === null) {
      if (Math.hypot(rawDelta.x, rawDelta.y) < 1) return;
      const gestureContext = directGestureContext();
      if (!gestureContext.proposedState) {
        canvasDrag.current = null;
        return;
      }
      const sourceScene = projectRuntimeSceneToSourceTimeline(
        gestureContext.proposedState.evaluatedScene,
        gestureContext.sourcePrograms,
      );
      const anchor = manualAuthoringAnchor({
        action: "object drag",
        allowSyntheticPreviewAnchor: interactionMode === "position",
        requireAlignedPlayhead: true,
        scene: sourceScene,
        sourcePrograms: gestureContext.sourcePrograms,
        targetEntityIds: drag.targetEntityIds,
      });
      if (!anchor) {
        canvasDrag.current = null;
        gesturePreviewStore.clear();
        return;
      }
      drag = { ...drag, sourceAnchor: anchor.sourceTime };
      canvasDrag.current = drag;
    }
    const snapped = resolvedCanvasDrag(drag, point, event.altKey);
    gesturePreviewStore.setDragPreview({
      delta: snapped.delta,
      entityIds: drag.targetEntityIds,
      guides: snapped.guides,
    });
  }

  function finishEntityDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = canvasDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    canvasDrag.current = null;
    gesturePreviewStore.clear();
    if (drag.sourceAnchor === null) {
      setSelectedObjectIds([drag.pressedEntityId]);
      return;
    }
    if (!activeScene || !draftBaseState || !draftSourceScene) return;
    const delta = resolvedCanvasDrag(drag, { x: event.clientX, y: event.clientY }, event.altKey).delta;
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
    gesturePreviewStore.clear();
  }

  function beginEntityResize(
    event: PointerEvent<HTMLButtonElement>,
    entityId: string,
    direction: ResizeHandleDirection,
  ) {
    event.stopPropagation();
    if (
      canvasDrag.current ||
      canvasGroupResize.current ||
      canvasGroupRotation.current ||
      canvasResize.current ||
      canvasRotation.current
    )
      return;
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) {
      setSelectedObjectIds([entityId]);
      return;
    }
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return;
    }
    const runtimeTraceEditCandidate = runtimeTraceEditCandidateFor(entityId);
    if (runtimeTraceEditCandidate && !runtimeTraceEditCandidate.capabilities.uniformScale) {
      setSelectedObjectIds([entityId]);
      setDraftError(runtimeTraceEditCandidate.restrictionMessage);
      return;
    }
    if (runtimeTraceEditCandidateFor(entityId) && interactionMode !== "position") {
      setSelectedObjectIds([entityId]);
      setDraftError("This Runtime Trace endpoint supports direct edits, not an animated resize.");
      return;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const editable =
      entity &&
      entity.present &&
      (!entity.provisional || (entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
    if (!editable) return;
    const runtimeUniformResizeOnly = runtimeTraceEditCandidateFor(entity.id) !== null;
    const shape = runtimeUniformResizeOnly ? null : resizeKindForType(entity.type);
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
      allowSyntheticPreviewAnchor: shape === null && interactionMode === "position",
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
      gesturePreviewStore.setGeometryPreview({
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
      gesturePreviewStore.setScalePreview({ entityId, scale: entity.scale });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.mode === "shape") {
      const geometry = resizedShapeGeometry(resize, { x: event.clientX, y: event.clientY });
      gesturePreviewStore.setGeometryPreview({ ...geometry, entityId: resize.entityId });
    } else {
      gesturePreviewStore.setScalePreview({
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
    gesturePreviewStore.clear();
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
    gesturePreviewStore.clear();
  }

  function selectionResizeState(
    basis: PreparedSelectionResizeBasis,
    direction: ResizeHandleDirection,
    pointerId: number,
    start: Point,
    surfaceBounds: Readonly<{ height: number; left: number; top: number; width: number }>,
  ): SelectionResizeGesture | null {
    if (
      canvasDrag.current ||
      canvasGroupResize.current ||
      canvasGroupRotation.current ||
      canvasResize.current ||
      canvasRotation.current
    )
      return null;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing the selection.");
      return null;
    }
    if (interactionMode !== "position" || previewSelectionOnly || boundedRuntimeEditTargetIds.size > 0) return null;
    const selectedEntities = selectedObjectIds.flatMap((entityId) => {
      const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
      return entity ? [entity] : [];
    });
    if (
      selectedEntities.length < 2 ||
      selectedEntities.length !== selectedObjectIds.length ||
      selectedEntities.some(
        (entity) =>
          studioCreationProjectionEntityFor(entity.id) === null ||
          entity.geometry.position.kind === "unknown" ||
          entity.geometry.scale.kind === "unknown" ||
          (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId))),
      )
    ) {
      setDraftError("Group resize currently requires two or more editable Studio-created objects.");
      return null;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return null;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "selection resize",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: selectedObjectIds,
    });
    if (!anchor) return null;
    return createSelectionResizeGesture({
      basis,
      cameraScale: projection?.camera.scale ?? 1,
      direction,
      maximumScale: MAX_ENTITY_SCALE,
      minimumScale: MIN_ENTITY_SCALE,
      pointerId,
      sourceAnchor: anchor.sourceTime,
      start,
      surfaceBounds,
      targets: selectedEntities.map((entity) => ({
        entityId: entity.id,
        fromPosition: entity.position,
        fromScale: entity.scale,
      })),
    });
  }

  function installSelectionResizeDraft(
    resize: SelectionResizeGesture,
    preview: ReturnType<typeof selectionResizePreviewAtFactor>,
  ) {
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    try {
      const validation = createDirectManipulationGroupResizeProgram({
        capturedPlayhead: resize.sourceAnchor,
        scene: sourceScene,
        start: resize.sourceAnchor,
        targets: selectionResizeCommandTargets(resize, preview),
        transactionId: `studio-group-resize-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, resize.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The selection could not be resized.");
      return false;
    }
  }

  function beginSelectionResize(
    event: PointerEvent<HTMLButtonElement>,
    direction: ResizeHandleDirection,
    basis: PreparedSelectionResizeBasis,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const surfaceBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    if (!surfaceBounds) return;
    const start = clientPointToViewport(surfaceBounds, { x: event.clientX, y: event.clientY });
    const resize = selectionResizeState(basis, direction, event.pointerId, start, surfaceBounds);
    if (!resize) return;
    canvasGroupResize.current = resize;
    setIsPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSelectionResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasGroupResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const point = clientPointToViewport(resize.surfaceBounds, { x: event.clientX, y: event.clientY });
    gesturePreviewStore.setGroupResizePreview(resizeSelectionAtPoint(resize, point).preview);
  }

  function finishSelectionResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasGroupResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    canvasGroupResize.current = null;
    gesturePreviewStore.clear();
    const point = clientPointToViewport(resize.surfaceBounds, { x: event.clientX, y: event.clientY });
    const { factor, preview } = resizeSelectionAtPoint(resize, point);
    if (Math.abs(factor - 1) < 0.01) return;
    installSelectionResizeDraft(resize, preview);
  }

  function cancelSelectionResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (canvasGroupResize.current?.pointerId !== event.pointerId) return;
    canvasGroupResize.current = null;
    gesturePreviewStore.clear();
  }

  function nudgeSelectionResize(
    event: KeyboardEvent<HTMLButtonElement>,
    direction: ResizeHandleDirection,
    basis: PreparedSelectionResizeBasis,
  ) {
    if (!(event.key in NUDGE_DELTAS)) return;
    event.preventDefault();
    event.stopPropagation();
    const handleBounds = event.currentTarget.getBoundingClientRect();
    const canvasBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    if (!canvasBounds) return;
    const start = clientPointToViewport(canvasBounds, {
      x: handleBounds.left + handleBounds.width / 2,
      y: handleBounds.top + handleBounds.height / 2,
    });
    const resize = selectionResizeState(basis, direction, -1, start, canvasBounds);
    if (!resize) return;
    const step = event.shiftKey ? 1.25 : 1.05;
    const grows = event.key === "ArrowUp" || event.key === "ArrowRight";
    const factor = clamp(grows ? step : 1 / step, resize.minimumFactor, resize.maximumFactor);
    if (Math.abs(factor - 1) < 0.01) return;
    installSelectionResizeDraft(resize, selectionResizePreviewAtFactor(resize, factor));
  }

  function selectionRotationState(
    basis: PreparedSelectionResizeBasis,
    pointerId: number,
    start: Point,
    surfaceBounds: Readonly<{ height: number; left: number; top: number; width: number }>,
  ): SelectionRotationGesture | null {
    if (
      canvasDrag.current ||
      canvasGroupResize.current ||
      canvasGroupRotation.current ||
      canvasResize.current ||
      canvasRotation.current
    )
      return null;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before rotating the selection.");
      return null;
    }
    if (interactionMode !== "position" || previewSelectionOnly || boundedRuntimeEditTargetIds.size > 0) return null;
    const selectedEntities = selectedObjectIds.flatMap((entityId) => {
      const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
      return entity ? [entity] : [];
    });
    const selectedTargets = selectedEntities.flatMap((entity) => {
      const fromPosition = latestCreationPositionForEntity(workspaceCreationProjection, entity.id);
      return fromPosition ? [{ entityId: entity.id, fromPosition }] : [];
    });
    if (
      selectedEntities.length < 2 ||
      selectedEntities.length !== selectedObjectIds.length ||
      selectedTargets.length !== selectedEntities.length ||
      selectedEntities.some(
        (entity) =>
          !groupRotationEligibleIds.has(entity.id) ||
          studioCreationProjectionEntityFor(entity.id) === null ||
          entity.geometry.position.kind === "unknown" ||
          (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId))),
      )
    ) {
      setDraftError("Group rotation currently requires two or more unrotated Studio-created objects.");
      return null;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return null;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "selection rotation",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: selectedObjectIds,
    });
    if (!anchor) return null;
    return createSelectionRotationGesture({
      basis,
      cameraScale: projection?.camera.scale ?? 1,
      pointerId,
      sourceAnchor: anchor.sourceTime,
      start,
      surfaceBounds,
      targets: selectedTargets,
    });
  }

  function installSelectionRotationDraft(rotation: SelectionRotationGesture, angleRadians: number) {
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const preview = selectionRotationPreviewAtAngle(rotation, angleRadians);
    try {
      const validation = createDirectManipulationGroupRotationProgram({
        angleRadians,
        capturedPlayhead: rotation.sourceAnchor,
        scene: sourceScene,
        start: rotation.sourceAnchor,
        targets: selectionRotationCommandTargets(rotation, preview),
        transactionId: `studio-group-rotation-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, rotation.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The selection could not be rotated.");
      return false;
    }
  }

  function selectionRotationAngle(rotation: SelectionRotationGesture, event: PointerEvent<HTMLButtonElement>) {
    return rotationDeltaFromClientPoints(
      rotation.pivot,
      rotation.start,
      clientPointToViewport(rotation.surfaceBounds, { x: event.clientX, y: event.clientY }),
      event.shiftKey ? Math.PI / 12 : null,
    );
  }

  function beginSelectionRotation(event: PointerEvent<HTMLButtonElement>, basis: PreparedSelectionResizeBasis) {
    event.preventDefault();
    event.stopPropagation();
    const surfaceBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    if (!surfaceBounds) return;
    const start = clientPointToViewport(surfaceBounds, { x: event.clientX, y: event.clientY });
    const rotation = selectionRotationState(basis, event.pointerId, start, surfaceBounds);
    if (!rotation) return;
    canvasGroupRotation.current = rotation;
    setIsPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveSelectionRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rotation = canvasGroupRotation.current;
    if (!rotation || rotation.pointerId !== event.pointerId) return;
    gesturePreviewStore.setGroupRotationPreview(
      selectionRotationPreviewAtAngle(rotation, selectionRotationAngle(rotation, event)),
    );
  }

  function finishSelectionRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rotation = canvasGroupRotation.current;
    if (!rotation || rotation.pointerId !== event.pointerId) return;
    canvasGroupRotation.current = null;
    const angleRadians = selectionRotationAngle(rotation, event);
    gesturePreviewStore.clear();
    if (Math.abs(angleRadians) < Math.PI / 360) return;
    installSelectionRotationDraft(rotation, angleRadians);
  }

  function cancelSelectionRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (canvasGroupRotation.current?.pointerId !== event.pointerId) return;
    canvasGroupRotation.current = null;
    gesturePreviewStore.clear();
  }

  function nudgeSelectionRotation(event: KeyboardEvent<HTMLButtonElement>, basis: PreparedSelectionResizeBasis) {
    if (event.key === "Escape") {
      const rotation = canvasGroupRotation.current;
      if (!rotation) return;
      event.preventDefault();
      event.stopPropagation();
      canvasGroupRotation.current = null;
      gesturePreviewStore.clear();
      if (rotation.pointerId >= 0 && event.currentTarget.hasPointerCapture(rotation.pointerId)) {
        event.currentTarget.releasePointerCapture(rotation.pointerId);
      }
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const surfaceBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    if (!surfaceBounds) return;
    const start = {
      x: (basis.bounds.left + basis.bounds.right) / 2,
      y: basis.bounds.top,
    };
    const rotation = selectionRotationState(basis, -1, start, surfaceBounds);
    if (!rotation) return;
    const stepRadians = ((event.shiftKey ? 1 : 15) * Math.PI) / 180;
    installSelectionRotationDraft(rotation, event.key === "ArrowLeft" ? stepRadians : -stepRadians);
  }

  function beginEntityRotation(event: PointerEvent<HTMLButtonElement>, entityId: string) {
    event.stopPropagation();
    if (
      canvasDrag.current ||
      canvasGroupResize.current ||
      canvasGroupRotation.current ||
      canvasResize.current ||
      canvasRotation.current
    )
      return;
    const wrapper = event.currentTarget.closest<HTMLElement>("[data-studio-entity-wrapper]");
    const object = wrapper?.querySelector<HTMLElement>("[data-studio-entity]");
    const bounds = object?.getBoundingClientRect();
    if (!bounds) return;
    canvasRotation.current = {
      center: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
      entityId,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
    };
    setSelectedObjectIds([entityId]);
    setIsPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function rotationGestureAngle(rotation: CanvasRotationState, event: PointerEvent<HTMLButtonElement>) {
    return rotationDeltaFromClientPoints(
      rotation.center,
      rotation.start,
      { x: event.clientX, y: event.clientY },
      event.shiftKey ? Math.PI / 12 : null,
    );
  }

  function moveEntityRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rotation = canvasRotation.current;
    if (!rotation || rotation.pointerId !== event.pointerId) return;
    gesturePreviewStore.setRotationPreview({
      angleRadians: rotationGestureAngle(rotation, event),
      entityId: rotation.entityId,
    });
  }

  function finishEntityRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rotation = canvasRotation.current;
    if (!rotation || rotation.pointerId !== event.pointerId) return;
    canvasRotation.current = null;
    const angleRadians = rotationGestureAngle(rotation, event);
    gesturePreviewStore.clear();
    if (Math.abs(angleRadians) < Math.PI / 360) return;
    rotateEntityFromInspector(rotation.entityId, angleRadians);
  }

  function cancelEntityRotation(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (canvasRotation.current?.pointerId !== event.pointerId) return;
    canvasRotation.current = null;
    gesturePreviewStore.clear();
  }

  function nudgeEntityRotation(event: KeyboardEvent<HTMLButtonElement>, entityId: string) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const stepRadians = ((event.shiftKey ? 1 : 15) * Math.PI) / 180;
    rotateEntityFromInspector(entityId, event.key === "ArrowLeft" ? stepRadians : -stepRadians);
  }

  function nudgeEntityResize(event: KeyboardEvent<HTMLButtonElement>, entityId: string, handle: ResizeHandleDirection) {
    const delta = NUDGE_DELTAS[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) {
      setSelectedObjectIds([entityId]);
      return;
    }
    const runtimeTraceEditCandidate = runtimeTraceEditCandidateFor(entityId);
    if (runtimeTraceEditCandidate && !runtimeTraceEditCandidate.capabilities.uniformScale) {
      setSelectedObjectIds([entityId]);
      setDraftError(runtimeTraceEditCandidate.restrictionMessage);
      return;
    }
    if (runtimeTraceEditCandidateFor(entityId) && interactionMode !== "position") {
      setSelectedObjectIds([entityId]);
      setDraftError("This Runtime Trace endpoint supports direct edits, not an animated resize.");
      return;
    }
    if (!resizeHandleUsesDelta(handle, delta)) return;
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity) return;
    const runtimeUniformResizeOnly = runtimeTraceEditCandidateFor(entity.id) !== null;
    const shape = runtimeUniformResizeOnly ? null : resizeKindForType(entity.type);
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
            allowSyntheticPreviewAnchor: !animated,
            requireAlignedPlayhead: true,
            scene: sourceScene,
            sourcePrograms: gestureContext.sourcePrograms,
            targetEntityIds: [entityId],
          })
        : { sourceTime: capturedSourceAnchor };
    if (!anchor) return false;
    const runtimeTraceEditCandidate = runtimeTraceEditCandidateAt(entityId, anchor.sourceTime);
    // Runtime Trace candidates define relative resize against a normalized
    // scale of one. Python's absolute scale and a replaced transient draft are
    // not valid authoring baselines for this closed endpoint contract.
    const replacementBaselineScene =
      !runtimeTraceEditCandidate && gestureContext.replacesDraft
        ? projectRuntimeSceneToSourceTimeline(draftBaseState.evaluatedScene, gestureContext.sourcePrograms)
        : null;
    const scaleBasisScene = replacementBaselineScene ?? sourceScene;
    const sampledScale = runtimeTraceEditCandidate
      ? 1
      : samplePropertyValue(scaleBasisScene.propertyChannels[`${entityId}/scale`]?.samples ?? [], anchor.sourceTime);
    const baselineEntityScale = replacementBaselineScene?.objectGraph.entities[entityId]?.geometry?.scale;
    const executionScale =
      typeof sampledScale === "number"
        ? sampledScale
        : baselineEntityScale?.kind === "known"
          ? baselineEntityScale.value
          : fromScale;
    const end = animated ? anchor.sourceTime + motionDuration : anchor.sourceTime;
    if (animated && (motionDuration < 0.1 || end > sourceScene.duration + 0.001)) {
      setDraftError("The resize must be at least 0.1 seconds and fit within the current Scene duration.");
      return false;
    }
    const validationScene = projectStudioPreviewRuntimeTraceValidationScene(sourceScene, runtimeTraceEditCandidate);
    try {
      const validation = createDirectManipulationScaleProgram({
        capturedPlayhead: anchor.sourceTime,
        interval: { end, start: anchor.sourceTime },
        scales: { [entityId]: { from: executionScale, to: targetScale } },
        scene: validationScene,
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
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity || Math.abs(entity.scale - targetScale) < 0.001) return false;
    const runtimeTraceEditCandidate = runtimeTraceEditCandidateFor(entityId);
    if (runtimeTraceEditCandidate && !runtimeTraceEditCandidate.capabilities.uniformScale) {
      setDraftError(runtimeTraceEditCandidate.restrictionMessage);
      return false;
    }
    return installEntityScaleDraft(
      entityId,
      entity.scale,
      targetScale,
      false,
      `studio-resize-input-${crypto.randomUUID()}`,
    );
  }

  function rotateEntityFromInspector(entityId: string, angleRadians: number) {
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    const authority = runtimeTraceProjectionAuthorityFor(entityId);
    if (createdAuthority && !createdAuthority.rotationAvailable) {
      setDraftError("Rotate this object before adding a move, resize, or scale edit.");
      return false;
    }
    if (!createdAuthority && !authority?.capabilities.rotation) {
      setDraftError("Rotation requires a Studio-created object or one exact updater-free Runtime Trace binding.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "object rotation",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (
      !anchor ||
      (createdAuthority
        ? Math.abs(anchor.sourceTime - createdAuthority.sourceAnchor) >= 0.0005
        : anchor.sourceTime !== 0)
    )
      return false;
    const sourceTime = createdAuthority?.sourceAnchor ?? 0;
    try {
      const validation = createDirectManipulationRotationProgram({
        angleRadians,
        capturedPlayhead: sourceTime,
        entityId,
        scene: createdAuthority ? sourceScene : projectStudioPreviewRuntimeTraceValidationScene(sourceScene, authority),
        start: sourceTime,
        transactionId: `studio-rotation-input-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, sourceTime);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object could not be rotated.");
      return false;
    }
  }

  function setEntityOpacityFromInspector(entityId: string, opacity: number) {
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    const authority = runtimeTraceProjectionAuthorityFor(entityId);
    if (!createdAuthority && (!authority?.capabilities.paintOpacity || !("baseOpacity" in authority))) {
      setDraftError("Opacity requires a Studio-created object or one exact updater-free Runtime Trace binding.");
      return false;
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      setDraftError("Opacity must be a number from 0 to 1.");
      return false;
    }
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const baseOpacity = createdAuthority
      ? (entity?.opacity ?? null)
      : authority && "baseOpacity" in authority
        ? authority.baseOpacity
        : null;
    if (baseOpacity !== null && baseOpacity !== undefined && Math.abs(baseOpacity - opacity) < 0.0005) return false;
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "object opacity edit",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (
      !anchor ||
      (createdAuthority
        ? Math.abs(anchor.sourceTime - createdAuthority.sourceAnchor) >= 0.0005
        : anchor.sourceTime !== 0)
    )
      return false;
    const sourceTime = createdAuthority?.sourceAnchor ?? 0;
    try {
      const validation = createDirectManipulationOpacityProgram({
        capturedPlayhead: sourceTime,
        entityId,
        opacity,
        scene: createdAuthority ? sourceScene : projectStudioPreviewRuntimeTraceValidationScene(sourceScene, authority),
        start: sourceTime,
        transactionId: `studio-opacity-input-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, sourceTime);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object opacity could not be changed.");
      return false;
    }
  }

  function setEntityColorFromInspector(entityId: string, property: "fillColor" | "strokeColor", color: string) {
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!createdAuthority || !entity || (entity.type !== "Circle" && entity.type !== "Rectangle")) {
      setDraftError("Fill and stroke colors can currently be changed on Studio-created circles and rectangles.");
      return false;
    }
    const normalizedColor = color.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(normalizedColor)) {
      setDraftError("Color must use the #rrggbb format.");
      return false;
    }
    if (entity.geometry.style.kind === "known") {
      const style = entity.geometry.style.value;
      const currentColor = style[property] ?? (property === "strokeColor" ? (style.color ?? "#ffffff") : undefined);
      if (currentColor?.toLowerCase() === normalizedColor) return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "shape color edit",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor || Math.abs(anchor.sourceTime - createdAuthority.sourceAnchor) >= 0.0005) return false;
    try {
      const validation = createDirectManipulationColorProgram({
        capturedPlayhead: createdAuthority.sourceAnchor,
        color: normalizedColor,
        entityId,
        property,
        scene: sourceScene,
        start: createdAuthority.sourceAnchor,
        transactionId: `studio-${property}-input-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, createdAuthority.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The shape color could not be changed.");
      return false;
    }
  }

  function editEntityFromInspector(entityId: string, edits: ValidatedInspectorEdits, returnFocus: InspectorEditField) {
    if (previewSelectionOnly) {
      setDraftError("This verified snapshot is selection-only because it has no safe .py source edit anchor.");
      return false;
    }
    if (boundedRuntimeMutationIsLocked(entityId)) {
      setDraftError("Only the runtime-proven source edit target can be changed in this preview.");
      return false;
    }
    const runtimeTraceTransformAuthority = runtimeTraceProjectionAuthorityFor(entityId);
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    if (!entity || (!entity.present && runtimeTraceTransformAuthority?.studioEntityId !== entityId)) return false;
    const replacesStudioTextContent =
      edits.content !== undefined &&
      entity.type === "Text" &&
      entity.sourceIdentity.kind === "unknown" &&
      Boolean(entity.transactionId);
    if (replacesStudioTextContent) {
      if (edits.position || edits.dimensions) {
        setDraftError("Apply Text content and typography separately from position or size changes.");
        return false;
      }
      if (draftEdit) {
        setDraftError("Apply or discard the current draft before editing Text content or typography.");
        return false;
      }
      const owner = findStudioLifetimeOwner(appliedEdits, entityId);
      if (!owner || owner.record.program.transactionId !== entity.transactionId) {
        setDraftError("The Studio-created Text has no unique creation owner.");
        return false;
      }
      try {
        const preceding = sourceSceneBeforeAppliedProgram(owner.index);
        const validation = replaceStudioTextContentProgram({
          content: edits.content,
          entityId,
          owner: owner.record,
          scene: preceding.scene,
        });
        const validated = validatedProgramRecord(validation);
        if (validated.kind === "invalid") throw new Error(validated.message);
        const installed = installCanonicalDraft(validated.record, [entityId], preceding.canonical, null, {
          index: owner.index,
          original: owner.record,
        });
        if (installed) setInspectorReturnFocus(returnFocus);
        return installed;
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : "The Text creation Program could not be updated.");
        return false;
      }
    }
    if (runtimeTraceTransformAuthority?.studioEntityId === entityId) {
      const runtimeTraceTransformBaseCenter = studioPreviewRuntimeTraceEditBaseCenter(runtimeTraceTransformAuthority);
      if (!runtimeTraceTransformBaseCenter || !edits.position || edits.content || edits.dimensions) {
        setDraftError(runtimeTraceTransformAuthority.restrictionMessage);
        return false;
      }
      if (!draftBaseState) return false;
      const sourcePrograms = draftPrecedingSceneEdits;
      const sourceScene = projectRuntimeSceneToSourceTimeline(draftBaseState.evaluatedScene, sourcePrograms);
      const anchor = manualAuthoringAnchor({
        action: "Inspector position edit",
        allowSyntheticPreviewAnchor: true,
        requireAlignedPlayhead: true,
        scene: sourceScene,
        sourcePrograms,
        targetEntityIds: [entityId],
      });
      if (!anchor) return false;
      const validationScene = projectStudioPreviewRuntimeTraceValidationScene(
        sourceScene,
        runtimeTraceEditCandidateAt(entityId, anchor.sourceTime),
      );
      const validation = createDirectManipulationPositionProgram({
        capturedPlayhead: anchor.sourceTime,
        delta: {
          x: edits.position.x - runtimeTraceTransformBaseCenter.x,
          y: edits.position.y - runtimeTraceTransformBaseCenter.y,
        },
        positions: { [entityId]: runtimeTraceTransformBaseCenter },
        scene: validationScene,
        start: anchor.sourceTime,
        targetEntityIds: [entityId],
        transactionId: `studio-inspector-position-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") {
        setDraftError(validated.message);
        return false;
      }
      const installed = installCanonicalDraft(validated.record, [entityId], sourcePrograms);
      if (installed) setInspectorReturnFocus(returnFocus);
      return installed;
    }
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
    const projected = projectedPositions(editableEntities, targetIds);
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
            allowSyntheticPreviewAnchor: true,
            requireAlignedPlayhead: true,
            scene: sourceScene,
            sourcePrograms: gestureContext.sourcePrograms,
            targetEntityIds: targetIds,
          })
        : { sourceTime: capturedSourceAnchor };
    if (!anchor) return;
    const validationScene = projectStudioPreviewRuntimeTraceValidationScene(
      sourceScene,
      targetIds.length === 1 ? runtimeTraceEditCandidateAt(targetIds[0], anchor.sourceTime) : null,
    );
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: anchor.sourceTime,
      delta,
      positions: projected.positions,
      scene: validationScene,
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
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) {
      setSelectedObjectIds([entityId]);
      return;
    }
    const multiplier = event.shiftKey ? 5 : 1;
    const targetIds = boundedRuntimeEditTargetIds.has(entityId)
      ? [entityId]
      : selectedObjectIds.includes(entityId)
        ? selectedObjectIds
        : [entityId];
    installPositionDraft(
      { x: delta.x * multiplier, y: delta.y * multiplier },
      targetIds,
      `studio-nudge-${crypto.randomUUID()}`,
    );
  }

  function changeDraftMotionControl(path: StudioMotionPath, delta: Point) {
    if (!draftOperation || !draftEdit || !editableMotionIds.has(path.motionId)) return;
    const adjusted = adjustAppliedMotionClipControl({
      delta,
      operation: draftOperation,
      operationId: path.motionId,
      program: draftEdit.program,
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
    if (command === "undo") {
      if (!draftEdit && appliedEdits.length === 0) return false;
      undoProgramCommitFirst();
      return true;
    }
    if (command === "escape") {
      if (inlineTextEditor) {
        cancelInlineTextEdit();
        return true;
      }
      if (insertTool !== "select") {
        setInsertTool("select");
        return true;
      }
      if (draftEdit) {
        discardDraft();
        return true;
      }
      if (selectedObjectIds.length > 0) {
        setSelectedObjectIds([]);
        return true;
      }
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
    if (tool === "select") {
      setInlineTextEditor(null);
      setInsertTool(tool);
      return true;
    }
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview before editing the Scene.");
      return false;
    }
    if (tool) {
      setInlineTextEditor(null);
      setInsertTool(tool);
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
    return false;
  }

  commandHandler.current = handleStudioCommand;

  const renderPrograms = editingAppliedProgram
    ? previewAppliedEdits.map((record) => record.program)
    : [...appliedEdits.map((record) => record.program), ...(draftEdit ? [draftEdit.program] : [])];
  const renderProgram = renderPrograms[0] ?? null;
  const renderCandidateUnavailableReason =
    "Export .py downloads the selected source unchanged. Create or apply a Canonical draft to render or export Studio edits.";
  const renderCandidate: RenderProgramCandidate | null =
    activeScene && activeProjectId && renderProgram && previewRenderer?.runtimeTraceProgramValidation !== "rejected"
      ? {
          anchors: activeScene.anchors,
          ...(previewRenderer?.cameraCenter &&
          (previewRenderer.cameraCenter.x !== 0 || previewRenderer.cameraCenter.y !== 0)
            ? { cameraCenter: previewRenderer.cameraCenter }
            : {}),
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
          ...(previewRenderer?.runtimeTraceProgramValidation === "authorized"
            ? { sourceValidation: "runtime-trace" as const }
            : {}),
          viewport: STUDIO_VIEWPORT,
        }
      : null;

  const selectedEntity = editableEntities.find((entity) => selectedSet.has(entity.id)) ?? null;
  const selectedFragmentMaterialEntity = selectedSet.size === 1 ? selectedEntity : null;
  const selectedFragmentMaterialAssignment = selectedFragmentMaterialEntity
    ? (activeSceneFragmentMaterials.assignments[selectedFragmentMaterialEntity.id] ?? null)
    : null;
  const selectedFragmentMaterialAssigned = selectedFragmentMaterialAssignment !== null;
  const selectedFragmentMaterialAvailable =
    previewMutationAvailable &&
    selectedFragmentMaterialEntity !== null &&
    selectedFragmentMaterialEntity.geometry.style.kind === "known" &&
    selectedFragmentMaterialEntity.geometry.style.value.fillColor !== undefined &&
    selectedFragmentMaterialEntity.geometry.style.value.fillColor !== null;
  const activeSceneHasFragmentMaterialAssignments = sceneHasFragmentMaterialAssignmentsV1(activeSceneFragmentMaterials);
  const activeSceneFragmentMaterialCompileError = studioFragmentMaterialCompileErrorV1(
    activeSceneFragmentMaterials,
    previewRenderer?.state,
  );
  const sourceFragmentMaterialExportBlocker = activeSceneHasFragmentMaterialAssignments
    ? "Manim .py export does not support project-local WGSL fragment materials. Remove them before exporting source."
    : null;

  function commitProjectFragmentMaterials(projectId: string, next: ProjectFragmentMaterialStateV1) {
    if (!saveProjectFragmentMaterials(projectId, next)) {
      setDraftError("The project fragment materials could not be saved.");
      return false;
    }
    setProjectFragmentMaterials((current) => ({ ...current, [projectId]: next }));
    return true;
  }

  function commitActiveProjectFragmentMaterials(next: ProjectFragmentMaterialStateV1) {
    return activeProjectId ? commitProjectFragmentMaterials(activeProjectId, next) : false;
  }

  function createFragmentMaterial(name: string) {
    try {
      const created = createStudioFragmentMaterialV1(activeProjectFragmentMaterials, { name });
      return commitActiveProjectFragmentMaterials(created.state) ? created.shaderId : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material could not be created.");
      return null;
    }
  }

  function createWaveFragmentMaterialPreset() {
    try {
      const created = createStudioWaveFragmentMaterialPresetV1(activeProjectFragmentMaterials);
      const next =
        activeScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable
          ? assignStudioFragmentMaterialV1(created.state, {
              entityId: selectedFragmentMaterialEntity.id,
              sceneId: activeScene.sceneId,
              shaderId: created.shaderId,
            })
          : created.state;
      return commitActiveProjectFragmentMaterials(next) ? created.shaderId : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Wave preset could not be created.");
      return null;
    }
  }

  function createTextureFragmentMaterialPreset() {
    try {
      const created = createStudioTextureFragmentMaterialPresetV1(activeProjectFragmentMaterials);
      const asset = activeFragmentMaterialTextureAssets[0];
      const next =
        activeScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable && asset
          ? assignStudioFragmentMaterialV1(created.state, {
              entityId: selectedFragmentMaterialEntity.id,
              sceneId: activeScene.sceneId,
              shaderId: created.shaderId,
              texture: { asset: { assetId: asset.id, sha256: asset.sha256 }, sampler: "linear" },
            })
          : created.state;
      return commitActiveProjectFragmentMaterials(next) ? created.shaderId : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Texture preset could not be created.");
      return null;
    }
  }

  function duplicateFragmentMaterial(shaderId: string) {
    try {
      const duplicated = duplicateStudioFragmentMaterialV1(activeProjectFragmentMaterials, shaderId);
      return commitActiveProjectFragmentMaterials(duplicated.state) ? duplicated.shaderId : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material could not be duplicated.");
      return null;
    }
  }

  function renameFragmentMaterial(shaderId: string, name: string) {
    try {
      commitActiveProjectFragmentMaterials(
        renameStudioFragmentMaterialV1(activeProjectFragmentMaterials, { name, shaderId }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material could not be renamed.");
    }
  }

  function removeFragmentMaterialAsset(shaderId: string) {
    try {
      const result = removeStudioFragmentMaterialAssetV1(activeProjectFragmentMaterials, shaderId);
      if (result.kind === "in-use") {
        setDraftError(`Unassign this material from ${result.assignmentCount} object(s) before deleting it.`);
        return;
      }
      commitActiveProjectFragmentMaterials(result.state);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material could not be deleted.");
    }
  }

  function updateFragmentMaterialSource(shaderId: string, source: string) {
    try {
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialSourceV1(activeProjectFragmentMaterials, { shaderId, source }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The fragment material source is invalid.");
    }
  }

  async function importFragmentMaterialGlsl(shaderId: string, input: Readonly<{ entryPoint: "main"; source: string }>) {
    if (!activeProjectId) throw new Error("No project is open.");
    const projectId = activeProjectId;
    const expectedMaterial = activeProjectFragmentMaterials.registry.materials.find(
      (material) => material.shaderId === shaderId,
    );
    if (!expectedMaterial) throw new Error("The material no longer exists.");
    if (expectedMaterial.textureSlot) throw new Error("Texture materials currently accept canonical WGSL only.");
    const expectedGlsl = activeProjectFragmentMaterials.glslSourcesByShaderId[shaderId] ?? null;
    const compilation = await compileFragmentMaterialGlsl(input).then(
      (wgsl) => ({ kind: "compiled" as const, wgsl }),
      (error: unknown) => ({ error, kind: "rejected" as const }),
    );
    const current = loadProjectFragmentMaterials(projectId) ?? EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1;
    const currentMaterial = current.registry.materials.find((material) => material.shaderId === shaderId);
    const currentGlsl = current.glslSourcesByShaderId[shaderId] ?? null;
    if (
      !currentMaterial ||
      currentMaterial.revision !== expectedMaterial.revision ||
      currentMaterial.source !== expectedMaterial.source ||
      currentGlsl?.diagnostic !== expectedGlsl?.diagnostic ||
      currentGlsl?.entryPoint !== expectedGlsl?.entryPoint ||
      currentGlsl?.source !== expectedGlsl?.source
    ) {
      throw new Error("The material changed while GLSL was compiling. Review the latest source and try again.");
    }
    if (compilation.kind === "rejected") {
      const diagnostic =
        compilation.error instanceof Error && compilation.error.message
          ? compilation.error.message
          : "The Rust core rejected the GLSL source.";
      const rejected = recordStudioFragmentMaterialGlslDiagnosticV1(current, {
        ...input,
        diagnostic,
        shaderId,
      });
      if (!commitProjectFragmentMaterials(projectId, rejected)) {
        throw new Error("The rejected GLSL source and its diagnostic could not be saved.");
      }
      throw new Error(diagnostic);
    }
    const next = updateStudioFragmentMaterialFromGlslV1(current, {
      ...input,
      shaderId,
      wgsl: compilation.wgsl,
    });
    if (!commitProjectFragmentMaterials(projectId, next)) {
      throw new Error("The compiled GLSL material could not be saved.");
    }
  }

  function assignSelectedFragmentMaterial(shaderId: string | null) {
    if (!activeScene || !selectedFragmentMaterialEntity || (shaderId !== null && !selectedFragmentMaterialAvailable)) {
      return;
    }
    try {
      const material = shaderId
        ? activeProjectFragmentMaterials.registry.materials.find((candidate) => candidate.shaderId === shaderId)
        : null;
      const previousTexture = selectedFragmentMaterialAssignment?.texture;
      const selectedTextureAsset = material?.textureSlot
        ? (activeFragmentMaterialTextureAssets.find(
            (asset) => asset.id === previousTexture?.asset.assetId && asset.sha256 === previousTexture.asset.sha256,
          ) ?? activeFragmentMaterialTextureAssets[0])
        : null;
      const next = shaderId
        ? assignStudioFragmentMaterialV1(activeProjectFragmentMaterials, {
            entityId: selectedFragmentMaterialEntity.id,
            sceneId: activeScene.sceneId,
            shaderId,
            ...(selectedTextureAsset
              ? {
                  texture: {
                    asset: { assetId: selectedTextureAsset.id, sha256: selectedTextureAsset.sha256 },
                    sampler: previousTexture?.sampler ?? "linear",
                  },
                }
              : {}),
          })
        : removeStudioFragmentMaterialV1(activeProjectFragmentMaterials, {
            entityId: selectedFragmentMaterialEntity.id,
            sceneId: activeScene.sceneId,
          });
      commitActiveProjectFragmentMaterials(next);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material assignment could not be updated.");
    }
  }

  function updateSelectedFragmentMaterialTexture(assetId: string, sampler: "linear" | "nearest") {
    if (!activeScene || !selectedFragmentMaterialEntity || !selectedFragmentMaterialAssignment) return;
    const asset = activeFragmentMaterialTextureAssets.find(({ id }) => id === assetId);
    if (!asset) {
      setDraftError("The selected project PNG is no longer available.");
      return;
    }
    try {
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialTextureV1(activeProjectFragmentMaterials, {
          entityId: selectedFragmentMaterialEntity.id,
          sceneId: activeScene.sceneId,
          texture: { asset: { assetId: asset.id, sha256: asset.sha256 }, sampler },
        }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material texture could not be updated.");
    }
  }

  function updateSelectedFragmentMaterialParameter(name: string, value: number) {
    if (
      !activeScene ||
      !selectedFragmentMaterialEntity ||
      !selectedFragmentMaterialAssignment ||
      !selectedFragmentMaterialAvailable
    )
      return;
    try {
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialParameterV1(activeProjectFragmentMaterials, {
          entityId: selectedFragmentMaterialEntity.id,
          name,
          sceneId: activeScene.sceneId,
          value,
        }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material parameter could not be updated.");
    }
  }
  const selectedRuntimeTraceEditAuthority = runtimeTraceProjectionAuthorityFor(selectedEntity?.id);
  const selectedRuntimeTraceEditCapabilities = selectedRuntimeTraceEditAuthority?.capabilities ?? null;
  const selectedStudioCreationAppearanceAuthority = studioCreationAppearanceAuthorityFor(selectedEntity?.id);
  const selectedStudioCreationAppearanceAtAnchor =
    selectedStudioCreationAppearanceAuthority !== null &&
    Math.abs(sourceCurrentTime - selectedStudioCreationAppearanceAuthority.sourceAnchor) < 0.0005;
  const rotationHandleEntityId =
    selectedObjectIds.length === 1 &&
    selectedEntity !== null &&
    ((selectedStudioCreationAppearanceAtAnchor && selectedStudioCreationAppearanceAuthority.rotationAvailable) ||
      selectedRuntimeTraceEditCapabilities?.rotation === true)
      ? selectedEntity.id
      : null;
  const groupResizeEligibleIds = groupResizeEligibleCreationEntityIds(workspaceCreationProjection);
  const groupRotationEligibleIds = new Set(
    selectedObjectIds.filter((entityId) => {
      const authority = studioCreationAppearanceAuthorityFor(entityId);
      return authority?.rotationAvailable === true && groupResizeEligibleIds.has(entityId);
    }),
  );
  const selectedOpacityAuthority =
    selectedRuntimeTraceEditAuthority &&
    selectedRuntimeTraceEditCapabilities?.paintOpacity &&
    "baseOpacity" in selectedRuntimeTraceEditAuthority
      ? selectedRuntimeTraceEditAuthority
      : null;
  const appliedProgramReadOnlyReasons = Object.fromEntries(
    appliedEdits.map((record) => {
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
    void runAfterEditorSessionFlush(() => {
      suspendEditor();
      canvasDrag.current = null;
      canvasGroupRotation.current = null;
      canvasGroupResize.current = null;
      canvasResize.current = null;
      canvasRotation.current = null;
      gesturePreviewStore.clear();
      setInspectorReturnFocus(null);
      leaveWorkspace();
    });
  }

  async function unregisterWorkspaceAndClearSession(workspaceId: string) {
    if (!(await unregisterWorkspace(workspaceId))) return false;
    clearProjectSessions(workspaceId);
    setProjectFragmentMaterials((current) => {
      if (!(workspaceId in current)) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
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
          accountSession && flushedAccountActions ? (
            <AccountSessionBadge
              actions={flushedAccountActions}
              beforeExternalNavigation={() => runAfterEditorSessionFlush(() => undefined)}
              disabled={sessionTransitionPending}
              session={accountSession}
            />
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
              disabled={sourceLifecyclePending || sessionTransitionPending}
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
                  const sceneId = event.currentTarget.value;
                  void runAfterEditorSessionFlush(() => setActiveSceneId(sceneId));
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
            {accountSession && flushedAccountActions ? (
              <AccountSessionBadge
                actions={flushedAccountActions}
                beforeExternalNavigation={() => runAfterEditorSessionFlush(() => undefined)}
                compact
                disabled={sessionTransitionPending}
                session={accountSession}
              />
            ) : null}
            {activeScene && !previewAwaitingConsent ? (
              <StudioPreviewControl
                disabled={sessionTransitionPending}
                onRetry={retryPreviewRenderer}
                providerPending={previewProviderPending}
                renderer={previewRenderer}
              />
            ) : null}
            <StudioExportControl exportSource={studioExportSource} publication={studioExportPublication} />
            <StudioThumbnailControl
              generate={studioExportSource && previewRenderer ? previewRenderer.generateThumbnail : null}
              publication={studioExportPublication}
            />
            <button
              className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-wait disabled:text-zinc-600"
              disabled={
                sessionTransitionPending || workspaceIsRefreshing || sourceMutationPendingProjectId === activeProjectId
              }
              onClick={reimportWorkspaceAfterSessionFlush}
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
              disabled={!activeScene || studioAuthoringLocked || !previewMutationAvailable}
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
              disabled={sessionTransitionPending}
              onClick={reimportWorkspaceAfterSessionFlush}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : null}

        {editorDocumentAuthority.message ? (
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-950 bg-amber-950/40 px-3 py-1.5 text-xs text-amber-200"
            role="alert"
          >
            <span className="min-w-0 truncate">Editor sync: {editorDocumentAuthority.message}</span>
            {editorDocumentAuthority.retryable && editorDocumentPresentationReady ? (
              <button
                className="shrink-0 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                onClick={() => void editorDocumentAuthority.retry()}
                type="button"
              >
                Retry sync
              </button>
            ) : editorDocumentAuthority.pendingSessionConflict ? (
              <button
                className="shrink-0 underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                onClick={discardPendingCloudSession}
                type="button"
              >
                {editorDocumentAuthority.pendingSessionConflictAccountWide
                  ? editorDocumentAuthority.pendingJournalConflictKind === "mutation"
                    ? "Clear all pending mutation journals"
                    : "Clear all pending session journals"
                  : editorDocumentAuthority.pendingJournalConflictKind === "mutation"
                    ? "Clear pending mutation journal"
                    : "Clear pending session journal"}
              </button>
            ) : null}
          </div>
        ) : null}

        {activeScene && previewAwaitingConsent ? (
          <section
            aria-labelledby="preview-activation-title"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-950 bg-sky-950/30 px-3 py-2"
            data-studio-manim-preview-state="awaiting-consent"
          >
            <div className="min-w-0">
              <h2 className="text-balance text-xs font-medium text-sky-200" id="preview-activation-title">
                WebGPU Scene preview is ready to start
              </h2>
              <p className="mt-0.5 text-pretty text-[10px] leading-4 text-sky-200/70">
                Starting the canonical preview executes the selected workspace Scene through the configured producer.
              </p>
            </div>
            {previewActivationAllowed ? (
              <button
                aria-haspopup="dialog"
                className="shrink-0 border border-sky-800 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                onClick={() => previewActivationDialog.current?.showModal()}
                type="button"
              >
                Start preview…
              </button>
            ) : (
              <p className="shrink-0 text-pretty text-xs text-sky-200" role="status">
                Open Studio in a top-level tab to start it.
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
        ) : editorDocumentAuthority.enabled && !editorDocumentPresentationReady ? (
          <div className="grid min-h-0 flex-1 place-items-center bg-zinc-900 p-6">
            <div className="w-full max-w-sm border border-zinc-800 p-5">
              <h2 className="text-balance text-sm font-medium text-zinc-200">
                {editorDocumentAuthority.phase === "opening" || editorDocumentAuthority.phase === "pending"
                  ? "Synchronizing shared editor"
                  : editorDocumentAuthority.retryable
                    ? "Shared editor needs attention"
                    : "Shared editor is unavailable"}
              </h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                {editorDocumentAuthority.message ??
                  "Loading the authoritative Scene history before showing editable content…"}
              </p>
              {editorDocumentAuthority.rejectedTimelineProgramAvailable ? (
                <button
                  className="mt-4 border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-950/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                  onClick={() => void editorDocumentAuthority.removeRejectedTimelineProgram()}
                  type="button"
                >
                  Remove last incompatible edit
                </button>
              ) : editorDocumentAuthority.retryable ? (
                <button
                  className="mt-4 border border-sky-700 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-950/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                  onClick={() => void editorDocumentAuthority.retry()}
                  type="button"
                >
                  Retry sync
                </button>
              ) : editorDocumentAuthority.pendingSessionConflict ? (
                <button
                  className="mt-4 border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-950/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                  onClick={discardPendingCloudSession}
                  type="button"
                >
                  {editorDocumentAuthority.pendingSessionConflictAccountWide
                    ? editorDocumentAuthority.pendingJournalConflictKind === "mutation"
                      ? "Clear all pending mutation journals"
                      : "Clear all pending session journals"
                    : editorDocumentAuthority.pendingJournalConflictKind === "mutation"
                      ? "Clear pending mutation journal"
                      : "Clear pending session journal"}
                </button>
              ) : null}
            </div>
          </div>
        ) : workspaceStatus !== "error" && activeScene && workspaceTimelineProjection === undefined ? (
          <div className="grid min-h-0 flex-1 place-items-center bg-zinc-900 p-6">
            <div className="w-full max-w-md border border-amber-900 bg-amber-950/20 p-5">
              <h2 className="text-balance text-sm font-medium text-amber-200">Timeline projection is not ready</h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-amber-200/70">
                The canonical Rust core has not accepted the current timeline edit yet. Retry the preview, or remove the
                edit that cannot be projected.
              </p>
              {draftEdit ? (
                <button
                  className="mt-4 border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                  onClick={discardDraft}
                  type="button"
                >
                  Discard draft
                </button>
              ) : appliedEdits.length > 0 ? (
                <button
                  className="mt-4 border border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-900/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
                  onClick={undoProgramCommitFirst}
                  type="button"
                >
                  Undo last edit
                </button>
              ) : null}
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
                disabled={sessionTransitionPending}
                onClick={reimportWorkspaceAfterSessionFlush}
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
              appliedEdits={appliedEdits}
              appliedTransactionIds={appliedTransactionIds}
              authoringAvailable={previewMutationAvailable}
              className="order-2 min-h-64 md:order-1 md:col-start-1 md:row-start-1 md:min-h-0"
              draftActive={draftEdit !== null}
              duration={activeDuration}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              durationError={durationError}
              durationMinimum={durationTrimAvailability.minimumDuration}
              entities={editableEntities}
              layers={studioLayers}
              nextScene={nextScene}
              onDurationChange={(duration) => void changeSceneDuration(duration)}
              onEditAppliedProgram={editAppliedProgram}
              onLayerOrder={changeLayerOrder}
              onRedo={() => void redoProgram()}
              onToggleEntity={(entityId, selected) =>
                setSelectedObjectIds((selection) =>
                  selected ? selection.filter((id) => id !== entityId) : [...selection, entityId],
                )
              }
              onUndo={undoProgramCommitFirst}
              redoCount={redoPrograms.length}
              selectedIds={selectedSet}
              sourceImportOutcomes={activeScene.importOutcomes}
            />

            <StudioViewport
              anchors={timelineAnchors}
              appliedMotionClips={appliedMotionClips}
              appliedTransactionIds={appliedTransactionIds}
              boundaryActive={boundary !== null}
              className="order-1 min-h-[30rem] md:order-2 md:col-start-2 md:row-start-1 md:min-h-[32rem] xl:min-h-0"
              currentTime={currentTime}
              duration={activeDuration}
              editableMotionIds={editableMotionIds}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              entities={visibleEntities}
              frame={workspace?.frame ?? { height: 8, width: 14.222 }}
              gesturePreviewStore={gesturePreviewStore}
              groupRotationEligibleIds={groupRotationEligibleIds}
              groupResizeEligibleIds={groupResizeEligibleIds}
              incomingSceneName={nextScene?.name ?? null}
              inlineTextEditor={inlineTextEditor}
              insertTool={insertTool}
              insertValue={insertValue}
              interactionMode={interactionMode}
              isPlaying={isPlaying}
              lifetimeControls={lifetimeControls}
              lifetimeEditMessage={lifetimeEditMessage}
              lifetimeTrimDisabled={draftEdit !== null}
              motionDuration={motionDuration}
              motionPaths={motionPaths}
              onAppliedMotionClipChange={changeAppliedMotionClip}
              onAppliedMotionClipSelect={editAppliedMotionClip}
              onCanvasPlace={(point) => {
                if (insertTool === "Text") beginInlineTextCreation(point);
                else void insertEntitiesAt(point);
              }}
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
              onEntityRotationCancel={cancelEntityRotation}
              onEntityRotationKeyDown={nudgeEntityRotation}
              onEntityRotationPointerDown={beginEntityRotation}
              onEntityRotationPointerMove={moveEntityRotation}
              onEntityRotationPointerUp={finishEntityRotation}
              onEntityTextEdit={beginInlineTextEdit}
              onInlineTextCancel={cancelInlineTextEdit}
              onInlineTextCommit={commitInlineTextEdit}
              onInteractionModeChange={setInteractionMode}
              onInsertAtCenter={() => void insertEntitiesAt({ x: 320, y: 180 })}
              onInsertToolChange={(tool) => {
                setInlineTextEditor(null);
                setInsertTool(tool);
              }}
              onInsertValueChange={setInsertValue}
              onLifetimeChange={(entityId, lifetimeStart, target) => {
                void editEntityLifetime(entityId, lifetimeStart, target);
              }}
              onMotionControlChange={changeDraftMotionControl}
              onMotionDurationChange={setMotionDuration}
              onPresenceCursorChange={(cursor) => editorDocumentAuthority.updatePresence({ cursor })}
              onSelectionResizeCancel={cancelSelectionResize}
              onSelectionResizeKeyDown={nudgeSelectionResize}
              onSelectionResizePointerDown={beginSelectionResize}
              onSelectionResizePointerMove={moveSelectionResize}
              onSelectionResizePointerUp={finishSelectionResize}
              onSelectionRotationCancel={cancelSelectionRotation}
              onSelectionRotationKeyDown={nudgeSelectionRotation}
              onSelectionRotationPointerDown={beginSelectionRotation}
              onSelectionRotationPointerMove={moveSelectionRotation}
              onSelectionRotationPointerUp={finishSelectionRotation}
              onSelectEntity={(entityId, mode = "single") =>
                setSelectedObjectIds((selection) =>
                  mode === "toggle" ? toggleCanvasEntitySelection(selection, entityId) : [entityId],
                )
              }
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
              previewPaintAvailable={previewMutationAvailable}
              presenceParticipants={editorDocumentAuthority.presenceParticipants}
              projection={projection}
              readOnly={boundary !== null || canvasInteractionLocked}
              rotationHandleEntityId={rotationHandleEntityId}
              selectedIds={selectedSet}
            />

            <StudioInspector
              appliedProgramCount={appliedEdits.length}
              authoringAvailable={previewMutationAvailable}
              className="order-3 min-h-96 md:col-span-2 md:col-start-1 md:row-start-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:min-h-0"
              draftError={draftError}
              draftApplyPending={draftApplyPending}
              draftOperation={draftOperation}
              draftEdit={draftEdit}
              inspectorReturnFocus={inspectorReturnFocus}
              onApplyDraft={() => void applyDraft()}
              onDiscardDraft={discardDraft}
              onDraftOperationChange={updateDraftOperation}
              onEntityEdit={editEntityFromInspector}
              onEntityColorChange={(entityId, property, color) =>
                void setEntityColorFromInspector(entityId, property, color)
              }
              onEntityOpacityChange={(entityId, opacity) => void setEntityOpacityFromInspector(entityId, opacity)}
              onEntityRotate={(entityId, angleRadians) => void rotateEntityFromInspector(entityId, angleRadians)}
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
              colorAvailable={
                selectedStudioCreationAppearanceAtAnchor &&
                (selectedEntity?.type === "Circle" || selectedEntity?.type === "Rectangle")
              }
              fillColorValue={
                selectedEntity?.geometry.style.kind === "known"
                  ? (selectedEntity.geometry.style.value.fillColor ?? null)
                  : null
              }
              fragmentMaterial={{
                active: selectedFragmentMaterialAssigned && previewRenderer?.state.phase === "presented",
                assignedParameters: selectedFragmentMaterialAssignment?.parameters ?? null,
                assignedShaderId: selectedFragmentMaterialAssignment?.shaderId ?? null,
                assignedTexture: selectedFragmentMaterialAssignment?.texture ?? null,
                available: selectedFragmentMaterialAvailable,
                compileError: activeSceneFragmentMaterialCompileError,
                materials: activeProjectNamedFragmentMaterials,
                onAssign: assignSelectedFragmentMaterial,
                onCreate: createFragmentMaterial,
                onCreatePreset: createWaveFragmentMaterialPreset,
                onCreateTexturePreset: createTextureFragmentMaterialPreset,
                onDuplicate: duplicateFragmentMaterial,
                onImportGlsl: importFragmentMaterialGlsl,
                onRemoveAsset: removeFragmentMaterialAsset,
                onRename: renameFragmentMaterial,
                onUpdateSource: updateFragmentMaterialSource,
                onUpdateParameter: updateSelectedFragmentMaterialParameter,
                onUpdateTexture: updateSelectedFragmentMaterialTexture,
                textureAssets: activeFragmentMaterialTextureAssets.map((asset) => ({
                  assetId: asset.id,
                  label: `${asset.id} (${asset.pixelWidth}×${asset.pixelHeight})`,
                })),
              }}
              opacityAvailable={selectedStudioCreationAppearanceAtAnchor || selectedOpacityAuthority !== null}
              opacityValue={
                selectedStudioCreationAppearanceAtAnchor
                  ? (selectedEntity?.opacity ?? null)
                  : (selectedOpacityAuthority?.baseOpacity ?? null)
              }
              rotationAvailable={
                (selectedStudioCreationAppearanceAtAnchor &&
                  selectedStudioCreationAppearanceAuthority.rotationAvailable) ||
                selectedRuntimeTraceEditCapabilities?.rotation === true
              }
              selectedEntity={selectedEntity}
              strokeColorValue={
                selectedEntity?.geometry.style.kind === "known"
                  ? (selectedEntity.geometry.style.value.strokeColor ??
                    selectedEntity.geometry.style.value.color ??
                    (selectedStudioCreationAppearanceAuthority ? "#ffffff" : null))
                  : null
              }
              sourceExport={
                activeProjectId && activeScene
                  ? {
                      projectId: activeProjectId,
                      sourceHash: activeScene.sourceHash,
                      sourcePath: activeScene.sourcePath,
                    }
                  : null
              }
              sourceExportBlocker={sourceFragmentMaterialExportBlocker}
              suggestion={suggestion}
              workspace={workspace}
            />
          </div>
        )}

        <dialog
          aria-describedby="enable-preview-description"
          aria-labelledby="enable-preview-title"
          className="m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
          id="enable-preview-dialog"
          ref={previewActivationDialog}
          role="alertdialog"
        >
          <form className="p-4" method="dialog">
            <h2 className="text-balance text-sm font-medium" id="enable-preview-title">
              Run workspace Scenes for WebGPU preview?
            </h2>
            <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="enable-preview-description">
              Studio will execute the selected Scene, and any Scene you switch to, through the configured fast-manim
              producer. Start this only for workspace source you trust. Permission ends when this tab reloads or closes.
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
            authoringAvailable={previewMutationAvailable}
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
