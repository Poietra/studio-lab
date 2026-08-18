import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "../lib/cn";
import type { EntityDimensions, Point, ProjectedEntity } from "./model";
import type { StudioMotionPath } from "./motion-paths";
import { describeStudioPreviewFallback } from "./preview-renderer-policy";
import {
  hasShapeDimensions,
  inverseResizeHandleScale,
  type ResizeHandleDirection,
  resizeKindForType,
} from "./shape-resize";
import { StudioInlineTextEditor, type StudioInlineTextEditorSession } from "./studio-inline-text-editor";
import { StudioMotionOverlay } from "./studio-motion-overlay";
import {
  orderedStudioPeersV1,
  StudioPresenceOverlay,
  type StudioPresenceParticipantV1,
} from "./studio-presence-overlay";
import { markStudioRenderBoundary } from "./studio-render-profiler";
import type { StudioTool } from "./studio-toolbar";
import {
  clientPointToViewport,
  type EntityDragPreview,
  type EntityGeometryPreview,
  type EntityRotationPreview,
  type EntityScalePreview,
  entityDragDelta,
  entityPreviewRotation,
  entityPreviewScale,
  type InteractionMode,
  isCanvasInteractionTarget,
  STUDIO_VIEWPORT,
  viewportPositionStyle,
} from "./studio-viewport-geometry";
import type { StudioPreviewRendererView } from "./use-preview-renderer";

export type StudioCanvasProps = Readonly<{
  appliedTransactionIds: ReadonlySet<string>;
  boundaryActive: boolean;
  cameraScale: number;
  dragPreview: EntityDragPreview | null;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
  frame: Readonly<{ height: number; width: number }>;
  geometryPreview: EntityGeometryPreview | null;
  incomingSceneName: string | null;
  inlineTextEditor: StudioInlineTextEditorSession | null;
  insertTool: StudioTool;
  interactionMode: InteractionMode;
  motionPaths: readonly StudioMotionPath[];
  onCanvasPlace: (point: Point) => void;
  onEntityKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityResizeCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityResizeKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    entityId: string,
    direction: ResizeHandleDirection,
  ) => void;
  onEntityResizePointerDown: (
    event: PointerEvent<HTMLButtonElement>,
    entityId: string,
    direction: ResizeHandleDirection,
  ) => void;
  onEntityResizePointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityResizePointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityRotationCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityRotationKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityRotationPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityRotationPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityRotationPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityTextEdit: (entityId: string, point: Point) => void;
  onInlineTextCancel: () => void;
  onInlineTextCommit: (text: string) => boolean;
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
  onPresenceCursorChange?: (cursor: Readonly<{ x: number; y: number }> | null) => void;
  onSelectEntity: (entityId: string) => void;
  presenceParticipants?: readonly StudioPresenceParticipantV1[];
  preview?: StudioPreviewRendererView | null;
  readOnly: boolean;
  rotationHandleEntityId: string | null;
  rotationPreview: EntityRotationPreview | null;
  sampleId: string;
  scalePreview: EntityScalePreview | null;
  selectedIds: ReadonlySet<string>;
}>;

export function entityLabel(entity: ProjectedEntity) {
  return entity.content?.label ?? entity.content?.text ?? entity.id.split(":").at(-1) ?? entity.id;
}

function entityPreviewGeometry(preview: EntityGeometryPreview | null, entity: ProjectedEntity) {
  return preview?.entityId === entity.id
    ? { dimensions: preview.dimensions, position: preview.position }
    : {
        dimensions: entity.geometry.dimensions.kind === "known" ? entity.geometry.dimensions.value : null,
        position: entity.position,
      };
}

function entityDimensionStyle(dimensions: EntityDimensions | null, frame: Readonly<{ height: number; width: number }>) {
  if (!dimensions) return undefined;
  return {
    height:
      dimensions.radius !== undefined
        ? `${((2 * dimensions.radius) / frame.height) * 100}cqh`
        : dimensions.height !== undefined
          ? `${(dimensions.height / frame.height) * 100}cqh`
          : undefined,
    width:
      dimensions.radius !== undefined
        ? `${((2 * dimensions.radius) / frame.width) * 100}cqw`
        : dimensions.width !== undefined
          ? `${(dimensions.width / frame.width) * 100}cqw`
          : undefined,
  };
}

/** Cancels the camera/entity CSS scales surrounding the interaction overlay so
 * an engine-projected visual AABB lands at its sampled pixel box once. */
export function compensatePreparedGeometryForOverlayScales(
  geometry: Readonly<{ dimensions: EntityDimensions | null; position: Point }>,
  cameraScale: number,
  entityScale: number,
): Readonly<{ dimensions: EntityDimensions | null; position: Point }> {
  const safeCameraScale = Math.max(Math.abs(cameraScale), Number.EPSILON);
  const safeEntityScale = Math.max(Math.abs(entityScale), Number.EPSILON);
  const scale = safeCameraScale * safeEntityScale;
  return {
    dimensions: geometry.dimensions
      ? {
          height: geometry.dimensions.height === undefined ? undefined : geometry.dimensions.height / scale,
          width: geometry.dimensions.width === undefined ? undefined : geometry.dimensions.width / scale,
        }
      : null,
    position: {
      x: STUDIO_VIEWPORT.width / 2 + (geometry.position.x - STUDIO_VIEWPORT.width / 2) / safeCameraScale,
      y: STUDIO_VIEWPORT.height / 2 + (geometry.position.y - STUDIO_VIEWPORT.height / 2) / safeCameraScale,
    },
  };
}

/** Resolves hit geometry only from the exact prepared WebGPU frame. Imported
 * entities require the server-verified source/runtime map. Studio-created
 * entities use their canonical core ID, which the compiler explicitly admits
 * to the worker interaction list. */
export function verifiedPreviewGeometryForStudioEntity(
  preview: StudioPreviewRendererView,
  studioEntityIdByUniqueSourceName: ReadonlyMap<string, string | null>,
  entity: ProjectedEntity,
) {
  if (!preview.interactionGeometry) return null;
  if (entity.transactionId && entity.id.startsWith(`tx:${entity.transactionId}/entity:`)) {
    const geometry = preview.interactionGeometry.get(entity.id);
    return geometry ? { bindingId: null, geometry, runtimeEntityId: entity.id } : null;
  }
  if (entity.sourceIdentity.kind !== "known") return null;
  if (!preview.sourceRuntimeIdentity) return null;
  const sourceName = entity.sourceIdentity.value;
  if (studioEntityIdByUniqueSourceName.get(sourceName) !== entity.id) return null;
  const mapping = preview.sourceRuntimeIdentity.get(sourceName);
  if (!mapping) return null;
  const geometry = preview.interactionGeometry.get(mapping.entityId);
  return geometry ? { bindingId: mapping.bindingId, geometry, runtimeEntityId: mapping.entityId } : null;
}

const RESIZE_HANDLES: readonly Readonly<{
  className: string;
  direction: ResizeHandleDirection;
  label: string;
}>[] = [
  { className: "-top-3 left-1/2 -translate-x-1/2 cursor-n-resize", direction: "n", label: "top edge" },
  { className: "-right-3 top-1/2 -translate-y-1/2 cursor-e-resize", direction: "e", label: "right edge" },
  { className: "-bottom-3 left-1/2 -translate-x-1/2 cursor-s-resize", direction: "s", label: "bottom edge" },
  { className: "-left-3 top-1/2 -translate-y-1/2 cursor-w-resize", direction: "w", label: "left edge" },
  { className: "-left-3 -top-3 cursor-nw-resize", direction: "nw", label: "top-left corner" },
  { className: "-right-3 -top-3 cursor-ne-resize", direction: "ne", label: "top-right corner" },
  { className: "-bottom-3 -left-3 cursor-sw-resize", direction: "sw", label: "bottom-left corner" },
  { className: "-bottom-3 -right-3 cursor-se-resize", direction: "se", label: "bottom-right corner" },
];

function EntityResizeHandles({
  cameraScale,
  displayedScale,
  entity,
  onCancel,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  shape,
}: Readonly<{
  cameraScale: number;
  displayedScale: number;
  entity: ProjectedEntity;
  onCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string, direction: ResizeHandleDirection) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string, direction: ResizeHandleDirection) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  shape: "circle" | "rectangle" | null;
}>) {
  const handles =
    shape === "rectangle"
      ? RESIZE_HANDLES
      : shape === "circle"
        ? RESIZE_HANDLES.filter((handle) => handle.direction.length === 2)
        : RESIZE_HANDLES.filter((handle) => handle.direction === "se");
  return handles.map((handle) => {
    const arrowKeys =
      handle.direction.length === 2
        ? "ArrowUp ArrowDown ArrowLeft ArrowRight"
        : handle.direction === "e" || handle.direction === "w"
          ? "ArrowLeft ArrowRight"
          : "ArrowUp ArrowDown";
    return (
      <button
        aria-keyshortcuts={arrowKeys}
        aria-label={`Resize ${entityLabel(entity)} from ${handle.label}`}
        className={cn(
          "absolute z-30 size-6 touch-none bg-transparent outline-none after:absolute after:left-1/2 after:top-1/2 after:size-2.5 after:-translate-x-1/2 after:-translate-y-1/2 after:border-2 after:border-sky-950 after:bg-sky-400 focus-visible:ring-2 focus-visible:ring-sky-300",
          handle.className,
        )}
        data-resize-direction={handle.direction}
        data-studio-resize-handle={entity.id}
        key={handle.direction}
        onKeyDown={(event) => onKeyDown(event, entity.id, handle.direction)}
        onLostPointerCapture={onCancel}
        onPointerCancel={onCancel}
        onPointerDown={(event) => onPointerDown(event, entity.id, handle.direction)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ scale: inverseResizeHandleScale(displayedScale, cameraScale) }}
        title={`Drag ${handle.label} to resize · ${arrowKeys.replaceAll("Arrow", "")} adjust precisely`}
        type="button"
      />
    );
  });
}

const ROTATION_HANDLE_RADIUS_PX = 14;
const ROTATION_HANDLE_CONNECTOR_PX = 28;

/** Keeps both the disc and its connector anchored in screen space even
 * though the selection bounds live below entity and camera scaling. */
export function rotationHandleLayoutStyle(displayedScale: number, cameraScale: number) {
  const inverseCompositeScale = inverseResizeHandleScale(displayedScale, cameraScale);
  return {
    scale: inverseCompositeScale,
    top:
      -ROTATION_HANDLE_RADIUS_PX - (ROTATION_HANDLE_RADIUS_PX + ROTATION_HANDLE_CONNECTOR_PX) * inverseCompositeScale,
  };
}

function EntityRotationHandle({
  cameraScale,
  displayedScale,
  entity,
  onCancel,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: Readonly<{
  cameraScale: number;
  displayedScale: number;
  entity: ProjectedEntity;
  onCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
}>) {
  return (
    <button
      aria-keyshortcuts="ArrowLeft ArrowRight"
      aria-label={`Rotate ${entityLabel(entity)}`}
      className="absolute left-1/2 z-30 size-7 -translate-x-1/2 cursor-grab touch-none rounded-full border-2 border-sky-950 bg-sky-400 outline-none before:absolute before:left-1/2 before:top-full before:h-7 before:w-px before:-translate-x-1/2 before:bg-sky-400 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-sky-300"
      data-studio-rotation-handle={entity.id}
      onKeyDown={(event) => onKeyDown(event, entity.id)}
      onLostPointerCapture={onCancel}
      onPointerCancel={onCancel}
      onPointerDown={(event) => onPointerDown(event, entity.id)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={rotationHandleLayoutStyle(displayedScale, cameraScale)}
      title="Drag to rotate · Left/Right rotate by 15° · Shift for 1°"
      type="button"
    >
      <span aria-hidden="true" className="text-sm leading-none text-sky-950">
        ↻
      </span>
    </button>
  );
}

export function StudioCanvas({
  appliedTransactionIds,
  boundaryActive,
  cameraScale,
  dragPreview,
  editableMotionIds,
  entities,
  frame,
  geometryPreview,
  incomingSceneName,
  inlineTextEditor,
  insertTool,
  interactionMode,
  motionPaths,
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
  onMotionControlChange,
  onPresenceCursorChange = () => undefined,
  onSelectEntity,
  preview = null,
  presenceParticipants = [],
  readOnly,
  rotationHandleEntityId,
  rotationPreview,
  sampleId,
  scalePreview,
  selectedIds,
}: StudioCanvasProps) {
  markStudioRenderBoundary("canvas");
  // Scene pixels have one authority: an exactly correlated WebGPU frame.
  // React keeps only prepared hit targets, focus, selection and gesture
  // overlays. A renderer failure or unsupported Scene is explicit and never
  // resurrects a second DOM renderer.
  const presentingCanvasPixels = preview?.state.phase === "presented";
  const showingCanvasPixels = presentingCanvasPixels;
  const displayOnlyPreview = preview?.interactionAuthority.kind === "display-only";
  const selectionOnlyPreview = preview?.interactionAuthority.kind === "selection-only";
  const runtimeTraceEditActive =
    presentingCanvasPixels &&
    preview?.interactionAuthority.kind === "bounded-interactive" &&
    preview.interactionAuthority.reason === "runtime-trace-edit" &&
    preview.runtimeTraceEditAnchor !== null;
  const runtimeTraceEditCandidates = runtimeTraceEditActive ? preview.runtimeTraceEditCandidates : [];
  const runtimeTraceEditCandidatesByStudioEntityId = new Map(
    runtimeTraceEditCandidates.map((candidate) => [candidate.studioEntityId, candidate]),
  );
  const boundedRuntimeEditTargetIds = new Set(runtimeTraceEditCandidates.map(({ studioEntityId }) => studioEntityId));
  const boundedRuntimeEditActive = boundedRuntimeEditTargetIds.size > 0;
  const remotePeers = orderedStudioPeersV1(presenceParticipants);
  const remoteSelectorOrdinalsByEntityId = new Map<string, number[]>();
  remotePeers.forEach((participant, index) => {
    for (const entityId of participant.selectedEntityIds) {
      const selectors = remoteSelectorOrdinalsByEntityId.get(entityId) ?? [];
      selectors.push(index + 1);
      remoteSelectorOrdinalsByEntityId.set(entityId, selectors);
    }
  });
  const studioEntityIdByUniqueSourceName = new Map<string, string | null>();
  if (showingCanvasPixels && preview?.sourceRuntimeIdentity && preview.interactionGeometry) {
    for (const entity of entities) {
      if (entity.sourceIdentity.kind !== "known") continue;
      const sourceName = entity.sourceIdentity.value;
      studioEntityIdByUniqueSourceName.set(
        sourceName,
        studioEntityIdByUniqueSourceName.has(sourceName) ? null : entity.id,
      );
    }
  }
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
      <div
        className="relative aspect-video w-full max-w-5xl overflow-hidden border border-zinc-700 bg-black [container-type:size]"
        data-studio-canvas
        data-preview-fallback-reason={preview?.state.phase === "fallback" ? preview.state.reason : undefined}
        data-preview-packet-id={preview?.state.phase === "presented" ? preview.state.frame.packetId : undefined}
        data-preview-interaction={preview?.interactionAuthority.kind ?? "interactive"}
        data-preview-renderer={preview ? preview.state.phase : "off"}
        data-preview-revision={preview?.state.phase === "presented" ? preview.state.frame.revision : undefined}
        data-preview-sample-time={
          preview?.state.phase === "presented" ? String(preview.state.frame.sampleTime) : undefined
        }
        data-preview-viewport={
          preview?.state.phase === "presented"
            ? `${preview.state.frame.viewport.widthPx}x${preview.state.frame.viewport.heightPx}`
            : undefined
        }
        data-proposed-state-sample={sampleId}
        data-scene-phase={boundaryActive ? "incoming" : "outgoing"}
        onPointerLeave={() => onPresenceCursorChange(null)}
        onPointerMove={(event) => {
          const point = clientPointToViewport(event.currentTarget.getBoundingClientRect(), {
            x: event.clientX,
            y: event.clientY,
          });
          onPresenceCursorChange({
            x: Math.min(1, Math.max(0, point.x / STUDIO_VIEWPORT.width)),
            y: Math.min(1, Math.max(0, point.y / STUDIO_VIEWPORT.height)),
          });
        }}
        onPointerDown={(event) => {
          if (
            !showingCanvasPixels ||
            displayOnlyPreview ||
            selectionOnlyPreview ||
            insertTool === "select" ||
            inlineTextEditor !== null ||
            boundaryActive ||
            isCanvasInteractionTarget(event.target)
          )
            return;
          onCanvasPlace(
            clientPointToViewport(event.currentTarget.getBoundingClientRect(), { x: event.clientX, y: event.clientY }),
          );
        }}
      >
        {preview ? (
          <canvas
            className={cn("pointer-events-none absolute inset-0 z-0 size-full", !showingCanvasPixels && "invisible")}
            data-studio-preview-canvas=""
            key={`preview-${preview.epoch}`}
            ref={preview.attachCanvas}
          />
        ) : null}
        <div className="absolute inset-0 origin-center" data-studio-transform-layer style={{ scale: cameraScale }}>
          <svg
            aria-hidden="true"
            className={cn("absolute inset-0 size-full", showingCanvasPixels ? "opacity-0" : "opacity-10")}
            viewBox="0 0 640 360"
          >
            <g stroke="#a1a1aa" strokeWidth="1">
              {[80, 160, 240, 320, 400, 480, 560].map((x) => (
                <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="360" />
              ))}
              {[90, 180, 270].map((y) => (
                <line key={`y-${y}`} x1="0" x2="640" y1={y} y2={y} />
              ))}
            </g>
          </svg>
          {showingCanvasPixels ? (
            <StudioMotionOverlay
              dragPreview={dragPreview}
              editableMotionIds={editableMotionIds}
              entities={entities}
              interactionMode={interactionMode}
              motionPaths={motionPaths}
              onMotionControlChange={onMotionControlChange}
            />
          ) : null}
          {entities.map((entity) => {
            const runtimeTraceEditCandidate = runtimeTraceEditCandidatesByStudioEntityId.get(entity.id);
            const runtimeTraceEditIdentity: ReturnType<typeof verifiedPreviewGeometryForStudioEntity> =
              runtimeTraceEditCandidate
                ? {
                    bindingId: runtimeTraceEditCandidate.bindingId,
                    geometry: {
                      dimensions: runtimeTraceEditCandidate.baseDimensions,
                      position: runtimeTraceEditCandidate.baseCenter,
                    },
                    runtimeEntityId: runtimeTraceEditCandidate.runtimeEntityId,
                  }
                : null;
            const verifiedIdentity =
              showingCanvasPixels && preview
                ? (verifiedPreviewGeometryForStudioEntity(preview, studioEntityIdByUniqueSourceName, entity) ??
                  runtimeTraceEditIdentity)
                : null;
            const preparedIdentity = verifiedIdentity;
            // Source projection does not expand a directly-added VGroup into
            // present child rows. A correlated selection-only frame does: its
            // runtime identity plus prepared bounds are sufficient to expose
            // a paint-free selector, but never a mutation gesture.
            const runtimePresentSelectionEntity =
              (selectionOnlyPreview || preview?.interactionAuthority.kind === "bounded-interactive") &&
              showingCanvasPixels &&
              preparedIdentity !== null;
            if (!entity.present && !runtimePresentSelectionEntity) return null;
            // Aggregate morph identity is intentionally ambiguous. Once its
            // verified pixels are presented, retaining source-projected hit
            // targets would both obscure the frame and suggest unsupported
            // per-entity editing authority.
            if (displayOnlyPreview && presentingCanvasPixels) return null;
            if (preparedIdentity === null) return null;
            const selected = selectedIds.has(entity.id);
            const selectionLocked =
              readOnly ||
              displayOnlyPreview ||
              (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
            const runtimeMutationLocked = boundedRuntimeEditActive && !boundedRuntimeEditTargetIds.has(entity.id);
            const selectionOnlyEntity = selectionOnlyPreview || runtimeMutationLocked;
            const mutationLocked = selectionLocked || selectionOnlyEntity;
            const positionUnknown = entity.geometry.position.kind === "unknown";
            const scaleUnknown = entity.geometry.scale.kind === "unknown";
            const dimensionsUnknown = entity.geometry.dimensions.kind === "unknown";
            const approximate = Object.values(entity.geometry).some((knowledge) => knowledge.kind === "unknown");
            // A logical source group with no requested prepared bounds must
            // not mint a source-derived hit target beside the WebGPU frame. The
            // bounded edit targets are admitted only by verified runtime
            // identity or a Runtime Trace candidate.
            const runtimeGeometry = preparedIdentity.geometry;
            const moveLocked = selectionLocked;
            const localDelta = entityDragDelta(dragPreview, entity.id);
            const displayedScale = entityPreviewScale(scalePreview, entity);
            const displayedRotation = entityPreviewRotation(rotationPreview, entity.id);
            const compensatedRuntimeGeometry = runtimeGeometry
              ? compensatePreparedGeometryForOverlayScales(runtimeGeometry, cameraScale, entity.scale)
              : null;
            const runtimePositionOnly = runtimeTraceEditCandidate?.capabilities.uniformScale === false;
            const gestureGeometry = entityPreviewGeometry(geometryPreview, entity);
            const previewGeometry =
              geometryPreview?.entityId === entity.id
                ? {
                    dimensions: runtimePositionOnly
                      ? (compensatedRuntimeGeometry?.dimensions ?? null)
                      : gestureGeometry.dimensions,
                    position: gestureGeometry.position,
                  }
                : compensatedRuntimeGeometry;
            if (!previewGeometry) return null;
            const position = {
              x: previewGeometry.position.x + localDelta.x,
              y: previewGeometry.position.y + localDelta.y,
            };
            const shape = resizeKindForType(entity.type);
            const runtimeUniformScaleOnly = runtimeTraceEditCandidate !== undefined;
            // Runtime AABBs position and size the hit target, but are not
            // authoring evidence for a Circle radius or Rectangle dimensions.
            // Shape resizing remains gated by the source projection.
            const shapeResizeAvailable =
              !runtimeUniformScaleOnly &&
              shape !== null &&
              entity.geometry.dimensions.kind === "known" &&
              hasShapeDimensions(shape, entity.geometry.dimensions.value) &&
              !dimensionsUnknown &&
              !positionUnknown &&
              !scaleUnknown;
            const resizeAvailable = !scaleUnknown && !runtimePositionOnly;
            const remoteSelectorOrdinals = remoteSelectorOrdinalsByEntityId.get(entity.id) ?? [];
            return (
              <div
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2",
                  selected && !selectionOnlyEntity ? "z-20" : "z-10",
                  remoteSelectorOrdinals.length > 0 && "outline outline-1 outline-offset-2 outline-sky-800",
                )}
                data-studio-geometry={approximate ? "approximate" : "known"}
                data-studio-entity-height={previewGeometry.dimensions?.height?.toFixed(4)}
                data-studio-entity-radius={previewGeometry.dimensions?.radius?.toFixed(4)}
                data-studio-entity-scale={displayedScale.toFixed(4)}
                data-studio-entity-width={previewGeometry.dimensions?.width?.toFixed(4)}
                data-studio-entity-wrapper={entity.id}
                data-studio-runtime-binding={preparedIdentity.bindingId}
                data-studio-runtime-entity={preparedIdentity.runtimeEntityId}
                key={entity.id}
                style={{ ...viewportPositionStyle(position), touchAction: "none" }}
              >
                <div
                  className="relative origin-center"
                  data-studio-selection-bounds={selected ? entity.id : undefined}
                  style={{ rotate: `${-displayedRotation}rad`, scale: displayedScale }}
                >
                  <button
                    aria-label={`Move ${entityLabel(entity)}`}
                    aria-pressed={selected}
                    className={cn(
                      "block border outline-none",
                      "box-border p-0",
                      moveLocked
                        ? "pointer-events-none border-dashed border-sky-800"
                        : selectionOnlyEntity
                          ? "cursor-pointer"
                          : "cursor-grab active:cursor-grabbing",
                      selected
                        ? "border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400"
                        : "border-transparent hover:border-zinc-600",
                    )}
                    data-studio-entity={entity.id}
                    disabled={moveLocked}
                    onKeyDown={(event) => {
                      if (!selectionOnlyEntity) {
                        onEntityKeyDown(event, entity.id);
                        return;
                      }
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      onSelectEntity(entity.id);
                    }}
                    onLostPointerCapture={selectionOnlyEntity ? undefined : onEntityPointerCancel}
                    onDoubleClick={
                      entity.type === "Text" &&
                      !mutationLocked &&
                      (entity.sourceIdentity.kind === "known" || entity.transactionId)
                        ? (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const canvas = event.currentTarget.closest<HTMLElement>("[data-studio-canvas]");
                            if (!canvas) return;
                            onEntityTextEdit(
                              entity.id,
                              clientPointToViewport(canvas.getBoundingClientRect(), {
                                x: event.clientX,
                                y: event.clientY,
                              }),
                            );
                          }
                        : undefined
                    }
                    onPointerCancel={selectionOnlyEntity ? undefined : onEntityPointerCancel}
                    onPointerDown={(event) => {
                      if (!selectionOnlyEntity) {
                        onEntityPointerDown(event, entity.id);
                        return;
                      }
                      event.stopPropagation();
                      onSelectEntity(entity.id);
                    }}
                    onPointerMove={selectionOnlyEntity ? undefined : onEntityPointerMove}
                    onPointerUp={selectionOnlyEntity ? undefined : onEntityPointerUp}
                    style={entityDimensionStyle(previewGeometry.dimensions, frame)}
                    title={
                      selectionOnlyEntity
                        ? "This verified object can be selected, but source rewriting is unavailable."
                        : positionUnknown
                          ? entity.geometry.position.reason
                          : undefined
                    }
                    type="button"
                  >
                    {selected ? (
                      <span className="pointer-events-none absolute -top-6 left-0 max-w-56 truncate bg-sky-400 px-1.5 py-0.5 text-[10px] font-medium text-sky-950">
                        {entityLabel(entity)}
                      </span>
                    ) : null}
                  </button>
                  {selected && selectedIds.size === 1 && !mutationLocked && resizeAvailable ? (
                    <EntityResizeHandles
                      cameraScale={cameraScale}
                      displayedScale={displayedScale}
                      entity={entity}
                      onCancel={onEntityResizeCancel}
                      onKeyDown={onEntityResizeKeyDown}
                      onPointerDown={onEntityResizePointerDown}
                      onPointerMove={onEntityResizePointerMove}
                      onPointerUp={onEntityResizePointerUp}
                      shape={shapeResizeAvailable ? shape : null}
                    />
                  ) : null}
                  {selected && selectedIds.size === 1 && !mutationLocked && rotationHandleEntityId === entity.id ? (
                    <EntityRotationHandle
                      cameraScale={cameraScale}
                      displayedScale={displayedScale}
                      entity={entity}
                      onCancel={onEntityRotationCancel}
                      onKeyDown={onEntityRotationKeyDown}
                      onPointerDown={onEntityRotationPointerDown}
                      onPointerMove={onEntityRotationPointerMove}
                      onPointerUp={onEntityRotationPointerUp}
                    />
                  ) : null}
                  {remoteSelectorOrdinals.length > 0 ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -bottom-6 left-0 max-w-28 truncate border border-sky-900 bg-sky-950 px-1 py-0.5 text-[10px] text-sky-200"
                    >
                      {remoteSelectorOrdinals.map((ordinal) => `E${ordinal}`).join(", ")}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {inlineTextEditor ? (
          <StudioInlineTextEditor
            key={`${inlineTextEditor.kind}:${inlineTextEditor.entityId ?? "new"}:${inlineTextEditor.point.x}:${inlineTextEditor.point.y}`}
            onCancel={onInlineTextCancel}
            onCommit={onInlineTextCommit}
            session={inlineTextEditor}
          />
        ) : null}
        {preview ? (
          <div
            className="absolute right-2 top-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300"
            data-studio-preview-status={preview.state.phase}
            title={preview.state.phase === "fallback" ? (preview.state.detail ?? undefined) : undefined}
          >
            {preview.state.phase === "presented"
              ? `WebGPU preview · ${preview.sourceLabel ?? "verified snapshot"} · ${
                  displayOnlyPreview
                    ? "display only"
                    : selectionOnlyPreview
                      ? "selection only"
                      : preview.interactionAuthority.kind === "bounded-interactive"
                        ? "Runtime Trace bounded editing"
                        : "editing preview only"
                }`
              : `WebGPU preview unavailable · ${describeStudioPreviewFallback(preview.state.reason)}`}
          </div>
        ) : null}
        <StudioPresenceOverlay participants={presenceParticipants} />
        {boundaryActive && incomingSceneName ? (
          <div className="absolute bottom-2 left-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300">
            Incoming Scene · {incomingSceneName}
          </div>
        ) : null}
      </div>
    </div>
  );
}
