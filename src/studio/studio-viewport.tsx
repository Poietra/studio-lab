import { cn } from "../lib/cn";
import type { ProposedStateProjection } from "./model";
import { StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
import { StudioTimeline, type StudioTimelineProps } from "./studio-timeline";
import { StudioToolbar, type StudioTool } from "./studio-toolbar";

export type StudioViewportProps = Readonly<
  Omit<StudioCanvasProps, "cameraScale" | "readOnly" | "sampleId"> &
    Omit<StudioTimelineProps, "events" | "objectTracks" | "readOnly"> & {
      className?: string;
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
  draftTransactionId,
  dragPreview,
  duration,
  editableMotionIds,
  editingAppliedTransactionId,
  entities,
  incomingSceneName,
  insertTool,
  insertValue,
  interactionMode,
  isPlaying,
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
  onInteractionModeChange,
  onInsertAtCenter,
  onInsertToolChange,
  onInsertValueChange,
  onLifetimeEndChange,
  onMotionControlChange,
  onMotionDurationChange,
  onSelectEntity,
  onTimeChange,
  onTogglePlayback,
  projection,
  readOnly = false,
  scalePreview,
  selectedIds,
}: StudioViewportProps) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col bg-zinc-900", className)}>
      <StudioToolbar
        insertValue={insertValue}
        onInsertAtCenter={onInsertAtCenter}
        onInsertValueChange={onInsertValueChange}
        onToolChange={onInsertToolChange}
        tool={insertTool}
      />
      <StudioCanvas
        appliedTransactionIds={appliedTransactionIds}
        boundaryActive={boundaryActive}
        cameraScale={projection.camera.scale}
        draftTransactionId={draftTransactionId}
        dragPreview={dragPreview}
        editableMotionIds={editableMotionIds}
        entities={entities}
        incomingSceneName={incomingSceneName}
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
        onMotionControlChange={onMotionControlChange}
        readOnly={readOnly}
        sampleId={projection.canvas.sampleId}
        scalePreview={scalePreview}
        selectedIds={selectedIds}
      />
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
        lifetimeTrimDisabled={lifetimeTrimDisabled}
        motionDuration={motionDuration}
        objectTracks={projection.timeline.objectTracks}
        onAppliedMotionClipChange={onAppliedMotionClipChange}
        onAppliedMotionClipSelect={onAppliedMotionClipSelect}
        onInteractionModeChange={onInteractionModeChange}
        onLifetimeEndChange={onLifetimeEndChange}
        onMotionDurationChange={onMotionDurationChange}
        onSelectEntity={onSelectEntity}
        onTimeChange={onTimeChange}
        onTogglePlayback={onTogglePlayback}
        readOnly={readOnly}
        selectedIds={selectedIds}
      />
    </section>
  );
}

export { entityLabel } from "./studio-canvas";
export type { StudioTimelineAnchor } from "./studio-timeline-geometry";
export {
  entityDragDelta,
  entityPreviewScale,
  STUDIO_VIEWPORT,
} from "./studio-viewport-geometry";
export type {
  EntityDragPreview,
  EntityScalePreview,
  InteractionMode,
} from "./studio-viewport-geometry";
