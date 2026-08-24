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
import {
  extendStudioCubicBezier,
  inspectStudioCubicBezier,
  type StudioCubicBezierPointRef,
  type StudioCubicBezierSpec,
} from "./engine/cubic-bezier-authoring";
import { compileFragmentMaterialGlsl } from "./engine/fragment-material-glsl";
import type { StudioCreationProjectionMutationV1, StudioPropertyKeyframeEasing } from "./engine/scene-authoring";
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
  createStudioGroupLifetimeTrimProgram,
  createStudioGroupProgram,
  createStudioSceneBackgroundProgram,
  createStudioUngroupProgram,
  defaultEntityContent,
  duplicateEntityInput,
  replaceStudioCreatedContentProgram,
  replaceStudioCreatedCubicBezierProgram,
  replaceStudioCreatedDataSeriesProgram,
  replaceStudioEntityLifetimeProgram,
  replaceStudioSceneBackgroundProgram,
  type StudioEntityInput,
} from "./studio/authoring-commands";
import {
  type CameraClipEasing,
  type CameraView,
  cameraClipFromProgram,
  cameraFocusViewFromPreparedBounds,
  createCameraProgram,
  replaceCameraProgram,
} from "./studio/camera-clip-edit";
import { canvasDragTargetEntityIds, toggleCanvasEntitySelection } from "./studio/canvas-selection";
import { commandForShortcut, isEditableShortcutTarget, type StudioCommandId } from "./studio/commands";
import type { DataPlotInspectorAuthoring } from "./studio/data-plot-editor";
import { runDraftSourcePreflight } from "./studio/draft-apply-preflight";
import { projectedPositions, validatedProgramRecord, validateSuggestionDraft } from "./studio/draft-validation";
import {
  drawInClipFromProgram,
  drawInUnavailableReason,
  replaceDrawInProgram,
  sceneProgramsHaveDrawIn,
} from "./studio/draw-in-edit";
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
import { editorSessionIdentityKey } from "./studio/editor-session-store";
import type { ShapeTransformInspectorInput } from "./studio/entity-inspector";
import { LOCKED_ENTITY_MUTATION_MESSAGE, lockedEntityMutationTargets, toggleEntityLock } from "./studio/entity-lock";
import {
  assignStudioFragmentMaterialV1,
  CUBIC_BEZIER_FRAGMENT_MATERIAL_FILL_BLOCKER,
  createStudioFragmentMaterialV1,
  createStudioGradientFragmentMaterialPresetV1,
  createStudioPulseFragmentMaterialPresetV1,
  createStudioTextureFragmentMaterialPresetV1,
  createStudioWaveFragmentMaterialPresetV1,
  cubicBezierFragmentMaterialTransitionBlocker,
  duplicateStudioFragmentMaterialV1,
  EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
  listStudioFragmentMaterialsV1,
  type ProjectFragmentMaterialStateV1,
  projectFragmentMaterialsForSceneV1,
  recordStudioFragmentMaterialGlslDiagnosticV1,
  removeStudioFragmentMaterialAssetV1,
  removeStudioFragmentMaterialV1,
  renameStudioFragmentMaterialV1,
  type StudioFragmentMaterialParameterSchemaV1,
  type StudioFragmentMaterialParameterValueV1,
  type StudioFragmentMaterialPresetId,
  type StudioFragmentMaterialRemovalResolution,
  sceneHasFragmentMaterialAssignmentsV1,
  studioFragmentMaterialAssignmentCountV1,
  studioFragmentMaterialCompileErrorV1,
  studioFragmentMaterialParameterLayoutV1,
  updateStudioFragmentMaterialFromGlslV1,
  updateStudioFragmentMaterialParameterSchemaV1,
  updateStudioFragmentMaterialParameterV1,
  updateStudioFragmentMaterialSourceV1,
  updateStudioFragmentMaterialTextureV1,
} from "./studio/fragment-material-authoring";
import {
  type FrameSnapBasis,
  type PreparedMoveSnapBasis,
  snapViewportDragToFrame,
} from "./studio/frame-alignment-snap";
import { projectVerifiedSourceDuration } from "./studio/imported-workspace";
import {
  type InspectorEditField,
  initialInspectorEditValues,
  type ValidatedInspectorEdits,
  validateInspectorEdits,
} from "./studio/inspector-edit";
import {
  filterStudioCanvasEntitiesByVisibility,
  planStudioLayerGroup,
  planStudioLayerGroupOrder,
  planStudioLayerGroupReorder,
  planStudioLayerOrder,
  planStudioLayerReorder,
  projectStudioLayers,
  type StudioLayerGroupOrderPlan,
  type StudioLayerOrderDirection,
  type StudioLayerOrderPlan,
  selectedStudioLayerGroup,
  selectionContainsGroupedChild,
} from "./studio/layer-order";
import {
  buildLifetimeEditControls,
  findCompetingImportedLifetimeOwner,
  findCompetingStudioLifetimeOwner,
  findImportedLifetimeEdit,
  findStudioLifetimeOwner,
  programSourceAnchorBounds,
  studioLogicalGroupLifetimeTrimUnavailableReason,
} from "./studio/lifetime-editing";
import { MAX_ENTITY_SCALE, MIN_ENTITY_SCALE, magicEditCapabilities } from "./studio/magic-edit-capabilities";
import { MagicEditPanel } from "./studio/magic-edit-panel";
import {
  appendMaterialParameterKeyframe,
  type MaterialParameterKeyframe,
  type MaterialParameterKeyframeTrack,
  materialParameterIdentityEditBlocker,
  materialParameterKeyframeTrackFromProgram,
  replaceMaterialParameterKeyframe,
  replaceMaterialParameterKeyframeProgram,
} from "./studio/material-parameter-keyframe-edit";
import {
  createMathTexTransformProgram,
  type MathTexTransformEasing,
  mathTexTransformClipFromProgram,
  replaceMathTexTransformProgram,
} from "./studio/mathtex-transform-clip-edit";
import type {
  DataSeries,
  EntityContent,
  EntityDimensions,
  Point,
  ProgramRecord,
  ProjectedEntity,
  ProposedState,
  RuntimeSceneState,
} from "./studio/model";
import {
  adjustAppliedMotionClipControl,
  appliedMotionClipReadOnlyReason,
  retimeAppliedMotionClip,
} from "./studio/motion-clip-edit";
import { projectMotionPaths, type StudioMotionPath } from "./studio/motion-paths";
import type { AppliedMotionClip, AppliedMotionClipChange } from "./studio/motion-timeline-clip";
import { ingestNativeProjectPngV1, type NativeProjectAssetStateV1 } from "./studio/native-project-assets";
import { browserNativeProjectLocalStore } from "./studio/native-project-local-store";
import {
  type OpacityKeyframe,
  opacityKeyframeTrackFromProgram,
  replaceOpacityKeyframe,
  replaceOpacityKeyframeProgram,
} from "./studio/opacity-keyframe-edit";
import { programExecutionCapabilities } from "./studio/operation-registry";
import {
  initialAppearanceEnd,
  isSceneDurationOperation,
  isStudioNativeAuthoringBatchOperation,
  type OperationOrigin,
} from "./studio/operations";
import {
  appendPaintColorKeyframe,
  initialPaintColorKeyframes,
  type PaintColorKeyframe,
  type PaintColorProperty,
  paintColorKeyframeTrackFromProgram,
  replacePaintColorKeyframe,
  replacePaintColorKeyframeProgram,
} from "./studio/paint-color-keyframe-edit";
import { PoietraBrand } from "./studio/poietra-brand";
import type {
  StudioNativePreviewEditingContextV1,
  StudioNativePreviewSceneIdentityV1,
} from "./studio/preview-snapshot-provider";
import { createStudioNativePreviewSnapshotProviderV1 } from "./studio/preview-snapshot-provider.native";
import {
  projectStudioPreviewRuntimeTraceEntityPresence,
  projectStudioPreviewRuntimeTraceValidationScene,
  studioPreviewRuntimeTraceEditBaseCenter,
  studioPreviewRuntimeTraceEditTargetIsPresent,
} from "./studio/preview-temporal-rebase";
import {
  insertedProgramDuration,
  latestSafeSourceAnchor,
  sourceTimeToWorkingTime as sourceTimeToWorkingTimeWithoutTimeline,
  workingTimeToSourceTime as workingTimeToSourceTimeWithoutTimeline,
} from "./studio/program-composition";
import { duplicatePropertyKeyframeAtTime } from "./studio/property-keyframe-duplicate";
import { samplePropertyValue } from "./studio/property-sampling";
import {
  appendRotationKeyframe,
  type RotationKeyframe,
  replaceRotationKeyframe,
  replaceRotationKeyframeProgram,
  rotationKeyframeTrackFromProgram,
  rotationKeyframeTransformConflictEntity,
} from "./studio/rotation-keyframe-edit";
import {
  appendScaleKeyframe,
  MAX_TIMELINE_SCALE,
  MIN_TIMELINE_SCALE,
  replaceScaleKeyframe,
  replaceScaleKeyframeProgram,
  type ScaleKeyframe,
  scaleKeyframeTrackFromProgram,
  scaleKeyframeTransformConflictEntity,
} from "./studio/scale-keyframe-edit";
import { isExactStudioMathTexTransformProgramBatch } from "./studio/scene-authoring-wire";
import {
  type SceneEdit,
  shapeTransformChangesShape,
  studioEntityTypeSupportsStrokeCap,
  studioEntityTypeSupportsStrokeWidth,
  studioPaintColorTrackProperty,
} from "./studio/scene-edit-contract";
import {
  isSelectionLayoutCommand,
  planSelectionLayout,
  type SelectionLayoutCommand,
  type SelectionLayoutTarget,
} from "./studio/selection-layout";
import {
  createSelectionResizeGesture,
  groupResizeEligibleCreationEntityIds,
  importedGroupResizeHistoryIsSupported,
  type PreparedSelectionResizeBasis,
  resizeSelectionAtPoint,
  resizeUnavailableCreationEntityIds,
  type SelectionResizeGesture,
  selectionResizeCommandTargets,
  selectionResizePreviewAtFactor,
  uniformScaleResizeOnlyCreationEntityIds,
} from "./studio/selection-resize-gesture";
import {
  createSelectionRotationGesture,
  currentCreationTransformForEntity,
  importedGroupRotationHistoryIsSupported,
  latestCreationPositionForEntity,
  type SelectionRotationGesture,
  selectionRotationCommandTargets,
  selectionRotationPreviewAtAngle,
  studioCreationStaticTransformAnchorForEntity,
} from "./studio/selection-rotation-gesture";
import {
  hasShapeDimensions,
  type ResizeHandleDirection,
  resizeHandleDeltaIsOutward,
  resizeHandleUsesDelta,
  resizeKindForType,
  resizeShapeByViewportDelta,
  type ShapeGeometry,
  type ShapeResizeKind,
  sameShapeGeometry,
} from "./studio/shape-resize";
import {
  createShapeTransformProgram,
  isShapeTransformTarget,
  replaceShapeTransformProgram,
  type ShapeTransformState,
  shapeTransformClipFromProgram,
} from "./studio/shape-transform-clip-edit";
import {
  createSingleScaleResizeGesture,
  resolveSingleScaleResize,
  type SingleScaleResizeGesture,
} from "./studio/single-scale-resize-gesture";
import { projectRuntimeSceneToSourceTimeline as projectRuntimeSceneToSourceTimelineWithProjection } from "./studio/source-timeline";
import { studioStarterCompositionEntities } from "./studio/starter-composition";
import { preparedGeometryBounds, verifiedPreviewGeometryForStudioEntity } from "./studio/studio-canvas";
import {
  type StudioEmptyWorkspaceEntityType,
  studioNativeWorkspaceOnboardingAvailable,
} from "./studio/studio-empty-workspace";
import { resolveStudioExportPublicationAvailabilityV1 } from "./studio/studio-export-publication";
import { StudioExportSettingsControl } from "./studio/studio-export-settings-control";
import { createStudioGesturePreviewStore } from "./studio/studio-gesture-preview-store";
import { resolveStudioImageAssetDrag, studioNativeImageAssetsV1 } from "./studio/studio-image-assets";
import type { StudioInlineTextEditorSession } from "./studio/studio-inline-text-editor";
import {
  createStudioNativeBlankSceneIrBundle,
  isStudioNativeWorkspaceScene,
  studioWorkspaceWorkingState,
} from "./studio/studio-native-workspace";
import { createStudioPlaybackClock } from "./studio/studio-playback-clock";
import { StudioPreviewControl } from "./studio/studio-preview-control";
import { markStudioRenderBoundary } from "./studio/studio-render-profiler";
import { StudioInspector, WorkspaceSidebar } from "./studio/studio-sidebars";
import { importStudioSvgPathAsset, type StudioSvgPathAsset } from "./studio/studio-svg-assets";
import type {
  StudioCameraClipChange,
  StudioCameraTimelineClip,
  StudioDrawInClipChange,
  StudioDrawInTimelineClip,
  StudioMaterialParameterTimelineOption,
  StudioMaterialParameterTimelineTrack,
  StudioMathTexTransformClipChange,
  StudioMathTexTransformTimelineClip,
  StudioOpacityTimelineTrack,
  StudioPaintColorTimelineTrack,
  StudioRotationTimelineTrack,
  StudioScaleTimelineTrack,
  StudioShapeTransformClipChange,
  StudioShapeTransformTimelineClip,
  StudioWriteInClipChange,
  StudioWriteInTimelineClip,
} from "./studio/studio-timeline";
import type { CoordinateInsertSettings, CurveInsertSettings, StudioTool } from "./studio/studio-toolbar";
import { entityLabel, STUDIO_VIEWPORT, StudioViewport } from "./studio/studio-viewport";
import { clientPointToViewport, rotationDeltaFromClientPoints } from "./studio/studio-viewport-geometry";
import { STUDIO_STYLE_PROFILE } from "./studio/style-profile";
import {
  createDirectManipulationColorProgram,
  createDirectManipulationGroupLayerOrderProgram,
  createDirectManipulationGroupResizeProgram,
  createDirectManipulationGroupRotationProgram,
  createDirectManipulationGroupVisibilityProgram,
  createDirectManipulationLayerOrderProgram,
  createDirectManipulationOpacityProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationResizeProgram,
  createDirectManipulationRotationProgram,
  createDirectManipulationScaleProgram,
  createDirectManipulationStrokeCapProgram,
  createDirectManipulationStrokeWidthProgram,
  createDirectManipulationVisibilityProgram,
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
  discardEditorDraft as discardEditorDraftTransition,
  draftEditorProgramRecord,
  type EditorControllerState,
  type EditorProgramRecord,
  type EditorSessionIdentity,
  editorProgramRecord,
  initializeEditorScene,
  installAuthoritativeEditorPrograms,
  installCloudEditorSessionSnapshotV1,
  nextEditorRedoAction,
  nextEditorUndoAction,
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
  selectHistoricalCreationProjectionPrefix,
  selectMathTexTransformProjection,
  selectMotionProjection,
  selectPersistentRemoveProjection,
  selectStaticRootProjection,
  selectStudioWorkspaceEditAuthority,
} from "./studio/workspace-projection";
import {
  replaceWriteInProgram,
  sceneProgramsHaveWriteIn,
  type WriteInEasing,
  writeInClipFromProgram,
  writeInUnavailableReason,
} from "./studio/write-in-edit";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);
const NUDGE_DELTAS: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
  ArrowDown: { x: 0, y: 2 },
  ArrowLeft: { x: -2, y: 0 },
  ArrowRight: { x: 2, y: 0 },
  ArrowUp: { x: 0, y: -2 },
};
const DRAW_IN_GROUPING_BLOCKER = "Remove Draw from every selected object before grouping.";

function sceneOffsetFromViewport(
  point: Point,
  origin: Point,
  frame: Readonly<{ height: number; width: number }>,
): Point {
  return {
    x: ((point.x - origin.x) / STUDIO_VIEWPORT.width) * frame.width,
    y: -((point.y - origin.y) / STUDIO_VIEWPORT.height) * frame.height,
  };
}

function viewportOffsetFromScene(point: Point, frame: Readonly<{ height: number; width: number }>): Point {
  return {
    x: (point.x / frame.width) * STUDIO_VIEWPORT.width,
    y: -(point.y / frame.height) * STUDIO_VIEWPORT.height,
  };
}

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
    gesture: SingleScaleResizeGesture;
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
type TabLocalNativeProjectState = NativeProjectAssetStateV1 &
  Readonly<{
    documentKey: string;
    fragmentMaterials: ProjectFragmentMaterialStateV1;
    projectId: string;
    svgAssets: readonly StudioSvgPathAsset[];
  }>;

function tabLocalNativeProjectKey(projectId: string, documentKey: string) {
  return JSON.stringify([projectId, documentKey]);
}

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

function resizedEntityScale(
  resize: CanvasScaleResizeState,
  point: Readonly<{ x: number; y: number }>,
  disableSnap: boolean,
) {
  return resolveSingleScaleResize(resize.gesture, point, disableSnap);
}

function resizedShapeGeometry(
  resize: CanvasShapeResizeState,
  point: Readonly<{ x: number; y: number }>,
  preserveAspectRatio: boolean,
) {
  return resizeShapeByViewportDelta({
    cameraScale: resize.cameraScale,
    direction: resize.direction,
    frame: resize.frame,
    from: resize.from,
    preserveAspectRatio,
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
  markStudioRenderBoundary("app");
  const shell = detectShell();
  const aiEndpointConfigured = Boolean(import.meta.env.VITE_POIETRA_AI_ENDPOINT);
  const {
    activeEditorScene,
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
    projectHasLocalMaterialParameterTrack,
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
    toggleEntityLock: toggleEditorEntityLock,
    toggleEntityLocks: toggleEditorEntityLocks,
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
    lockRedoEntries,
    lockedEntityIds,
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
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const playbackClock = useMemo(() => createStudioPlaybackClock(), []);
  const playbackSeekPendingRef = useRef(false);
  const lockedEntityIdSet = useMemo(() => new Set(lockedEntityIds), [lockedEntityIds]);
  const lockedEntityIdsRef = useRef<ReadonlySet<string>>(lockedEntityIdSet);
  lockedEntityIdsRef.current = lockedEntityIdSet;
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
  const [nativeProjectState, setNativeProjectState] = useState<TabLocalNativeProjectState | null>(null);
  const [nativeProjectAssetPending, setNativeProjectAssetPending] = useState(false);
  const [nativeProjectAssetError, setNativeProjectAssetError] = useState<string | null>(null);
  const [nativeProjectAssetErrorKind, setNativeProjectAssetErrorKind] = useState<"image" | "svg" | null>(null);
  const [lifetimeEditMessage, setLifetimeEditMessage] = useState<string | null>(null);
  const [coordinateInsertSettings, setCoordinateInsertSettings] = useState<CoordinateInsertSettings>({
    height: 4,
    width: 6,
    xMaximum: 5,
    xMinimum: -5,
    xStep: 1,
    yMaximum: 3,
    yMinimum: -3,
    yStep: 1,
  });
  const [curveInsertSettings, setCurveInsertSettings] = useState<CurveInsertSettings>({
    ellipseHeight: 2,
    ellipseWidth: 3,
    radius: 1,
    startDegrees: 0,
    sweepDegrees: 90,
  });
  const [regularPolygonSides, setRegularPolygonSides] = useState(6);
  const [cubicBezierExtensionEntityId, setCubicBezierExtensionEntityId] = useState<string | null>(null);
  const [cubicBezierPenPoints, setCubicBezierPenPoints] = useState<readonly Point[]>([]);
  const [isMagicEditVisible, setIsMagicEditVisible] = useState(() => window.matchMedia("(min-width: 640px)").matches);
  const nativeProjectLocalStore = useMemo(browserNativeProjectLocalStore, []);
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
  const nativeProjectAssetGeneration = useRef(0);
  const cubicBezierAuthoringGeneration = useRef(0);
  const cubicBezierAuthoringSnapshot = useRef({
    activeProjectId,
    activeSceneId,
    appliedEdits,
    draftEdit,
    editingAppliedProgram,
    insertTool,
    selectedObjectIds,
  });
  cubicBezierAuthoringSnapshot.current = {
    activeProjectId,
    activeSceneId,
    appliedEdits,
    draftEdit,
    editingAppliedProgram,
    insertTool,
    selectedObjectIds,
  };
  const nativeProjectStates = useRef(new Map<string, TabLocalNativeProjectState>());
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
  useEffect(() => {
    cubicBezierAuthoringGeneration.current += 1;
    setCubicBezierExtensionEntityId(null);
    setCubicBezierPenPoints([]);
  }, [activeProjectId, activeSceneId]);
  useEffect(() => {
    if (
      cubicBezierExtensionEntityId &&
      (selectedObjectIds.length !== 1 || !selectedObjectIds.includes(cubicBezierExtensionEntityId))
    ) {
      setCubicBezierExtensionEntityId(null);
    }
  }, [cubicBezierExtensionEntityId, selectedObjectIds]);

  useEffect(() => {
    const generation = nativeProjectAssetGeneration.current + 1;
    nativeProjectAssetGeneration.current = generation;
    setNativeProjectState(null);
    setNativeProjectAssetError(null);
    setNativeProjectAssetErrorKind(null);
    setNativeProjectAssetPending(false);
    if (
      !activeProjectId ||
      !activeEditorScene ||
      !isStudioNativeWorkspaceScene(activeEditorScene) ||
      workspace?.nativeDocument?.documentKey !== activeEditorScene.identity.documentKey
    )
      return;
    const projectId = activeProjectId;
    const documentKey = activeEditorScene.identity.documentKey;
    const stateKey = tabLocalNativeProjectKey(projectId, documentKey);
    const retained = nativeProjectStates.current.get(stateKey);
    if (retained) {
      setNativeProjectState(retained);
      return;
    }
    setNativeProjectAssetPending(true);
    void (async () => {
      const restored = await nativeProjectLocalStore?.restore({ documentKey, projectId });
      if (nativeProjectAssetGeneration.current !== generation) return;
      const initialized = restored
        ? { ...restored, documentKey, projectId }
        : {
            assetPayloads: [],
            bundle: await createStudioNativeBlankSceneIrBundle(activeEditorScene, workspace.frame),
            documentKey,
            fragmentMaterials: EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1,
            projectId,
            svgAssets: [],
          };
      if (nativeProjectAssetGeneration.current !== generation) return;
      nativeProjectStates.current.set(stateKey, initialized);
      setNativeProjectState(initialized);
      setNativeProjectAssetPending(false);
    })().catch((cause: unknown) => {
      if (nativeProjectAssetGeneration.current !== generation) return;
      setNativeProjectAssetError(
        cause instanceof Error ? cause.message : "Studio could not restore this native project.",
      );
      setNativeProjectAssetPending(false);
    });
  }, [activeEditorScene, activeProjectId, nativeProjectLocalStore, workspace]);

  function activeEditorSessionIdentity(): EditorSessionIdentity | null {
    if (!activeProjectId || !activeEditorScene) return null;
    return isStudioNativeWorkspaceScene(activeEditorScene)
      ? {
          documentKey: activeEditorScene.identity.documentKey,
          origin: "studio-native",
          projectId: activeProjectId,
          sceneId: activeEditorScene.sceneId,
        }
      : {
          projectId: activeProjectId,
          sceneId: activeEditorScene.sceneId,
          sourceHash: activeEditorScene.sourceHash,
        };
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
    for (const [key, state] of nativeProjectStates.current) {
      if (!registeredProjectIds.has(state.projectId)) nativeProjectStates.current.delete(key);
    }
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
      if (!activeEditorScene || event.defaultPrevented || isEditableShortcutTarget(event.target)) return;
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
    if (!activeEditorScene) return;
    cancelSuggestionRequest();
    canvasDrag.current = null;
    canvasGroupRotation.current = null;
    canvasGroupResize.current = null;
    canvasResize.current = null;
    canvasRotation.current = null;
    const identity = activeEditorSessionIdentity();
    const initialTime = activeEditorScene.anchors[0] ?? 0;
    const initialEntities = Object.values(activeEditorScene.runtimeSceneState.objectGraph.entities).filter((entity) =>
      entity.lifetime.some((lifetime) => initialTime >= lifetime.start && initialTime < lifetime.end),
    );
    if (identity) {
      openSession(identity, {
        currentTime: clamp(initialTime, 0, activeEditorScene.runtimeSceneState.duration),
        selectedObjectIds: initialEntities.slice(0, 1).map((entity) => entity.id),
      });
    }
    setLifetimeEditMessage(null);
    gesturePreviewStore.clear();
    setInspectorReturnFocus(null);
  }, [activeEditorScene, activeProjectId, gesturePreviewStore]);

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
  const targetEditorSessionIdentity = activeEditorSessionIdentity();
  const editorPresenceSessionAligned =
    activeEditorScene !== null &&
    activeSessionIdentity !== null &&
    targetEditorSessionIdentity !== null &&
    editorSessionIdentityKey(activeSessionIdentity) === editorSessionIdentityKey(targetEditorSessionIdentity);
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
  const importedEditorDocumentPresentationReady = editorDocumentAuthority.presentationReady;

  const importedSceneBoundaryActive =
    activeScene?.runtimeSceneState.eventTrack.events.some(
      (event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= currentTime,
    ) ?? false;
  const nativeSceneActive = activeEditorScene !== null && isStudioNativeWorkspaceScene(activeEditorScene);
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
  const editorSelectionAligned =
    activeProjectId !== null && workspace?.projectId === activeProjectId && activeEditorScene !== null;
  const editorSessionReady =
    editorSelectionAligned &&
    activeSessionIdentity !== null &&
    targetEditorSessionIdentity !== null &&
    editorSessionIdentityKey(activeSessionIdentity) === editorSessionIdentityKey(targetEditorSessionIdentity);
  const editorDocumentPresentationReady = nativeSceneActive
    ? editorSessionReady
    : importedEditorDocumentPresentationReady;
  // The retained duration adopted by the revision policy is the only value
  // allowed to reshape Studio's imported base. The provider candidate is
  // committed in a layout effect, so adapter compilation may lag metadata by
  // one render but can never compile against unadopted runtime timing.
  const projectedEditorScene = useMemo(
    () =>
      activeEditorScene
        ? isStudioNativeWorkspaceScene(activeEditorScene)
          ? activeEditorScene
          : projectVerifiedSourceDuration(activeEditorScene, editorRevision.retainedSourceDuration)
        : null,
    [activeEditorScene, editorRevision.retainedSourceDuration],
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
  const previewProjectionAppliedEdits = editingAppliedProgram && draftEdit ? draftPrecedingEdits : previewAppliedEdits;
  const previewProjectionStagedEdits =
    editingAppliedProgram && draftEdit
      ? previewAppliedEdits.slice(editingAppliedProgram.index)
      : editingAppliedProgram || !draftEdit
        ? []
        : [draftEdit];
  const previewWorkingState =
    editorDocumentPresentationReady && projectedEditorScene
      ? studioWorkspaceWorkingState(projectedEditorScene, {
          appliedEdits: previewProjectionAppliedEdits,
          playhead: currentTime,
          selection: selectedObjectIds,
          stagedEdits: previewProjectionStagedEdits,
        })
      : null;
  const activeProjectFragmentMaterials = nativeSceneActive
    ? (nativeProjectState?.fragmentMaterials ?? EMPTY_PROJECT_FRAGMENT_MATERIAL_STATE_V1)
    : activeProjectId
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
    () => projectFragmentMaterialsForSceneV1(activeProjectFragmentMaterials, activeEditorScene?.sceneId ?? null),
    [activeProjectFragmentMaterials, activeEditorScene?.sceneId],
  );
  const nativePreviewIdentity = useMemo<StudioNativePreviewSceneIdentityV1 | null>(
    () =>
      nativeSceneActive && activeProjectId && activeEditorScene && isStudioNativeWorkspaceScene(activeEditorScene)
        ? {
            documentKey: activeEditorScene.identity.documentKey,
            origin: "studio-native",
            projectId: activeProjectId,
            sceneId: activeEditorScene.sceneId,
          }
        : null,
    [activeEditorScene, activeProjectId, nativeSceneActive],
  );
  const nativePreviewContext = useMemo<StudioNativePreviewEditingContextV1 | null>(
    () =>
      nativePreviewIdentity && activeEditorScene
        ? {
            ...nativePreviewIdentity,
            sourceDuration: activeEditorScene.runtimeSceneState.duration,
            workingRevision: editorRevision.workingRevision,
          }
        : null,
    [activeEditorScene, editorRevision.workingRevision, nativePreviewIdentity],
  );
  const nativePreviewBundle = nativeProjectState?.bundle ?? null;
  const nativePreviewAssetPayloads = nativeProjectState?.assetPayloads ?? null;
  const nativePreviewProjectId = nativeProjectState?.projectId ?? null;
  const nativePreviewDocumentKey = nativeProjectState?.documentKey ?? null;
  const nativePreviewProvider = useMemo(() => {
    if (
      !nativePreviewIdentity ||
      !nativePreviewBundle ||
      !nativePreviewAssetPayloads ||
      nativePreviewProjectId !== nativePreviewIdentity.projectId ||
      nativePreviewDocumentKey !== nativePreviewIdentity.documentKey
    )
      return null;
    return createStudioNativePreviewSnapshotProviderV1({
      assetPayloads: nativePreviewAssetPayloads,
      bundle: nativePreviewBundle,
      identity: nativePreviewIdentity,
    });
  }, [
    nativePreviewAssetPayloads,
    nativePreviewBundle,
    nativePreviewDocumentKey,
    nativePreviewIdentity,
    nativePreviewProjectId,
  ]);
  const {
    activate: activatePreviewAuthority,
    activationAllowed: previewActivationAllowed,
    awaitingConsent: previewAwaitingConsent,
    providerPending: previewProviderPending,
    renderer: previewRenderer,
    retry: retryPreviewAuthority,
  } = useStudioPreviewAuthorityController({
    context: editorDocumentPresentationReady ? (nativePreviewContext ?? editorRevision.previewContext) : null,
    frame: workspace?.frame ?? { height: 8, width: 14.222 },
    nativeProvider: nativePreviewProvider,
    playbackClock,
    sceneFragmentMaterials: activeSceneFragmentMaterials,
    retainedSourceDuration: nativePreviewContext?.sourceDuration ?? editorRevision.retainedSourceDuration,
    sampleTime: currentTime,
    sceneBoundaryActive: importedSceneBoundaryActive,
    sourceEvents: projectedEditorScene?.runtimeSceneState.eventTrack.events ?? [],
    workingState: previewWorkingState,
  });
  const studioExportSource = previewRenderer?.canonicalScene ?? null;
  const studioImageAssets = studioNativeImageAssetsV1(studioExportSource);
  const studioSvgAssets = nativeProjectState?.svgAssets ?? [];
  const studioSvgPathFillState = (program: SceneEdit, entityId: string): boolean | null => {
    const create = program.operations.find(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
    );
    if (!create || create.kind !== "CreateEntity" || create.entity.type !== "SvgPath" || !create.entity.svg)
      return null;
    return studioSvgAssets.find((asset) => asset.source === create.entity.svg?.source)?.hasFill ?? null;
  };
  const activeFragmentMaterialTextureAssets = studioExportSource?.bundle.assets.assets ?? [];
  const studioExportPublication = resolveStudioExportPublicationAvailabilityV1({
    exportSource: studioExportSource,
    lineage: editorDocumentAuthority.exportLineage,
    organizationId: accountSession?.activeOrganization.id ?? null,
  });

  async function importNativeProjectImageFiles(files: readonly File[]) {
    if (
      !activeProjectId ||
      !activeEditorScene ||
      !isStudioNativeWorkspaceScene(activeEditorScene) ||
      !nativeProjectState ||
      nativeProjectState.projectId !== activeProjectId ||
      nativeProjectState.documentKey !== activeEditorScene.identity.documentKey ||
      nativeProjectAssetPending ||
      files.length === 0
    )
      return;
    const generation = nativeProjectAssetGeneration.current;
    const projectId = activeProjectId;
    const documentKey = activeEditorScene.identity.documentKey;
    setNativeProjectAssetPending(true);
    setNativeProjectAssetError(null);
    setNativeProjectAssetErrorKind(null);
    try {
      let result: NativeProjectAssetStateV1 = nativeProjectState;
      for (const file of files) {
        result = await ingestNativeProjectPngV1({
          source: { file, kind: "file" },
          state: result,
        });
      }
      if (nativeProjectAssetGeneration.current !== generation) return;
      const stateKey = tabLocalNativeProjectKey(projectId, documentKey);
      const retained = nativeProjectStates.current.get(stateKey);
      const updated = {
        assetPayloads: result.assetPayloads,
        bundle: result.bundle,
        documentKey,
        fragmentMaterials: retained?.fragmentMaterials ?? nativeProjectState.fragmentMaterials,
        projectId,
        svgAssets: retained?.svgAssets ?? nativeProjectState.svgAssets,
      };
      await nativeProjectLocalStore?.save({ documentKey, projectId }, updated);
      if (nativeProjectAssetGeneration.current !== generation) return;
      nativeProjectStates.current.set(stateKey, updated);
      setNativeProjectState(updated);
    } catch (cause) {
      if (nativeProjectAssetGeneration.current !== generation) return;
      setNativeProjectAssetErrorKind("image");
      setNativeProjectAssetError(cause instanceof Error ? cause.message : "Studio could not import the selected PNGs.");
    } finally {
      if (nativeProjectAssetGeneration.current === generation) setNativeProjectAssetPending(false);
    }
  }

  async function importNativeProjectSvgFiles(files: readonly File[]) {
    if (
      !activeProjectId ||
      !activeEditorScene ||
      !isStudioNativeWorkspaceScene(activeEditorScene) ||
      !nativeProjectState ||
      nativeProjectState.projectId !== activeProjectId ||
      nativeProjectState.documentKey !== activeEditorScene.identity.documentKey ||
      nativeProjectAssetPending ||
      files.length === 0
    )
      return;
    const generation = nativeProjectAssetGeneration.current;
    const projectId = activeProjectId;
    const documentKey = activeEditorScene.identity.documentKey;
    setNativeProjectAssetPending(true);
    setNativeProjectAssetError(null);
    setNativeProjectAssetErrorKind(null);
    try {
      const imported: StudioSvgPathAsset[] = [];
      for (const file of files) imported.push(await importStudioSvgPathAsset(file));
      if (nativeProjectAssetGeneration.current !== generation) return;
      const stateKey = tabLocalNativeProjectKey(projectId, documentKey);
      const retained = nativeProjectStates.current.get(stateKey) ?? nativeProjectState;
      const updated = { ...retained, svgAssets: [...retained.svgAssets, ...imported] };
      await nativeProjectLocalStore?.save({ documentKey, projectId }, updated);
      if (nativeProjectAssetGeneration.current !== generation) return;
      nativeProjectStates.current.set(stateKey, updated);
      setNativeProjectState(updated);
    } catch (cause) {
      if (nativeProjectAssetGeneration.current !== generation) return;
      setNativeProjectAssetErrorKind("svg");
      setNativeProjectAssetError(cause instanceof Error ? cause.message : "Studio could not import the selected SVGs.");
    } finally {
      if (nativeProjectAssetGeneration.current === generation) setNativeProjectAssetPending(false);
    }
  }

  function programBatchIsExact(left: readonly SceneEdit[], right: readonly SceneEdit[]) {
    return left.length === right.length && left.every((program, index) => program === right[index]);
  }
  function exactTimelineProjectionForPrograms(programs: readonly SceneEdit[]) {
    const fullPrograms = previewEditRecords.map((record) => record.program);
    if (programBatchIsExact(programs, fullPrograms)) return previewRenderer?.timelineProjection;
    const appliedPrograms = previewProjectionAppliedEdits.map((record) => record.program);
    if (programBatchIsExact(programs, appliedPrograms)) return previewRenderer?.appliedTimelineProjection;
    // Historical Program editing still starts synchronously before an exact
    // applied-prefix preview can be requested. Use the correlated full Rust
    // projection only for that bootstrap path.
    return previewRenderer?.timelineProjection;
  }
  function timelineProjectionForPrograms(programs: readonly SceneEdit[]) {
    const durationPrograms = programs.filter((program) => program.operations.some(isSceneDurationOperation));
    if (durationPrograms.length === 0) return null;
    if (!projectedEditorScene) return undefined;
    try {
      if (programs.some((program) => program.operations.some(isStudioNativeAuthoringBatchOperation))) {
        const creationProjection = creationProjectionForPrograms(programs);
        return creationProjection === undefined ? undefined : creationProjection?.timelineProjection;
      }
      if (!isSceneDurationProgramBatch(programs)) return undefined;
      const exactProjection = exactTimelineProjectionForPrograms(programs);
      if (!exactProjection) return undefined;
      return selectTimelineProgramBatchProjection(
        projectedEditorScene.runtimeSceneState.duration,
        programs,
        exactProjection,
      ).projection;
    } catch {
      // A previous asynchronous preview result must never authorize the
      // current Program batch. The renderer will replace it for this revision.
      return undefined;
    }
  }
  function creationProjectionForPrograms(programs: readonly SceneEdit[]) {
    if (!programs.some((program) => program.operations.some(isStudioNativeAuthoringBatchOperation))) return null;
    if (!projectedEditorScene || !previewRenderer) return undefined;
    try {
      const fullPrograms = previewEditRecords.map((record) => record.program);
      const appliedPrograms = previewProjectionAppliedEdits.map((record) => record.program);
      if (programBatchIsExact(programs, fullPrograms)) {
        return selectCreationProjection(
          projectedEditorScene.runtimeSceneState.duration,
          programs,
          previewRenderer.creationProjection,
        );
      }
      if (programBatchIsExact(programs, appliedPrograms)) {
        return selectCreationProjection(
          projectedEditorScene.runtimeSceneState.duration,
          programs,
          previewRenderer.appliedCreationProjection,
        );
      }
      return selectHistoricalCreationProjectionPrefix(
        projectedEditorScene.runtimeSceneState.duration,
        programs,
        fullPrograms,
        previewRenderer.creationProjection,
      );
    } catch {
      return undefined;
    }
  }
  function timelineTransformsForPrograms(programs: readonly SceneEdit[]) {
    const creationProjection = creationProjectionForPrograms(programs);
    if (creationProjection === undefined) return undefined;
    if (creationProjection) {
      return creationProjection.insertions.map((insertion, index) => ({
        interval: { end: insertion.at + insertion.duration, start: insertion.at },
        kind: "insert" as const,
        operationId: `creation-insertion-${index}`,
      }));
    }
    const timelineProjection = timelineProjectionForPrograms(programs);
    return timelineProjection === undefined ? undefined : (timelineProjection?.transforms ?? null);
  }
  function timelineProjectionForRecords(records: readonly ProgramRecord[]) {
    return timelineProjectionForPrograms(records.map((record) => record.program));
  }
  function persistentRemoveProjectionForPrograms(programs: readonly SceneEdit[]) {
    if (programs.some((program) => program.operations.some(isStudioNativeAuthoringBatchOperation))) return null;
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
    if (!projectedEditorScene || !previewRenderer?.mathTexTransformProjection) return undefined;
    try {
      return selectMathTexTransformProjection(
        projectedEditorScene.runtimeSceneState.duration,
        programs,
        previewRenderer.mathTexTransformProjection,
      );
    } catch {
      return undefined;
    }
  }
  function creationProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    if (!programs.some((program) => program.operations.some(isStudioNativeAuthoringBatchOperation))) return null;
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "rust-authorized-batch") return null;
    return creationProjectionForPrograms(programs);
  }
  function motionProjectionForRecords(records: readonly ProgramRecord[]) {
    const programs = records.map((record) => record.program);
    if (programs.some((program) => program.operations.some(isStudioNativeAuthoringBatchOperation))) return null;
    if (!programs.some((program) => program.operations.some(({ kind }) => kind === "CreateMotion"))) return null;
    const authority = workspaceEditAuthorityForRecords(records);
    if (authority === undefined) return undefined;
    if (authority !== "rust-authorized-batch" && authority !== "static-imported-root") return null;
    if (!projectedEditorScene || !previewRenderer?.motionProjection) return undefined;
    try {
      return selectMotionProjection(
        projectedEditorScene.runtimeSceneState.duration,
        programs,
        previewRenderer.motionProjection,
      );
    } catch {
      return undefined;
    }
  }
  function sourceTimeToWorkingTime(programs: readonly SceneEdit[], sourceTime: number) {
    const transforms = timelineTransformsForPrograms(programs);
    if (transforms === undefined) {
      throw new Error("Wait for the Rust timeline projection before resolving this source timestamp.");
    }
    return transforms
      ? sourceTimeToWorkingTimeFromProjection(transforms, sourceTime)
      : sourceTimeToWorkingTimeWithoutTimeline(programs, sourceTime);
  }
  function workingTimeToSourceTime(programs: readonly SceneEdit[], workingTime: number) {
    const transforms = timelineTransformsForPrograms(programs);
    if (transforms === undefined) {
      throw new Error("Wait for the Rust timeline projection before resolving this working timestamp.");
    }
    return transforms
      ? workingTimeToSourceTimeFromProjection(transforms, workingTime)
      : workingTimeToSourceTimeWithoutTimeline(programs, workingTime);
  }
  function projectRuntimeSceneToSourceTimeline(scene: RuntimeSceneState, programs: readonly SceneEdit[]) {
    const transforms = timelineTransformsForPrograms(programs);
    if (transforms === undefined) {
      throw new Error("Wait for the Rust timeline projection before mapping this Scene to source time.");
    }
    return projectRuntimeSceneToSourceTimelineWithProjection(
      scene,
      programs,
      transforms ? { programProjections: [], projectedDuration: scene.duration, transforms } : null,
    );
  }
  const previewEditRecords = [...previewAppliedEdits, ...(editingAppliedProgram || !draftEdit ? [] : [draftEdit])];
  const latestPreviewEditPrograms = useRef<readonly SceneEdit[]>([]);
  latestPreviewEditPrograms.current = previewEditRecords.map(({ program }) => program);
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
  const sceneBackgroundColor =
    workspaceCreationProjection?.mutations
      .filter(
        (
          mutation,
        ): mutation is Extract<(typeof workspaceCreationProjection.mutations)[number], { kind: "scene-background" }> =>
          mutation.kind === "scene-background",
      )
      .at(-1)?.value ?? "#000000";
  const workspaceEntityCreationProjection = workspaceCreationProjection
    ? {
        ...workspaceCreationProjection,
        mutations: workspaceCreationProjection.mutations.filter(
          (
            mutation,
          ): mutation is Extract<(typeof workspaceCreationProjection.mutations)[number], { entityId: string }> =>
            "entityId" in mutation,
        ),
      }
    : workspaceCreationProjection;
  const workspaceMathTexTransformProjection = mathTexTransformProjectionForRecords(previewEditRecords);
  const workspaceMotionProjection = motionProjectionForRecords(previewEditRecords);
  const workspacePersistentRemoveProjection = persistentRemoveProjectionForRecords(previewEditRecords);
  const workspaceEditAuthority = workspaceEditAuthorityForRecords(previewEditRecords);
  const workspaceStaticRootProjection = staticRootProjectionForRecords(previewEditRecords);
  const workspaceProjection =
    editorDocumentPresentationReady &&
    projectedEditorScene &&
    workspaceBoundEntityProjection !== undefined &&
    workspaceCreationProjection !== undefined &&
    workspaceTimelineProjection !== undefined &&
    workspaceMathTexTransformProjection !== undefined &&
    workspaceMotionProjection !== undefined &&
    workspacePersistentRemoveProjection !== undefined &&
    workspaceEditAuthority !== undefined &&
    workspaceStaticRootProjection !== undefined
      ? projectStudioWorkspace({
          activeScene: projectedEditorScene,
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
  const appliedCreationProjection = creationProjectionForPrograms(previewAppliedSceneEdits);
  const appliedTimelineProjection = timelineProjectionForPrograms(previewAppliedSceneEdits);
  const appliedTimelineTransforms = timelineTransformsForPrograms(previewAppliedSceneEdits);
  const sourceCurrentTime =
    appliedTimelineTransforms === undefined
      ? currentTime
      : appliedTimelineTransforms
        ? workingTimeToSourceTimeFromProjection(appliedTimelineTransforms, currentTime)
        : workingTimeToSourceTimeWithoutTimeline(previewAppliedSceneEdits, currentTime);
  const timelineAnchors =
    activeEditorScene?.anchors.map((sourceTime) => ({
      sourceTime,
      workingTime:
        appliedTimelineTransforms === undefined
          ? sourceTime
          : appliedTimelineTransforms
            ? sourceTimeToWorkingTimeFromProjection(appliedTimelineTransforms, sourceTime)
            : sourceTimeToWorkingTimeWithoutTimeline(previewAppliedSceneEdits, sourceTime),
    })) ?? [];
  const canonicalGroupedChildIds = new Set(
    previewRenderer?.canonicalScene?.bundle.scene.entities.flatMap(({ id, parentId }) => (parentId ? [id] : [])) ?? [],
  );
  const drawInAvailability = new Map(
    (workspaceProjection?.projection.timeline.objectTracks ?? []).map(({ entityId }) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
      );
      const hasExternalFillOrMaterial = previewAppliedEdits.some(({ program }) =>
        program.operations.some(
          (operation) =>
            "entityId" in operation &&
            operation.entityId === entityId &&
            ((operation.kind === "SetProperty" && operation.key === "fillColor") ||
              (operation.kind === "AnimateProperty" && operation.materialParameter !== undefined)),
        ),
      );
      const reason = !owner
        ? "Draw supports only Studio-created objects."
        : draftEdit && editingAppliedProgram?.original.program.transactionId !== owner.program.transactionId
          ? "Apply or discard the current draft before adding Draw."
          : canonicalGroupedChildIds.has(entityId)
            ? "Draw currently supports only ungrouped root objects."
            : activeSceneFragmentMaterials.assignments[entityId]
              ? "Remove the object's fragment material before adding Draw."
              : hasExternalFillOrMaterial
                ? "Remove the object's fill or material animation before adding Draw."
                : drawInUnavailableReason(owner.program, entityId, {
                    svgHasFill: studioSvgPathFillState(owner.program, entityId),
                  });
      return [entityId, reason] as const;
    }),
  );
  const writeInAvailability = new Map(
    (workspaceProjection?.projection.timeline.objectTracks ?? []).map(({ entityId }) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
      );
      const hasExternalMaterialAnimation = previewAppliedEdits.some(({ program }) =>
        program.operations.some(
          (operation) =>
            "entityId" in operation &&
            operation.entityId === entityId &&
            operation.kind === "AnimateProperty" &&
            operation.materialParameter !== undefined,
        ),
      );
      const reason = !owner
        ? "Write supports only Studio-created objects."
        : draftEdit && editingAppliedProgram?.original.program.transactionId !== owner.program.transactionId
          ? "Apply or discard the current draft before adding Write."
          : canonicalGroupedChildIds.has(entityId)
            ? "Write currently supports only ungrouped root objects."
            : activeSceneFragmentMaterials.assignments[entityId]
              ? "Remove the object's fragment material before adding Write."
              : hasExternalMaterialAnimation
                ? "Remove the object's material animation before adding Write."
                : writeInUnavailableReason(owner.program, entityId);
      return [entityId, reason] as const;
    }),
  );
  const maximumStudioEntranceDuration = (
    record: ProgramRecord,
    sourceClip: Readonly<{
      entityId: string;
      interval: Readonly<{ end: number; start: number }>;
      operationId: string;
    }>,
    mutation: Readonly<{ interval: Readonly<{ end: number; start: number }> }>,
  ) => {
    if (!workspaceCreationProjection) return 0.1;
    const created = workspaceCreationProjection.entities.find(({ entityId }) => entityId === sourceClip.entityId);
    const sourceCreated = record.program.operations.find(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === sourceClip.entityId,
    );
    const sourceLifetimeEnd =
      sourceCreated?.kind === "CreateEntity"
        ? (sourceCreated.entity.lifetime.end ?? projectedEditorScene?.runtimeSceneState.duration)
        : projectedEditorScene?.runtimeSceneState.duration;
    const maximumEnds = [
      ...workspaceCreationProjection.mutations.flatMap((candidate) =>
        "entityId" in candidate &&
        candidate.entityId === sourceClip.entityId &&
        candidate.operationId !== sourceClip.operationId &&
        candidate.interval.start > mutation.interval.start + 0.0005
          ? [candidate.interval.start - (candidate.kind.endsWith("keyframes") ? 0.001 : 0)]
          : [],
      ),
      ...workspaceCreationProjection.motions.flatMap((candidate) =>
        candidate.targetEntityId === sourceClip.entityId && candidate.interval.start > mutation.interval.start + 0.0005
          ? [candidate.interval.start]
          : [],
      ),
      ...workspaceCreationProjection.removals.flatMap((candidate) =>
        candidate.studioEntityId === sourceClip.entityId && candidate.removedAt > mutation.interval.start + 0.0005
          ? [candidate.fadeInterval?.start ?? candidate.removedAt]
          : [],
      ),
    ];
    return Math.max(
      0.1,
      Math.min(
        sourceLifetimeEnd !== undefined ? sourceLifetimeEnd - sourceClip.interval.start : Number.POSITIVE_INFINITY,
        (workspaceProjection?.proposedState.evaluatedScene.duration ??
          projectedEditorScene?.runtimeSceneState.duration ??
          mutation.interval.start + 0.1) - mutation.interval.start,
        created ? created.createdLifetime.end - mutation.interval.start : Number.POSITIVE_INFINITY,
        ...maximumEnds.map((end) => end - mutation.interval.start),
      ),
    );
  };
  const drawInClips: readonly StudioDrawInTimelineClip[] = previewAppliedEdits.flatMap((record) => {
    const sourceClip = drawInClipFromProgram(record.program);
    if (!sourceClip || !workspaceCreationProjection) return [];
    const mutation = workspaceCreationProjection.mutations.find(
      (candidate) => candidate.kind === "draw-in" && candidate.operationId === sourceClip.operationId,
    );
    if (!mutation || mutation.kind !== "draw-in") return [];
    const activeDraftIsThisClip = editingAppliedProgram?.original.program.transactionId === sourceClip.transactionId;
    return [
      {
        ...sourceClip,
        interval: mutation.interval,
        label:
          workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === sourceClip.entityId)
            ?.label ?? sourceClip.entityId,
        maximumDuration: maximumStudioEntranceDuration(record, sourceClip, mutation),
        readOnlyReason:
          previewRenderer?.state.phase !== "presented"
            ? "Wait for the canonical WebGPU preview before editing Draw."
            : draftEdit && !activeDraftIsThisClip
              ? "Apply or discard the current draft before editing Draw."
              : null,
      },
    ];
  });
  const writeInClips: readonly StudioWriteInTimelineClip[] = previewAppliedEdits.flatMap((record) => {
    const sourceClip = writeInClipFromProgram(record.program);
    if (!sourceClip || !workspaceCreationProjection) return [];
    const mutation = workspaceCreationProjection.mutations.find(
      (candidate) => candidate.kind === "write-in" && candidate.operationId === sourceClip.operationId,
    );
    if (!mutation || mutation.kind !== "write-in") return [];
    const activeDraftIsThisClip = editingAppliedProgram?.original.program.transactionId === sourceClip.transactionId;
    return [
      {
        ...sourceClip,
        interval: mutation.interval,
        label:
          workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === sourceClip.entityId)
            ?.label ?? sourceClip.entityId,
        maximumDuration: maximumStudioEntranceDuration(record, sourceClip, mutation),
        readOnlyReason:
          previewRenderer?.state.phase !== "presented"
            ? "Wait for the canonical WebGPU preview before editing Write."
            : draftEdit && !activeDraftIsThisClip
              ? "Apply or discard the current draft before editing Write."
              : null,
      },
    ];
  });
  const mathTexTransformClips: readonly StudioMathTexTransformTimelineClip[] = previewAppliedEdits.flatMap((record) => {
    if (!workspaceCreationProjection) return [];
    const operation = record.program.operations.find((candidate) => candidate.kind === "TransformContent");
    if (!operation || operation.kind !== "TransformContent") return [];
    const mutation = workspaceCreationProjection.mutations.find(
      (candidate) => candidate.kind === "math-tex-transform" && candidate.operationId === operation.id,
    );
    if (!mutation || mutation.kind !== "math-tex-transform") return [];
    const sourceClip = mathTexTransformClipFromProgram(record.program, mutation.entityId);
    if (!sourceClip) return [];
    const createOperation = previewAppliedEdits
      .flatMap(({ program }) => program.operations)
      .find((candidate) => candidate.kind === "CreateEntity" && candidate.entity.id === mutation.entityId);
    const sourceLifetimeEnd =
      createOperation?.kind === "CreateEntity"
        ? (createOperation.entity.lifetime.end ?? projectedEditorScene?.runtimeSceneState.duration)
        : projectedEditorScene?.runtimeSceneState.duration;
    const activeDraftIsThisClip = editingAppliedProgram?.original.program.transactionId === sourceClip.transactionId;
    return [
      {
        easing: sourceClip.easing,
        entityId: mutation.entityId,
        interval: mutation.interval,
        label:
          workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === mutation.entityId)
            ?.label ?? mutation.entityId,
        maximumDuration: Math.max(0.1, (sourceLifetimeEnd ?? sourceClip.interval.end) - sourceClip.interval.start),
        operationId: sourceClip.operationId,
        readOnlyReason:
          previewRenderer?.state.phase !== "presented"
            ? "Wait for the canonical WebGPU preview before editing Transform."
            : draftEdit && !activeDraftIsThisClip
              ? "Apply or discard the current draft before editing Transform."
              : lockedEntityIdSet.has(mutation.entityId)
                ? LOCKED_ENTITY_MUTATION_MESSAGE
                : null,
        targetLabel: sourceClip.content.displayLines.join(" "),
        transactionId: sourceClip.transactionId,
      },
    ];
  });
  const shapeTransformClips: readonly StudioShapeTransformTimelineClip[] = previewAppliedEdits.flatMap((record) => {
    if (!workspaceCreationProjection) return [];
    const sourceClip = shapeTransformClipFromProgram(record.program);
    if (!sourceClip) return [];
    const mutation = workspaceCreationProjection.mutations.find(
      (candidate) => candidate.kind === "shape-transform" && candidate.operationId === sourceClip.operationId,
    );
    if (!mutation || mutation.kind !== "shape-transform") return [];
    const createOperation = previewAppliedEdits
      .flatMap(({ program }) => program.operations)
      .find((candidate) => candidate.kind === "CreateEntity" && candidate.entity.id === mutation.entityId);
    const sourceLifetimeEnd =
      createOperation?.kind === "CreateEntity"
        ? (createOperation.entity.lifetime.end ?? projectedEditorScene?.runtimeSceneState.duration)
        : projectedEditorScene?.runtimeSceneState.duration;
    const nextTransformStart = previewAppliedEdits
      .flatMap(({ program }) => {
        const candidate = shapeTransformClipFromProgram(program);
        return candidate?.entityId === mutation.entityId &&
          candidate.interval.start > sourceClip.interval.start + 0.0005
          ? [candidate.interval.start]
          : [];
      })
      .reduce((earliest, start) => Math.min(earliest, start), Number.POSITIVE_INFINITY);
    const maximumEnd = Math.min(sourceLifetimeEnd ?? sourceClip.interval.end, nextTransformStart);
    const activeDraftIsThisClip = editingAppliedProgram?.original.program.transactionId === sourceClip.transactionId;
    return [
      {
        easing: sourceClip.easing,
        entityId: mutation.entityId,
        interval: mutation.interval,
        label:
          workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === mutation.entityId)
            ?.label ?? mutation.entityId,
        maximumDuration: Math.max(0.1, maximumEnd - sourceClip.interval.start),
        operationId: sourceClip.operationId,
        readOnlyReason:
          previewRenderer?.state.phase !== "presented"
            ? "Wait for the canonical WebGPU preview before editing Shape Transform."
            : draftEdit && !activeDraftIsThisClip
              ? "Apply or discard the current draft before editing Shape Transform."
              : lockedEntityIdSet.has(mutation.entityId)
                ? LOCKED_ENTITY_MUTATION_MESSAGE
                : null,
        targetShape: sourceClip.to.shape,
        transactionId: sourceClip.transactionId,
      },
    ];
  });
  const cameraClips: readonly StudioCameraTimelineClip[] = previewAppliedEdits.flatMap((record) => {
    if (!workspaceCreationProjection) return [];
    const sourceClip = cameraClipFromProgram(record.program);
    if (!sourceClip) return [];
    const mutation = workspaceCreationProjection.mutations.find(
      (candidate) => candidate.kind === "animate-camera" && candidate.operationId === sourceClip.operationId,
    );
    if (!mutation || mutation.kind !== "animate-camera") return [];
    const nextSourceStart = previewAppliedEdits
      .flatMap(({ program }) => {
        const candidate = cameraClipFromProgram(program);
        return candidate && candidate.interval.start > sourceClip.interval.start + 0.0005
          ? [candidate.interval.start]
          : [];
      })
      .reduce((earliest, start) => Math.min(earliest, start), Number.POSITIVE_INFINITY);
    const maximumEnd = Math.min(
      projectedEditorScene?.runtimeSceneState.duration ?? sourceClip.interval.end,
      nextSourceStart,
    );
    const activeDraftIsThisClip = editingAppliedProgram?.original.program.transactionId === sourceClip.transactionId;
    return [
      {
        easing: sourceClip.easing,
        from: sourceClip.from,
        interval: mutation.interval,
        maximumDuration: Math.max(0.1, maximumEnd - sourceClip.interval.start),
        operationId: sourceClip.operationId,
        readOnlyReason:
          previewRenderer?.state.phase !== "presented"
            ? "Wait for the canonical WebGPU preview before editing Camera."
            : draftEdit && !activeDraftIsThisClip
              ? "Apply or discard the current draft before editing Camera."
              : null,
        to: sourceClip.to,
        transactionId: sourceClip.transactionId,
      },
    ];
  });
  const opacityTrackEligibleIds = new Set(
    workspaceCreationProjection?.entities.flatMap(({ entityId, transactionId }) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
      );
      const existingTrack = owner ? opacityKeyframeTrackFromProgram(owner.program, 0) : null;
      const ownerIsApplied = owner !== undefined;
      const draftAllowsOwner = !draftEdit || editingAppliedProgram?.original.program.transactionId === transactionId;
      const hasCompetingAppearanceOrRemoval = previewAppliedEdits.some(({ program }) =>
        program.operations.some(
          (operation) =>
            "entityId" in operation &&
            operation.entityId === entityId &&
            ((operation.kind === "SetProperty" && operation.key === "appearance") ||
              (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent)),
        ),
      );
      const sharedProgramAllowsEntity = !existingTrack || existingTrack.entityId === entityId;
      return ownerIsApplied && draftAllowsOwner && !hasCompetingAppearanceOrRemoval && sharedProgramAllowsEntity
        ? [entityId]
        : [];
    }) ?? [],
  );
  const opacityTracks: readonly StudioOpacityTimelineTrack[] = previewAppliedEdits.flatMap((record, programIndex) => {
    const track = opacityKeyframeTrackFromProgram(record.program, programIndex);
    if (!track || !workspaceCreationProjection) return [];
    const operations = record.program.operations.filter(
      (operation) =>
        operation.kind === "AnimateProperty" &&
        operation.key === "appearance" &&
        operation.materialParameter === undefined &&
        operation.entityId === track.entityId,
    );
    const mutations = operations.map((operation) =>
      workspaceCreationProjection.mutations.find(
        (mutation) => mutation.kind === "opacity-keyframes" && mutation.operationId === operation.id,
      ),
    );
    if (mutations.some((mutation) => !mutation)) return [];
    const projectedMutations = mutations as readonly Extract<
      (typeof workspaceCreationProjection.mutations)[number],
      { kind: "opacity-keyframes" }
    >[];
    const workingTimes =
      projectedMutations.length === 1 &&
      Math.abs(projectedMutations[0]!.interval.end - projectedMutations[0]!.interval.start) < 0.0005
        ? [projectedMutations[0]!.interval.start]
        : [projectedMutations[0]!.interval.start, ...projectedMutations.map(({ interval }) => interval.end)];
    if (workingTimes.length !== track.keyframes.length) return [];
    const label =
      workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === track.entityId)
        ?.label ?? track.entityId;
    const activeDraftIsThisTrack = editingAppliedProgram?.original.program.transactionId === track.transactionId;
    return [
      {
        entityId: track.entityId,
        keyframes: track.keyframes.map((keyframe, index) => ({
          ...keyframe,
          sourceTime: keyframe.time,
          time: workingTimes[index]!,
        })),
        label,
        programIndex,
        readOnlyReason:
          draftEdit && !activeDraftIsThisTrack ? "Apply or discard the current draft before editing opacity." : null,
        transactionId: track.transactionId,
      },
    ];
  });
  const paintColorTrackEligibleProperties = new Map<string, PaintColorProperty>(
    workspaceCreationProjection?.entities.flatMap((projectedEntity) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some(
          (operation) => operation.kind === "CreateEntity" && operation.entity.id === projectedEntity.entityId,
        ),
      );
      const targetCreate = owner?.program.operations.find(
        (operation) => operation.kind === "CreateEntity" && operation.entity.id === projectedEntity.entityId,
      );
      if (!owner || !targetCreate || targetCreate.kind !== "CreateEntity") return [];
      const property = studioPaintColorTrackProperty(targetCreate.entity.type);
      if (!property || projectedEntity[property] === undefined) return [];
      const existingTrack = paintColorKeyframeTrackFromProgram(owner.program, 0);
      const draftAllowsOwner =
        !draftEdit || editingAppliedProgram?.original.program.transactionId === projectedEntity.transactionId;
      const hasMaterialOrEntranceConflict =
        activeSceneFragmentMaterials.assignments[projectedEntity.entityId] !== undefined ||
        previewAppliedEdits.some(({ program }) =>
          program.operations.some(
            (operation) =>
              "entityId" in operation &&
              operation.entityId === projectedEntity.entityId &&
              ((operation.kind === "AnimateProperty" && operation.materialParameter !== undefined) ||
                operation.kind === "WriteIn" ||
                (property === "fillColor" && operation.kind === "DrawIn") ||
                (operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent)),
          ),
        );
      const sharedProgramAllowsEntity =
        !existingTrack || (existingTrack.entityId === projectedEntity.entityId && existingTrack.property === property);
      return draftAllowsOwner &&
        !hasMaterialOrEntranceConflict &&
        sharedProgramAllowsEntity &&
        !canonicalGroupedChildIds.has(projectedEntity.entityId)
        ? ([[projectedEntity.entityId, property]] as const)
        : [];
    }) ?? [],
  );
  const paintColorTracks: readonly StudioPaintColorTimelineTrack[] = previewAppliedEdits.flatMap(
    (record, programIndex) => {
      const track = paintColorKeyframeTrackFromProgram(record.program, programIndex);
      if (!track || !workspaceCreationProjection) return [];
      const operations = record.program.operations.filter(
        (operation) =>
          operation.kind === "AnimateProperty" &&
          operation.key === track.property &&
          operation.timelineTrack === true &&
          operation.entityId === track.entityId,
      );
      const projectedProperty = track.property === "fillColor" ? "fill-color" : "stroke-color";
      const mutations = operations.map((operation) =>
        workspaceCreationProjection.mutations.find(
          (mutation) =>
            mutation.kind === "paint-color-keyframes" &&
            mutation.property === projectedProperty &&
            mutation.operationId === operation.id,
        ),
      );
      if (mutations.some((mutation) => !mutation)) return [];
      const projectedMutations = mutations as readonly Extract<
        (typeof workspaceCreationProjection.mutations)[number],
        { kind: "paint-color-keyframes" }
      >[];
      const first = projectedMutations[0];
      if (!first) return [];
      const workingTimes = [first.interval.start, ...projectedMutations.map(({ interval }) => interval.end)];
      if (workingTimes.length !== track.keyframes.length) return [];
      const label =
        workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === track.entityId)
          ?.label ?? track.entityId;
      const activeDraftIsThisTrack = editingAppliedProgram?.original.program.transactionId === track.transactionId;
      return [
        {
          entityId: track.entityId,
          keyframes: track.keyframes.map((keyframe, index) => ({
            ...keyframe,
            sourceTime: keyframe.time,
            time: workingTimes[index]!,
          })),
          label,
          programIndex,
          property: track.property,
          readOnlyReason:
            draftEdit && !activeDraftIsThisTrack
              ? "Apply or discard the current draft before editing paint color."
              : null,
          transactionId: track.transactionId,
        },
      ];
    },
  );
  const scaleTrackEligibleIds = new Set(
    workspaceCreationProjection?.entities.flatMap(({ entityId, transactionId }) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
      );
      if (!owner) return [];
      const existingTrack = scaleKeyframeTrackFromProgram(owner.program, 0);
      const draftAllowsOwner = !draftEdit || editingAppliedProgram?.original.program.transactionId === transactionId;
      const hasCompetingTransform = previewAppliedEdits.some(({ program }) =>
        program.operations.some((operation) => {
          if (operation.kind === "CreateMotion") return operation.targetEntityIds.includes(entityId);
          if (!("entityId" in operation) || operation.entityId !== entityId) return false;
          if (operation.kind === "ResizeEntity") return true;
          if (operation.kind === "AnimateProperty") {
            return operation.key === "rotation" || (operation.key === "scale" && operation.timelineTrack !== true);
          }
          return (
            operation.kind === "SetProperty" &&
            operation.key === "position" &&
            program.transactionId !== owner.program.transactionId
          );
        }),
      );
      const sharedProgramAllowsEntity = !existingTrack || existingTrack.entityId === entityId;
      return draftAllowsOwner && !hasCompetingTransform && sharedProgramAllowsEntity ? [entityId] : [];
    }) ?? [],
  );
  const scaleTracks: readonly StudioScaleTimelineTrack[] = previewAppliedEdits.flatMap((record, programIndex) => {
    const track = scaleKeyframeTrackFromProgram(record.program, programIndex);
    if (!track || !workspaceCreationProjection) return [];
    const operations = record.program.operations.filter(
      (operation) =>
        operation.kind === "AnimateProperty" &&
        operation.key === "scale" &&
        operation.timelineTrack === true &&
        operation.entityId === track.entityId,
    );
    const mutations = operations.map((operation) =>
      workspaceCreationProjection.mutations.find(
        (mutation) => mutation.kind === "uniform-scale" && mutation.operationId === operation.id,
      ),
    );
    if (mutations.some((mutation) => !mutation)) return [];
    const projectedMutations = mutations as readonly Extract<
      (typeof workspaceCreationProjection.mutations)[number],
      { kind: "uniform-scale" }
    >[];
    const workingTimes =
      projectedMutations.length === 1 &&
      Math.abs(projectedMutations[0]!.interval.end - projectedMutations[0]!.interval.start) < 0.0005
        ? [projectedMutations[0]!.interval.start]
        : [projectedMutations[0]!.interval.start, ...projectedMutations.map(({ interval }) => interval.end)];
    if (workingTimes.length !== track.keyframes.length) return [];
    const label =
      workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === track.entityId)
        ?.label ?? track.entityId;
    const activeDraftIsThisTrack = editingAppliedProgram?.original.program.transactionId === track.transactionId;
    return [
      {
        entityId: track.entityId,
        keyframes: track.keyframes.map((keyframe, index) => ({
          ...keyframe,
          sourceTime: keyframe.time,
          time: workingTimes[index]!,
        })),
        label,
        programIndex,
        readOnlyReason:
          draftEdit && !activeDraftIsThisTrack ? "Apply or discard the current draft before editing scale." : null,
        transactionId: track.transactionId,
      },
    ];
  });
  const rotationTrackEligibleIds = new Set(
    workspaceCreationProjection?.entities.flatMap(({ entityId, transactionId }) => {
      const owner = previewAppliedEdits.find(({ program }) =>
        program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
      );
      if (!owner) return [];
      const existingTrack = rotationKeyframeTrackFromProgram(owner.program, 0);
      const draftAllowsOwner = !draftEdit || editingAppliedProgram?.original.program.transactionId === transactionId;
      const hasCompetingTransform = previewAppliedEdits.some(({ program }) =>
        program.operations.some((operation) => {
          if (operation.kind === "CreateMotion") return operation.targetEntityIds.includes(entityId);
          if (!("entityId" in operation) || operation.entityId !== entityId) return false;
          if (operation.kind === "ResizeEntity") return true;
          if (operation.kind === "AnimateProperty") {
            return operation.key === "scale" || (operation.key === "rotation" && operation.timelineTrack !== true);
          }
          return (
            operation.kind === "SetProperty" &&
            operation.key === "position" &&
            program.transactionId !== owner.program.transactionId
          );
        }),
      );
      const sharedProgramAllowsEntity = !existingTrack || existingTrack.entityId === entityId;
      return draftAllowsOwner &&
        !hasCompetingTransform &&
        sharedProgramAllowsEntity &&
        !canonicalGroupedChildIds.has(entityId)
        ? [entityId]
        : [];
    }) ?? [],
  );
  const rotationTracks: readonly StudioRotationTimelineTrack[] = previewAppliedEdits.flatMap((record, programIndex) => {
    const track = rotationKeyframeTrackFromProgram(record.program, programIndex);
    if (!track || !workspaceCreationProjection) return [];
    const operations = record.program.operations.filter(
      (operation) =>
        operation.kind === "AnimateProperty" &&
        operation.key === "rotation" &&
        operation.timelineTrack === true &&
        operation.entityId === track.entityId,
    );
    const mutations = operations.map((operation) =>
      workspaceCreationProjection.mutations.find(
        (mutation) => mutation.kind === "rotation" && mutation.operationId === operation.id,
      ),
    );
    if (mutations.some((mutation) => !mutation)) return [];
    const projectedMutations = mutations as readonly Extract<
      (typeof workspaceCreationProjection.mutations)[number],
      { kind: "rotation" }
    >[];
    const workingTimes =
      projectedMutations.length === 1 &&
      Math.abs(projectedMutations[0]!.interval.end - projectedMutations[0]!.interval.start) < 0.0005
        ? [projectedMutations[0]!.interval.start]
        : [projectedMutations[0]!.interval.start, ...projectedMutations.map(({ interval }) => interval.end)];
    if (workingTimes.length !== track.keyframes.length) return [];
    const label =
      workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === track.entityId)
        ?.label ?? track.entityId;
    const activeDraftIsThisTrack = editingAppliedProgram?.original.program.transactionId === track.transactionId;
    return [
      {
        entityId: track.entityId,
        keyframes: track.keyframes.map((keyframe, index) => ({
          ...keyframe,
          sourceTime: keyframe.time,
          time: workingTimes[index]!,
          value: (keyframe.value * 180) / Math.PI,
        })),
        label,
        programIndex,
        readOnlyReason:
          draftEdit && !activeDraftIsThisTrack ? "Apply or discard the current draft before editing rotation." : null,
        transactionId: track.transactionId,
      },
    ];
  });
  const transformTrackPrograms = previewAppliedEdits.map(({ program }) => program);
  const materialParameterOptions: readonly StudioMaterialParameterTimelineOption[] = workspaceCreationProjection
    ? Object.entries(activeSceneFragmentMaterials.assignments).flatMap(([entityId, assignment]) => {
        const owner = previewAppliedEdits.find(({ program }) =>
          program.operations.some((operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId),
        );
        if (!owner) return [];
        const projectedEntity = workspaceCreationProjection.entities.find((entity) => entity.entityId === entityId);
        if (!projectedEntity || !["arrow", "math-tex", "text"].includes(projectedEntity.kind)) return [];
        if (draftEdit && editingAppliedProgram?.original.program.transactionId !== owner.program.transactionId)
          return [];
        const schema = activeProjectFragmentMaterials.parameterSchemasByShaderId[assignment.shaderId];
        const materialName = activeProjectFragmentMaterials.namesByShaderId[assignment.shaderId] ?? assignment.shaderId;
        const existing = materialParameterKeyframeTrackFromProgram(owner.program, 0);
        if (!schema || (existing && JSON.stringify(existing.material) !== JSON.stringify(assignment))) return [];
        return studioFragmentMaterialParameterLayoutV1(schema).entries.flatMap(({ offset, parameter }) =>
          parameter.type === "f32" &&
          Number.isFinite(assignment.parameters[offset]) &&
          (!existing || existing.name === parameter.name)
            ? [{ entityId, materialName, name: parameter.name }]
            : [],
        );
      })
    : [];
  const staleMaterialParameterTracks = previewAppliedEdits.flatMap((record, programIndex) => {
    const track = materialParameterKeyframeTrackFromProgram(record.program, programIndex);
    if (!track) return [];
    const assignment = activeSceneFragmentMaterials.assignments[track.entityId];
    const parameterSchema = activeProjectFragmentMaterials.parameterSchemasByShaderId[track.material.shaderId];
    const parameterEntry = parameterSchema
      ? studioFragmentMaterialParameterLayoutV1(parameterSchema).entries.find(
          ({ offset }) => offset === track.parameterIndex,
        )
      : null;
    const parameter = parameterEntry?.parameter.type === "f32" ? parameterEntry.parameter : null;
    const materialOrSchemaChanged =
      !assignment ||
      JSON.stringify(assignment) !== JSON.stringify(track.material) ||
      !parameter ||
      parameter.name !== track.name;
    return materialOrSchemaChanged ? [track] : [];
  });
  const materialParameterTracks: readonly StudioMaterialParameterTimelineTrack[] = previewAppliedEdits.flatMap(
    (record, programIndex) => {
      const track = materialParameterKeyframeTrackFromProgram(record.program, programIndex);
      if (!track || !workspaceCreationProjection) return [];
      const assignment = activeSceneFragmentMaterials.assignments[track.entityId];
      const schema = activeProjectFragmentMaterials.parameterSchemasByShaderId[track.material.shaderId];
      const parameterEntry = schema
        ? studioFragmentMaterialParameterLayoutV1(schema).entries.find(({ offset }) => offset === track.parameterIndex)
        : null;
      const parameter = parameterEntry?.parameter.type === "f32" ? parameterEntry.parameter : null;
      const assignmentChanged =
        !assignment ||
        JSON.stringify(assignment) !== JSON.stringify(track.material) ||
        !parameter ||
        parameter.name !== track.name;
      const operations = record.program.operations.filter(
        (operation) =>
          operation.kind === "AnimateProperty" &&
          operation.materialParameter !== undefined &&
          operation.entityId === track.entityId,
      );
      const mutations = operations.map((operation) =>
        workspaceCreationProjection.mutations.find(
          (mutation) => mutation.kind === "material-parameter-keyframes" && mutation.operationId === operation.id,
        ),
      );
      if (mutations.some((mutation) => !mutation)) return [];
      const projectedMutations = mutations as readonly Extract<
        (typeof workspaceCreationProjection.mutations)[number],
        { kind: "material-parameter-keyframes" }
      >[];
      const workingTimes =
        projectedMutations.length === 1 &&
        Math.abs(projectedMutations[0]!.interval.end - projectedMutations[0]!.interval.start) < 0.0005
          ? [projectedMutations[0]!.interval.start]
          : [projectedMutations[0]!.interval.start, ...projectedMutations.map(({ interval }) => interval.end)];
      if (workingTimes.length !== track.keyframes.length) return [];
      const activeDraftIsThisTrack = editingAppliedProgram?.original.program.transactionId === track.transactionId;
      const baseline = track.material.parameters[track.parameterIndex] ?? 0;
      return [
        {
          assignmentChanged,
          entityId: track.entityId,
          keyframes: track.keyframes.map((keyframe, index) => ({
            ...keyframe,
            sourceTime: keyframe.time,
            time: workingTimes[index]!,
          })),
          label:
            workspaceProjection?.projection.timeline.objectTracks.find(({ entityId }) => entityId === track.entityId)
              ?.label ?? track.entityId,
          materialName:
            activeProjectFragmentMaterials.namesByShaderId[track.material.shaderId] ?? track.material.shaderId,
          parameterIndex: track.parameterIndex,
          parameterName: track.name,
          programIndex,
          range: parameter?.name === track.name ? parameter.range : { max: baseline, min: baseline, step: 1 },
          readOnlyReason: assignmentChanged
            ? "The assigned material changed. Restore it or remove this track."
            : draftEdit && !activeDraftIsThisTrack
              ? "Apply or discard the current draft before editing this material track."
              : null,
          transactionId: track.transactionId,
        },
      ];
    },
  );
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
    return {
      entity,
      sourceAnchor: creationProgram.anchor.resolvedSeconds,
    };
  };
  const studioCreationStaticTransformAuthorityFor = (entityId: string | null | undefined) => {
    if (!entityId) return null;
    const entity = studioCreationProjectionEntityFor(entityId);
    const sourceAnchor = studioCreationStaticTransformAnchorForEntity(
      workspaceEntityCreationProjection,
      previewEditRecords.map(({ program }) => program),
      entityId,
    );
    return entity && sourceAnchor !== null ? { entity, sourceAnchor } : null;
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
    // Native Scene duration is part of the canonical local document. The
    // source-duration adoption policy exists only to reconcile imported
    // Python estimates with a verified runtime snapshot.
    candidate: nativeSceneActive ? null : (previewRenderer?.verifiedSourceDuration ?? null),
    lifecycle: sourceLifecycle,
    metadataPhase: nativeSceneActive ? null : (previewRenderer?.sourceMetadataPhase ?? null),
    providerPending: nativeSceneActive ? false : previewProviderPending,
    retained: nativeSceneActive ? null : verifiedSourceDurationBasis,
    revision: editorRevision,
    setVerifiedSourceDurationBasis,
  });
  const { sourceLifecyclePending } = sourceLifecycle;
  const studioAuthoringLocked =
    editorDocumentAuthority.authoringBlocked ||
    sessionTransitionPending ||
    sourceLifecycle.studioAuthoringLocked ||
    (editorSelectionAligned && !editorSessionReady);
  const previewPaintAvailable = previewRenderer?.state.phase === "presented";
  const previewMutationAvailable = previewPaintAvailable && !previewSelectionOnly;
  const previewDraftMutationAvailable =
    previewMutationAvailable || (previewPaintAvailable && draftEdit !== null && isStudioEntityInsertion(draftEdit));
  const canvasInteractionLocked = studioAuthoringLocked || isPlaying || !previewPaintAvailable;
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

  function rejectLockedEntityMutation(entityId: string) {
    if (!lockedEntityIdsRef.current.has(entityId)) return false;
    setDraftError(LOCKED_ENTITY_MUTATION_MESSAGE);
    setIsPlaying(false);
    return true;
  }

  function rejectPropertyTrackMutation(entityId: string, readOnlyReason: string | null) {
    if (readOnlyReason) {
      setDraftError(readOnlyReason);
      setIsPlaying(false);
      return true;
    }
    return rejectLockedEntityMutation(entityId);
  }

  function rejectLockedProgramMutation(program: SceneEdit) {
    const lockedTarget = lockedEntityMutationTargets(program, lockedEntityIdsRef.current)[0];
    return lockedTarget === undefined ? false : rejectLockedEntityMutation(lockedTarget);
  }

  function stageDraft(input: Parameters<typeof stageEditorDraft>[0]) {
    // This is the common authoring boundary for pointer, Inspector, timeline,
    // keyboard, Magic Edit, and insertion drafts. Selection-only mappings do
    // not authorize edits to imported entities. A closed Studio insertion is
    // independent of those mappings and is lowered through a safe source
    // anchor, so it remains available.
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview before editing the Scene.");
      setIsPlaying(false);
      return false;
    }
    const selectionOnlyInsertion =
      isStudioEntityInsertion(input.record) &&
      (!input.preserveAppliedProgram || isStudioEntityInsertion(input.preserveAppliedProgram));
    if (!selectionOnlyInsertion && rejectSelectionOnlyPreviewMutation()) return false;
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
    if (
      (input.preserveAppliedProgram && rejectLockedProgramMutation(input.preserveAppliedProgram.program)) ||
      rejectLockedProgramMutation(input.record.program)
    ) {
      return false;
    }
    const preservedAnchor = input.preserveAppliedProgram?.program.anchor.resolvedSeconds;
    if (
      !nativeSceneActive &&
      preservedAnchor !== undefined &&
      !activeEditorScene?.anchors.some((anchor) => Math.abs(anchor - preservedAnchor) < 0.0005)
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

  function cubicBezierMaterialBlockerForEditorState(candidate: EditorControllerState) {
    const programs = candidate.appliedPrograms.map(({ program }) => program);
    const draft = candidate.draftProgram?.program;
    if (draft) {
      const editedTransactionId = candidate.editingAppliedProgram?.original.program.transactionId;
      const editedIndex = editedTransactionId
        ? programs.findIndex((program) => program.transactionId === editedTransactionId)
        : -1;
      if (editedIndex < 0) programs.push(draft);
      else programs[editedIndex] = draft;
    }
    return cubicBezierFragmentMaterialTransitionBlocker(activeSceneFragmentMaterials.assignments, programs);
  }

  function redoProgram() {
    const action = nextEditorRedoAction(editorState);
    if (action === "entity-lock") return redoEditorProgram();
    const entry = redoPrograms.at(-1);
    if (draftEdit || action === null || !entry) return false;
    const lockedRedoPrograms =
      entry.kind === "draft"
        ? [entry.value.program]
        : entry.mutation.kind === "append"
          ? [entry.mutation.value.program]
          : [entry.mutation.previous.program, entry.mutation.value.program];
    if (lockedRedoPrograms.some(rejectLockedProgramMutation)) return false;
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker) return redoEditorProgram(lifecycleBlocker);
    const planned = redoEditorProgramTransition(editorState);
    const materialBlocker = cubicBezierMaterialBlockerForEditorState(planned);
    if (materialBlocker) {
      setDraftError(materialBlocker);
      return false;
    }
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
    const action = nextEditorUndoAction(editorState);
    if (action === "entity-lock") return undoProgram();
    if (action === "draft") {
      const planned = undoEditorProgramTransition(editorState);
      const materialBlocker = cubicBezierMaterialBlockerForEditorState(planned);
      if (materialBlocker) {
        setDraftError(materialBlocker);
        return false;
      }
      return undoProgram();
    }
    if (action !== "program") return false;
    const mutation = programUndoEntries.at(-1);
    if (!mutation) return false;
    const lockedUndoPrograms =
      mutation.kind === "append" ? [mutation.value.program] : [mutation.previous.program, mutation.value.program];
    if (lockedUndoPrograms.some(rejectLockedProgramMutation)) return false;
    const planned = undoEditorProgramTransition(editorState);
    const materialBlocker = cubicBezierMaterialBlockerForEditorState(planned);
    if (materialBlocker) {
      setDraftError(materialBlocker);
      return false;
    }
    if (!editorDocumentAuthority.enabled) return undoProgram();
    const lifecycleBlocker = readDurationBlocker();
    if (lifecycleBlocker || !editorDocumentAuthority.canAuthor()) {
      setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
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
    editorDocumentPresentationReady && projectedEditorScene && draftEdit
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
            activeScene: projectedEditorScene,
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
    projectedEditorScene && projection && appliedTimelineProjection === null
      ? buildLifetimeEditControls({
          anchors: projectedEditorScene.anchors,
          baseScene: projectedEditorScene.runtimeSceneState,
          programs: previewAppliedEdits,
          sourceDuration: projectedEditorScene.runtimeSceneState.duration,
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
  const visibleEntities = filterStudioCanvasEntitiesByVisibility(
    [
      // Runtime-only groups such as NumberPlane can span the full frame. Keep
      // their selection-only hit targets below source-backed edit targets so the
      // editable grid_title remains directly draggable at the same timestamp.
      ...runtimeTraceOpaqueSelectionEntities,
      ...sourceProjectedVisibleEntities,
    ],
    previewRenderer?.canonicalScene?.bundle.scene.entities ?? null,
  );
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
  const nativeWorkspaceOnboardingAvailable = studioNativeWorkspaceOnboardingAvailable({
    authoredObjectCount: editableEntities.length,
    draftActive: draftEdit !== null,
    nativeSceneActive,
  });
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
    rotationKeyframeEntityIds: new Set(
      previewRenderer?.canonicalScene?.bundle.scene.animationChannels.flatMap((channel) =>
        channel.kind === "rotation" ? [channel.entityId] : [],
      ) ?? [],
    ),
    sourceRuntimeIdentity: previewRenderer?.sourceRuntimeIdentity ?? null,
  });
  const selectedSet = new Set(selectedObjectIds);
  const selectedLayerGroup = selectedStudioLayerGroup(studioLayers, selectedSet);
  const selectedLayerGroupLifetimeAnchor = selectedLayerGroup
    ? nativeSceneActive && draftSourceScene
      ? {
          sourceTime: clamp(currentTime, 0, draftSourceScene.duration),
          workingTime: clamp(currentTime, 0, draftSourceScene.duration),
        }
      : (timelineAnchors.find(({ workingTime }) => Math.abs(workingTime - currentTime) < 0.0005) ?? null)
    : null;
  const selectedLayerGroupLifetimeUnavailableReason =
    !selectedLayerGroup?.groupId || !selectedLayerGroup.childEntityIds
      ? null
      : !draftSourceScene
        ? "Wait for the canonical Scene before trimming this group lifetime."
        : appliedTimelineProjection === undefined
          ? "Wait for the Rust timeline projection before trimming this group lifetime."
          : appliedTimelineProjection !== null
            ? "Apply timeline-only duration edits separately before trimming this group lifetime."
            : !selectedLayerGroupLifetimeAnchor
              ? "Move the playhead to a safe source anchor before trimming this group lifetime."
              : studioLogicalGroupLifetimeTrimUnavailableReason({
                  capturedPlayhead: selectedLayerGroupLifetimeAnchor.sourceTime,
                  childEntityIds: selectedLayerGroup.childEntityIds,
                  groupId: selectedLayerGroup.groupId,
                  programs: appliedSceneEdits,
                  scene: draftSourceScene,
                });
  const layerGroupPlan = planStudioLayerGroup(studioLayers, selectedSet);
  const selectedDrawInGroupingBlocked = selectedObjectIds.some((entityId) =>
    sceneProgramsHaveDrawIn(previewAppliedSceneEdits, entityId),
  );
  const layerGroupUnavailableReason = studioAuthoringLocked
    ? (readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER)
    : draftEdit || editingAppliedProgram
      ? "Apply or discard the current draft before grouping."
      : selectedObjectIds.some((entityId) => lockedEntityIdSet.has(entityId))
        ? "Unlock every selected object before grouping."
        : selectedDrawInGroupingBlocked
          ? DRAW_IN_GROUPING_BLOCKER
          : layerGroupPlan.kind === "unavailable"
            ? layerGroupPlan.reason
            : null;
  const selectedEntityLocked = selectedObjectIds.some((entityId) => lockedEntityIdSet.has(entityId));
  const selectedLayoutIds = [...selectedSet];
  let selectionLayoutUnavailableReason: string | null = null;
  const selectionLayoutTargets: SelectionLayoutTarget[] = [];
  if (selectedLayoutIds.length < 2) {
    selectionLayoutUnavailableReason = "Select at least two objects to arrange them.";
  } else if (studioAuthoringLocked) {
    selectionLayoutUnavailableReason = readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER;
  } else if (boundary !== null) {
    selectionLayoutUnavailableReason = "Finish the Scene transition before arranging objects.";
  } else if (!previewPaintAvailable) {
    selectionLayoutUnavailableReason = "Wait for the canonical WebGPU preview before arranging objects.";
  } else if (previewSelectionOnly) {
    selectionLayoutUnavailableReason = "This verified preview is selection-only and cannot authorize layout edits.";
  } else if (draftEdit || editingAppliedProgram) {
    selectionLayoutUnavailableReason = "Apply or discard the current draft before arranging objects.";
  } else if (interactionMode !== "position") {
    selectionLayoutUnavailableReason = "Switch to Position mode before arranging objects.";
  } else if (boundedRuntimeEditTargetIds.size > 0) {
    selectionLayoutUnavailableReason = "Selection layout is unavailable while a bounded Runtime Trace edit is active.";
  } else if (!Number.isFinite(projection?.camera.scale) || (projection?.camera.scale ?? 0) <= 0) {
    selectionLayoutUnavailableReason = "The current camera scale cannot be used for layout.";
  } else {
    const entitiesById = new Map(editableEntities.map((entity) => [entity.id, entity]));
    const emptySourceIdentity = new Map<string, string | null>();
    for (const entityId of selectedLayoutIds) {
      const entity = entitiesById.get(entityId);
      if (!entity || !entity.present) {
        selectionLayoutUnavailableReason = "Every selected object must be present and editable.";
        break;
      }
      if (!studioCreationProjectionEntityFor(entity.id)) {
        selectionLayoutUnavailableReason =
          "Align and distribute currently support only applied Studio-created objects.";
        break;
      }
      if (entity.provisional || !entity.transactionId || !appliedTransactionIds.has(entity.transactionId)) {
        selectionLayoutUnavailableReason = "Apply every selected Studio-created object before arranging the selection.";
        break;
      }
      if (entity.geometry.position.kind === "unknown") {
        selectionLayoutUnavailableReason = `Studio cannot arrange ${entityLabel(entity)} safely: ${entity.geometry.position.reason}`;
        break;
      }
      const verified = previewRenderer
        ? verifiedPreviewGeometryForStudioEntity(previewRenderer, emptySourceIdentity, entity)
        : null;
      const bounds = verified
        ? preparedGeometryBounds(verified.geometry, workspace?.frame ?? { height: 8, width: 14.222 })
        : null;
      if (!bounds) {
        selectionLayoutUnavailableReason = `Exact prepared geometry is unavailable for ${entityLabel(entity)}.`;
        break;
      }
      selectionLayoutTargets.push({ bounds, entityId, position: entity.position });
    }
  }
  const selectionLayoutBasis =
    selectionLayoutUnavailableReason === null && projection
      ? { cameraScale: projection.camera.scale, targets: selectionLayoutTargets }
      : null;
  const activeDuration =
    workspaceProjection?.proposedState.evaluatedScene.duration ?? projectedEditorScene?.runtimeSceneState.duration ?? 1;
  const durationTrimAvailability = appliedTimelineProjection
    ? sceneDurationTrimAvailabilityFromProjection(
        appliedTimelineProjection,
        appliedCreationProjection?.durationTrimBarrierOperationIds,
      )
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
  const appliedMotionClips: readonly AppliedMotionClip[] = projectedEditorScene
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
          const workingInterval = workspaceProjection?.proposedState.evaluatedScene.eventTrack.events.find(
            (event) => event.transactionId === record.program.transactionId && event.operationId === operation.id,
          )?.interval;
          if (!workingInterval) return [];
          const metadataReason = appliedMotionClipReadOnlyReason(
            record.program,
            metadata?.operation,
            sourceOperation.id,
          );
          const busyReason =
            draftEdit && editingAppliedProgram?.original.program.transactionId !== record.program.transactionId
              ? "Apply or discard the current draft before editing this motion clip."
              : null;
          const anchors = projectedEditorScene.anchors
            .map((sourceTime) => ({
              maximumDuration: projectedEditorScene.runtimeSceneState.duration - sourceTime,
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
              interval: workingInterval,
              label: entity?.content?.label ?? entity?.content?.text ?? entityId.split(":").at(-1) ?? entityId,
              maximumDuration: Math.max(
                0.1,
                projectedEditorScene.runtimeSceneState.duration - sourceOperation.interval.start,
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

  const playbackSceneKey = targetEditorSessionIdentity ? editorSessionIdentityKey(targetEditorSessionIdentity) : null;
  const playbackSceneKeyRef = useRef(playbackSceneKey);
  playbackSceneKeyRef.current = playbackSceneKey;
  useEffect(() => {
    if (isPlaying && playbackSceneKey === null) {
      playbackClock.pause();
      setIsPlaying(false);
      return;
    }
    if (isPlaying && playbackSceneKey !== null && !sourceDurationBasisBlocked) {
      const clockSnapshot = playbackClock.getSnapshot();
      if (clockSnapshot.playing && clockSnapshot.sceneKey !== playbackSceneKey) {
        playbackClock.pause();
        playbackClock.reset({
          currentTime: currentTimeRef.current,
          duration: activeDuration,
          sceneKey: playbackSceneKey,
        });
        setIsPlaying(false);
        return;
      }
      const startTime = clockSnapshot.playing ? clockSnapshot.currentTime : currentTimeRef.current;
      playbackClock.play({
        currentTime: startTime,
        duration: activeDuration,
        onEnded: () => {
          const ended = playbackClock.getSnapshot();
          if (playbackSceneKeyRef.current !== ended.sceneKey) return;
          currentTimeRef.current = ended.currentTime;
          setCurrentTime(ended.currentTime);
          setIsPlaying(false);
        },
        sceneKey: playbackSceneKey,
      });
      return;
    }

    const paused = playbackClock.pause();
    let resetTime = currentTimeRef.current;
    const preserveExplicitSeek = playbackSeekPendingRef.current;
    playbackSeekPendingRef.current = false;
    if (!preserveExplicitSeek && paused.wasPlaying && paused.snapshot.sceneKey === playbackSceneKey) {
      resetTime = Math.min(activeDuration, paused.snapshot.currentTime);
      if (Math.abs(resetTime - currentTimeRef.current) >= 0.0005) {
        currentTimeRef.current = resetTime;
        setCurrentTime(resetTime);
      }
    }
    if (playbackSceneKey !== null) {
      playbackClock.reset({ currentTime: resetTime, duration: activeDuration, sceneKey: playbackSceneKey });
    }
  }, [activeDuration, isPlaying, playbackClock, playbackSceneKey, sourceDurationBasisBlocked, setIsPlaying]);

  useEffect(
    () => () => {
      playbackClock.pause();
    },
    [playbackClock],
  );
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
    if (!activeEditorScene || !proposedState) throw new Error("Choose an editable Scene first.");
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
    if (!metadata?.operation || !projectedEditorScene) {
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
      activeScene: projectedEditorScene,
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
      if (rejectLockedProgramMutation(validated.record.program)) return false;
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
    if (rejectLockedProgramMutation(draftEdit.program)) return;
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview or discard this draft.");
      return;
    }
    // A draft may predate preview activation; the correlated Rust compilation
    // below remains the final source-export boundary.
    if (!isStudioEntityInsertion(draftEdit) && rejectSelectionOnlyPreviewMutation()) return;
    const draftExecution = programExecutionCapabilities(draftEdit.program);
    if (draftExecution.apply !== "supported") {
      setDraftError(draftExecution.applyBlocker ?? "The draft cannot be applied safely.");
      return;
    }
    if (nativeSceneActive) {
      setDraftApplyPending(true);
      setDraftError(null);
      try {
        if (rejectLockedProgramMutation(draftEdit.program)) return;
        applyEditorDraft();
      } finally {
        setDraftApplyPending(false);
      }
      return;
    }
    const sourcePreflightCandidate = draftExecution.lowering === "supported" ? renderCandidate : null;
    if (draftExecution.lowering === "supported" && !sourcePreflightCandidate) return;
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
      await runDraftSourcePreflight(draftEdit.program, async () => {
        if (!sourcePreflightCandidate) throw new Error("The Manim source preflight candidate is unavailable.");
        await exportManimSource(renderCandidateRequest(sourcePreflightCandidate), revisionRequest.controller.signal);
      });
      if (!isEditorRevisionRequestCurrent(revisionRequest)) return;
      // Lock state can change while source preflight is in flight. Re-read the
      // current metadata immediately before either local or shared commit.
      if (rejectLockedProgramMutation(draftEdit.program)) return;
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
    currentTimeOverride?: number,
  ) {
    cancelSuggestionRequest();
    const staged = stageDraft({
      appliedEdit,
      clearAppliedEdit: appliedEdit === null,
      clearSuggestion: true,
      currentTime:
        currentTimeOverride ?? sourceTimeToWorkingTime(precedingPrograms, record.program.anchor.resolvedSeconds),
      operation: null,
      preserveAppliedProgram,
      record,
      selectedObjectIds: selectedIds,
      stopPlayback: true,
    });
    if (staged) setLifetimeEditMessage(null);
    return staged;
  }

  function stageOpacityKeyframes(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    keyframes: readonly OpacityKeyframe[],
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    if (!original || original.program.transactionId !== baseProgram.transactionId) {
      setDraftError("The opacity track no longer matches the applied Program history.");
      return false;
    }
    try {
      const validation = replaceOpacityKeyframeProgram({
        baseProgram,
        entityId,
        keyframes,
        scene: projectedEditorScene.runtimeSceneState,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The opacity keyframe could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function studioCreationProgramOwner(entityId: string) {
    const programIndex = previewAppliedEdits.findIndex((record) =>
      record.program.operations.some(
        (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
      ),
    );
    const record = previewAppliedEdits[programIndex];
    return programIndex >= 0 && record ? { programIndex, record } : null;
  }

  function stageDrawIn(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    draw: Readonly<{ easing: "linear" | "smooth"; end: number }> | null,
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    if (!original || original.program.transactionId !== baseProgram.transactionId) {
      setDraftError("The Draw entrance no longer matches the applied Program history.");
      return false;
    }
    try {
      const validation = replaceDrawInProgram({
        baseProgram,
        draw,
        entityId,
        scene: projectedEditorScene.runtimeSceneState,
        svgHasFill: studioSvgPathFillState(baseProgram, entityId),
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Draw entrance could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addDrawIn(entityId: string) {
    if (rejectLockedEntityMutation(entityId)) return;
    const owner = studioCreationProgramOwner(entityId);
    if (!owner || !projectedEditorScene) {
      setDraftError("Draw supports only eligible Studio-created path objects.");
      return;
    }
    const unavailable = drawInUnavailableReason(owner.record.program, entityId, {
      svgHasFill: studioSvgPathFillState(owner.record.program, entityId),
    });
    if (unavailable) {
      setDraftError(unavailable);
      return;
    }
    const create = owner.record.program.operations.find(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
    );
    if (!create || create.kind !== "CreateEntity") return;
    const fadeEnd = owner.record.program.operations.find(
      (operation) =>
        operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId,
    )?.interval.end;
    const lifetimeEnd = create.entity.lifetime.end ?? projectedEditorScene.runtimeSceneState.duration;
    const end = Math.min(
      projectedEditorScene.runtimeSceneState.duration,
      lifetimeEnd,
      Math.max(create.entity.lifetime.start + 0.1, fadeEnd ?? create.entity.lifetime.start + 1),
    );
    stageDrawIn(entityId, owner.programIndex, owner.record.program, { easing: "smooth", end });
  }

  function editDrawIn(clip: StudioDrawInTimelineClip) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    if (!owner || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Draw entrance no longer matches the applied Program history.");
      return;
    }
    const sourceClip = drawInClipFromProgram(owner.record.program);
    if (!sourceClip) return;
    stageDrawIn(clip.entityId, owner.programIndex, owner.record.program, {
      easing: sourceClip.easing,
      end: sourceClip.interval.end,
    });
  }

  function changeDrawIn(clip: StudioDrawInTimelineClip, change: StudioDrawInClipChange) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    const sourceClip = owner ? drawInClipFromProgram(owner.record.program) : null;
    if (!owner || !sourceClip || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Draw entrance no longer matches the applied Program history.");
      return;
    }
    const duration = change.duration ?? sourceClip.interval.end - sourceClip.interval.start;
    if (!Number.isFinite(duration) || duration > clip.maximumDuration + 0.0005) {
      setDraftError(`Draw must finish before the object's next edit (${clip.maximumDuration.toFixed(2)}s maximum).`);
      return;
    }
    stageDrawIn(clip.entityId, owner.programIndex, owner.record.program, {
      easing: change.easing ?? sourceClip.easing,
      end: sourceClip.interval.start + duration,
    });
  }

  function deleteDrawIn(clip: StudioDrawInTimelineClip) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    if (!owner || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Draw entrance no longer matches the applied Program history.");
      return;
    }
    stageDrawIn(clip.entityId, owner.programIndex, owner.record.program, null);
  }

  function stageWriteIn(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    write: Readonly<{ easing: WriteInEasing; end: number }> | null,
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    if (!original || original.program.transactionId !== baseProgram.transactionId) {
      setDraftError("The Write entrance no longer matches the applied Program history.");
      return false;
    }
    try {
      const validation = replaceWriteInProgram({
        baseProgram,
        entityId,
        scene: projectedEditorScene.runtimeSceneState,
        write,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Write entrance could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addWriteIn(entityId: string) {
    if (rejectLockedEntityMutation(entityId)) return;
    const owner = studioCreationProgramOwner(entityId);
    if (!owner || !projectedEditorScene) {
      setDraftError("Write supports only eligible Studio-created MathTex objects.");
      return;
    }
    const unavailable = writeInUnavailableReason(owner.record.program, entityId);
    if (unavailable) {
      setDraftError(unavailable);
      return;
    }
    const create = owner.record.program.operations.find(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
    );
    if (!create || create.kind !== "CreateEntity") return;
    const fadeEnd = owner.record.program.operations.find(
      (operation) =>
        operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId,
    )?.interval.end;
    const lifetimeEnd = create.entity.lifetime.end ?? projectedEditorScene.runtimeSceneState.duration;
    const end = Math.min(
      projectedEditorScene.runtimeSceneState.duration,
      lifetimeEnd,
      Math.max(create.entity.lifetime.start + 0.1, fadeEnd ?? create.entity.lifetime.start + 1),
    );
    stageWriteIn(entityId, owner.programIndex, owner.record.program, { easing: "linear", end });
  }

  function editWriteIn(clip: StudioWriteInTimelineClip) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    if (!owner || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Write entrance no longer matches the applied Program history.");
      return;
    }
    const sourceClip = writeInClipFromProgram(owner.record.program);
    if (!sourceClip) return;
    stageWriteIn(clip.entityId, owner.programIndex, owner.record.program, {
      easing: sourceClip.easing,
      end: sourceClip.interval.end,
    });
  }

  function changeWriteIn(clip: StudioWriteInTimelineClip, change: StudioWriteInClipChange) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    const sourceClip = owner ? writeInClipFromProgram(owner.record.program) : null;
    if (!owner || !sourceClip || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Write entrance no longer matches the applied Program history.");
      return;
    }
    const duration = change.duration ?? sourceClip.interval.end - sourceClip.interval.start;
    if (!Number.isFinite(duration) || duration > clip.maximumDuration + 0.0005) {
      setDraftError(`Write must finish before the object's next edit (${clip.maximumDuration.toFixed(2)}s maximum).`);
      return;
    }
    stageWriteIn(clip.entityId, owner.programIndex, owner.record.program, {
      easing: change.easing ?? sourceClip.easing,
      end: sourceClip.interval.start + duration,
    });
  }

  function deleteWriteIn(clip: StudioWriteInTimelineClip) {
    if (rejectPropertyTrackMutation(clip.entityId, clip.readOnlyReason)) return;
    const owner = studioCreationProgramOwner(clip.entityId);
    if (!owner || owner.record.program.transactionId !== clip.transactionId) {
      setDraftError("The Write entrance no longer matches the applied Program history.");
      return;
    }
    stageWriteIn(clip.entityId, owner.programIndex, owner.record.program, null);
  }

  function mathTexTransformMutationsForRoot(entityId: string) {
    return (workspaceCreationProjection?.mutations ?? [])
      .filter(
        (mutation): mutation is Extract<StudioCreationProjectionMutationV1, { kind: "math-tex-transform" }> =>
          mutation.kind === "math-tex-transform" && mutation.entityId === entityId,
      )
      .sort((left, right) => left.interval.end - right.interval.end);
  }

  function mathTexTransformUnavailableReason(entityId: string) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity || entity.type !== "MathTex" || entity.sourceIdentity.kind !== "unknown" || !entity.transactionId) {
      return "Transform supports only Studio-created MathTex objects.";
    }
    if (previewRenderer?.state.phase !== "presented" || !workspaceCreationProjection || !workspaceProjection) {
      return "Wait for the canonical WebGPU preview before creating Transform.";
    }
    if (lockedEntityIdSet.has(entityId)) return LOCKED_ENTITY_MUTATION_MESSAGE;
    if (draftEdit) return "Apply or discard the current draft before creating Transform.";
    const latest = mathTexTransformMutationsForRoot(entityId).at(-1);
    if (latest && currentTime < latest.interval.end - 0.0005) {
      return "Move the playhead to the end of the latest Transform before appending another one.";
    }
    return null;
  }

  function addMathTexTransform(
    entityId: string,
    input: Readonly<{ content: EntityContent; duration: number; easing: MathTexTransformEasing }>,
  ) {
    const unavailable = mathTexTransformUnavailableReason(entityId);
    if (unavailable) {
      setDraftError(unavailable);
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "creating a MathTex Transform",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor) return false;
    const sourceEntityId = mathTexTransformMutationsForRoot(entityId).at(-1)?.targetEntityId ?? entityId;
    try {
      const validation = createMathTexTransformProgram({
        capturedPlayhead: anchor.sourceTime,
        content: input.content,
        easing: input.easing,
        end: anchor.sourceTime + input.duration,
        rootEntityId: entityId,
        scene: sourceScene,
        sourceEntityId,
        start: anchor.sourceTime,
        transactionId: `studio-mathtex-transform-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [entityId], gestureContext.sourcePrograms);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The MathTex Transform could not be created.");
      return false;
    }
  }

  function stageMathTexTransform(
    clip: StudioMathTexTransformTimelineClip,
    change: StudioMathTexTransformClipChange = {},
  ) {
    if (clip.readOnlyReason) {
      setDraftError(clip.readOnlyReason);
      return false;
    }
    const programIndex = appliedEdits.findIndex(({ program }) => program.transactionId === clip.transactionId);
    const original = appliedEdits[programIndex];
    const base = previewAppliedEdits[programIndex];
    if (!original || !base || base.program.transactionId !== clip.transactionId) {
      setDraftError("The MathTex Transform no longer matches the applied Program history.");
      return false;
    }
    try {
      const preceding = sourceSceneBeforeAppliedProgram(programIndex);
      const validation = replaceMathTexTransformProgram({
        baseProgram: base.program,
        duration: change.duration,
        easing: change.easing,
        rootEntityId: clip.entityId,
        scene: preceding.scene,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [clip.entityId], preceding.canonical, null, {
        index: programIndex,
        original,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The MathTex Transform could not be edited.");
      return false;
    }
  }

  function deleteMathTexTransform(clip: StudioMathTexTransformTimelineClip) {
    const latest = appliedEdits.at(-1);
    const mutation = programUndoEntries.at(-1);
    if (
      !latest ||
      latest.program.transactionId !== clip.transactionId ||
      !mutation ||
      mutation.kind !== "append" ||
      mutation.value.program.transactionId !== clip.transactionId
    ) {
      setDraftError("Undo later edits and Transform changes before deleting this clip.");
      return false;
    }
    if (draftEdit) {
      if (editingAppliedProgram?.original.program.transactionId !== clip.transactionId) {
        setDraftError("Apply or discard the current draft before deleting Transform.");
        return false;
      }
      const planned = undoEditorProgramTransition(discardEditorDraftTransition(editorState));
      if (!editorDocumentAuthority.enabled) {
        installAcceptedState(planned);
        return true;
      }
      const lifecycleBlocker = readDurationBlocker();
      if (lifecycleBlocker || !editorDocumentAuthority.canAuthor()) {
        setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
        return false;
      }
      void commitEditorProgramMutation(collaborationMutationForUndoV1(mutation), planned);
      return true;
    }
    return undoProgramCommitFirst();
  }

  function baseCameraView(): CameraView | null {
    const view = previewRenderer?.canonicalScene?.bundle.scene.camera.view;
    return view
      ? {
          center: { ...view.center },
          frameHeight: view.frameHeight,
          frameWidth: view.frameWidth,
        }
      : null;
  }

  function sameCameraView(left: CameraView, right: CameraView) {
    return (
      Math.abs(left.center.x - right.center.x) < 0.0005 &&
      Math.abs(left.center.y - right.center.y) < 0.0005 &&
      Math.abs(left.frameHeight - right.frameHeight) < 0.0005 &&
      Math.abs(left.frameWidth - right.frameWidth) < 0.0005
    );
  }

  function currentExactCameraView(): CameraView | null {
    return cameraClips.at(-1)?.to ?? baseCameraView();
  }

  function selectedPreparedCameraBounds() {
    if (!previewRenderer || !workspace) return null;
    const sourceNames = new Map<string, string | null>();
    const bounds = selectedObjectIds.flatMap((entityId) => {
      const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
      const verified = entity ? verifiedPreviewGeometryForStudioEntity(previewRenderer, sourceNames, entity) : null;
      const prepared = verified ? preparedGeometryBounds(verified.geometry, workspace.frame) : null;
      return prepared ? [prepared] : [];
    });
    if (bounds.length !== selectedObjectIds.length || bounds.length === 0) return null;
    return {
      bottom: Math.max(...bounds.map((bound) => bound.bottom)),
      left: Math.min(...bounds.map((bound) => bound.left)),
      right: Math.max(...bounds.map((bound) => bound.right)),
      top: Math.min(...bounds.map((bound) => bound.top)),
    };
  }

  function cameraCommonUnavailableReason() {
    if (!nativeSceneActive) return "Camera clips currently support only Studio-native Scenes.";
    if (studioAuthoringLocked) return readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER;
    if (boundary !== null) return "Finish the Scene transition before authoring Camera clips.";
    if (
      previewRenderer?.state.phase !== "presented" ||
      !previewPaintAvailable ||
      !workspaceCreationProjection ||
      !workspaceProjection
    ) {
      return "Wait for the canonical WebGPU preview before authoring Camera clips.";
    }
    if (previewSelectionOnly) return "Camera clips require a complete canonical Scene preview.";
    if (draftEdit) return "Apply or discard the current draft before authoring Camera clips.";
    const latest = cameraClips.at(-1);
    if (latest && currentTime < latest.interval.end - 0.0005) {
      return "Move the playhead to the end of the latest Camera clip before appending another one.";
    }
    if (!baseCameraView() || !currentExactCameraView()) return "The exact Scene Camera view is unavailable.";
    return null;
  }

  function cameraFocusUnavailableReason() {
    const common = cameraCommonUnavailableReason();
    if (common) return common;
    if (selectedObjectIds.length === 0) return "Select at least one Studio object to focus the Camera.";
    if (selectedObjectIds.some((entityId) => !studioCreationProjectionEntityFor(entityId))) {
      return "Camera Focus supports only applied Studio-created objects.";
    }
    const bounds = selectedPreparedCameraBounds();
    const base = baseCameraView();
    const current = currentExactCameraView();
    if (!bounds || !base || !current) return "Exact prepared bounds are unavailable for the complete selection.";
    try {
      cameraFocusViewFromPreparedBounds({ bounds, baseView: base, currentView: current, viewport: STUDIO_VIEWPORT });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "The selection cannot produce a bounded Camera view.";
    }
  }

  function cameraResetUnavailableReason() {
    const common = cameraCommonUnavailableReason();
    if (common) return common;
    const base = baseCameraView();
    const current = currentExactCameraView();
    if (!base || !current) return "The exact Scene Camera view is unavailable.";
    return sameCameraView(base, current) ? "The Camera is already at the base Scene view." : null;
  }

  function addCameraClip(kind: "focus" | "reset", input: Readonly<{ duration: number; easing: CameraClipEasing }>) {
    const unavailable = kind === "focus" ? cameraFocusUnavailableReason() : cameraResetUnavailableReason();
    if (unavailable) {
      setDraftError(unavailable);
      return false;
    }
    const base = baseCameraView();
    const from = currentExactCameraView();
    if (!base || !from) return false;
    const bounds = kind === "focus" ? selectedPreparedCameraBounds() : null;
    let to: CameraView;
    try {
      to =
        kind === "focus" && bounds
          ? cameraFocusViewFromPreparedBounds({ bounds, baseView: base, currentView: from, viewport: STUDIO_VIEWPORT })
          : base;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Camera target view is invalid.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: `creating a Camera ${kind === "focus" ? "Focus" : "Reset"}`,
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: kind === "focus" ? selectedObjectIds : [],
    });
    if (!anchor) return false;
    try {
      const validation = createCameraProgram({
        baseView: base,
        capturedPlayhead: anchor.sourceTime,
        easing: input.easing,
        end: anchor.sourceTime + input.duration,
        from,
        scene: sourceScene,
        start: anchor.sourceTime,
        to,
        transactionId: `studio-camera-${kind}-${crypto.randomUUID()}`,
        workspaceOrigin: "studio-native",
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, selectedObjectIds, gestureContext.sourcePrograms);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Camera clip could not be created.");
      return false;
    }
  }

  function stageCameraClip(clip: StudioCameraTimelineClip, change: StudioCameraClipChange = {}) {
    if (clip.readOnlyReason) {
      setDraftError(clip.readOnlyReason);
      return false;
    }
    const programIndex = appliedEdits.findIndex(({ program }) => program.transactionId === clip.transactionId);
    const original = appliedEdits[programIndex];
    const base = previewAppliedEdits[programIndex];
    const cameraBase = baseCameraView();
    if (!original || !base || !cameraBase || base.program.transactionId !== clip.transactionId) {
      setDraftError("The Camera clip no longer matches the applied Program history.");
      return false;
    }
    try {
      const preceding = sourceSceneBeforeAppliedProgram(programIndex);
      const validation = replaceCameraProgram({
        baseProgram: base.program,
        baseView: cameraBase,
        duration: change.duration,
        easing: change.easing,
        scene: preceding.scene,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, selectedObjectIds, preceding.canonical, null, {
        index: programIndex,
        original,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Camera clip could not be edited.");
      return false;
    }
  }

  function deleteCameraClip(clip: StudioCameraTimelineClip) {
    const latest = appliedEdits.at(-1);
    const mutation = programUndoEntries.at(-1);
    if (
      !latest ||
      latest.program.transactionId !== clip.transactionId ||
      !mutation ||
      mutation.kind !== "append" ||
      mutation.value.program.transactionId !== clip.transactionId
    ) {
      setDraftError("Undo later edits and Camera changes before deleting this clip.");
      return false;
    }
    if (draftEdit) {
      if (editingAppliedProgram?.original.program.transactionId !== clip.transactionId) {
        setDraftError("Apply or discard the current draft before deleting Camera.");
        return false;
      }
      const planned = undoEditorProgramTransition(discardEditorDraftTransition(editorState));
      if (!editorDocumentAuthority.enabled) {
        installAcceptedState(planned);
        return true;
      }
      const lifecycleBlocker = readDurationBlocker();
      if (lifecycleBlocker || !editorDocumentAuthority.canAuthor()) {
        setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
        return false;
      }
      void commitEditorProgramMutation(collaborationMutationForUndoV1(mutation), planned);
      return true;
    }
    return undoProgramCommitFirst();
  }

  function shapeTransformMutationsForRoot(entityId: string) {
    return (workspaceCreationProjection?.mutations ?? [])
      .filter(
        (mutation): mutation is Extract<StudioCreationProjectionMutationV1, { kind: "shape-transform" }> =>
          mutation.kind === "shape-transform" && mutation.entityId === entityId,
      )
      .sort((left, right) => left.interval.end - right.interval.end);
  }

  function currentShapeTransformState(entityId: string): ShapeTransformState | null {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!entity || entity.geometry.dimensions.kind !== "known") return null;
    if (entity.type === "Circle") {
      const radius = entity.geometry.dimensions.value.radius;
      return typeof radius === "number" && Number.isFinite(radius) && radius > 0
        ? { dimensions: { radius }, shape: "circle" }
        : null;
    }
    if (entity.type === "Rectangle") {
      const { height, width } = entity.geometry.dimensions.value;
      return typeof width === "number" &&
        Number.isFinite(width) &&
        width > 0 &&
        typeof height === "number" &&
        Number.isFinite(height) &&
        height > 0
        ? { dimensions: { height, width }, shape: "rectangle" }
        : null;
    }
    if (entity.type === "Ellipse") {
      const { height, width } = entity.geometry.dimensions.value;
      return typeof width === "number" &&
        Number.isFinite(width) &&
        width > 0 &&
        typeof height === "number" &&
        Number.isFinite(height) &&
        height > 0
        ? { dimensions: { height, width }, shape: "ellipse" }
        : null;
    }
    if (entity.type === "Triangle") {
      const radius = entity.geometry.dimensions.value.radius;
      return typeof radius === "number" && Number.isFinite(radius) && radius > 0
        ? { dimensions: { radius, sides: 3 }, shape: "triangle" }
        : null;
    }
    if (entity.type === "RegularPolygon") {
      const { radius, sides } = entity.geometry.dimensions.value;
      return typeof radius === "number" &&
        Number.isFinite(radius) &&
        radius > 0 &&
        typeof sides === "number" &&
        Number.isInteger(sides) &&
        sides >= 3 &&
        sides <= 32
        ? { dimensions: { radius, sides }, shape: "regular-polygon" }
        : null;
    }
    return null;
  }

  function targetShapeTransformState(input: ShapeTransformInspectorInput): ShapeTransformState {
    if (input.target === "Circle") return { dimensions: { radius: input.radius }, shape: "circle" };
    if (input.target === "Ellipse") {
      return { dimensions: { height: input.height, width: input.width }, shape: "ellipse" };
    }
    if (input.target === "Rectangle") {
      return { dimensions: { height: input.height, width: input.width }, shape: "rectangle" };
    }
    if (input.target === "Triangle") return { dimensions: { radius: input.radius, sides: 3 }, shape: "triangle" };
    if (input.target === "RegularPolygon") {
      return {
        dimensions: { radius: input.radius, sides: input.sides },
        shape: "regular-polygon",
      };
    }
    throw new Error("Unsupported Shape Transform target.");
  }

  function shapeTransformUnavailableReason(entityId: string) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (
      !entity ||
      !isShapeTransformTarget(entity.type) ||
      entity.sourceIdentity.kind !== "unknown" ||
      !entity.transactionId
    ) {
      return "Shape Transform supports only Studio-created closed primitive objects.";
    }
    if (previewRenderer?.state.phase !== "presented" || !workspaceCreationProjection || !workspaceProjection) {
      return "Wait for the canonical WebGPU preview before creating Shape Transform.";
    }
    if (lockedEntityIdSet.has(entityId)) return LOCKED_ENTITY_MUTATION_MESSAGE;
    if (canonicalGroupedChildIds.has(entityId))
      return "Shape Transform currently supports only ungrouped root objects.";
    if (draftEdit) return "Apply or discard the current draft before creating Shape Transform.";
    if (
      previewAppliedEdits.some(({ program }) =>
        program.operations.some((operation) => operation.kind === "ResizeEntity" && operation.entityId === entityId),
      )
    ) {
      return "Create all Shape Transform clips before resizing this object.";
    }
    if (!currentShapeTransformState(entityId)) return "Shape Transform requires known positive shape dimensions.";
    const latest = shapeTransformMutationsForRoot(entityId).at(-1);
    if (latest && currentTime < latest.interval.end - 0.0005) {
      return "Move the playhead to the end of the latest Shape Transform before appending another one.";
    }
    return null;
  }

  function addShapeTransform(entityId: string, input: ShapeTransformInspectorInput) {
    const unavailable = shapeTransformUnavailableReason(entityId);
    if (unavailable) {
      setDraftError(unavailable);
      return false;
    }
    const from = currentShapeTransformState(entityId);
    const to = targetShapeTransformState(input);
    if (!from || !shapeTransformChangesShape(from, to)) {
      setDraftError("Shape Transform must change to a different closed primitive.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "creating a Shape Transform",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor) return false;
    try {
      const validation = createShapeTransformProgram({
        capturedPlayhead: anchor.sourceTime,
        easing: input.easing,
        end: anchor.sourceTime + input.duration,
        entityId,
        from,
        scene: sourceScene,
        start: anchor.sourceTime,
        to,
        transactionId: `studio-shape-transform-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [entityId], gestureContext.sourcePrograms);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Shape Transform could not be created.");
      return false;
    }
  }

  function stageShapeTransform(clip: StudioShapeTransformTimelineClip, change: StudioShapeTransformClipChange = {}) {
    if (clip.readOnlyReason) {
      setDraftError(clip.readOnlyReason);
      return false;
    }
    const programIndex = appliedEdits.findIndex(({ program }) => program.transactionId === clip.transactionId);
    const original = appliedEdits[programIndex];
    const base = previewAppliedEdits[programIndex];
    if (!original || !base || base.program.transactionId !== clip.transactionId) {
      setDraftError("The Shape Transform no longer matches the applied Program history.");
      return false;
    }
    try {
      const preceding = sourceSceneBeforeAppliedProgram(programIndex);
      const validation = replaceShapeTransformProgram({
        baseProgram: base.program,
        duration: change.duration,
        easing: change.easing,
        scene: preceding.scene,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [clip.entityId], preceding.canonical, null, {
        index: programIndex,
        original,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Shape Transform could not be edited.");
      return false;
    }
  }

  function deleteShapeTransform(clip: StudioShapeTransformTimelineClip) {
    const latest = appliedEdits.at(-1);
    const mutation = programUndoEntries.at(-1);
    if (
      !latest ||
      latest.program.transactionId !== clip.transactionId ||
      !mutation ||
      mutation.kind !== "append" ||
      mutation.value.program.transactionId !== clip.transactionId
    ) {
      setDraftError("Undo later edits and Shape Transform changes before deleting this clip.");
      return false;
    }
    if (draftEdit) {
      if (editingAppliedProgram?.original.program.transactionId !== clip.transactionId) {
        setDraftError("Apply or discard the current draft before deleting Shape Transform.");
        return false;
      }
      const planned = undoEditorProgramTransition(discardEditorDraftTransition(editorState));
      if (!editorDocumentAuthority.enabled) {
        installAcceptedState(planned);
        return true;
      }
      const lifecycleBlocker = readDurationBlocker();
      if (lifecycleBlocker || !editorDocumentAuthority.canAuthor()) {
        setDraftError(lifecycleBlocker ?? editorDocumentAuthority.message ?? EDITOR_SESSION_LOADING_BLOCKER);
        return false;
      }
      void commitEditorProgramMutation(collaborationMutationForUndoV1(mutation), planned);
      return true;
    }
    return undoProgramCommitFirst();
  }

  function duplicateStudioPropertyKeyframe<
    TSourceTrack extends Readonly<{
      keyframes: readonly Readonly<{ easing: StudioPropertyKeyframeEasing; time: number; value: unknown }>[];
      transactionId: string;
    }>,
  >(input: {
    conflictReason: string | null;
    index: number;
    label: string;
    mismatchMessage: string;
    owner: ReturnType<typeof studioCreationProgramOwner>;
    sourceTrack: TSourceTrack | null;
    stage: (
      keyframes: readonly TSourceTrack["keyframes"][number][],
      owner: NonNullable<ReturnType<typeof studioCreationProgramOwner>>,
      sourceTrack: TSourceTrack,
    ) => boolean;
    track: Readonly<{ entityId: string; readOnlyReason: string | null; transactionId: string }>;
  }) {
    if (rejectPropertyTrackMutation(input.track.entityId, input.track.readOnlyReason)) return null;
    const { owner, sourceTrack } = input;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== input.track.transactionId) {
      setDraftError(input.mismatchMessage);
      return null;
    }
    if (input.conflictReason) {
      setDraftError(input.conflictReason);
      return null;
    }
    if (!projectedEditorScene) {
      setDraftError(`Wait for the canonical Scene before duplicating a ${input.label} keyframe.`);
      return null;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const keyframes = duplicatePropertyKeyframeAtTime(sourceTrack.keyframes, input.index, sourceTime);
      const duplicatedIndex = keyframes.findIndex((keyframe) => keyframe.time === sourceTime);
      return input.stage(keyframes, owner, sourceTrack) ? duplicatedIndex : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : `The ${input.label} keyframe could not be duplicated.`);
      return null;
    }
  }

  function addOpacityKeyframe(entityId: string) {
    const owner = studioCreationProgramOwner(entityId);
    if (!owner) {
      setDraftError("Opacity keyframes currently support only Studio-created objects.");
      return;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const track = opacityKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      if (track && track.entityId !== entityId) {
        throw new Error("This shared creation Program already owns another object's opacity track.");
      }
      const fadeEnd = Math.max(
        owner.record.program.anchor.resolvedSeconds,
        ...owner.record.program.operations.flatMap((operation) =>
          operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId
            ? [operation.interval.end]
            : [],
        ),
      );
      if (!track && sourceTime <= fadeEnd + 0.0005) {
        setDraftError("Add the first opacity keyframe after the object's initial fade has finished.");
        return;
      }
      if (track?.keyframes.some((keyframe) => Math.abs(keyframe.time - sourceTime) < 0.0005)) {
        setDraftError("An opacity keyframe already exists at the playhead.");
        return;
      }
      const staticOpacity = owner.record.program.operations
        .flatMap((operation) =>
          operation.kind === "SetProperty" &&
          operation.key === "appearance" &&
          operation.entityId === entityId &&
          typeof operation.value === "number"
            ? [operation.value]
            : [],
        )
        .at(-1);
      const sampledOpacity = samplePropertyValue(
        workspaceProjection?.proposedState.evaluatedScene.propertyChannels[`${entityId}/appearance`]?.samples ?? [],
        currentTime,
      );
      const value = track ? (typeof sampledOpacity === "number" ? sampledOpacity : (staticOpacity ?? 1)) : 1;
      const keyframes = [...(track?.keyframes ?? []), { easing: "smooth" as const, time: sourceTime, value }].sort(
        (left, right) => left.time - right.time,
      );
      stageOpacityKeyframes(entityId, owner.programIndex, owner.record.program, keyframes);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The opacity keyframe could not be added.");
    }
  }

  function duplicateOpacityKeyframe(track: StudioOpacityTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? opacityKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    return duplicateStudioPropertyKeyframe({
      conflictReason: opacityTrackEligibleIds.has(track.entityId)
        ? null
        : "Opacity keyframes cannot overlap this object's existing appearance or removal edit.",
      index,
      label: "opacity",
      mismatchMessage: "The opacity track no longer matches the Studio-created object.",
      owner,
      sourceTrack,
      stage: (keyframes, canonicalOwner) =>
        stageOpacityKeyframes(track.entityId, canonicalOwner.programIndex, canonicalOwner.record.program, keyframes),
      track,
    });
  }

  function changeOpacityKeyframe(
    track: StudioOpacityTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioOpacityTimelineTrack["keyframes"][number], "easing" | "time" | "value">>,
  ) {
    const owner = studioCreationProgramOwner(track.entityId);
    if (!owner || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The opacity track no longer matches the Studio-created object.");
      return;
    }
    try {
      if (index === 0 && patch.value !== undefined) {
        throw new Error("The first opacity keyframe preserves the object's post-fade opacity of 1.");
      }
      const sourcePatch: Partial<OpacityKeyframe> = {
        ...(patch.easing === undefined ? {} : { easing: patch.easing }),
        ...(patch.time === undefined ? {} : { time: workingTimeToSourceTime(previewAppliedSceneEdits, patch.time) }),
        ...(patch.value === undefined ? {} : { value: patch.value }),
      };
      const sourceTrack = opacityKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      if (!sourceTrack) throw new Error("The opacity track is not a canonical Studio property track.");
      stageOpacityKeyframes(
        track.entityId,
        owner.programIndex,
        owner.record.program,
        replaceOpacityKeyframe(sourceTrack.keyframes, index, sourcePatch),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The opacity keyframe could not be changed.");
    }
  }

  function deleteOpacityKeyframe(track: StudioOpacityTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? opacityKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The opacity track no longer matches the Studio-created object.");
      return;
    }
    if (index === 0 && sourceTrack.keyframes.length > 1) {
      setDraftError("Delete the later opacity keyframes before deleting the fixed first marker.");
      return;
    }
    stageOpacityKeyframes(
      track.entityId,
      owner.programIndex,
      owner.record.program,
      sourceTrack.keyframes.filter((_, candidate) => candidate !== index),
    );
  }

  function paintColorBaseline(entityId: string, property: PaintColorProperty) {
    const entity = workspaceCreationProjection?.entities.find((candidate) => candidate.entityId === entityId);
    return entity?.[property] ?? null;
  }

  function stagePaintColorKeyframes(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    property: PaintColorProperty,
    keyframes: readonly PaintColorKeyframe[],
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    const baseline = paintColorBaseline(entityId, property);
    if (!original || original.program.transactionId !== baseProgram.transactionId || baseline === null) {
      setDraftError("The paint color track no longer matches the applied Studio-created object.");
      return false;
    }
    try {
      const validation = replacePaintColorKeyframeProgram({
        baseProgram,
        baseline,
        entityId,
        keyframes,
        property,
        scene: projectedEditorScene.runtimeSceneState,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The paint color keyframe could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addPaintColorKeyframe(entityId: string) {
    const owner = studioCreationProgramOwner(entityId);
    if (!owner) {
      setDraftError("Paint color keyframes currently support only Studio-created objects.");
      return;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const track = paintColorKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      const property = track?.property ?? paintColorTrackEligibleProperties.get(entityId) ?? null;
      if (!property || !paintColorTrackEligibleProperties.has(entityId)) {
        throw new Error(
          "Paint color keyframes require a supported solid color without a material, Write, Draw, group, or removal conflict.",
        );
      }
      const baseline = paintColorBaseline(entityId, property);
      if (baseline === null) throw new Error("Set a canonical static color before adding paint color keyframes.");
      if (track && (track.entityId !== entityId || track.property !== property)) {
        throw new Error("This shared creation Program already owns another paint color track.");
      }
      const targetCreate = owner.record.program.operations.find(
        (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
      );
      if (!targetCreate || targetCreate.kind !== "CreateEntity") {
        throw new Error("The Studio-created object's creation operation is unavailable.");
      }
      const keyframes = track
        ? appendPaintColorKeyframe(track.keyframes, sourceTime)
        : initialPaintColorKeyframes({
            baseline,
            entranceEnd: initialAppearanceEnd(
              owner.record.program.operations,
              entityId,
              targetCreate.entity.lifetime.start,
            ),
            playhead: sourceTime,
          });
      stagePaintColorKeyframes(entityId, owner.programIndex, owner.record.program, property, keyframes);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The paint color keyframe could not be added.");
    }
  }

  function duplicatePaintColorKeyframe(track: StudioPaintColorTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? paintColorKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    return duplicateStudioPropertyKeyframe({
      conflictReason: paintColorTrackEligibleProperties.has(track.entityId)
        ? null
        : "Paint color keyframes cannot overlap this object's material, entrance, group, or removal edit.",
      index,
      label: "paint color",
      mismatchMessage: "The paint color track no longer matches the Studio-created object.",
      owner,
      sourceTrack,
      stage: (keyframes, canonicalOwner, canonicalTrack) =>
        stagePaintColorKeyframes(
          track.entityId,
          canonicalOwner.programIndex,
          canonicalOwner.record.program,
          canonicalTrack.property,
          keyframes,
        ),
      track,
    });
  }

  function changePaintColorKeyframe(
    track: StudioPaintColorTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioPaintColorTimelineTrack["keyframes"][number], "easing" | "time" | "value">>,
  ) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? paintColorKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The paint color track no longer matches the Studio-created object.");
      return;
    }
    try {
      if (index === 0 && patch.value !== undefined) {
        throw new Error("The first paint color keyframe preserves the object's canonical static color.");
      }
      const sourcePatch: Partial<PaintColorKeyframe> = {
        ...(patch.easing === undefined ? {} : { easing: patch.easing }),
        ...(patch.time === undefined ? {} : { time: workingTimeToSourceTime(previewAppliedSceneEdits, patch.time) }),
        ...(patch.value === undefined ? {} : { value: patch.value.toLowerCase() }),
      };
      stagePaintColorKeyframes(
        track.entityId,
        owner.programIndex,
        owner.record.program,
        sourceTrack.property,
        replacePaintColorKeyframe(sourceTrack.keyframes, index, sourcePatch),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The paint color keyframe could not be changed.");
    }
  }

  function deletePaintColorKeyframe(track: StudioPaintColorTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? paintColorKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The paint color track no longer matches the Studio-created object.");
      return;
    }
    if (index === 0) {
      setDraftError("Delete the later paint color keyframes before removing the fixed baseline marker.");
      return;
    }
    stagePaintColorKeyframes(
      track.entityId,
      owner.programIndex,
      owner.record.program,
      sourceTrack.property,
      sourceTrack.keyframes.length === 2 ? [] : sourceTrack.keyframes.filter((_, candidate) => candidate !== index),
    );
  }

  function scaleBaseline(entityId: string) {
    return workspaceCreationProjection?.entities.find((entity) => entity.entityId === entityId)?.initialScale ?? null;
  }

  function stageScaleKeyframes(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    keyframes: readonly ScaleKeyframe[],
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    const baseline = scaleBaseline(entityId);
    if (!original || original.program.transactionId !== baseProgram.transactionId || baseline === null) {
      setDraftError("The scale track no longer matches the applied Studio-created object.");
      return false;
    }
    try {
      const validation = replaceScaleKeyframeProgram({
        baseProgram,
        baseline,
        entityId,
        keyframes,
        scene: projectedEditorScene.runtimeSceneState,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The scale keyframe could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addScaleKeyframe(entityId: string) {
    const owner = studioCreationProgramOwner(entityId);
    const baseline = scaleBaseline(entityId);
    if (!owner || baseline === null) {
      setDraftError("Scale keyframes currently support only Studio-created objects.");
      return;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const track = scaleKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      if (!track && !scaleTrackEligibleIds.has(entityId)) {
        throw new Error(
          "Scale keyframes cannot overlap this object's existing move, resize, rotation, or motion edit.",
        );
      }
      if (track && track.entityId !== entityId) {
        throw new Error("This shared creation Program already owns another object's scale track.");
      }
      const fadeEnd = Math.max(
        owner.record.program.anchor.resolvedSeconds,
        ...owner.record.program.operations.flatMap((operation) =>
          operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId
            ? [operation.interval.end]
            : [],
        ),
      );
      if (!track && sourceTime <= fadeEnd + 0.0005) {
        throw new Error("Add the first scale keyframe after the object's initial fade has finished.");
      }
      if (track?.keyframes.some((keyframe) => Math.abs(keyframe.time - sourceTime) < 0.0005)) {
        throw new Error("A scale keyframe already exists at the playhead.");
      }
      stageScaleKeyframes(
        entityId,
        owner.programIndex,
        owner.record.program,
        appendScaleKeyframe(track?.keyframes ?? [], sourceTime, baseline),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The scale keyframe could not be added.");
    }
  }

  function duplicateScaleKeyframe(track: StudioScaleTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? scaleKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    return duplicateStudioPropertyKeyframe({
      conflictReason: scaleTrackEligibleIds.has(track.entityId)
        ? null
        : "Scale keyframes cannot overlap this object's existing move, resize, rotation, or motion edit.",
      index,
      label: "scale",
      mismatchMessage: "The scale track no longer matches the Studio-created object.",
      owner,
      sourceTrack,
      stage: (keyframes, canonicalOwner) =>
        stageScaleKeyframes(track.entityId, canonicalOwner.programIndex, canonicalOwner.record.program, keyframes),
      track,
    });
  }

  function changeScaleKeyframe(
    track: StudioScaleTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioScaleTimelineTrack["keyframes"][number], "easing" | "time" | "value">>,
  ) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? scaleKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The scale track no longer matches the Studio-created object.");
      return;
    }
    try {
      if (index === 0 && patch.value !== undefined) {
        throw new Error("The first scale keyframe preserves the object's baseline scale.");
      }
      if (patch.value !== undefined && (patch.value < MIN_TIMELINE_SCALE || patch.value > MAX_TIMELINE_SCALE)) {
        throw new Error(`Scale must be between ${MIN_TIMELINE_SCALE} and ${MAX_TIMELINE_SCALE}.`);
      }
      const sourcePatch: Partial<ScaleKeyframe> = {
        ...(patch.easing === undefined ? {} : { easing: patch.easing }),
        ...(patch.time === undefined ? {} : { time: workingTimeToSourceTime(previewAppliedSceneEdits, patch.time) }),
        ...(patch.value === undefined ? {} : { value: patch.value }),
      };
      stageScaleKeyframes(
        track.entityId,
        owner.programIndex,
        owner.record.program,
        replaceScaleKeyframe(sourceTrack.keyframes, index, sourcePatch),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The scale keyframe could not be changed.");
    }
  }

  function deleteScaleKeyframe(track: StudioScaleTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? scaleKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The scale track no longer matches the Studio-created object.");
      return;
    }
    if (index === 0 && sourceTrack.keyframes.length > 1) {
      setDraftError("Delete the later scale keyframes before deleting the fixed first marker.");
      return;
    }
    stageScaleKeyframes(
      track.entityId,
      owner.programIndex,
      owner.record.program,
      sourceTrack.keyframes.filter((_, candidate) => candidate !== index),
    );
  }

  function rotationBaseline(entityId: string) {
    return (
      workspaceCreationProjection?.entities.find((entity) => entity.entityId === entityId)?.initialRotation ?? null
    );
  }

  function stageRotationKeyframes(
    entityId: string,
    programIndex: number,
    baseProgram: SceneEdit,
    keyframes: readonly RotationKeyframe[],
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[programIndex];
    const baseline = rotationBaseline(entityId);
    if (!original || original.program.transactionId !== baseProgram.transactionId || baseline === null) {
      setDraftError("The rotation track no longer matches the applied Studio-created object.");
      return false;
    }
    try {
      const validation = replaceRotationKeyframeProgram({
        baseProgram,
        baseline,
        entityId,
        keyframes,
        scene: projectedEditorScene.runtimeSceneState,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The rotation keyframe could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addRotationKeyframe(entityId: string) {
    if (canonicalGroupedChildIds.has(entityId)) {
      setDraftError("Ungroup this object in Layers before adding rotation keyframes.");
      return;
    }
    const owner = studioCreationProgramOwner(entityId);
    const baseline = rotationBaseline(entityId);
    if (!owner || baseline === null) {
      setDraftError("Rotation keyframes currently support only Studio-created objects.");
      return;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const track = rotationKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      if (!track && !rotationTrackEligibleIds.has(entityId)) {
        throw new Error(
          "Rotation keyframes cannot overlap this object's existing move, resize, scale, rotation, or motion edit.",
        );
      }
      if (track && track.entityId !== entityId) {
        throw new Error("This shared creation Program already owns another object's rotation track.");
      }
      const fadeEnd = Math.max(
        owner.record.program.anchor.resolvedSeconds,
        ...owner.record.program.operations.flatMap((operation) =>
          operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId
            ? [operation.interval.end]
            : [],
        ),
      );
      if (!track && sourceTime <= fadeEnd + 0.0005) {
        throw new Error("Add the first rotation keyframe after the object's initial fade has finished.");
      }
      if (track?.keyframes.some((keyframe) => Math.abs(keyframe.time - sourceTime) < 0.0005)) {
        throw new Error("A rotation keyframe already exists at the playhead.");
      }
      stageRotationKeyframes(
        entityId,
        owner.programIndex,
        owner.record.program,
        appendRotationKeyframe(track?.keyframes ?? [], sourceTime, baseline),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The rotation keyframe could not be added.");
    }
  }

  function duplicateRotationKeyframe(track: StudioRotationTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? rotationKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    return duplicateStudioPropertyKeyframe({
      conflictReason: rotationTrackEligibleIds.has(track.entityId)
        ? null
        : "Rotation keyframes cannot overlap this object's existing move, resize, scale, or motion edit.",
      index,
      label: "rotation",
      mismatchMessage: "The rotation track no longer matches the Studio-created object.",
      owner,
      sourceTrack,
      stage: (keyframes, canonicalOwner) =>
        stageRotationKeyframes(track.entityId, canonicalOwner.programIndex, canonicalOwner.record.program, keyframes),
      track,
    });
  }

  function changeRotationKeyframe(
    track: StudioRotationTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioRotationTimelineTrack["keyframes"][number], "easing" | "time" | "value">>,
  ) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? rotationKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The rotation track no longer matches the Studio-created object.");
      return;
    }
    try {
      if (index === 0 && patch.value !== undefined) {
        throw new Error("The first rotation keyframe preserves the object's baseline rotation.");
      }
      const sourcePatch: Partial<RotationKeyframe> = {
        ...(patch.easing === undefined ? {} : { easing: patch.easing }),
        ...(patch.time === undefined ? {} : { time: workingTimeToSourceTime(previewAppliedSceneEdits, patch.time) }),
        ...(patch.value === undefined ? {} : { value: (patch.value * Math.PI) / 180 }),
      };
      stageRotationKeyframes(
        track.entityId,
        owner.programIndex,
        owner.record.program,
        replaceRotationKeyframe(sourceTrack.keyframes, index, sourcePatch),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The rotation keyframe could not be changed.");
    }
  }

  function deleteRotationKeyframe(track: StudioRotationTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner ? rotationKeyframeTrackFromProgram(owner.record.program, owner.programIndex) : null;
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The rotation track no longer matches the Studio-created object.");
      return;
    }
    if (index === 0 && sourceTrack.keyframes.length > 1) {
      setDraftError("Delete the later rotation keyframes before deleting the fixed first marker.");
      return;
    }
    stageRotationKeyframes(
      track.entityId,
      owner.programIndex,
      owner.record.program,
      sourceTrack.keyframes.filter((_, candidate) => candidate !== index),
    );
  }

  function stageMaterialParameterKeyframes(
    track: Readonly<{
      entityId: string;
      keyframes: readonly MaterialParameterKeyframe[];
      material: NonNullable<(typeof activeSceneFragmentMaterials.assignments)[string]>;
      name: string;
      parameterIndex: number;
      programIndex: number;
      program: SceneEdit;
    }>,
  ) {
    if (!projectedEditorScene) return false;
    const original = appliedEdits[track.programIndex];
    if (!original || original.program.transactionId !== track.program.transactionId) {
      setDraftError("The material track no longer matches the applied Program history.");
      return false;
    }
    try {
      const validation = replaceMaterialParameterKeyframeProgram({
        baseProgram: track.program,
        entityId: track.entityId,
        keyframes: track.keyframes,
        material: track.material,
        name: track.name,
        parameterIndex: track.parameterIndex,
        scene: projectedEditorScene.runtimeSceneState,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return stageDraft({
        appliedEdit: { index: track.programIndex, original },
        clearSuggestion: true,
        currentTime,
        operation: null,
        record: validated.record,
        selectedObjectIds: [track.entityId],
        stopPlayback: true,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material parameter keyframe could not be edited.");
      setIsPlaying(false);
      return false;
    }
  }

  function addMaterialParameterKeyframe(entityId: string, name: string) {
    const owner = studioCreationProgramOwner(entityId);
    const assignment = activeSceneFragmentMaterials.assignments[entityId];
    const schema = assignment ? activeProjectFragmentMaterials.parameterSchemasByShaderId[assignment.shaderId] : null;
    const parameterEntry = schema
      ? studioFragmentMaterialParameterLayoutV1(schema).entries.find(
          ({ parameter }) => parameter.type === "f32" && parameter.name === name,
        )
      : null;
    const parameterIndex = parameterEntry?.offset ?? -1;
    const parameter = parameterEntry?.parameter.type === "f32" ? parameterEntry.parameter : null;
    if (!owner || !assignment || !parameter) {
      setDraftError("This Studio-created object no longer has that editable material parameter.");
      return;
    }
    try {
      const sourceTime = workingTimeToSourceTime(previewAppliedSceneEdits, currentTime);
      const track = materialParameterKeyframeTrackFromProgram(owner.record.program, owner.programIndex);
      if (track && (track.name !== name || track.entityId !== entityId)) {
        throw new Error("This creation Program already owns another material parameter track.");
      }
      if (track && JSON.stringify(track.material) !== JSON.stringify(assignment)) {
        throw new Error("The assigned material changed. Restore it or remove the existing track first.");
      }
      const fadeEnd = Math.max(
        owner.record.program.anchor.resolvedSeconds,
        ...owner.record.program.operations.flatMap((operation) =>
          operation.kind === "ChangePresence" && operation.effect === "fade-in" && operation.entityId === entityId
            ? [operation.interval.end]
            : [],
        ),
      );
      if (!track && sourceTime <= fadeEnd + 0.0005) {
        throw new Error("Add the first material keyframe after the object's initial fade has finished.");
      }
      if (track?.keyframes.some((keyframe) => Math.abs(keyframe.time - sourceTime) < 0.0005)) {
        throw new Error("A material parameter keyframe already exists at the playhead.");
      }
      const baseValue = assignment.parameters[parameterIndex];
      if (baseValue === undefined) throw new Error("The selected material parameter no longer exists.");
      const keyframes = appendMaterialParameterKeyframe(track?.keyframes ?? [], sourceTime, baseValue);
      stageMaterialParameterKeyframes({
        entityId,
        keyframes,
        material: assignment,
        name,
        parameterIndex,
        program: owner.record.program,
        programIndex: owner.programIndex,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material parameter keyframe could not be added.");
    }
  }

  function duplicateMaterialParameterKeyframe(track: StudioMaterialParameterTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner
      ? materialParameterKeyframeTrackFromProgram(owner.record.program, owner.programIndex)
      : null;
    const assignment = activeSceneFragmentMaterials.assignments[track.entityId];
    if (!owner || !sourceTrack || !assignment || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The material parameter track no longer matches the Studio-created object.");
      return null;
    }
    return duplicateStudioPropertyKeyframe({
      conflictReason: null,
      index,
      label: "material parameter",
      mismatchMessage: "The material parameter track no longer matches the Studio-created object.",
      owner,
      sourceTrack,
      stage: (keyframes, canonicalOwner, canonicalTrack) =>
        stageMaterialParameterKeyframes({
          entityId: track.entityId,
          keyframes,
          material: assignment,
          name: canonicalTrack.name,
          parameterIndex: canonicalTrack.parameterIndex,
          program: canonicalOwner.record.program,
          programIndex: canonicalOwner.programIndex,
        }),
      track,
    });
  }

  function changeMaterialParameterKeyframe(
    track: StudioMaterialParameterTimelineTrack,
    index: number,
    patch: Partial<Pick<StudioMaterialParameterTimelineTrack["keyframes"][number], "easing" | "time" | "value">>,
  ) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner
      ? materialParameterKeyframeTrackFromProgram(owner.record.program, owner.programIndex)
      : null;
    const assignment = activeSceneFragmentMaterials.assignments[track.entityId];
    if (!owner || !sourceTrack || !assignment || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The material parameter track no longer matches the Studio-created object.");
      return;
    }
    try {
      if (index === 0 && patch.value !== undefined) {
        throw new Error("The first material keyframe preserves the assigned parameter value.");
      }
      if (patch.value !== undefined && (patch.value < track.range.min || patch.value > track.range.max)) {
        throw new Error(`${track.parameterName} must be between ${track.range.min} and ${track.range.max}.`);
      }
      const sourcePatch: Partial<MaterialParameterKeyframe> = {
        ...(patch.easing === undefined ? {} : { easing: patch.easing }),
        ...(patch.time === undefined ? {} : { time: workingTimeToSourceTime(previewAppliedSceneEdits, patch.time) }),
        ...(patch.value === undefined ? {} : { value: patch.value }),
      };
      stageMaterialParameterKeyframes({
        entityId: track.entityId,
        keyframes: replaceMaterialParameterKeyframe(sourceTrack.keyframes, index, sourcePatch),
        material: assignment,
        name: sourceTrack.name,
        parameterIndex: sourceTrack.parameterIndex,
        program: owner.record.program,
        programIndex: owner.programIndex,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material parameter keyframe could not be changed.");
    }
  }

  function deleteMaterialParameterKeyframe(track: StudioMaterialParameterTimelineTrack, index: number) {
    const owner = studioCreationProgramOwner(track.entityId);
    const sourceTrack = owner
      ? materialParameterKeyframeTrackFromProgram(owner.record.program, owner.programIndex)
      : null;
    const assignment = activeSceneFragmentMaterials.assignments[track.entityId];
    if (!owner || !sourceTrack || owner.record.program.transactionId !== track.transactionId) {
      setDraftError("The material parameter track no longer matches the Studio-created object.");
      return;
    }
    const assignmentChanged =
      track.assignmentChanged || !assignment || JSON.stringify(assignment) !== JSON.stringify(sourceTrack.material);
    if (assignmentChanged) {
      removeMaterialParameterTrack(sourceTrack);
      return;
    }
    if (index === 0 && sourceTrack.keyframes.length > 1) {
      setDraftError("Delete the later material keyframes before deleting the fixed first marker.");
      return;
    }
    stageMaterialParameterKeyframes({
      entityId: track.entityId,
      keyframes: sourceTrack.keyframes.filter((_, candidate) => candidate !== index),
      material: sourceTrack.material,
      name: sourceTrack.name,
      parameterIndex: sourceTrack.parameterIndex,
      program: owner.record.program,
      programIndex: owner.programIndex,
    });
  }

  function removeMaterialParameterTrack(sourceTrack: MaterialParameterKeyframeTrack) {
    const owner = studioCreationProgramOwner(sourceTrack.entityId);
    if (!owner || owner.record.program.transactionId !== sourceTrack.transactionId) {
      setDraftError("The material parameter track no longer matches the Studio-created object.");
      return;
    }
    stageMaterialParameterKeyframes({
      entityId: sourceTrack.entityId,
      keyframes: [],
      material: sourceTrack.material,
      name: sourceTrack.name,
      parameterIndex: sourceTrack.parameterIndex,
      program: owner.record.program,
      programIndex: owner.programIndex,
    });
  }

  function studioOwnedCreation(entityId: string, type: "Axes" | "CubicBezier" | "DataPlot") {
    const owner = studioCreationProgramOwner(entityId);
    const creations =
      owner?.record.program.operations.filter(
        (operation) =>
          operation.kind === "CreateEntity" && operation.entity.id === entityId && operation.entity.type === type,
      ) ?? [];
    const creation = creations[0];
    return owner && creations.length === 1 && creation?.kind === "CreateEntity" ? { creation, owner } : null;
  }

  function cubicBezierOwnedCreation(entityId: string) {
    const owned = studioOwnedCreation(entityId, "CubicBezier");
    if (!owned?.creation.entity.cubicBezier || owned.owner.programIndex !== appliedEdits.length - 1) return null;
    const positions = owned.owner.record.program.operations.filter(
      (operation) =>
        operation.kind === "SetProperty" && operation.entityId === entityId && operation.key === "position",
    );
    const positionOperation = positions[0];
    if (positions.length !== 1 || !positionOperation || positionOperation.kind !== "SetProperty") return null;
    const position = positionOperation.value;
    if (
      typeof position !== "object" ||
      position === null ||
      !("x" in position) ||
      !("y" in position) ||
      typeof position.x !== "number" ||
      typeof position.y !== "number"
    )
      return null;
    return { ...owned, position: { x: position.x, y: position.y } };
  }

  async function normalizeAndStageCubicBezier(
    entityId: string,
    cubicBezier: StudioCubicBezierSpec,
    extensionEnd?: Point,
  ) {
    if (draftEdit || editingAppliedProgram) {
      setDraftError("Apply or discard the current draft before editing the curve.");
      return false;
    }
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned) {
      setDraftError("Only the latest untransformed Studio-created curve exposes editable path nodes.");
      return false;
    }
    const requestGeneration = cubicBezierAuthoringGeneration.current + 1;
    cubicBezierAuthoringGeneration.current = requestGeneration;
    const requestProjectId = activeProjectId;
    const requestSceneId = activeSceneId;
    const requestAppliedEdits = appliedEdits;
    const requestSelectedObjectIds = selectedObjectIds;
    try {
      const frame = workspace?.frame ?? { height: 8, width: 14.222 };
      const inspection = extensionEnd
        ? await extendStudioCubicBezier({ cubicBezier, end: extensionEnd })
        : await inspectStudioCubicBezier(cubicBezier);
      const current = cubicBezierAuthoringSnapshot.current;
      if (
        cubicBezierAuthoringGeneration.current !== requestGeneration ||
        current.activeProjectId !== requestProjectId ||
        current.activeSceneId !== requestSceneId ||
        current.appliedEdits !== requestAppliedEdits ||
        current.selectedObjectIds !== requestSelectedObjectIds ||
        current.draftEdit !== null ||
        current.editingAppliedProgram !== null
      )
        return false;
      const offset = viewportOffsetFromScene(inspection.centerOffset, frame);
      const position = { x: owned.position.x + offset.x, y: owned.position.y + offset.y };
      const preceding = sourceSceneBeforeAppliedProgram(owned.owner.programIndex);
      const original = appliedEdits[owned.owner.programIndex];
      if (!original || original.program.transactionId !== owned.owner.record.program.transactionId) {
        throw new Error("The applied curve creation Program is unavailable.");
      }
      const validation = replaceStudioCreatedCubicBezierProgram({
        cubicBezier: inspection.cubicBezier,
        dimensions: inspection.dimensions,
        entityId,
        owner: original,
        position,
        scene: preceding.scene,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [entityId], preceding.canonical, null, {
        index: owned.owner.programIndex,
        original,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The curve could not be updated.");
      return false;
    }
  }

  function changeCubicBezierControl(entityId: string, pointRef: StudioCubicBezierPointRef, point: Point) {
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned) return false;
    const frame = workspace?.frame ?? { height: 8, width: 14.222 };
    const localPoint = sceneOffsetFromViewport(point, owned.position, frame);
    const cubicBezier = owned.creation.entity.cubicBezier!;
    if (pointRef.kind === "start") {
      void normalizeAndStageCubicBezier(entityId, { ...cubicBezier, start: localPoint });
      return true;
    }
    if (pointRef.segmentIndex === 0) {
      void normalizeAndStageCubicBezier(entityId, { ...cubicBezier, [pointRef.point]: localPoint });
      return true;
    }
    const continuationSegments = [...(cubicBezier.continuationSegments ?? [])];
    const continuationIndex = pointRef.segmentIndex - 1;
    const segment = continuationSegments[continuationIndex];
    if (!segment) return false;
    continuationSegments[continuationIndex] = { ...segment, [pointRef.point]: localPoint };
    void normalizeAndStageCubicBezier(entityId, { ...cubicBezier, continuationSegments });
    return true;
  }

  function toggleCubicBezierExtension(entityId: string) {
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned || owned.creation.entity.cubicBezier?.closed) return false;
    setCubicBezierExtensionEntityId((current) => (current === entityId ? null : entityId));
    return true;
  }

  function extendCubicBezierAtPoint(entityId: string, point: Point) {
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned) return false;
    const cubicBezier = owned.creation.entity.cubicBezier!;
    if (cubicBezier.closed) {
      setCubicBezierExtensionEntityId(null);
      setDraftError("Reopen the Pen path before extending it.");
      return false;
    }
    if ((cubicBezier.continuationSegments?.length ?? 0) >= 7) {
      setCubicBezierExtensionEntityId(null);
      setDraftError("A Studio Pen path supports at most 8 segments.");
      return false;
    }
    const frame = workspace?.frame ?? { height: 8, width: 14.222 };
    const localEnd = sceneOffsetFromViewport(point, owned.position, frame);
    setCubicBezierExtensionEntityId(null);
    void normalizeAndStageCubicBezier(entityId, cubicBezier, localEnd);
    return true;
  }

  function removeLastCubicBezierSegment(entityId: string) {
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned) return false;
    const cubicBezier = owned.creation.entity.cubicBezier!;
    const continuationSegments = cubicBezier.continuationSegments ?? [];
    if (continuationSegments.length === 0) return false;
    setCubicBezierExtensionEntityId(null);
    void normalizeAndStageCubicBezier(entityId, {
      ...cubicBezier,
      continuationSegments: continuationSegments.slice(0, -1),
    });
    return true;
  }

  function changeCubicBezierStyle(
    entityId: string,
    change: Readonly<
      Partial<Pick<StudioCubicBezierSpec, "arrowEnd" | "closed" | "fillColor" | "strokeCap" | "strokeWidth">>
    >,
  ) {
    const owned = cubicBezierOwnedCreation(entityId);
    if (!owned) return false;
    void normalizeAndStageCubicBezier(entityId, { ...owned.creation.entity.cubicBezier!, ...change });
    return true;
  }

  function toggleCubicBezierClosed(entityId: string) {
    const owned = cubicBezierOwnedCreation(entityId);
    const cubicBezier = owned?.creation.entity.cubicBezier;
    if (!owned || !cubicBezier) return false;
    setCubicBezierExtensionEntityId(null);
    if (cubicBezier.closed) {
      if (activeSceneFragmentMaterials.assignments[entityId] !== undefined) {
        setDraftError(CUBIC_BEZIER_FRAGMENT_MATERIAL_FILL_BLOCKER);
        return false;
      }
      void normalizeAndStageCubicBezier(entityId, {
        ...cubicBezier,
        closed: false,
        fillColor: undefined,
      });
      return true;
    }
    if (sceneProgramsHaveDrawIn(previewAppliedSceneEdits, entityId)) {
      setDraftError("Remove Draw before closing and filling this Pen path.");
      return false;
    }
    void normalizeAndStageCubicBezier(entityId, {
      ...cubicBezier,
      arrowEnd: false,
      closed: true,
      fillColor: cubicBezier.fillColor ?? "#ffffff",
    });
    return true;
  }

  async function addCubicBezierPenPoint(point: Point) {
    const requestGeneration = cubicBezierAuthoringGeneration.current + 1;
    cubicBezierAuthoringGeneration.current = requestGeneration;
    const points = [...cubicBezierPenPoints, point];
    if (points.length < 4) {
      setCubicBezierPenPoints(points);
      return;
    }
    setCubicBezierPenPoints([]);
    const [startPoint, endPoint, control1Point, control2Point] = points;
    if (!startPoint || !endPoint || !control1Point || !control2Point) return;
    const frame = workspace?.frame ?? { height: 8, width: 14.222 };
    const viewportCenter = { x: STUDIO_VIEWPORT.width / 2, y: STUDIO_VIEWPORT.height / 2 };
    const requestProjectId = activeProjectId;
    const requestSceneId = activeSceneId;
    const requestAppliedEdits = appliedEdits;
    try {
      const inspection = await inspectStudioCubicBezier({
        arrowEnd: false,
        control1: sceneOffsetFromViewport(control1Point, viewportCenter, frame),
        control2: sceneOffsetFromViewport(control2Point, viewportCenter, frame),
        end: sceneOffsetFromViewport(endPoint, viewportCenter, frame),
        start: sceneOffsetFromViewport(startPoint, viewportCenter, frame),
        strokeCap: "round",
        strokeWidth: 0.04,
      });
      const current = cubicBezierAuthoringSnapshot.current;
      if (
        cubicBezierAuthoringGeneration.current !== requestGeneration ||
        current.activeProjectId !== requestProjectId ||
        current.activeSceneId !== requestSceneId ||
        current.appliedEdits !== requestAppliedEdits ||
        current.draftEdit !== null ||
        current.editingAppliedProgram !== null ||
        current.insertTool !== "CubicBezier"
      )
        return;
      const offset = viewportOffsetFromScene(inspection.centerOffset, frame);
      const position = { x: viewportCenter.x + offset.x, y: viewportCenter.y + offset.y };
      insertEntitiesAt(position, [
        {
          content: defaultEntityContent("CubicBezier", ""),
          cubicBezier: inspection.cubicBezier,
          dimensions: inspection.dimensions,
          position,
          type: "CubicBezier",
        },
      ]);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The curve could not be created.");
    }
  }

  function dataPlotAxesUnavailableReason(entity: ProjectedEntity) {
    if (selectedObjectIds.length !== 1) return "Select one Axes object to add a data plot.";
    if (!previewMutationAvailable) return "Wait for an editable canonical WebGPU preview.";
    if (selectedEntityLocked) return "Unlock this Axes object before adding a data plot.";
    if (draftEdit || editingAppliedProgram) return "Apply or discard the current draft first.";
    if (entity.sourceIdentity.kind !== "unknown" || !entity.transactionId) {
      return "Data plots currently require a Studio-created Axes object.";
    }
    const owned = studioOwnedCreation(entity.id, "Axes");
    if (!owned || owned.owner.record.program.transactionId !== entity.transactionId) {
      return "The Axes creation Program is unavailable.";
    }
    const dimensions = owned.creation.entity.dimensions;
    if (!dimensions?.coordinateSystem?.y || dimensions.width === undefined || dimensions.height === undefined) {
      return "The Axes range and size are not exact enough to create a data plot.";
    }
    const transformed = previewAppliedSceneEdits.some((program) =>
      program.operations.some(
        (operation) =>
          (operation.kind === "AnimateProperty" &&
            operation.entityId === entity.id &&
            (operation.key === "rotation" || operation.key === "scale")) ||
          (operation.kind === "ResizeEntity" && operation.entityId === entity.id) ||
          (operation.kind === "TransformShape" && operation.entityId === entity.id) ||
          (operation.kind === "CreateMotion" && operation.targetEntityIds.includes(entity.id)),
      ),
    );
    if (transformed || Math.abs(entity.scale - 1) >= 0.0005) {
      return "Create a data plot from an unscaled, unrotated Axes object.";
    }
    return null;
  }

  function addDataPlotFromAxes(entityId: string, dataSeries: DataSeries) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.type === "Axes");
    if (!entity) return false;
    const unavailable = dataPlotAxesUnavailableReason(entity);
    if (unavailable) {
      setDraftError(unavailable);
      return false;
    }
    const dimensions = studioOwnedCreation(entity.id, "Axes")?.creation.entity.dimensions;
    if (!dimensions) return false;
    return insertEntitiesAt(entity.position, [{ dataSeries, dimensions, position: entity.position, type: "DataPlot" }]);
  }

  function dataPlotUpdateUnavailableReason(entity: ProjectedEntity) {
    if (selectedObjectIds.length !== 1) return "Select one data plot to edit its samples.";
    if (!previewMutationAvailable) return "Wait for an editable canonical WebGPU preview.";
    if (selectedEntityLocked) return "Unlock this data plot before editing it.";
    if (draftEdit || editingAppliedProgram) return "Apply or discard the current draft first.";
    if (entity.sourceIdentity.kind !== "unknown" || !entity.transactionId) {
      return "Only a Studio-created data plot can replace its stored samples.";
    }
    const owned = studioOwnedCreation(entity.id, "DataPlot");
    return owned && owned.owner.record.program.transactionId === entity.transactionId
      ? null
      : "The data plot creation Program is unavailable.";
  }

  function updateDataPlot(entityId: string, dataSeries: DataSeries) {
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.type === "DataPlot");
    if (!entity) return false;
    const unavailable = dataPlotUpdateUnavailableReason(entity);
    if (unavailable) {
      setDraftError(unavailable);
      return false;
    }
    const owned = studioOwnedCreation(entityId, "DataPlot");
    if (!owned) return false;
    try {
      const preceding = sourceSceneBeforeAppliedProgram(owned.owner.programIndex);
      const original = appliedEdits[owned.owner.programIndex];
      if (!original || original.program.transactionId !== owned.owner.record.program.transactionId) {
        throw new Error("The applied data plot creation Program is unavailable.");
      }
      const validation = replaceStudioCreatedDataSeriesProgram({
        dataSeries,
        entityId,
        owner: original,
        scene: preceding.scene,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, [entityId], preceding.canonical, null, {
        index: owned.owner.programIndex,
        original,
      });
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The data plot creation Program could not be updated.");
      return false;
    }
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
      const insertDimensions =
        insertTool === "RegularPolygon"
          ? { radius: 1, sides: regularPolygonSides }
          : insertTool === "Ellipse"
            ? { height: curveInsertSettings.ellipseHeight, width: curveInsertSettings.ellipseWidth }
            : insertTool === "Arc" || insertTool === "Sector"
              ? {
                  angles: {
                    start: (curveInsertSettings.startDegrees * Math.PI) / 180,
                    sweep: (curveInsertSettings.sweepDegrees * Math.PI) / 180,
                  },
                  radius: curveInsertSettings.radius,
                }
              : insertTool === "NumberLine" || insertTool === "Axes" || insertTool === "NumberPlane"
                ? {
                    coordinateSystem: {
                      x: {
                        maximum: coordinateInsertSettings.xMaximum,
                        minimum: coordinateInsertSettings.xMinimum,
                        step: coordinateInsertSettings.xStep,
                      },
                      ...(insertTool === "NumberLine"
                        ? {}
                        : {
                            y: {
                              maximum: coordinateInsertSettings.yMaximum,
                              minimum: coordinateInsertSettings.yMinimum,
                              step: coordinateInsertSettings.yStep,
                            },
                          }),
                    },
                    ...(insertTool === "NumberLine" ? {} : { height: coordinateInsertSettings.height }),
                    width: coordinateInsertSettings.width,
                  }
                : undefined;
      const inputs =
        entities ??
        (insertTool === "select"
          ? []
          : [
              {
                content: defaultEntityContent(insertTool, insertValue),
                ...(insertDimensions ? { dimensions: insertDimensions } : {}),
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
      const creationPreviewTime =
        sourceTimeToWorkingTime(precedingPrograms, validated.record.program.anchor.resolvedSeconds) +
        insertedProgramDuration(validated.record.program);
      if (
        !installCanonicalDraft(
          validated.record,
          result.entityIds,
          precedingPrograms,
          previousInsertion,
          null,
          creationPreviewTime,
        )
      )
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

  function createEmptyWorkspaceEntity(type: StudioEmptyWorkspaceEntityType) {
    const position = { x: 320, y: 180 };
    setIsPlaying(false);
    void insertEntitiesAt(position, [{ content: defaultEntityContent(type, ""), position, type }]);
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
    if (!activeEditorScene || !draftBaseState) return false;
    if (draftEdit) {
      const message = "Apply or discard the current draft before changing the Scene duration.";
      setDraftError(message);
      setDurationError(message);
      return false;
    }
    const sourceAnchor =
      durationTrimAvailability.anchor ??
      (isStudioNativeWorkspaceScene(activeEditorScene) ? sourceCurrentTime : activeEditorScene.anchors.at(-1));
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

  function changeSceneBackground(color: string) {
    if (!nativeSceneActive || !draftBaseState) {
      setDraftError("Scene background editing is available only in a Studio-native workspace.");
      return false;
    }
    if (draftEdit || editingAppliedProgram) {
      setDraftError("Apply or discard the current draft before changing the Scene background.");
      return false;
    }
    if (color === sceneBackgroundColor) return true;
    try {
      const owners = appliedEdits.flatMap((record, index) =>
        record.program.operations.some((operation) => operation.kind === "SetSceneBackground")
          ? [{ index, record }]
          : [],
      );
      if (owners.length > 1) throw new Error("More than one applied Program controls the Scene background.");
      const owner = owners[0];
      if (owner) {
        const current = owner.record.program.operations.find((operation) => operation.kind === "SetSceneBackground");
        if (current?.kind !== "SetSceneBackground") throw new Error("The Scene background Program is invalid.");
        if (current.color === color) return true;
        const preceding = sourceSceneBeforeAppliedProgram(owner.index);
        const validation = replaceStudioSceneBackgroundProgram({ color, owner: owner.record, scene: preceding.scene });
        const validated = validatedProgramRecord(validation);
        if (validated.kind === "invalid") throw new Error(validated.message);
        return installCanonicalDraft(validated.record, [], preceding.canonical, null, {
          index: owner.index,
          original: owner.record,
        });
      }
      const validation = createStudioSceneBackgroundProgram({
        color,
        scene: draftBaseState.evaluatedScene,
        transactionId: `studio-background-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The Scene background could not be changed.");
      return false;
    }
  }

  function sourceSceneBeforeAppliedProgram(index: number) {
    if (!projectedEditorScene) throw new Error("The active Scene is unavailable.");
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
      activeScene: projectedEditorScene,
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
    if (!projectedEditorScene || !draftSourceScene) return false;
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
          sourceAnchors: projectedEditorScene.anchors,
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
      const original = projectedEditorScene.runtimeSceneState.objectGraph.entities[entityId]?.lifetime.find(
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
        !projectedEditorScene.anchors.some((anchor) => Math.abs(anchor - sourceAnchor) < 0.001)
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
    if (selectedLayerGroup || selectionContainsGroupedChild(studioLayers, selectedSet)) {
      setDraftError("Grouped child delete is not supported in this vertical slice. Ungroup it first.");
      return false;
    }
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

  function stageLayerOrder(entityId: string, plan: StudioLayerOrderPlan) {
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

  function changeLayerOrder(entityId: string, direction: StudioLayerOrderDirection) {
    return stageLayerOrder(entityId, planStudioLayerOrder(studioLayers, entityId, direction));
  }

  function reorderLayer(entityId: string, frontFirstIndex: number) {
    return stageLayerOrder(entityId, planStudioLayerReorder(studioLayers, entityId, frontFirstIndex));
  }

  function stageLayerGroupOrder(groupId: string, plan: StudioLayerGroupOrderPlan) {
    if (plan.kind === "unavailable") {
      setDraftError(plan.reason);
      return false;
    }
    if (plan.targets.some(({ entityId }) => lockedEntityIdsRef.current.has(entityId))) {
      setDraftError(LOCKED_ENTITY_MUTATION_MESSAGE);
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const groupOwner = gestureContext.sourcePrograms.find(({ operations }) =>
      operations.some((operation) => operation.kind === "GroupEntities" && operation.groupId === groupId),
    );
    if (!groupOwner) {
      setDraftError("The canonical Group Program is unavailable; ungroup and group these objects again.");
      return false;
    }
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const requestedAnchor = manualAuthoringAnchor({
      action: "changing group layer order",
      requireAlignedPlayhead: false,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
    });
    if (!requestedAnchor) return false;
    const sourceAnchor = Math.max(
      groupOwner.anchor.resolvedSeconds,
      gestureContext.sourcePrograms.at(-1)?.anchor.resolvedSeconds ?? 0,
      requestedAnchor.sourceTime,
    );
    if (
      plan.targets.some(
        ({ entityId }) => !studioPreviewRuntimeTraceEditTargetIsPresent(sourceScene, entityId, sourceAnchor, null),
      )
    ) {
      setDraftError("The latest applied Program is outside this group's shared lifetime.");
      return false;
    }
    try {
      const validation = createDirectManipulationGroupLayerOrderProgram({
        capturedPlayhead: sourceAnchor,
        scene: sourceScene,
        start: sourceAnchor,
        targets: plan.targets,
        transactionId: `studio-group-layer-order-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The logical group order could not be changed.");
      return false;
    }
  }

  function changeLayerGroupOrder(groupId: string, direction: StudioLayerOrderDirection) {
    return stageLayerGroupOrder(groupId, planStudioLayerGroupOrder(studioLayers, groupId, direction));
  }

  function reorderLayerGroup(groupId: string, frontFirstIndex: number) {
    return stageLayerGroupOrder(groupId, planStudioLayerGroupReorder(studioLayers, groupId, frontFirstIndex));
  }

  function groupLayerSelection() {
    if (layerGroupPlan.kind === "planned") {
      const blocksDraw = layerGroupPlan.childEntityIds.some((entityId) =>
        sceneProgramsHaveDrawIn(appliedSceneEdits, entityId),
      );
      if (blocksDraw) {
        setDraftError(DRAW_IN_GROUPING_BLOCKER);
        return false;
      }
    }
    if (layerGroupUnavailableReason || layerGroupPlan.kind !== "planned" || !draftSourceScene) {
      if (layerGroupUnavailableReason) setDraftError(layerGroupUnavailableReason);
      return false;
    }
    const anchor = manualAuthoringAnchor({
      action: "grouping",
      requireAlignedPlayhead: true,
      scene: draftSourceScene,
      sourcePrograms: appliedSceneEdits,
      targetEntityIds: layerGroupPlan.childEntityIds,
    });
    if (!anchor) return false;
    try {
      const { validation } = createStudioGroupProgram({
        capturedPlayhead: anchor.sourceTime,
        childEntityIds: layerGroupPlan.childEntityIds,
        scene: draftSourceScene,
        transactionId: `studio-group-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, layerGroupPlan.childEntityIds);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The selected objects could not be grouped.");
      return false;
    }
  }

  function ungroupLayer(groupId: string) {
    if (!draftSourceScene || draftEdit || editingAppliedProgram) {
      setDraftError("Apply or discard the current draft before ungrouping.");
      return false;
    }
    const group = studioLayers.find((layer) => layer.isGroup && layer.groupId === groupId);
    if (!group?.childEntityIds) return false;
    if (group.childEntityIds.some((entityId) => lockedEntityIdSet.has(entityId))) {
      setDraftError("Unlock every grouped object before ungrouping.");
      return false;
    }
    const anchor = manualAuthoringAnchor({
      action: "ungrouping",
      requireAlignedPlayhead: true,
      scene: draftSourceScene,
      sourcePrograms: appliedSceneEdits,
      targetEntityIds: group.childEntityIds,
    });
    if (!anchor) return false;
    try {
      const validation = createStudioUngroupProgram({
        capturedPlayhead: anchor.sourceTime,
        groupId,
        scene: draftSourceScene,
        transactionId: `studio-ungroup-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, group.childEntityIds);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The selected group could not be ungrouped.");
      return false;
    }
  }

  function toggleLayerVisibility(entityId: string, visible: boolean) {
    const layer = studioLayers.find(({ entity, isGroup }) => !isGroup && entity.id === entityId);
    if (!layer || layer.visibilityReadOnlyReason || layer.sourceAnchor === null) {
      setDraftError(layer?.visibilityReadOnlyReason ?? "This layer visibility cannot be changed yet.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    try {
      const validation = createDirectManipulationVisibilityProgram({
        capturedPlayhead: layer.sourceAnchor,
        entityId,
        scene: sourceScene,
        start: layer.sourceAnchor,
        transactionId: `studio-visibility-${crypto.randomUUID()}`,
        visible,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, layer.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The layer visibility could not be changed.");
      return false;
    }
  }

  function toggleLayerGroupVisibility(groupId: string, visible: boolean) {
    const group = studioLayers.find((layer) => layer.isGroup && layer.groupId === groupId);
    if (!group?.childEntityIds || group.visibilityReadOnlyReason) {
      setDraftError(group?.visibilityReadOnlyReason ?? "This group visibility cannot be changed yet.");
      return false;
    }
    if (group.childEntityIds.some((entityId) => lockedEntityIdSet.has(entityId))) {
      setDraftError("Unlock every grouped object before changing group visibility.");
      return false;
    }
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const groupOwner = gestureContext.sourcePrograms.find(({ operations }) =>
      operations.some((operation) => operation.kind === "GroupEntities" && operation.groupId === groupId),
    );
    if (!groupOwner) {
      setDraftError("The canonical Group Program is unavailable; ungroup and group these objects again.");
      return false;
    }
    const sourceAnchor = groupOwner.anchor.resolvedSeconds;
    try {
      const validation = createDirectManipulationGroupVisibilityProgram({
        capturedPlayhead: sourceAnchor,
        entityIds: group.childEntityIds,
        scene: sourceScene,
        start: sourceAnchor,
        transactionId: `studio-group-visibility-${crypto.randomUUID()}`,
        visible,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The group visibility could not be changed.");
      return false;
    }
  }

  function trimLayerGroupLifetime(groupId: string) {
    if (rejectSelectionOnlyPreviewMutation()) return false;
    const group = studioLayers.find((layer) => layer.isGroup && layer.groupId === groupId);
    if (!group?.childEntityIds || !draftSourceScene) return false;
    if (draftEdit || editingAppliedProgram) {
      setDraftError("Apply or discard the current draft before trimming this group lifetime.");
      return false;
    }
    if (group.childEntityIds.some((entityId) => lockedEntityIdsRef.current.has(entityId))) {
      setDraftError("Unlock every grouped object before trimming this group lifetime.");
      return false;
    }
    if (groupId === selectedLayerGroup?.groupId && selectedLayerGroupLifetimeUnavailableReason) {
      setDraftError(selectedLayerGroupLifetimeUnavailableReason);
      return false;
    }
    const anchor = manualAuthoringAnchor({
      action: "trimming the group lifetime",
      requireAlignedPlayhead: true,
      scene: draftSourceScene,
      sourcePrograms: appliedSceneEdits,
      targetEntityIds: group.childEntityIds,
    });
    if (!anchor) return false;
    const unavailableReason = studioLogicalGroupLifetimeTrimUnavailableReason({
      capturedPlayhead: anchor.sourceTime,
      childEntityIds: group.childEntityIds,
      groupId,
      programs: appliedSceneEdits,
      scene: draftSourceScene,
    });
    if (unavailableReason) {
      setDraftError(unavailableReason);
      return false;
    }
    try {
      const validation = createStudioGroupLifetimeTrimProgram({
        capturedPlayhead: anchor.sourceTime,
        childEntityIds: group.childEntityIds,
        scene: draftSourceScene,
        transactionId: `studio-group-lifetime-${crypto.randomUUID()}`,
      });
      const validated = validatedProgramRecord(validation);
      if (validated.kind === "invalid") throw new Error(validated.message);
      return installCanonicalDraft(validated.record, group.childEntityIds);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The group lifetime could not be trimmed.");
      return false;
    }
  }

  function toggleLayerLock(entityId: string) {
    if (draftEdit) {
      setDraftError("Apply or discard the current draft before changing layer locks.");
      return false;
    }
    lockedEntityIdsRef.current = new Set(toggleEntityLock([...lockedEntityIdsRef.current], entityId));
    toggleEditorEntityLock(entityId);
    if (inlineTextEditor?.entityId === entityId) setInlineTextEditor(null);
    setDraftError((current) => (current === LOCKED_ENTITY_MUTATION_MESSAGE ? null : current));
    return true;
  }

  function toggleLayerGroupLock(entityIds: readonly string[]) {
    if (draftEdit) {
      setDraftError("Apply or discard the current draft before changing layer locks.");
      return false;
    }
    const locked = !entityIds.every((entityId) => lockedEntityIdsRef.current.has(entityId));
    const nextLockedEntityIds = new Set(lockedEntityIdsRef.current);
    for (const entityId of entityIds) {
      if (locked) nextLockedEntityIds.add(entityId);
      else nextLockedEntityIds.delete(entityId);
    }
    lockedEntityIdsRef.current = nextLockedEntityIds;
    toggleEditorEntityLocks(entityIds);
    if (inlineTextEditor?.entityId && entityIds.includes(inlineTextEditor.entityId)) setInlineTextEditor(null);
    setDraftError((current) => (current === LOCKED_ENTITY_MUTATION_MESSAGE ? null : current));
    return true;
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
    if (!activeEditorScene) return null;
    const timelineProjection = timelineProjectionForPrograms(input.sourcePrograms);
    if (timelineProjection === undefined) {
      setDraftError("Wait for the Rust timeline projection before authoring another edit.");
      setIsPlaying(false);
      return null;
    }
    if (timelineProjection !== null && !isStudioNativeWorkspaceScene(activeEditorScene)) {
      setDraftError("Apply timeline-only duration edits separately before authoring another operation family.");
      setIsPlaying(false);
      return null;
    }
    const nativeTimelineTransforms = isStudioNativeWorkspaceScene(activeEditorScene)
      ? timelineTransformsForPrograms(input.sourcePrograms)
      : null;
    if (nativeTimelineTransforms === undefined) {
      setDraftError("Wait for the Rust authoring projection before creating another edit.");
      setIsPlaying(false);
      return null;
    }
    const nativeSourceTime = isStudioNativeWorkspaceScene(activeEditorScene)
      ? clamp(
          nativeTimelineTransforms
            ? workingTimeToSourceTimeFromProjection(nativeTimelineTransforms, currentTime)
            : workingTimeToSourceTimeWithoutTimeline(input.sourcePrograms, currentTime),
          0,
          input.scene.duration,
        )
      : null;
    const sourceAnchor =
      nativeSourceTime !== null
        ? {
            sourceTime: nativeSourceTime,
            workingTime: nativeTimelineTransforms
              ? sourceTimeToWorkingTimeFromProjection(nativeTimelineTransforms, nativeSourceTime)
              : sourceTimeToWorkingTimeWithoutTimeline(input.sourcePrograms, nativeSourceTime),
          }
        : latestSafeSourceAnchor(input.sourcePrograms, activeEditorScene.anchors, currentTime);
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
      playbackSeekPendingRef.current = playbackClock.getSnapshot().playing;
      setCurrentTime(anchor.workingTime);
      setIsPlaying(false);
      setDraftError(
        `Moved the playhead to the latest safe .py source anchor at ${anchor.workingTime.toFixed(2)}s. Repeat the ${input.action}.`,
      );
      return null;
    }
    return anchor;
  }

  function blockTransformWhileTransformTrackExists(targetEntityIds: readonly string[], action: string) {
    const scaleBlockedEntityId = scaleKeyframeTransformConflictEntity(transformTrackPrograms, targetEntityIds);
    const rotationBlockedEntityId = rotationKeyframeTransformConflictEntity(transformTrackPrograms, targetEntityIds);
    const blockedEntityId = scaleBlockedEntityId ?? rotationBlockedEntityId;
    if (!blockedEntityId) return false;
    setSelectedObjectIds([blockedEntityId]);
    setDraftError(
      `Remove this object's ${scaleBlockedEntityId ? "scale" : "rotation"} keyframe track before ${action}.`,
    );
    setIsPlaying(false);
    return true;
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
    if (
      blockTransformWhileTransformTrackExists(
        targetEntityIds,
        interactionMode === "animate" ? "creating a motion clip" : "moving it",
      )
    )
      return;
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
              objects: preparedSnapBasis.objects?.filter(({ entityId }) => !snapTargetIds.has(entityId)),
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
    if (!activeEditorScene || !draftBaseState || !draftSourceScene) return;
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
    preparedResizeBasis: PreparedMoveSnapBasis | null,
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
    if (blockTransformWhileTransformTrackExists([entityId], "resizing it")) return;
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
    if (studioResizeUnavailableIds.has(entity.id)) {
      setSelectedObjectIds([entity.id]);
      setDraftError(
        "Resize is unavailable for this object's base rotation until local transform composition is supported.",
      );
      return;
    }
    const uniformScaleResizeOnly =
      runtimeTraceEditCandidateFor(entity.id) !== null || studioUniformScaleResizeOnlyIds.has(entity.id);
    const shape = uniformScaleResizeOnly ? null : resizeKindForType(entity.type);
    const unknownGeometry = entity.geometry.scale.kind === "unknown" ? entity.geometry.scale : null;
    if (unknownGeometry) {
      setDraftError(`Studio cannot resize ${entityLabel(entity)} safely: ${unknownGeometry.reason}`);
      return;
    }
    const shapeResizeAvailable =
      shape !== null &&
      entity.geometry.dimensions.kind === "known" &&
      entity.geometry.position.kind === "known" &&
      hasShapeDimensions(shape, entity.geometry.dimensions.value);
    const preparedScaleResizeAvailable =
      preparedResizeBasis !== null &&
      preparedResizeBasis.entityIds.length === 1 &&
      preparedResizeBasis.entityIds[0] === entityId;
    if (!shapeResizeAvailable && !preparedScaleResizeAvailable) {
      setDraftError(`Studio cannot resize ${entityLabel(entity)} until its prepared WebGPU bounds are available.`);
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
    const canvasBounds = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]")?.getBoundingClientRect();
    if (!canvasBounds) return;
    setSelectedObjectIds([entityId]);
    setIsPlaying(false);
    const surfaceBounds = {
      height: canvasBounds.height,
      left: canvasBounds.left,
      top: canvasBounds.top,
      width: canvasBounds.width,
    };
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
    if (shapeResizeAvailable && shape && entity.geometry.dimensions.kind === "known") {
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
      if (!preparedResizeBasis) return;
      const gesture = createSingleScaleResizeGesture({
        basis: preparedResizeBasis,
        entityId,
        frame: { bottom: STUDIO_VIEWPORT.height, left: 0, right: STUDIO_VIEWPORT.width, top: 0 },
        fromScale: entity.scale,
        maximumScale: MAX_ENTITY_SCALE,
        minimumScale: MIN_ENTITY_SCALE,
        startClient: { x: event.clientX, y: event.clientY },
        surfaceBounds,
      });
      if (!gesture) {
        setDraftError(`Studio cannot resize ${entityLabel(entity)} until its prepared WebGPU bounds are available.`);
        return;
      }
      canvasResize.current = {
        ...base,
        gesture,
        mode: "scale",
      };
      gesturePreviewStore.setScalePreview({ entityId, guides: [], scale: entity.scale });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveEntityResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.mode === "shape") {
      const geometry = resizedShapeGeometry(resize, { x: event.clientX, y: event.clientY }, event.shiftKey);
      gesturePreviewStore.setGeometryPreview({ ...geometry, entityId: resize.entityId });
    } else {
      const preview = resizedEntityScale(resize, { x: event.clientX, y: event.clientY }, event.altKey);
      gesturePreviewStore.setScalePreview({
        entityId: resize.entityId,
        ...preview,
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
      const target = resizedShapeGeometry(resize, { x: event.clientX, y: event.clientY }, event.shiftKey);
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
    const targetScale = resizedEntityScale(resize, { x: event.clientX, y: event.clientY }, event.altKey).scale;
    if (Math.abs(targetScale - resize.gesture.fromScale) < 0.01) return;
    installEntityScaleDraft(
      resize.entityId,
      resize.gesture.fromScale,
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
    if (blockTransformWhileTransformTrackExists(selectedObjectIds, "resizing the selection")) return null;
    if (interactionMode !== "position" || previewSelectionOnly || boundedRuntimeEditTargetIds.size > 0) return null;
    const selectedEntities = selectedObjectIds.flatMap((entityId) => {
      const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
      return entity ? [entity] : [];
    });
    const selectedTargets = selectedEntities.flatMap(
      (
        entity,
      ): readonly Readonly<{
        authority: "imported" | "studio-created";
        entityId: string;
        fromPosition: Point;
        fromScale: number;
      }>[] => {
        const transform = currentCreationTransformForEntity(workspaceEntityCreationProjection, entity.id);
        if (transform) {
          return [
            {
              authority: "studio-created" as const,
              entityId: entity.id,
              fromPosition: transform.transformOrigin,
              fromScale: entity.scale,
            },
          ];
        }
        if (
          activeEditorScene &&
          !isStudioNativeWorkspaceScene(activeEditorScene) &&
          !entity.provisional &&
          entity.sourceIdentity.kind === "known" &&
          entity.geometry.position.kind === "known" &&
          entity.geometry.scale.kind === "known"
        ) {
          return [
            {
              authority: "imported" as const,
              entityId: entity.id,
              fromPosition:
                latestCreationPositionForEntity(workspaceStaticRootProjection, entity.id) ??
                entity.geometry.position.value,
              fromScale: entity.geometry.scale.value,
            },
          ];
        }
        return [];
      },
    );
    const authorities = new Set(selectedTargets.map(({ authority }) => authority));
    const importedSelection = authorities.size === 1 && authorities.has("imported");
    if (
      selectedEntities.length < 2 ||
      (importedSelection && selectedEntities.length > 8) ||
      selectedEntities.length !== selectedObjectIds.length ||
      selectedTargets.length !== selectedEntities.length ||
      authorities.size !== 1 ||
      selectedEntities.some(
        (entity) =>
          !groupResizeEligibleIds.has(entity.id) ||
          entity.geometry.position.kind === "unknown" ||
          entity.geometry.scale.kind === "unknown" ||
          (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId))),
      )
    ) {
      setDraftError(
        "Group resize requires 2–8 objects from one supported authority; imported objects must be independent static roots with position/resize/rotation history.",
      );
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
    if (importedSelection && Math.abs(anchor.sourceTime) >= 0.0005) {
      setDraftError("Imported static-root group resize currently requires the source-time-zero anchor.");
      return null;
    }
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
      targets: selectedTargets.map(({ entityId, fromPosition, fromScale }) => ({
        entityId,
        fromPosition,
        fromScale,
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
    gesturePreviewStore.setGroupResizePreview(resizeSelectionAtPoint(resize, point, event.altKey).preview);
  }

  function finishSelectionResize(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = canvasGroupResize.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    canvasGroupResize.current = null;
    gesturePreviewStore.clear();
    const point = clientPointToViewport(resize.surfaceBounds, { x: event.clientX, y: event.clientY });
    const { factor, preview } = resizeSelectionAtPoint(resize, point, event.altKey);
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
    const grows = resizeHandleDeltaIsOutward(direction, NUDGE_DELTAS[event.key]!);
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
    const selectedTargets = selectedEntities.flatMap(
      (
        entity,
      ): readonly Readonly<{
        authority: "imported" | "studio-created";
        entityId: string;
        fromPosition: Point;
      }>[] => {
        const createdPosition = latestCreationPositionForEntity(workspaceEntityCreationProjection, entity.id);
        if (createdPosition)
          return [{ authority: "studio-created" as const, entityId: entity.id, fromPosition: createdPosition }];
        if (
          activeEditorScene &&
          !isStudioNativeWorkspaceScene(activeEditorScene) &&
          !entity.provisional &&
          entity.sourceIdentity.kind === "known" &&
          entity.geometry.position.kind === "known"
        ) {
          return [
            {
              authority: "imported" as const,
              entityId: entity.id,
              fromPosition:
                latestCreationPositionForEntity(workspaceStaticRootProjection, entity.id) ??
                entity.geometry.position.value,
            },
          ];
        }
        return [];
      },
    );
    const authorities = new Set(selectedTargets.map(({ authority }) => authority));
    const importedSelection = authorities.size === 1 && authorities.has("imported");
    if (
      selectedEntities.length < 2 ||
      (importedSelection && selectedEntities.length > 8) ||
      selectedEntities.length !== selectedObjectIds.length ||
      selectedTargets.length !== selectedEntities.length ||
      authorities.size !== 1 ||
      selectedEntities.some(
        (entity) =>
          !groupRotationEligibleIds.has(entity.id) ||
          entity.geometry.position.kind === "unknown" ||
          (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId))),
      )
    ) {
      setDraftError(
        "Group rotation requires 2–8 objects from one supported authority; imported objects must be independent static roots with position/resize/rotation history.",
      );
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
    if (importedSelection && Math.abs(anchor.sourceTime) >= 0.0005) {
      setDraftError("Imported static-root group rotation currently requires the source-time-zero anchor.");
      return null;
    }
    return createSelectionRotationGesture({
      basis,
      cameraScale: projection?.camera.scale ?? 1,
      pointerId,
      sourceAnchor: anchor.sourceTime,
      start,
      surfaceBounds,
      targets: selectedTargets.map(({ entityId, fromPosition }) => ({ entityId, fromPosition })),
    });
  }

  function installSelectionRotationDraft(rotation: SelectionRotationGesture, angleRadians: number) {
    if (
      blockTransformWhileTransformTrackExists(
        rotation.entities.map(({ entityId }) => entityId),
        "rotating the selection",
      )
    )
      return false;
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
    if (studioResizeUnavailableIds.has(entity.id)) {
      setSelectedObjectIds([entity.id]);
      setDraftError(
        "Resize is unavailable for this object's base rotation until local transform composition is supported.",
      );
      return;
    }
    const uniformScaleResizeOnly =
      runtimeTraceEditCandidateFor(entity.id) !== null || studioUniformScaleResizeOnlyIds.has(entity.id);
    const shape = uniformScaleResizeOnly ? null : resizeKindForType(entity.type);
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
    const grow = resizeHandleDeltaIsOutward(handle, delta);
    const factor = event.shiftKey ? 1.25 : 1.05;
    const targetScale = clamp(grow ? entity.scale * factor : entity.scale / factor, MIN_ENTITY_SCALE, MAX_ENTITY_SCALE);
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
    if (!activeEditorScene || !draftBaseState) return false;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return false;
    }
    if (blockTransformWhileTransformTrackExists([entityId], "resizing it")) return false;
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
    if (!activeEditorScene || !draftBaseState) return false;
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before resizing another object.");
      return false;
    }
    if (blockTransformWhileTransformTrackExists([entityId], "resizing it")) return false;
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
    if (studioResizeUnavailableIds.has(entity.id)) {
      setDraftError(
        "Resize is unavailable for this object's base rotation until local transform composition is supported.",
      );
      return false;
    }
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
    if (blockTransformWhileTransformTrackExists([entityId], "rotating it")) return false;
    const createdAuthority = studioCreationStaticTransformAuthorityFor(entityId);
    const authority = runtimeTraceProjectionAuthorityFor(entityId);
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
    const entity = editableEntities.find((candidate) => candidate.id === entityId);
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    if (createdAuthority && entity?.type === "ImageMobject") {
      setDraftError("Use Timeline opacity keyframes for Images.");
      return false;
    }
    const authority = runtimeTraceProjectionAuthorityFor(entityId);
    if (!createdAuthority && (!authority?.capabilities.paintOpacity || !("baseOpacity" in authority))) {
      setDraftError("Opacity requires a Studio-created object or one exact updater-free Runtime Trace binding.");
      return false;
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      setDraftError("Opacity must be a number from 0 to 1.");
      return false;
    }
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
    const colorableTypes =
      property === "fillColor"
        ? ["Circle", "CubicBezier", "Ellipse", "MathTex", "Rectangle", "RegularPolygon", "Sector", "Text", "Triangle"]
        : [
            "Arc",
            "Arrow",
            "Axes",
            "Circle",
            "CubicBezier",
            "DataPlot",
            "Ellipse",
            "Line",
            "NumberLine",
            "NumberPlane",
            "Rectangle",
            "RegularPolygon",
            "Sector",
            "Triangle",
          ];
    if (!createdAuthority || !entity || !colorableTypes.includes(entity.type)) {
      setDraftError(`This object does not support a ${property === "fillColor" ? "fill" : "stroke"} color.`);
      return false;
    }
    if (paintColorTracks.some((track) => track.entityId === entityId)) {
      setDraftError("Remove the paint color track before changing the object's static color.");
      return false;
    }
    if (property === "fillColor" && sceneProgramsHaveDrawIn(previewAppliedSceneEdits, entityId)) {
      setDraftError("Remove Draw before adding a fill to this object.");
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
    if (property === "fillColor" && entity.type === "CubicBezier") {
      const owned = cubicBezierOwnedCreation(entityId);
      if (!owned?.creation.entity.cubicBezier?.closed) {
        setDraftError("Close the Pen path before setting its fill color.");
        return false;
      }
      return changeCubicBezierStyle(entityId, { fillColor: normalizedColor });
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

  function setEntityStrokeWidthFromInspector(entityId: string, strokeWidth: number) {
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!createdAuthority || !entity || !studioEntityTypeSupportsStrokeWidth(entity.type)) {
      setDraftError("Stroke width is available only for a supported Studio-created object.");
      return false;
    }
    if (!Number.isFinite(strokeWidth) || strokeWidth < 0.005 || strokeWidth > 0.5) {
      setDraftError("Stroke width must be from 0.005 to 0.5 scene units.");
      return false;
    }
    const currentWidth =
      entity.geometry.style.kind === "known" ? (entity.geometry.style.value.strokeWidth ?? 0.04) : null;
    if (currentWidth !== null && Math.abs(currentWidth - strokeWidth) < 0.0005) return false;
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "stroke width edit",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor || Math.abs(anchor.sourceTime - createdAuthority.sourceAnchor) >= 0.0005) return false;
    try {
      const validation = createDirectManipulationStrokeWidthProgram({
        capturedPlayhead: createdAuthority.sourceAnchor,
        entityId,
        scene: sourceScene,
        start: createdAuthority.sourceAnchor,
        strokeWidth,
        transactionId: `studio-stroke-width-input-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, createdAuthority.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The object stroke width could not be changed.");
      return false;
    }
  }

  function setEntityStrokeCapFromInspector(entityId: string, strokeCap: "butt" | "round" | "square") {
    if (previewSelectionOnly || boundedRuntimeMutationIsLocked(entityId)) return false;
    const createdAuthority = studioCreationAppearanceAuthorityFor(entityId);
    const entity = editableEntities.find((candidate) => candidate.id === entityId && candidate.present);
    if (!createdAuthority || !entity || !studioEntityTypeSupportsStrokeCap(entity.type)) {
      setDraftError("Stroke cap is available only for a supported Studio-created open path.");
      return false;
    }
    const currentCap =
      entity.geometry.style.kind === "known" ? (entity.geometry.style.value.strokeCap ?? "butt") : null;
    if (currentCap === strokeCap) return false;
    const gestureContext = directGestureContext();
    if (!gestureContext.proposedState) return false;
    const sourceScene = projectRuntimeSceneToSourceTimeline(
      gestureContext.proposedState.evaluatedScene,
      gestureContext.sourcePrograms,
    );
    const anchor = manualAuthoringAnchor({
      action: "stroke cap edit",
      allowSyntheticPreviewAnchor: true,
      requireAlignedPlayhead: true,
      scene: sourceScene,
      sourcePrograms: gestureContext.sourcePrograms,
      targetEntityIds: [entityId],
    });
    if (!anchor || Math.abs(anchor.sourceTime - createdAuthority.sourceAnchor) >= 0.0005) return false;
    try {
      const validation = createDirectManipulationStrokeCapProgram({
        capturedPlayhead: createdAuthority.sourceAnchor,
        entityId,
        scene: sourceScene,
        start: createdAuthority.sourceAnchor,
        strokeCap,
        transactionId: `studio-stroke-cap-input-${crypto.randomUUID()}`,
      });
      return acceptDirectManipulationDraft(validation, gestureContext, createdAuthority.sourceAnchor);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The path stroke cap could not be changed.");
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
    if (
      (edits.position || edits.dimensions) &&
      blockTransformWhileTransformTrackExists([entityId], "transforming it")
    ) {
      return false;
    }
    const replacesStudioCreatedContent =
      edits.content !== undefined &&
      (entity.type === "Text" || entity.type === "MathTex") &&
      entity.sourceIdentity.kind === "unknown" &&
      Boolean(entity.transactionId);
    if (replacesStudioCreatedContent) {
      if (edits.position || edits.dimensions) {
        setDraftError("Apply content separately from position or size changes.");
        return false;
      }
      if (draftEdit) {
        setDraftError("Apply or discard the current draft before editing content.");
        return false;
      }
      const owner = findStudioLifetimeOwner(appliedEdits, entityId);
      if (!owner || owner.record.program.transactionId !== entity.transactionId) {
        setDraftError("The Studio-created content has no unique creation owner.");
        return false;
      }
      try {
        const preceding = sourceSceneBeforeAppliedProgram(owner.index);
        const validation = replaceStudioCreatedContentProgram({
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
        setDraftError(error instanceof Error ? error.message : "The creation Program content could not be updated.");
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
    absolutePositions?: Readonly<Record<string, Point>>,
  ) {
    if (editingAppliedProgram) {
      setDraftError("Apply or discard the Applied Program edit before moving another object.");
      return false;
    }
    if (blockTransformWhileTransformTrackExists(targetIds, "moving it")) return false;
    if (!gestureContext.proposedState || !projection) return false;
    const projected = absolutePositions
      ? { kind: "valid" as const, positions: absolutePositions }
      : projectedPositions(editableEntities, targetIds);
    if (projected.kind === "invalid") {
      setDraftError(projected.message);
      return false;
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
    if (!anchor) return false;
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
      return false;
    }
    cancelSuggestionRequest();
    return stageDraft({
      clearAppliedEdit: true,
      clearSuggestion: true,
      currentTime: sourceTimeToWorkingTime(gestureContext.sourcePrograms, anchor.sourceTime),
      operation: null,
      preserveAppliedProgram: gestureContext.preserveDraft,
      record: validated.record,
      stopPlayback: true,
    });
  }

  function arrangeSelection(command: SelectionLayoutCommand) {
    if (!selectionLayoutBasis) {
      setDraftError(selectionLayoutUnavailableReason ?? "The selected objects cannot be arranged.");
      return false;
    }
    const plan = planSelectionLayout(command, selectionLayoutBasis);
    if (plan.kind === "unavailable") {
      setDraftError(plan.reason);
      return false;
    }
    return installPositionDraft(
      { x: 0, y: 0 },
      plan.targetEntityIds,
      `studio-layout-${crypto.randomUUID()}`,
      undefined,
      undefined,
      plan.positions,
    );
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

  function activateStudioTool(tool: StudioTool) {
    cubicBezierAuthoringGeneration.current += 1;
    setInlineTextEditor(null);
    setCubicBezierExtensionEntityId(null);
    setCubicBezierPenPoints([]);
    setInsertTool(tool);
  }

  function handleStudioCommand(command: StudioCommandId) {
    if (isPlaying && command !== "play-pause") {
      setDraftError("Pause playback before editing the Scene.");
      return false;
    }
    if (studioAuthoringLocked) {
      setDraftError(readDurationBlocker() ?? EDITOR_SESSION_LOADING_BLOCKER);
      return false;
    }
    if (command === "undo") {
      return undoProgramCommitFirst();
    }
    if (command === "redo") return redoProgram();
    if (command === "escape") {
      cubicBezierAuthoringGeneration.current += 1;
      if (cubicBezierExtensionEntityId) {
        setCubicBezierExtensionEntityId(null);
        return true;
      }
      if (cubicBezierPenPoints.length > 0) {
        setCubicBezierPenPoints([]);
        return true;
      }
      if (inlineTextEditor) {
        cancelInlineTextEdit();
        return true;
      }
      if (insertTool !== "select") {
        activateStudioTool("select");
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
      "insert-arc": "Arc",
      "insert-arrow": "Arrow",
      "insert-axes": "Axes",
      "insert-circle": "Circle",
      "insert-cubic-bezier": "CubicBezier",
      "insert-ellipse": "Ellipse",
      "insert-line": "Line",
      "insert-mathtex": "MathTex",
      "insert-number-line": "NumberLine",
      "insert-number-plane": "NumberPlane",
      "insert-regular-polygon": "RegularPolygon",
      "insert-rectangle": "Rectangle",
      "insert-sector": "Sector",
      "insert-text": "Text",
      "insert-triangle": "Triangle",
      "select-tool": "select",
    };
    const tool = toolByCommand[command];
    if (tool === "select") {
      activateStudioTool(tool);
      return true;
    }
    if (!previewPaintAvailable) {
      setDraftError("Wait for the canonical WebGPU preview before editing the Scene.");
      return false;
    }
    if (tool) {
      activateStudioTool(tool);
      return true;
    }
    if (command === "group") return groupLayerSelection();
    if (command === "ungroup") {
      return selectedLayerGroup?.groupId ? ungroupLayer(selectedLayerGroup.groupId) : false;
    }
    if (isSelectionLayoutCommand(command)) return arrangeSelection(command);
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
      if (!activeEditorScene) return false;
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
  const selectedCubicBezierCreation =
    selectedEntity?.type === "CubicBezier" && !draftEdit && !editingAppliedProgram
      ? cubicBezierOwnedCreation(selectedEntity.id)
      : null;
  const selectedCubicBezierControls = (() => {
    const cubicBezier = selectedCubicBezierCreation?.creation.entity.cubicBezier;
    if (!selectedCubicBezierCreation || !cubicBezier) return null;
    const frame = workspace?.frame ?? { height: 8, width: 14.222 };
    const toViewport = (point: Point) => {
      const offset = viewportOffsetFromScene(point, frame);
      return {
        x: selectedCubicBezierCreation.position.x + offset.x,
        y: selectedCubicBezierCreation.position.y + offset.y,
      };
    };
    return {
      entityId: selectedCubicBezierCreation.creation.entity.id,
      segments: [
        { control1: cubicBezier.control1, control2: cubicBezier.control2, end: cubicBezier.end },
        ...(cubicBezier.continuationSegments ?? []),
      ].map((segment) => ({
        control1: toViewport(segment.control1),
        control2: toViewport(segment.control2),
        end: toViewport(segment.end),
      })),
      start: toViewport(cubicBezier.start),
    } as const;
  })();
  const selectedCubicBezierStyle = selectedCubicBezierCreation?.creation.entity.cubicBezier
    ? {
        arrowEnd: selectedCubicBezierCreation.creation.entity.cubicBezier.arrowEnd,
        closed: selectedCubicBezierCreation.creation.entity.cubicBezier.closed ?? false,
        entityId: selectedCubicBezierCreation.creation.entity.id,
        extensionActive: cubicBezierExtensionEntityId === selectedCubicBezierCreation.creation.entity.id,
        segmentCount: 1 + (selectedCubicBezierCreation.creation.entity.cubicBezier.continuationSegments?.length ?? 0),
        strokeCap: selectedCubicBezierCreation.creation.entity.cubicBezier.strokeCap,
        strokeWidth: selectedCubicBezierCreation.creation.entity.cubicBezier.strokeWidth,
      }
    : null;
  const selectedDataPlotAuthoring: DataPlotInspectorAuthoring | undefined = (() => {
    if (!selectedEntity || (selectedEntity.type !== "Axes" && selectedEntity.type !== "DataPlot")) return undefined;
    const owned = studioOwnedCreation(selectedEntity.id, selectedEntity.type);
    const dimensions: EntityDimensions =
      owned?.creation.entity.dimensions ??
      (selectedEntity.geometry.dimensions.kind === "known" ? selectedEntity.geometry.dimensions.value : {});
    if (selectedEntity.type === "Axes") {
      return {
        dimensions,
        entityId: selectedEntity.id,
        initialDataSeries: null,
        mode: "add",
        onSubmit: (dataSeries: DataSeries) => addDataPlotFromAxes(selectedEntity.id, dataSeries),
        unavailableReason: dataPlotAxesUnavailableReason(selectedEntity),
      };
    }
    return {
      dimensions,
      entityId: selectedEntity.id,
      initialDataSeries: owned?.creation.entity.dataSeries ?? null,
      mode: "update",
      onSubmit: (dataSeries: DataSeries) => updateDataPlot(selectedEntity.id, dataSeries),
      unavailableReason: dataPlotUpdateUnavailableReason(selectedEntity),
    };
  })();
  const selectedFragmentMaterialEntity = selectedSet.size === 1 ? selectedEntity : null;
  const selectedFragmentMaterialAssignment = selectedFragmentMaterialEntity
    ? (activeSceneFragmentMaterials.assignments[selectedFragmentMaterialEntity.id] ?? null)
    : null;
  const selectedFragmentMaterialAssigned = selectedFragmentMaterialAssignment !== null;
  const selectedFragmentMaterialPaintColorTrack = selectedFragmentMaterialEntity
    ? (paintColorTracks.find((track) => track.entityId === selectedFragmentMaterialEntity.id) ?? null)
    : null;
  const selectedSvgPathHasFill = selectedFragmentMaterialEntity
    ? (previewAppliedEdits
        .map(({ program }) => studioSvgPathFillState(program, selectedFragmentMaterialEntity.id))
        .find((hasFill) => hasFill !== null) ?? null)
    : null;
  const selectedEntranceMaterialBlocker = selectedFragmentMaterialEntity
    ? sceneProgramsHaveDrawIn(previewAppliedSceneEdits, selectedFragmentMaterialEntity.id)
      ? "Remove Draw before assigning a fragment material to this object."
      : sceneProgramsHaveWriteIn(previewAppliedSceneEdits, selectedFragmentMaterialEntity.id)
        ? "Remove Write before assigning a fragment material to this object."
        : null
    : null;
  const selectedFragmentMaterialAvailable =
    previewMutationAvailable &&
    draftEdit === null &&
    !selectedEntityLocked &&
    selectedFragmentMaterialEntity !== null &&
    selectedFragmentMaterialPaintColorTrack === null &&
    selectedFragmentMaterialEntity.geometry.style.kind === "known" &&
    ((selectedFragmentMaterialEntity.geometry.style.value.fillColor !== undefined &&
      selectedFragmentMaterialEntity.geometry.style.value.fillColor !== null) ||
      selectedSvgPathHasFill === true);
  const activeSceneHasFragmentMaterialAssignments = sceneHasFragmentMaterialAssignmentsV1(activeSceneFragmentMaterials);
  const activeSceneFragmentMaterialCompileError = studioFragmentMaterialCompileErrorV1(
    activeSceneFragmentMaterials,
    previewRenderer?.state,
  );
  const sourceFragmentMaterialExportBlocker = activeSceneHasFragmentMaterialAssignments
    ? "Manim .py export does not support project-local WGSL fragment materials. Remove them before exporting source."
    : null;
  const studioNativeExportLineage =
    studioExportSource?.sourceLineage && "origin" in studioExportSource.sourceLineage
      ? studioExportSource.sourceLineage
      : null;
  const studioNativeExportPreviewAligned =
    nativeSceneActive &&
    activeProjectId !== null &&
    activeEditorScene !== null &&
    isStudioNativeWorkspaceScene(activeEditorScene) &&
    studioNativeExportLineage?.origin === "studio-native" &&
    studioNativeExportLineage.projectId === activeProjectId &&
    studioNativeExportLineage.documentKey === activeEditorScene.identity.documentKey &&
    studioNativeExportLineage.sceneId === activeEditorScene.sceneId &&
    studioNativeExportLineage.workingRevision === editorRevision.workingRevision;
  const studioNativeManimSourceExport =
    nativeSceneActive && activeProjectId && activeEditorScene && isStudioNativeWorkspaceScene(activeEditorScene)
      ? {
          blocker: !editorDocumentPresentationReady
            ? "Wait for the Studio document to finish loading before exporting source."
            : !studioNativeExportPreviewAligned
              ? "Wait for the canonical preview to present this exact Studio revision before exporting source."
              : sourceFragmentMaterialExportBlocker,
          request:
            studioNativeExportPreviewAligned && studioExportSource && nativePreviewBundle
              ? {
                  baseDuration: nativePreviewBundle.scene.duration,
                  documentKey: activeEditorScene.identity.documentKey,
                  duration: studioExportSource.bundle.scene.duration,
                  fragmentMaterialEntityIds: Object.keys(activeSceneFragmentMaterials.assignments),
                  kind: "studio-native" as const,
                  programs: renderPrograms,
                  projectId: activeProjectId,
                  viewport: STUDIO_VIEWPORT,
                }
              : null,
        }
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
    if (nativeSceneActive) {
      if (!activeProjectId || !activeEditorScene || !isStudioNativeWorkspaceScene(activeEditorScene)) return false;
      const documentKey = activeEditorScene.identity.documentKey;
      if (
        !nativeProjectState ||
        nativeProjectState.projectId !== activeProjectId ||
        nativeProjectState.documentKey !== documentKey
      )
        return false;
      const updated = { ...nativeProjectState, fragmentMaterials: next };
      nativeProjectStates.current.set(tabLocalNativeProjectKey(activeProjectId, documentKey), updated);
      setNativeProjectState(updated);
      void nativeProjectLocalStore
        ?.save({ documentKey, projectId: activeProjectId }, updated)
        .catch((cause: unknown) => {
          setDraftError(cause instanceof Error ? cause.message : "The native project materials could not be saved.");
        });
      return true;
    }
    return activeProjectId ? commitProjectFragmentMaterials(activeProjectId, next) : false;
  }

  async function commitFragmentMaterialRemoval(next: ProjectFragmentMaterialStateV1) {
    if (!nativeSceneActive) return activeProjectId ? commitProjectFragmentMaterials(activeProjectId, next) : false;
    if (nativeProjectAssetPending) {
      setDraftError("Wait for the current project image import to finish before deleting a material.");
      return false;
    }
    if (!activeProjectId || !activeEditorScene || !isStudioNativeWorkspaceScene(activeEditorScene)) return false;
    const documentKey = activeEditorScene.identity.documentKey;
    if (
      !nativeProjectState ||
      nativeProjectState.projectId !== activeProjectId ||
      nativeProjectState.documentKey !== documentKey ||
      !nativeProjectLocalStore
    )
      return false;
    const generation = nativeProjectAssetGeneration.current;
    const stateKey = tabLocalNativeProjectKey(activeProjectId, documentKey);
    const updated = { ...nativeProjectState, fragmentMaterials: next };
    try {
      await nativeProjectLocalStore.save({ documentKey, projectId: activeProjectId }, updated);
    } catch (cause) {
      setDraftError(cause instanceof Error ? cause.message : "The native project materials could not be saved.");
      return false;
    }
    nativeProjectStates.current.set(stateKey, updated);
    if (nativeProjectAssetGeneration.current === generation) setNativeProjectState(updated);
    return true;
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

  function createFragmentMaterialPreset(preset: StudioFragmentMaterialPresetId) {
    try {
      if (activeEditorScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable) {
        if (selectedEntranceMaterialBlocker) throw new Error(selectedEntranceMaterialBlocker);
        const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, {
          entityId: selectedFragmentMaterialEntity.id,
        });
        if (blocker) throw new Error(blocker);
      }
      const created =
        preset === "gradient"
          ? createStudioGradientFragmentMaterialPresetV1(activeProjectFragmentMaterials)
          : preset === "pulse"
            ? createStudioPulseFragmentMaterialPresetV1(activeProjectFragmentMaterials)
            : createStudioWaveFragmentMaterialPresetV1(activeProjectFragmentMaterials);
      const next =
        activeEditorScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable
          ? assignStudioFragmentMaterialV1(created.state, {
              entityId: selectedFragmentMaterialEntity.id,
              sceneId: activeEditorScene.sceneId,
              shaderId: created.shaderId,
            })
          : created.state;
      return commitActiveProjectFragmentMaterials(next) ? created.shaderId : null;
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material preset could not be created.");
      return null;
    }
  }

  function createTextureFragmentMaterialPreset() {
    try {
      if (activeEditorScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable) {
        if (selectedEntranceMaterialBlocker) throw new Error(selectedEntranceMaterialBlocker);
        const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, {
          entityId: selectedFragmentMaterialEntity.id,
        });
        if (blocker) throw new Error(blocker);
      }
      const created = createStudioTextureFragmentMaterialPresetV1(activeProjectFragmentMaterials);
      const asset = activeFragmentMaterialTextureAssets[0];
      const next =
        activeEditorScene && selectedFragmentMaterialEntity && selectedFragmentMaterialAvailable && asset
          ? assignStudioFragmentMaterialV1(created.state, {
              entityId: selectedFragmentMaterialEntity.id,
              sceneId: activeEditorScene.sceneId,
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

  async function removeFragmentMaterialAsset(shaderId: string, resolution: StudioFragmentMaterialRemovalResolution) {
    try {
      if (!activeProjectId) throw new Error("No project is open.");
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, { shaderId });
      if (blocker) throw new Error(blocker);
      if (projectHasLocalMaterialParameterTrack(activeProjectId, shaderId)) {
        throw new Error(
          "Remove this material's parameter tracks from every Scene and its Undo/Redo history before deleting it.",
        );
      }
      const result = removeStudioFragmentMaterialAssetV1(activeProjectFragmentMaterials, shaderId, resolution);
      if (result.kind === "in-use") {
        setDraftError(`Unassign this material from ${result.assignmentCount} object(s) before deleting it.`);
        return false;
      }
      return await commitFragmentMaterialRemoval(result.state);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material could not be deleted.");
      return false;
    }
  }

  function updateFragmentMaterialSource(shaderId: string, source: string) {
    try {
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, { shaderId });
      if (blocker) throw new Error(blocker);
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialSourceV1(activeProjectFragmentMaterials, { shaderId, source }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The fragment material source is invalid.");
    }
  }

  function updateFragmentMaterialParameterSchema(
    shaderId: string,
    parameterSchema: StudioFragmentMaterialParameterSchemaV1,
  ) {
    try {
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, { shaderId });
      if (blocker) throw new Error(blocker);
      const next = updateStudioFragmentMaterialParameterSchemaV1(activeProjectFragmentMaterials, {
        parameterSchema,
        shaderId,
      });
      return commitActiveProjectFragmentMaterials(next) ? null : "The material parameter schema could not be saved.";
    } catch (error) {
      return error instanceof Error ? error.message : "The material parameter schema could not be updated.";
    }
  }

  async function importFragmentMaterialGlsl(shaderId: string, input: Readonly<{ entryPoint: "main"; source: string }>) {
    if (!activeProjectId) throw new Error("No project is open.");
    const projectId = activeProjectId;
    const expectedMaterial = activeProjectFragmentMaterials.registry.materials.find(
      (material) => material.shaderId === shaderId,
    );
    if (!expectedMaterial) throw new Error("The material no longer exists.");
    const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, { shaderId });
    if (blocker) throw new Error(blocker);
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
    const commitBlocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, { shaderId });
    if (commitBlocker) throw new Error(commitBlocker);
    if (!commitProjectFragmentMaterials(projectId, next)) {
      throw new Error("The compiled GLSL material could not be saved.");
    }
  }

  function assignSelectedFragmentMaterial(shaderId: string | null) {
    if (!activeEditorScene || !selectedFragmentMaterialEntity) {
      return;
    }
    if (shaderId !== null && selectedFragmentMaterialPaintColorTrack) {
      setDraftError("Remove the paint color track before assigning a fragment material to this object.");
      return;
    }
    if (shaderId !== null && !selectedFragmentMaterialAvailable) return;
    if (rejectLockedEntityMutation(selectedFragmentMaterialEntity.id)) return;
    try {
      if (shaderId !== null && selectedEntranceMaterialBlocker) throw new Error(selectedEntranceMaterialBlocker);
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
            sceneId: activeEditorScene.sceneId,
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
            sceneId: activeEditorScene.sceneId,
          });
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, {
        entityId: selectedFragmentMaterialEntity.id,
      });
      if (
        blocker &&
        JSON.stringify(next.assignmentsByScene[activeEditorScene.sceneId]?.[selectedFragmentMaterialEntity.id]) !==
          JSON.stringify(selectedFragmentMaterialAssignment)
      ) {
        throw new Error(blocker);
      }
      commitActiveProjectFragmentMaterials(next);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material assignment could not be updated.");
    }
  }

  function updateSelectedFragmentMaterialTexture(assetId: string, sampler: "linear" | "nearest") {
    if (!activeEditorScene || !selectedFragmentMaterialEntity || !selectedFragmentMaterialAssignment) return;
    if (rejectLockedEntityMutation(selectedFragmentMaterialEntity.id)) return;
    const asset = activeFragmentMaterialTextureAssets.find(({ id }) => id === assetId);
    if (!asset) {
      setDraftError("The selected project PNG is no longer available.");
      return;
    }
    try {
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, {
        entityId: selectedFragmentMaterialEntity.id,
      });
      if (blocker) throw new Error(blocker);
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialTextureV1(activeProjectFragmentMaterials, {
          entityId: selectedFragmentMaterialEntity.id,
          sceneId: activeEditorScene.sceneId,
          texture: { asset: { assetId: asset.id, sha256: asset.sha256 }, sampler },
        }),
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "The material texture could not be updated.");
    }
  }

  function updateSelectedFragmentMaterialParameter(name: string, value: StudioFragmentMaterialParameterValueV1) {
    if (
      !activeEditorScene ||
      !selectedFragmentMaterialEntity ||
      !selectedFragmentMaterialAssignment ||
      !selectedFragmentMaterialAvailable
    )
      return;
    if (rejectLockedEntityMutation(selectedFragmentMaterialEntity.id)) return;
    try {
      const blocker = materialParameterIdentityEditBlocker(latestPreviewEditPrograms.current, {
        entityId: selectedFragmentMaterialEntity.id,
      });
      if (blocker) throw new Error(blocker);
      commitActiveProjectFragmentMaterials(
        updateStudioFragmentMaterialParameterV1(activeProjectFragmentMaterials, {
          entityId: selectedFragmentMaterialEntity.id,
          name,
          sceneId: activeEditorScene.sceneId,
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
  const selectedStudioCreationStaticTransformAuthority = studioCreationStaticTransformAuthorityFor(selectedEntity?.id);
  const studioUniformScaleResizeOnlyIds = uniformScaleResizeOnlyCreationEntityIds(workspaceEntityCreationProjection);
  const studioResizeUnavailableIds = resizeUnavailableCreationEntityIds(workspaceEntityCreationProjection);
  const selectedStudioCreationAppearanceAtAnchor =
    selectedStudioCreationAppearanceAuthority !== null &&
    Math.abs(sourceCurrentTime - selectedStudioCreationAppearanceAuthority.sourceAnchor) < 0.0005;
  const selectedStudioCreationStaticTransformAtAnchor =
    selectedStudioCreationStaticTransformAuthority !== null &&
    Math.abs(sourceCurrentTime - selectedStudioCreationStaticTransformAuthority.sourceAnchor) < 0.0005;
  const rotationHandleEntityId =
    selectedObjectIds.length === 1 &&
    selectedEntity !== null &&
    scaleKeyframeTransformConflictEntity(transformTrackPrograms, [selectedEntity.id]) === null &&
    rotationKeyframeTransformConflictEntity(transformTrackPrograms, [selectedEntity.id]) === null &&
    (selectedStudioCreationStaticTransformAtAnchor || selectedRuntimeTraceEditCapabilities?.rotation === true)
      ? selectedEntity.id
      : null;
  const studioGroupResizeEligibleIds = new Set(
    [...groupResizeEligibleCreationEntityIds(workspaceEntityCreationProjection)].filter(
      (entityId) =>
        scaleKeyframeTransformConflictEntity(transformTrackPrograms, [entityId]) === null &&
        rotationKeyframeTransformConflictEntity(transformTrackPrograms, [entityId]) === null,
    ),
  );
  const groupTransformOrigins = new Map([
    ...[...studioGroupResizeEligibleIds].flatMap((entityId) => {
      const transform = currentCreationTransformForEntity(workspaceEntityCreationProjection, entityId);
      return transform ? [[entityId, transform.transformOrigin] as const] : [];
    }),
    ...editableEntities.flatMap((entity) =>
      !entity.provisional && entity.sourceIdentity.kind === "known" && entity.geometry.position.kind === "known"
        ? ([[entity.id, entity.position]] as const)
        : [],
    ),
  ]);
  const currentCanonicalSourceKind = previewRenderer?.canonicalScene?.bundle.scene.source.kind;
  const importedStaticSnapshotTransformSupported =
    previewRenderer?.canonicalScene?.bundle.scene.animationChannels.length === 0 &&
    (currentCanonicalSourceKind === "imported-manim-server-snapshot" ||
      (currentCanonicalSourceKind === "studio-edit-program" && workspaceEditAuthority === "static-imported-root"));
  const importedGroupRotationHistorySupported =
    activeEditorScene !== null &&
    !isStudioNativeWorkspaceScene(activeEditorScene) &&
    importedStaticSnapshotTransformSupported &&
    importedGroupRotationHistoryIsSupported(workspaceStaticRootProjection, workspacePersistentRemoveProjection);
  const importedGroupRotationEligibleIds = new Set(
    importedGroupRotationHistorySupported
      ? editableEntities.flatMap((entity) =>
          entity.present &&
          !entity.provisional &&
          entity.sourceIdentity.kind === "known" &&
          entity.geometry.position.kind === "known"
            ? [entity.id]
            : [],
        )
      : [],
  );
  const importedGroupResizeHistorySupported =
    activeEditorScene !== null &&
    !isStudioNativeWorkspaceScene(activeEditorScene) &&
    importedStaticSnapshotTransformSupported &&
    importedGroupResizeHistoryIsSupported(workspaceStaticRootProjection, workspacePersistentRemoveProjection);
  const importedGroupResizeEligibleIds = new Set(
    importedGroupResizeHistorySupported && selectedObjectIds.length <= 8
      ? editableEntities.flatMap((entity) =>
          entity.present &&
          !entity.provisional &&
          entity.sourceIdentity.kind === "known" &&
          entity.geometry.position.kind === "known" &&
          entity.geometry.scale.kind === "known" &&
          ["Circle", "ImageMobject", "MathTex", "Rectangle"].includes(entity.type)
            ? [entity.id]
            : [],
        )
      : [],
  );
  const groupResizeEligibleIds = new Set([...studioGroupResizeEligibleIds, ...importedGroupResizeEligibleIds]);
  const groupRotationEligibleIds = new Set(
    selectedObjectIds.filter(
      (entityId) =>
        groupTransformOrigins.has(entityId) &&
        (studioGroupResizeEligibleIds.has(entityId) || importedGroupRotationEligibleIds.has(entityId)),
    ),
  );
  const selectedOpacityAuthority =
    selectedRuntimeTraceEditAuthority &&
    selectedRuntimeTraceEditCapabilities?.paintOpacity &&
    "baseOpacity" in selectedRuntimeTraceEditAuthority
      ? selectedRuntimeTraceEditAuthority
      : null;
  const selectedStudioImageStaticOpacityUnavailable =
    selectedStudioCreationAppearanceAuthority !== null && selectedEntity?.type === "ImageMobject";
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
    for (const [key, state] of nativeProjectStates.current) {
      if (state.projectId === workspaceId) nativeProjectStates.current.delete(key);
    }
    try {
      await nativeProjectLocalStore?.deleteProject(workspaceId);
    } catch (cause) {
      setNativeProjectAssetError(
        cause instanceof Error ? cause.message : "The deleted workspace's local assets could not be cleared.",
      );
    }
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
        onOpen={(projectId) => {
          cubicBezierAuthoringGeneration.current += 1;
          setActiveProjectId(projectId);
        }}
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
                disabled={studioAuthoringLocked || isPlaying}
                onChange={(event) => {
                  const sceneId = event.currentTarget.value;
                  cubicBezierAuthoringGeneration.current += 1;
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
            {activeEditorScene && !previewAwaitingConsent ? (
              <StudioPreviewControl
                disabled={sessionTransitionPending}
                onRetry={retryPreviewRenderer}
                providerPending={previewProviderPending}
                renderer={previewRenderer}
              />
            ) : null}
            <StudioExportSettingsControl
              disabled={sessionTransitionPending}
              exportSource={studioExportSource}
              generateThumbnail={studioExportSource && previewRenderer ? previewRenderer.generateThumbnail : null}
              manimSourceExport={studioNativeManimSourceExport}
              publication={studioExportPublication}
            />
            {activeScene ? (
              <>
                <button
                  className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-wait disabled:text-zinc-600"
                  disabled={
                    isPlaying ||
                    sessionTransitionPending ||
                    workspaceIsRefreshing ||
                    sourceMutationPendingProjectId === activeProjectId
                  }
                  onClick={reimportWorkspaceAfterSessionFlush}
                  type="button"
                >
                  {workspaceIsRefreshing ? "Reimporting…" : "Reimport"}
                </button>
                <button
                  aria-controls="studio-magic-edit"
                  aria-expanded={isMagicEditVisible}
                  className={cn(
                    "border px-2 py-1 font-medium",
                    isMagicEditVisible
                      ? "border-sky-800 bg-sky-950 text-sky-300 hover:bg-sky-900"
                      : "border-zinc-700 text-zinc-300 hover:bg-zinc-800",
                  )}
                  disabled={studioAuthoringLocked || isPlaying || !previewMutationAvailable}
                  onClick={() => setIsMagicEditVisible((visible) => !visible)}
                  type="button"
                >
                  Magic Edit
                </button>
              </>
            ) : null}
            <span className="hidden border border-zinc-700 px-2 py-1 text-zinc-500 xl:inline">{shell}</span>
          </div>
        </header>

        {workspaceError && activeEditorScene ? (
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

        {activeEditorScene && previewAwaitingConsent ? (
          <section
            aria-labelledby="preview-activation-title"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-sky-950 bg-sky-950/30 px-3 py-2"
            data-studio-manim-preview-state="awaiting-consent"
          >
            <div className="min-w-0">
              <h2 className="text-balance text-xs font-medium text-sky-200" id="preview-activation-title">
                WebGPU Scene preview requires approval
              </h2>
              <p className="mt-0.5 text-pretty text-[10px] leading-4 text-sky-200/70">
                Starting requests the selected workspace Scene from the configured producer.
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
        ) : workspaceStatus !== "error" && activeEditorScene && workspaceTimelineProjection === undefined ? (
          <div className="grid min-h-0 flex-1 place-items-center bg-zinc-900 p-6">
            <div className="w-full max-w-md border border-amber-900 bg-amber-950/20 p-5">
              <h2 className="text-balance text-sm font-medium text-amber-200">Timeline projection is not ready</h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-amber-200/70">
                The canonical Rust core has not accepted the current timeline edit yet. Retry the preview, or remove the
                edit that cannot be projected.
              </p>
              {staleMaterialParameterTracks.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {staleMaterialParameterTracks.map((track) => (
                    <button
                      className="border border-red-800 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-950/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                      key={track.transactionId}
                      onClick={() => removeMaterialParameterTrack(track)}
                      type="button"
                    >
                      Remove stale {track.name} track
                    </button>
                  ))}
                </div>
              ) : draftEdit ? (
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
        ) : workspaceStatus === "error" || !activeEditorScene || !projection ? (
          <div className="grid flex-1 place-items-center p-6">
            <div className="max-w-md border border-zinc-800 p-5">
              <h2 className="text-balance text-sm font-medium">
                {activeEditorScene ? "Preparing Scene preview" : "No editable Scene is available"}
              </h2>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                {workspaceError ??
                  nativeProjectAssetError ??
                  (activeEditorScene
                    ? "Waiting for the canonical WebGPU preview to accept this Scene."
                    : "Add a Python Manim Scene or create a Studio-native workspace.")}
              </p>
              {activeScene ? (
                <button
                  className="mt-4 bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950"
                  disabled={sessionTransitionPending}
                  onClick={reimportWorkspaceAfterSessionFlush}
                  type="button"
                >
                  Inspect workspace again
                </button>
              ) : null}
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
              activeScene={activeEditorScene}
              appliedProgramReadOnlyReasons={appliedProgramReadOnlyReasons}
              appliedEdits={appliedEdits}
              appliedTransactionIds={appliedTransactionIds}
              authoringAvailable={!studioAuthoringLocked && !isPlaying && previewMutationAvailable}
              className="order-2 min-h-64 md:order-1 md:col-start-1 md:row-start-1 md:min-h-0"
              draftActive={draftEdit !== null}
              duration={activeDuration}
              durationBlocker={durationTrimAvailability.blocker}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              durationError={durationError}
              durationMinimum={durationTrimAvailability.minimumDuration}
              entities={editableEntities}
              groupUnavailableReason={layerGroupUnavailableReason}
              imageAssets={studioImageAssets}
              imageAssetDragAvailable={nativeSceneActive}
              imageImportError={
                nativeSceneActive && nativeProjectAssetErrorKind === "image" ? nativeProjectAssetError : null
              }
              imageImportPending={nativeSceneActive && nativeProjectAssetPending}
              svgAssets={nativeSceneActive ? studioSvgAssets : []}
              svgImportError={
                nativeSceneActive && nativeProjectAssetErrorKind === "svg" ? nativeProjectAssetError : null
              }
              svgImportPending={nativeSceneActive && nativeProjectAssetPending}
              layers={studioLayers}
              groupLifetimeTrimUnavailableReason={selectedLayerGroupLifetimeUnavailableReason}
              lockToggleDisabled={draftApplyPending || draftEdit !== null}
              lockedEntityIds={lockedEntityIdSet}
              nextScene={nextScene}
              onGroup={groupLayerSelection}
              onImportImageFiles={nativeSceneActive ? (files) => void importNativeProjectImageFiles(files) : undefined}
              onImportSvgFiles={nativeSceneActive ? (files) => void importNativeProjectSvgFiles(files) : undefined}
              onDurationChange={(duration) => void changeSceneDuration(duration)}
              onSceneBackgroundChange={(color) => void changeSceneBackground(color)}
              onAddImageAsset={(asset) => {
                setIsPlaying(false);
                void insertEntitiesAt({ x: 320, y: 180 }, [
                  { image: asset.image, position: { x: 320, y: 180 }, type: "ImageMobject" },
                ]);
              }}
              onAddSvgAsset={(asset) => {
                setIsPlaying(false);
                void insertEntitiesAt({ x: 320, y: 180 }, [
                  {
                    dimensions: asset.dimensions,
                    position: { x: 320, y: 180 },
                    svg: { source: asset.source },
                    type: "SvgPath",
                  },
                ]);
              }}
              onEditAppliedProgram={editAppliedProgram}
              onLayerOrder={changeLayerOrder}
              onLayerGroupOrder={changeLayerGroupOrder}
              onLayerGroupReorder={reorderLayerGroup}
              onLayerReorder={reorderLayer}
              onTrimLayerGroupLifetime={trimLayerGroupLifetime}
              onToggleLayerGroup={(childEntityIds, selected) =>
                setSelectedObjectIds(selected ? [] : [...childEntityIds])
              }
              onToggleLayerGroupLock={toggleLayerGroupLock}
              onToggleLayerGroupVisibility={toggleLayerGroupVisibility}
              onToggleEntityLock={toggleLayerLock}
              onToggleEntityVisibility={toggleLayerVisibility}
              onUngroup={ungroupLayer}
              onRedo={() => void redoProgram()}
              onToggleEntity={(entityId, selected) =>
                setSelectedObjectIds((selection) =>
                  selected ? selection.filter((id) => id !== entityId) : [...selection, entityId],
                )
              }
              onUndo={undoProgramCommitFirst}
              redoCount={redoPrograms.length + lockRedoEntries.length}
              sceneBackgroundAvailable={nativeSceneActive && draftEdit === null && editingAppliedProgram === null}
              sceneBackgroundColor={sceneBackgroundColor}
              sceneBackgroundUnavailableReason={
                nativeSceneActive
                  ? draftEdit || editingAppliedProgram
                    ? "Apply or discard the current draft before changing the Scene background."
                    : null
                  : "Scene background editing is available only in a Studio-native workspace."
              }
              selectedIds={selectedSet}
              selectedGroupId={selectedLayerGroup?.groupId ?? null}
              sourceImportOutcomes={activeEditorScene.importOutcomes}
              undoAvailable={nextEditorUndoAction(editorState) !== null}
            />

            <StudioViewport
              anchors={timelineAnchors}
              appliedMotionClips={appliedMotionClips}
              appliedTransactionIds={appliedTransactionIds}
              cameraClips={cameraClips}
              boundaryActive={boundary !== null}
              className="order-1 min-h-[30rem] md:order-2 md:col-start-2 md:row-start-1 md:min-h-[32rem] xl:min-h-0"
              coordinateInsertSettings={coordinateInsertSettings}
              cubicBezierStyle={selectedCubicBezierStyle}
              currentTime={currentTime}
              curveInsertSettings={curveInsertSettings}
              duration={activeDuration}
              drawInClips={drawInClips}
              drawInAvailability={drawInAvailability}
              editableMotionIds={editableMotionIds}
              editingAppliedTransactionId={editingAppliedProgram?.original.program.transactionId ?? null}
              entities={visibleEntities}
              frame={workspace?.frame ?? { height: 8, width: 14.222 }}
              cubicBezierControls={selectedCubicBezierControls}
              cubicBezierPenPoints={cubicBezierPenPoints}
              gesturePreviewStore={gesturePreviewStore}
              groupRotationEligibleIds={groupRotationEligibleIds}
              groupResizeEligibleIds={groupResizeEligibleIds}
              groupTransformOrigins={groupTransformOrigins}
              incomingSceneName={nextScene?.name ?? null}
              inlineTextEditor={inlineTextEditor}
              insertTool={insertTool}
              insertValue={insertValue}
              interactionMode={interactionMode}
              isPlaying={isPlaying}
              playbackClock={playbackClock}
              lifetimeControls={lifetimeControls}
              lifetimeEditMessage={lifetimeEditMessage}
              lifetimeTrimDisabled={draftEdit !== null}
              lockedEntityIds={lockedEntityIdSet}
              materialParameterOptions={materialParameterOptions}
              materialParameterTracks={materialParameterTracks}
              mathTexTransformClips={mathTexTransformClips}
              motionDuration={motionDuration}
              motionPaths={motionPaths}
              opacityTrackEligibleIds={opacityTrackEligibleIds}
              opacityTracks={opacityTracks}
              paintColorTrackEligibleProperties={paintColorTrackEligibleProperties}
              paintColorTracks={paintColorTracks}
              rotationTrackEligibleIds={rotationTrackEligibleIds}
              rotationTracks={rotationTracks}
              resizeUnavailableIds={studioResizeUnavailableIds}
              scaleTrackEligibleIds={scaleTrackEligibleIds}
              scaleTracks={scaleTracks}
              shapeTransformClips={shapeTransformClips}
              writeInClips={writeInClips}
              writeInAvailability={writeInAvailability}
              uniformScaleResizeOnlyIds={studioUniformScaleResizeOnlyIds}
              onAppliedMotionClipChange={changeAppliedMotionClip}
              onAppliedMotionClipSelect={editAppliedMotionClip}
              onCameraClipChange={stageCameraClip}
              onCameraClipDelete={deleteCameraClip}
              onCameraClipSelect={(clip) => void stageCameraClip(clip)}
              onDrawInAdd={addDrawIn}
              onDrawInChange={changeDrawIn}
              onDrawInDelete={deleteDrawIn}
              onDrawInSelect={editDrawIn}
              onWriteInAdd={addWriteIn}
              onWriteInChange={changeWriteIn}
              onWriteInDelete={deleteWriteIn}
              onWriteInSelect={editWriteIn}
              onCanvasPlace={(point) => {
                if (cubicBezierExtensionEntityId) {
                  extendCubicBezierAtPoint(cubicBezierExtensionEntityId, point);
                } else if (insertTool === "Text") beginInlineTextCreation(point);
                else if (insertTool === "CubicBezier") void addCubicBezierPenPoint(point);
                else void insertEntitiesAt(point);
              }}
              onCubicBezierControlChange={(name, point) => {
                if (selectedCubicBezierControls) {
                  changeCubicBezierControl(selectedCubicBezierControls.entityId, name, point);
                }
              }}
              onCreateEmptyWorkspaceEntity={nativeWorkspaceOnboardingAvailable ? createEmptyWorkspaceEntity : undefined}
              onCreateStarterComposition={
                !nativeSceneActive || nativeWorkspaceOnboardingAvailable
                  ? () => {
                      setIsPlaying(false);
                      void insertEntitiesAt({ x: 320, y: 180 }, studioStarterCompositionEntities());
                    }
                  : undefined
              }
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
              onCoordinateInsertSettingsChange={setCoordinateInsertSettings}
              onCubicBezierExtensionToggle={() => {
                if (selectedCubicBezierStyle) toggleCubicBezierExtension(selectedCubicBezierStyle.entityId);
              }}
              onCubicBezierClosedToggle={() => {
                if (selectedCubicBezierStyle) toggleCubicBezierClosed(selectedCubicBezierStyle.entityId);
              }}
              onCubicBezierRemoveLastSegment={() => {
                if (selectedCubicBezierStyle) removeLastCubicBezierSegment(selectedCubicBezierStyle.entityId);
              }}
              onCubicBezierStyleChange={(change) => {
                if (selectedCubicBezierStyle) changeCubicBezierStyle(selectedCubicBezierStyle.entityId, change);
              }}
              onCurveInsertSettingsChange={setCurveInsertSettings}
              onInsertAtCenter={() => void insertEntitiesAt({ x: 320, y: 180 })}
              onImageAssetDrop={
                nativeSceneActive
                  ? (payload, point) => {
                      const asset = resolveStudioImageAssetDrag(studioImageAssets, payload);
                      if (!asset) {
                        setDraftError("This project image is no longer available.");
                        return;
                      }
                      setIsPlaying(false);
                      void insertEntitiesAt(point, [{ image: asset.image, position: point, type: "ImageMobject" }]);
                    }
                  : undefined
              }
              onInsertToolChange={(tool) => {
                activateStudioTool(tool);
              }}
              onInsertValueChange={setInsertValue}
              onPolygonSidesChange={setRegularPolygonSides}
              onSelectionLayout={(command) => void arrangeSelection(command)}
              onLifetimeChange={(entityId, lifetimeStart, target) => {
                void editEntityLifetime(entityId, lifetimeStart, target);
              }}
              onMaterialParameterKeyframeAdd={addMaterialParameterKeyframe}
              onMaterialParameterKeyframeChange={changeMaterialParameterKeyframe}
              onMaterialParameterKeyframeDelete={deleteMaterialParameterKeyframe}
              onMaterialParameterKeyframeDuplicate={duplicateMaterialParameterKeyframe}
              onMathTexTransformClipChange={stageMathTexTransform}
              onMathTexTransformClipDelete={deleteMathTexTransform}
              onMathTexTransformClipSelect={(clip) => void stageMathTexTransform(clip)}
              onMotionControlChange={changeDraftMotionControl}
              onMotionDurationChange={setMotionDuration}
              onOpacityKeyframeAdd={addOpacityKeyframe}
              onOpacityKeyframeChange={changeOpacityKeyframe}
              onOpacityKeyframeDelete={deleteOpacityKeyframe}
              onOpacityKeyframeDuplicate={duplicateOpacityKeyframe}
              onPaintColorKeyframeAdd={addPaintColorKeyframe}
              onPaintColorKeyframeChange={changePaintColorKeyframe}
              onPaintColorKeyframeDelete={deletePaintColorKeyframe}
              onPaintColorKeyframeDuplicate={duplicatePaintColorKeyframe}
              onRotationKeyframeAdd={addRotationKeyframe}
              onRotationKeyframeChange={changeRotationKeyframe}
              onRotationKeyframeDelete={deleteRotationKeyframe}
              onRotationKeyframeDuplicate={duplicateRotationKeyframe}
              onScaleKeyframeAdd={addScaleKeyframe}
              onScaleKeyframeChange={changeScaleKeyframe}
              onScaleKeyframeDelete={deleteScaleKeyframe}
              onScaleKeyframeDuplicate={duplicateScaleKeyframe}
              onShapeTransformClipChange={stageShapeTransform}
              onShapeTransformClipDelete={deleteShapeTransform}
              onShapeTransformClipSelect={(clip) => void stageShapeTransform(clip)}
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
                playbackSeekPendingRef.current = playbackClock.getSnapshot().playing;
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
              insertionAvailable={!studioAuthoringLocked && !isPlaying && previewPaintAvailable}
              preview={previewRenderer}
              previewPaintAvailable={previewMutationAvailable}
              presenceParticipants={editorDocumentAuthority.presenceParticipants}
              polygonSides={regularPolygonSides}
              projection={projection}
              readOnly={boundary !== null || canvasInteractionLocked}
              rotationHandleEntityId={rotationHandleEntityId}
              selectedIds={selectedSet}
              selectionLayoutUnavailableReason={selectionLayoutUnavailableReason}
            />

            <StudioInspector
              appliedProgramCount={appliedEdits.length}
              authoringAvailable={!isPlaying && previewDraftMutationAvailable}
              cameraAuthoring={{
                defaultDuration: motionDuration,
                focusUnavailableReason: cameraFocusUnavailableReason(),
                onFocus: (input) => addCameraClip("focus", input),
                onReset: (input) => addCameraClip("reset", input),
                resetUnavailableReason: cameraResetUnavailableReason(),
              }}
              className="order-3 min-h-96 md:col-span-2 md:col-start-1 md:row-start-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:min-h-0"
              dataPlotAuthoring={selectedDataPlotAuthoring}
              draftError={draftError}
              draftApplyPending={draftApplyPending}
              draftOperation={draftOperation}
              draftEdit={draftEdit}
              inspectorReturnFocus={inspectorReturnFocus}
              mathTexTransform={
                selectedEntity?.type === "MathTex"
                  ? {
                      defaultDuration: motionDuration,
                      onCreate: addMathTexTransform,
                      unavailableReason: mathTexTransformUnavailableReason(selectedEntity.id),
                    }
                  : undefined
              }
              shapeTransform={
                selectedEntity && isShapeTransformTarget(selectedEntity.type)
                  ? {
                      currentShape: selectedEntity.type,
                      defaultDuration: motionDuration,
                      onCreate: addShapeTransform,
                      unavailableReason: shapeTransformUnavailableReason(selectedEntity.id),
                    }
                  : undefined
              }
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
              onEntityStrokeCapChange={(entityId, strokeCap) =>
                void setEntityStrokeCapFromInspector(entityId, strokeCap)
              }
              onEntityStrokeWidthChange={(entityId, strokeWidth) =>
                void setEntityStrokeWidthFromInspector(entityId, strokeWidth)
              }
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
                selectedEntity !== null &&
                !paintColorTracks.some((track) => track.entityId === selectedEntity.id) &&
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
                ].includes(selectedEntity.type) &&
                (selectedEntity.type !== "CubicBezier" || selectedCubicBezierStyle !== null)
              }
              cubicBezierClosed={
                selectedEntity?.type === "CubicBezier" &&
                studioCreationProjectionEntityFor(selectedEntity.id)?.cubicBezier?.closed === true
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
                onCreatePreset: createFragmentMaterialPreset,
                onCreateTexturePreset: createTextureFragmentMaterialPreset,
                onDuplicate: duplicateFragmentMaterial,
                onImportGlsl: importFragmentMaterialGlsl,
                onRemoveAsset: removeFragmentMaterialAsset,
                onRename: renameFragmentMaterial,
                onUpdateParameterSchema: updateFragmentMaterialParameterSchema,
                onUpdateSource: updateFragmentMaterialSource,
                onUpdateParameter: updateSelectedFragmentMaterialParameter,
                onUpdateTexture: updateSelectedFragmentMaterialTexture,
                textureAssets: activeFragmentMaterialTextureAssets.map((asset) => ({
                  assetId: asset.id,
                  label: `${asset.id} (${asset.pixelWidth}×${asset.pixelHeight})`,
                })),
              }}
              opacityAvailable={
                !selectedStudioImageStaticOpacityUnavailable &&
                (selectedStudioCreationAppearanceAtAnchor || selectedOpacityAuthority !== null)
              }
              opacityUnavailableReason={
                selectedStudioImageStaticOpacityUnavailable ? "Use Timeline opacity keyframes for Images." : null
              }
              opacityValue={
                selectedStudioCreationAppearanceAtAnchor
                  ? (selectedEntity?.opacity ?? null)
                  : (selectedOpacityAuthority?.baseOpacity ?? null)
              }
              rotationAvailable={
                selectedStudioCreationStaticTransformAtAnchor || selectedRuntimeTraceEditCapabilities?.rotation === true
              }
              selectedEntity={selectedEntity}
              selectedEntityLocked={selectedEntityLocked}
              strokeColorValue={
                selectedEntity?.geometry.style.kind === "known"
                  ? (selectedEntity.geometry.style.value.strokeColor ??
                    selectedEntity.geometry.style.value.color ??
                    (selectedStudioCreationAppearanceAuthority ? "#ffffff" : null))
                  : null
              }
              strokeCapAvailable={
                selectedStudioCreationAppearanceAtAnchor &&
                studioEntityTypeSupportsStrokeCap(selectedEntity?.type ?? "")
              }
              strokeCapValue={
                selectedEntity?.geometry.style.kind === "known" &&
                studioEntityTypeSupportsStrokeCap(selectedEntity.type)
                  ? (selectedEntity.geometry.style.value.strokeCap ?? "butt")
                  : null
              }
              strokeWidthAvailable={
                selectedStudioCreationAppearanceAtAnchor &&
                studioEntityTypeSupportsStrokeWidth(selectedEntity?.type ?? "")
              }
              strokeWidthValue={
                selectedEntity?.geometry.style.kind === "known" &&
                studioEntityTypeSupportsStrokeWidth(selectedEntity.type)
                  ? (selectedEntity.geometry.style.value.strokeWidth ?? 0.04)
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
              producer. Start this only for workspace source you trust. Permission survives reloads in this tab and ends
              when the tab closes.
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
            authoringAvailable={!isPlaying && previewMutationAvailable}
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
