import { Profiler, useSyncExternalStore } from "react";

import { cn } from "../lib/cn";
import type { ProposedStateProjection } from "./model";
import type { SelectionLayoutCommand } from "./selection-layout";
import { StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
import type { StudioGesturePreviewStore } from "./studio-gesture-preview-store";
import { recordStudioCommitProfile } from "./studio-render-profiler";
import { StudioTimeline, type StudioTimelineProps } from "./studio-timeline";
import {
  type CoordinateInsertSettings,
  type CubicBezierStyleChange,
  type CubicBezierStyleSettings,
  type CurveInsertSettings,
  type StudioTool,
  StudioToolbar,
} from "./studio-toolbar";

type StudioGestureCanvasBaseProps = Omit<
  StudioCanvasProps,
  "dragPreview" | "geometryPreview" | "groupResizePreview" | "groupRotationPreview" | "rotationPreview" | "scalePreview"
>;

function StudioGestureCanvas({
  gesturePreviewStore,
  ...canvasProps
}: Readonly<StudioGestureCanvasBaseProps & { gesturePreviewStore: StudioGesturePreviewStore }>) {
  const { dragPreview, geometryPreview, groupResizePreview, groupRotationPreview, rotationPreview, scalePreview } =
    useSyncExternalStore(
      gesturePreviewStore.subscribe,
      gesturePreviewStore.getSnapshot,
      gesturePreviewStore.getSnapshot,
    );

  return (
    <Profiler id="canvas" onRender={recordStudioCommitProfile}>
      <StudioCanvas
        {...canvasProps}
        dragPreview={dragPreview}
        geometryPreview={geometryPreview}
        groupRotationPreview={groupRotationPreview}
        groupResizePreview={groupResizePreview}
        rotationPreview={rotationPreview}
        scalePreview={scalePreview}
      />
    </Profiler>
  );
}

export type StudioViewportProps = Readonly<
  Omit<
    StudioCanvasProps,
    | "cameraScale"
    | "dragPreview"
    | "geometryPreview"
    | "groupRotationPreview"
    | "groupResizePreview"
    | "readOnly"
    | "rotationPreview"
    | "sampleId"
    | "scalePreview"
  > &
    Omit<StudioTimelineProps, "events" | "objectTracks" | "readOnly"> & {
      className?: string;
      coordinateInsertSettings: CoordinateInsertSettings;
      cubicBezierStyle?: CubicBezierStyleSettings | null;
      curveInsertSettings: CurveInsertSettings;
      insertionAvailable: boolean;
      previewPaintAvailable: boolean;
      gesturePreviewStore: StudioGesturePreviewStore;
      insertValue: string;
      onCoordinateInsertSettingsChange: (settings: CoordinateInsertSettings) => void;
      onCubicBezierClosedToggle?: () => void;
      onCubicBezierExtensionToggle?: () => void;
      onCubicBezierRemoveLastSegment?: () => void;
      onCubicBezierStyleChange?: (change: CubicBezierStyleChange) => void;
      onPathMorphAdd?: () => void;
      onCurveInsertSettingsChange: (settings: CurveInsertSettings) => void;
      onInsertAtCenter: () => void;
      onInsertToolChange: (tool: StudioTool) => void;
      onInsertValueChange: (value: string) => void;
      onPolygonSidesChange: (sides: number) => void;
      onSelectionLayout: (command: SelectionLayoutCommand) => void;
      polygonSides: number;
      pathMorphUnavailableReason?: string | null;
      projection: ProposedStateProjection;
      readOnly?: boolean;
      selectionLayoutUnavailableReason: string | null;
    }
>;

export function StudioViewport({
  anchors,
  appliedMotionClips,
  appliedTransactionIds,
  cameraClips,
  boundaryActive,
  className,
  coordinateInsertSettings,
  cubicBezierControls,
  cubicBezierPenPoints,
  cubicBezierStyle,
  currentTime,
  curveInsertSettings,
  duration,
  drawInClips,
  drawInAvailability,
  editableMotionIds,
  editingAppliedTransactionId,
  entities,
  frame,
  gesturePreviewStore,
  groupRotationEligibleIds,
  groupResizeEligibleIds,
  groupTransformOrigins,
  incomingSceneName,
  inlineTextEditor,
  insertionAvailable,
  insertTool,
  insertValue,
  interactionMode,
  isPlaying,
  lifetimeControls,
  lifetimeEditMessage,
  lifetimeTrimDisabled,
  lockedEntityIds,
  materialParameterOptions,
  materialParameterTracks,
  contentTransformClips,
  motionDuration,
  motionPaths,
  opacityTrackEligibleIds,
  opacityTracks,
  paintColorTrackEligibleProperties,
  paintColorTracks,
  pathMorphClips,
  pathMotionUnavailableReason,
  rotationTrackEligibleIds,
  rotationTracks,
  scaleTrackEligibleIds,
  scaleTracks,
  shapeTransformClips,
  writeInClips,
  writeInAvailability,
  uniformScaleResizeOnlyIds,
  onAppliedMotionClipChange,
  onAppliedMotionClipDelete,
  onAppliedMotionClipSelect,
  onCameraClipChange,
  onCameraClipDelete,
  onCameraClipSelect,
  onDrawInAdd,
  onDrawInChange,
  onDrawInDelete,
  onDrawInSelect,
  onCanvasPlace,
  onCubicBezierControlChange,
  onCreateEmptyWorkspaceEntity,
  onCreateStarterComposition,
  onEntityKeyDown,
  onEntityPointerCancel,
  onEntityPointerDown,
  onEntityPointerMove,
  onEntityPointerUp,
  onEntityResizeCancel,
  onEntityResizeKeyDown,
  onEntityResizePointerDown,
  onEntityResizePointerMove,
  onEntityResizePointerUp,
  onEntityRotationCancel,
  onEntityRotationKeyDown,
  onEntityRotationPointerDown,
  onEntityRotationPointerMove,
  onEntityRotationPointerUp,
  onEntityTextEdit,
  onInlineTextCancel,
  onInlineTextCommit,
  onInteractionModeChange,
  onCoordinateInsertSettingsChange,
  onCubicBezierClosedToggle,
  onCubicBezierExtensionToggle,
  onCubicBezierRemoveLastSegment,
  onCubicBezierStyleChange,
  onPathMorphAdd,
  onCurveInsertSettingsChange,
  onInsertAtCenter,
  onImageAssetDrop,
  onInsertToolChange,
  onInsertValueChange,
  onPolygonSidesChange,
  onLifetimeChange,
  onMaterialParameterKeyframeAdd,
  onMaterialParameterKeyframeChange,
  onMaterialParameterKeyframeDelete,
  onMaterialParameterKeyframeDuplicate,
  onContentTransformClipChange,
  onContentTransformClipDelete,
  onContentTransformClipSelect,
  onMotionControlChange,
  onMotionDurationChange,
  onPathMotionAdd,
  onOpacityKeyframeAdd,
  onOpacityKeyframeChange,
  onOpacityKeyframeDelete,
  onOpacityKeyframeDuplicate,
  onPaintColorKeyframeAdd,
  onPaintColorKeyframeChange,
  onPaintColorKeyframeDelete,
  onPaintColorKeyframeDuplicate,
  onPathMorphClipChange,
  onPathMorphClipDelete,
  onPathMorphClipSelect,
  onRotationKeyframeAdd,
  onRotationKeyframeChange,
  onRotationKeyframeDelete,
  onRotationKeyframeDuplicate,
  onScaleKeyframeAdd,
  onScaleKeyframeChange,
  onScaleKeyframeDelete,
  onScaleKeyframeDuplicate,
  onShapeTransformClipChange,
  onShapeTransformClipDelete,
  onShapeTransformClipSelect,
  onPresenceCursorChange,
  onSelectionResizeCancel,
  onSelectionResizeKeyDown,
  onSelectionResizePointerDown,
  onSelectionResizePointerMove,
  onSelectionResizePointerUp,
  onSelectionRotationCancel,
  onSelectionRotationKeyDown,
  onSelectionRotationPointerDown,
  onSelectionRotationPointerMove,
  onSelectionRotationPointerUp,
  onSelectEntity,
  onSelectionLayout,
  onTimeChange,
  onTogglePlayback,
  onWriteInAdd,
  onWriteInChange,
  onWriteInDelete,
  onWriteInSelect,
  playbackClock,
  preview = null,
  presenceParticipants,
  previewPaintAvailable,
  polygonSides,
  projection,
  readOnly = false,
  rotationHandleEntityId,
  pathMorphUnavailableReason,
  resizeUnavailableIds,
  selectedIds,
  selectionLayoutUnavailableReason,
}: StudioViewportProps) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col bg-zinc-900", className)}>
      <Profiler id="toolbar" onRender={recordStudioCommitProfile}>
        <StudioToolbar
          authoringAvailable={previewPaintAvailable && !readOnly}
          coordinateInsertSettings={coordinateInsertSettings}
          cubicBezierStyle={cubicBezierStyle}
          curveInsertSettings={curveInsertSettings}
          insertValue={insertValue}
          insertionAvailable={insertionAvailable}
          onCoordinateInsertSettingsChange={onCoordinateInsertSettingsChange}
          onCubicBezierClosedToggle={onCubicBezierClosedToggle}
          onCubicBezierExtensionToggle={onCubicBezierExtensionToggle}
          onCubicBezierRemoveLastSegment={onCubicBezierRemoveLastSegment}
          onCubicBezierStyleChange={onCubicBezierStyleChange}
          onPathMorphAdd={onPathMorphAdd}
          onCurveInsertSettingsChange={onCurveInsertSettingsChange}
          onInsertAtCenter={onInsertAtCenter}
          onInsertValueChange={onInsertValueChange}
          onPolygonSidesChange={onPolygonSidesChange}
          onSelectionLayout={onSelectionLayout}
          onToolChange={onInsertToolChange}
          polygonSides={polygonSides}
          pathMorphUnavailableReason={pathMorphUnavailableReason}
          selectionCount={selectedIds.size}
          selectionLayoutUnavailableReason={selectionLayoutUnavailableReason}
          tool={insertTool}
        />
      </Profiler>
      <StudioGestureCanvas
        appliedTransactionIds={appliedTransactionIds}
        boundaryActive={boundaryActive}
        cameraScale={projection.camera.scale}
        cubicBezierControls={cubicBezierControls}
        cubicBezierExtensionActive={cubicBezierStyle?.extensionActive ?? false}
        cubicBezierPenPoints={cubicBezierPenPoints}
        editableMotionIds={editableMotionIds}
        entities={entities}
        frame={frame}
        gesturePreviewStore={gesturePreviewStore}
        groupRotationEligibleIds={groupRotationEligibleIds}
        groupResizeEligibleIds={groupResizeEligibleIds}
        groupTransformOrigins={groupTransformOrigins}
        incomingSceneName={incomingSceneName}
        inlineTextEditor={inlineTextEditor}
        insertTool={insertTool}
        interactionMode={interactionMode}
        lockedEntityIds={lockedEntityIds}
        motionPaths={motionPaths}
        onCanvasPlace={onCanvasPlace}
        onCubicBezierControlChange={onCubicBezierControlChange}
        onCreateEmptyWorkspaceEntity={onCreateEmptyWorkspaceEntity}
        onCreateStarterComposition={onCreateStarterComposition}
        onEntityKeyDown={onEntityKeyDown}
        onEntityPointerCancel={onEntityPointerCancel}
        onEntityPointerDown={onEntityPointerDown}
        onEntityPointerMove={onEntityPointerMove}
        onEntityPointerUp={onEntityPointerUp}
        onEntityResizeCancel={onEntityResizeCancel}
        onEntityResizeKeyDown={onEntityResizeKeyDown}
        onEntityResizePointerDown={onEntityResizePointerDown}
        onEntityResizePointerMove={onEntityResizePointerMove}
        onEntityResizePointerUp={onEntityResizePointerUp}
        onEntityRotationCancel={onEntityRotationCancel}
        onEntityRotationKeyDown={onEntityRotationKeyDown}
        onEntityRotationPointerDown={onEntityRotationPointerDown}
        onEntityRotationPointerMove={onEntityRotationPointerMove}
        onEntityRotationPointerUp={onEntityRotationPointerUp}
        onEntityTextEdit={onEntityTextEdit}
        onInlineTextCancel={onInlineTextCancel}
        onInlineTextCommit={onInlineTextCommit}
        onImageAssetDrop={onImageAssetDrop}
        onMotionControlChange={onMotionControlChange}
        onPresenceCursorChange={onPresenceCursorChange}
        onSelectionResizeCancel={onSelectionResizeCancel}
        onSelectionResizeKeyDown={onSelectionResizeKeyDown}
        onSelectionResizePointerDown={onSelectionResizePointerDown}
        onSelectionResizePointerMove={onSelectionResizePointerMove}
        onSelectionResizePointerUp={onSelectionResizePointerUp}
        onSelectionRotationCancel={onSelectionRotationCancel}
        onSelectionRotationKeyDown={onSelectionRotationKeyDown}
        onSelectionRotationPointerDown={onSelectionRotationPointerDown}
        onSelectionRotationPointerMove={onSelectionRotationPointerMove}
        onSelectionRotationPointerUp={onSelectionRotationPointerUp}
        onSelectEntity={onSelectEntity}
        preview={preview}
        presenceParticipants={presenceParticipants}
        readOnly={readOnly}
        resizeUnavailableIds={resizeUnavailableIds}
        rotationHandleEntityId={rotationHandleEntityId}
        sampleId={projection.canvas.sampleId}
        selectedIds={selectedIds}
        uniformScaleResizeOnlyIds={uniformScaleResizeOnlyIds}
      />
      <Profiler id="timeline" onRender={recordStudioCommitProfile}>
        <StudioTimeline
          anchors={anchors}
          appliedMotionClips={appliedMotionClips}
          appliedTransactionIds={appliedTransactionIds}
          cameraClips={cameraClips}
          currentTime={currentTime}
          playbackClock={playbackClock}
          duration={duration}
          drawInClips={drawInClips}
          drawInAvailability={drawInAvailability}
          editingAppliedTransactionId={editingAppliedTransactionId}
          events={projection.timeline.events}
          interactionMode={interactionMode}
          isPlaying={isPlaying}
          lifetimeControls={lifetimeControls}
          lifetimeEditMessage={lifetimeEditMessage}
          lifetimeTrimDisabled={lifetimeTrimDisabled}
          lockedEntityIds={lockedEntityIds}
          materialParameterOptions={materialParameterOptions}
          materialParameterTracks={materialParameterTracks}
          contentTransformClips={contentTransformClips}
          motionDuration={motionDuration}
          objectTracks={projection.timeline.objectTracks}
          opacityTrackEligibleIds={opacityTrackEligibleIds}
          opacityTracks={opacityTracks}
          paintColorTrackEligibleProperties={paintColorTrackEligibleProperties}
          paintColorTracks={paintColorTracks}
          pathMorphClips={pathMorphClips}
          pathMotionUnavailableReason={pathMotionUnavailableReason}
          rotationTrackEligibleIds={rotationTrackEligibleIds}
          rotationTracks={rotationTracks}
          scaleTrackEligibleIds={scaleTrackEligibleIds}
          scaleTracks={scaleTracks}
          shapeTransformClips={shapeTransformClips}
          writeInClips={writeInClips}
          writeInAvailability={writeInAvailability}
          onAppliedMotionClipChange={onAppliedMotionClipChange}
          onAppliedMotionClipDelete={onAppliedMotionClipDelete}
          onAppliedMotionClipSelect={onAppliedMotionClipSelect}
          onCameraClipChange={onCameraClipChange}
          onCameraClipDelete={onCameraClipDelete}
          onCameraClipSelect={onCameraClipSelect}
          onDrawInAdd={onDrawInAdd}
          onDrawInChange={onDrawInChange}
          onDrawInDelete={onDrawInDelete}
          onDrawInSelect={onDrawInSelect}
          onInteractionModeChange={onInteractionModeChange}
          onLifetimeChange={onLifetimeChange}
          onMaterialParameterKeyframeAdd={onMaterialParameterKeyframeAdd}
          onMaterialParameterKeyframeChange={onMaterialParameterKeyframeChange}
          onMaterialParameterKeyframeDelete={onMaterialParameterKeyframeDelete}
          onMaterialParameterKeyframeDuplicate={onMaterialParameterKeyframeDuplicate}
          onContentTransformClipChange={onContentTransformClipChange}
          onContentTransformClipDelete={onContentTransformClipDelete}
          onContentTransformClipSelect={onContentTransformClipSelect}
          onMotionDurationChange={onMotionDurationChange}
          onPathMotionAdd={onPathMotionAdd}
          onOpacityKeyframeAdd={onOpacityKeyframeAdd}
          onOpacityKeyframeChange={onOpacityKeyframeChange}
          onOpacityKeyframeDelete={onOpacityKeyframeDelete}
          onOpacityKeyframeDuplicate={onOpacityKeyframeDuplicate}
          onPaintColorKeyframeAdd={onPaintColorKeyframeAdd}
          onPaintColorKeyframeChange={onPaintColorKeyframeChange}
          onPaintColorKeyframeDelete={onPaintColorKeyframeDelete}
          onPaintColorKeyframeDuplicate={onPaintColorKeyframeDuplicate}
          onPathMorphClipChange={onPathMorphClipChange}
          onPathMorphClipDelete={onPathMorphClipDelete}
          onPathMorphClipSelect={onPathMorphClipSelect}
          onRotationKeyframeAdd={onRotationKeyframeAdd}
          onRotationKeyframeChange={onRotationKeyframeChange}
          onRotationKeyframeDelete={onRotationKeyframeDelete}
          onRotationKeyframeDuplicate={onRotationKeyframeDuplicate}
          onScaleKeyframeAdd={onScaleKeyframeAdd}
          onScaleKeyframeChange={onScaleKeyframeChange}
          onScaleKeyframeDelete={onScaleKeyframeDelete}
          onScaleKeyframeDuplicate={onScaleKeyframeDuplicate}
          onShapeTransformClipChange={onShapeTransformClipChange}
          onShapeTransformClipDelete={onShapeTransformClipDelete}
          onShapeTransformClipSelect={onShapeTransformClipSelect}
          onSelectEntity={onSelectEntity}
          onTimeChange={onTimeChange}
          onTogglePlayback={onTogglePlayback}
          onWriteInAdd={onWriteInAdd}
          onWriteInChange={onWriteInChange}
          onWriteInDelete={onWriteInDelete}
          onWriteInSelect={onWriteInSelect}
          readOnly={readOnly}
          selectedIds={selectedIds}
        />
      </Profiler>
    </section>
  );
}

export { entityLabel } from "./studio-canvas";
export type { StudioTimelineAnchor } from "./studio-timeline-geometry";
export type {
  EntityDragPreview,
  EntityGeometryPreview,
  EntityGroupResizePreview,
  EntityScalePreview,
  InteractionMode,
} from "./studio-viewport-geometry";
export { entityDragDelta, entityPreviewScale, STUDIO_VIEWPORT } from "./studio-viewport-geometry";
