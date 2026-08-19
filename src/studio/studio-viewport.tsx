import { Profiler, useSyncExternalStore } from "react";

import { cn } from "../lib/cn";
import type { ProposedStateProjection } from "./model";
import { StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
import type { StudioGesturePreviewStore } from "./studio-gesture-preview-store";
import { recordStudioCommitProfile } from "./studio-render-profiler";
import { StudioTimeline, type StudioTimelineProps } from "./studio-timeline";
import { type StudioTool, StudioToolbar } from "./studio-toolbar";

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
      previewPaintAvailable: boolean;
      gesturePreviewStore: StudioGesturePreviewStore;
      insertValue: string;
      onInsertAtCenter: () => void;
      onInsertToolChange: (tool: StudioTool) => void;
      onInsertValueChange: (value: string) => void;
      projection: ProposedStateProjection;
      readOnly?: boolean;
    }
>;

export function StudioViewport({
  anchors,
  appliedMotionClips,
  appliedTransactionIds,
  boundaryActive,
  className,
  currentTime,
  duration,
  editableMotionIds,
  editingAppliedTransactionId,
  entities,
  frame,
  gesturePreviewStore,
  groupRotationEligibleIds,
  groupResizeEligibleIds,
  incomingSceneName,
  inlineTextEditor,
  insertTool,
  insertValue,
  interactionMode,
  isPlaying,
  lifetimeControls,
  lifetimeEditMessage,
  lifetimeTrimDisabled,
  motionDuration,
  motionPaths,
  onAppliedMotionClipChange,
  onAppliedMotionClipSelect,
  onCanvasPlace,
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
  onInsertAtCenter,
  onInsertToolChange,
  onInsertValueChange,
  onLifetimeChange,
  onMotionControlChange,
  onMotionDurationChange,
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
  onTimeChange,
  onTogglePlayback,
  preview = null,
  presenceParticipants,
  previewPaintAvailable,
  projection,
  readOnly = false,
  rotationHandleEntityId,
  selectedIds,
}: StudioViewportProps) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col bg-zinc-900", className)}>
      <Profiler id="toolbar" onRender={recordStudioCommitProfile}>
        <StudioToolbar
          authoringAvailable={previewPaintAvailable}
          insertValue={insertValue}
          onInsertAtCenter={onInsertAtCenter}
          onInsertValueChange={onInsertValueChange}
          onToolChange={onInsertToolChange}
          tool={insertTool}
        />
      </Profiler>
      <StudioGestureCanvas
        appliedTransactionIds={appliedTransactionIds}
        boundaryActive={boundaryActive}
        cameraScale={projection.camera.scale}
        editableMotionIds={editableMotionIds}
        entities={entities}
        frame={frame}
        gesturePreviewStore={gesturePreviewStore}
        groupRotationEligibleIds={groupRotationEligibleIds}
        groupResizeEligibleIds={groupResizeEligibleIds}
        incomingSceneName={incomingSceneName}
        inlineTextEditor={inlineTextEditor}
        insertTool={insertTool}
        interactionMode={interactionMode}
        motionPaths={motionPaths}
        onCanvasPlace={onCanvasPlace}
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
        rotationHandleEntityId={rotationHandleEntityId}
        sampleId={projection.canvas.sampleId}
        selectedIds={selectedIds}
      />
      <Profiler id="timeline" onRender={recordStudioCommitProfile}>
        <StudioTimeline
          anchors={anchors}
          appliedMotionClips={appliedMotionClips}
          appliedTransactionIds={appliedTransactionIds}
          currentTime={currentTime}
          duration={duration}
          editingAppliedTransactionId={editingAppliedTransactionId}
          events={projection.timeline.events}
          interactionMode={interactionMode}
          isPlaying={isPlaying}
          lifetimeControls={lifetimeControls}
          lifetimeEditMessage={lifetimeEditMessage}
          lifetimeTrimDisabled={lifetimeTrimDisabled}
          motionDuration={motionDuration}
          objectTracks={projection.timeline.objectTracks}
          onAppliedMotionClipChange={onAppliedMotionClipChange}
          onAppliedMotionClipSelect={onAppliedMotionClipSelect}
          onInteractionModeChange={onInteractionModeChange}
          onLifetimeChange={onLifetimeChange}
          onMotionDurationChange={onMotionDurationChange}
          onSelectEntity={onSelectEntity}
          onTimeChange={onTimeChange}
          onTogglePlayback={onTogglePlayback}
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
