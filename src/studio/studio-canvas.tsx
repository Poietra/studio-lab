import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "../lib/cn";
import type { EntityDimensions, Point, ProjectedEntity } from "./model";
import type { StudioMotionPath } from "./motion-paths";
import { describeStudioPreviewFallbackV1 } from "./preview-renderer-policy";
import { EquationContent } from "./prototype-rendering";
import {
  hasShapeDimensions,
  inverseResizeHandleScale,
  type ResizeHandleDirection,
  resizeKindForType,
} from "./shape-resize";
import { StudioMotionOverlay } from "./studio-motion-overlay";
import {
  orderedStudioPeersV1,
  StudioPresenceOverlay,
  type StudioPresenceParticipantV1,
} from "./studio-presence-overlay";
import type { StudioTool } from "./studio-toolbar";
import {
  clientPointToViewport,
  type EntityDragPreview,
  type EntityGeometryPreview,
  type EntityScalePreview,
  entityDragDelta,
  entityPreviewScale,
  type InteractionMode,
  isCanvasInteractionTarget,
  STUDIO_VIEWPORT,
  viewportPositionStyle,
} from "./studio-viewport-geometry";
import type { StudioPreviewRendererViewV1 } from "./use-preview-renderer";
import { isTransitionOverlay } from "./workspace-projection";

export type StudioCanvasProps = Readonly<{
  appliedTransactionIds: ReadonlySet<string>;
  boundaryActive: boolean;
  cameraScale: number;
  draftTransactionId: string | null;
  dragPreview: EntityDragPreview | null;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
  frame: Readonly<{ height: number; width: number }>;
  geometryPreview: EntityGeometryPreview | null;
  incomingSceneName: string | null;
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
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
  onPresenceCursorChange?: (cursor: Readonly<{ x: number; y: number }> | null) => void;
  onSelectEntity: (entityId: string) => void;
  presenceParticipants?: readonly StudioPresenceParticipantV1[];
  preview?: StudioPreviewRendererViewV1 | null;
  readOnly: boolean;
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

/** Cancels the semantic camera/entity CSS scales surrounding the DOM overlay
 * so an engine-projected visual AABB lands at its sampled pixel box once. */
export function compensatePreviewGeometryForSemanticScalesV1(
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

/**
 * Resolves runtime hit geometry only through the server-verified identity map.
 * A source name that currently identifies zero or several Studio objects is
 * intentionally unusable: paint order, Scene order, type, and geometry never
 * break the tie.
 */
export function verifiedPreviewGeometryForStudioEntityV1(
  preview: StudioPreviewRendererViewV1,
  studioEntityIdByUniqueSourceName: ReadonlyMap<string, string | null>,
  entity: ProjectedEntity,
) {
  if (entity.sourceIdentity.kind !== "known" || !preview.sourceRuntimeIdentity || !preview.interactionGeometry) {
    return null;
  }
  const sourceName = entity.sourceIdentity.value;
  if (studioEntityIdByUniqueSourceName.get(sourceName) !== entity.id) return null;
  const mapping = preview.sourceRuntimeIdentity.get(sourceName);
  if (!mapping) return null;
  const geometry = preview.interactionGeometry.get(mapping.entityId);
  return geometry ? { bindingId: mapping.bindingId, geometry, runtimeEntityId: mapping.entityId } : null;
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
    style: { opacity: entity.opacity, scale: 0.05 + entity.opacity * 14 },
  };
}

function ObjectVisual({
  dimensions,
  entity,
  frame,
}: Readonly<{
  dimensions: EntityDimensions | null;
  entity: ProjectedEntity;
  frame: Readonly<{ height: number; width: number }>;
}>) {
  const dimensionStyle = entityDimensionStyle(dimensions, frame);
  if (entity.type === "MathTex") {
    return (
      <EquationContent
        lines={entity.content?.displayLines ?? [entityLabel(entity)]}
        texParts={entity.content?.texParts}
      />
    );
  }
  if (entity.type === "Text") {
    return (
      <span className="block max-w-56 text-pretty text-center text-sm leading-5">
        {entity.content?.text ?? entityLabel(entity)}
      </span>
    );
  }
  if (entity.type === "Arrow") {
    return (
      <svg aria-hidden="true" className="h-5 w-24" viewBox="0 0 96 20">
        <path d="M 2 10 H 88 M 80 3 L 89 10 L 80 17" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  if (entity.type === "Line") {
    return <span aria-hidden="true" className="block h-px w-24 bg-zinc-400" />;
  }
  if (entity.type === "Rectangle" || entity.type === "SurroundingRectangle" || entity.type === "Square") {
    return <span aria-hidden="true" className="block h-14 w-32 border border-zinc-500" style={dimensionStyle} />;
  }
  if (entity.type === "Circle" || entity.type === "Dot") {
    return (
      <span aria-hidden="true" className="block size-16 rounded-full border border-zinc-500" style={dimensionStyle} />
    );
  }
  if (entity.type === "RegularPolygon") {
    return (
      <span
        aria-hidden="true"
        className="block size-16 border border-zinc-500 [clip-path:polygon(50%_0%,93%_25%,93%_75%,50%_100%,7%_75%,7%_25%)]"
      />
    );
  }
  return <span className="block border border-zinc-600 px-3 py-2 text-xs text-zinc-300">{entityLabel(entity)}</span>;
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

export function StudioCanvas({
  appliedTransactionIds,
  boundaryActive,
  cameraScale,
  draftTransactionId,
  dragPreview,
  editableMotionIds,
  entities,
  frame,
  geometryPreview,
  incomingSceneName,
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
  onMotionControlChange,
  onPresenceCursorChange = () => undefined,
  onSelectEntity,
  preview = null,
  presenceParticipants = [],
  readOnly,
  sampleId,
  scalePreview,
  selectedIds,
}: StudioCanvasProps) {
  // Only a fully correlated, presented WebGPU frame may replace the duplicate
  // DOM fill/stroke paint: `preview.state` is resolved synchronously against
  // the current playhead, viewport, snapshot correlation, and host, so hiding
  // the paint here never trusts a stale emission. Hit targets, focus,
  // selection, resize handles, and the object/timeline/Inspector DOM stay
  // fully interactive as a paint-free overlay, and any fallback restores the
  // semantic paint in the same render.
  const presentingCanvasPixels = preview?.state.phase === "presented";
  const retainingRuntimeTraceBasePixels = preview?.runtimeTraceBaseFrameRetained === true;
  const showingCanvasPixels = presentingCanvasPixels || retainingRuntimeTraceBasePixels;
  const displayOnlyPreview = preview?.interactionAuthority.kind === "display-only";
  const selectionOnlyPreview = preview?.interactionAuthority.kind === "selection-only";
  const boundedRuntimeEditAuthority =
    preview?.genericInitialEditCandidate ??
    preview?.initialEditRuntimeAuthority ??
    preview?.runtimeTraceTerminalEditAuthority ??
    null;
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
            displayOnlyPreview ||
            insertTool === "select" ||
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
          <StudioMotionOverlay
            dragPreview={dragPreview}
            editableMotionIds={editableMotionIds}
            entities={entities}
            interactionMode={interactionMode}
            motionPaths={motionPaths}
            onMotionControlChange={onMotionControlChange}
          />
          {entities.map((entity) => {
            const pendingRuntimeTraceTargetId = preview?.runtimeTraceValidationPending?.studioEntityId ?? null;
            if (
              pendingRuntimeTraceTargetId !== null &&
              !retainingRuntimeTraceBasePixels &&
              entity.id !== pendingRuntimeTraceTargetId
            )
              return null;
            const presentedIdentity =
              showingCanvasPixels && preview
                ? verifiedPreviewGeometryForStudioEntityV1(preview, studioEntityIdByUniqueSourceName, entity)
                : null;
            // Source projection does not expand a directly-added VGroup into
            // present child rows. A correlated selection-only frame does: its
            // runtime identity plus prepared bounds are sufficient to expose
            // a paint-free selector, but never a mutation gesture.
            const runtimePresentSelectionEntity =
              (selectionOnlyPreview || preview?.interactionAuthority.kind === "bounded-interactive") &&
              showingCanvasPixels &&
              presentedIdentity !== null;
            if (!entity.present && !runtimePresentSelectionEntity) return null;
            // Aggregate morph identity is intentionally ambiguous. Once its
            // verified pixels are presented, retaining source-projected hit
            // targets would both obscure the frame and suggest unsupported
            // per-entity editing authority.
            if (displayOnlyPreview && presentingCanvasPixels) return null;
            if (isTransitionOverlay(entity)) {
              const transition = transitionStyle(entity);
              return <div className={transition.className} key={entity.id} style={transition.style} />;
            }
            const selected = selectedIds.has(entity.id);
            const selectionLocked =
              readOnly ||
              displayOnlyPreview ||
              (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
            const runtimeMutationLocked =
              boundedRuntimeEditAuthority !== null && entity.id !== boundedRuntimeEditAuthority.studioEntityId;
            const selectionOnlyEntity = selectionOnlyPreview || runtimeMutationLocked;
            const mutationLocked = selectionLocked || selectionOnlyEntity;
            const positionUnknown = entity.geometry.position.kind === "unknown";
            const scaleUnknown = entity.geometry.scale.kind === "unknown";
            const dimensionsUnknown = entity.geometry.dimensions.kind === "unknown";
            const approximate = Object.values(entity.geometry).some((knowledge) => knowledge.kind === "unknown");
            const geometrylessInitialTargetIsRetained =
              (preview?.state.phase === "presented" && preview.state.frame.sampleTime === 0) ||
              dragPreview?.entityIds.includes(entity.id) === true;
            const sealedPositionOnlyTarget =
              preview?.initialEditRuntimeAuthority?.profile === "square-to-circle-v8" &&
              preview.initialEditRuntimeAuthority.studioEntityId === entity.id &&
              geometrylessInitialTargetIsRetained &&
              !positionUnknown &&
              !dimensionsUnknown &&
              !scaleUnknown;
            // A logical source group with no requested prepared bounds must
            // not mint a semantic hit target beside the WebGPU frame. The
            // bounded V10/V12 targets are admitted only by runtime identity.
            // Exact V8 is position-only and its sealed source projection owns
            // the hit target even when the retained packet has no AABB table.
            if (
              (selectionOnlyPreview || boundedRuntimeEditAuthority !== null) &&
              showingCanvasPixels &&
              presentedIdentity === null &&
              !sealedPositionOnlyTarget
            )
              return null;
            const runtimeTraceTargetGhost =
              pendingRuntimeTraceTargetId === entity.id ||
              (retainingRuntimeTraceBasePixels &&
                boundedRuntimeEditAuthority?.studioEntityId === entity.id &&
                (dragPreview?.entityIds.includes(entity.id) === true ||
                  scalePreview?.entityId === entity.id ||
                  geometryPreview?.entityId === entity.id));
            const runtimeGeometry = presentedIdentity?.geometry ?? null;
            const presentedGeometry = runtimeTraceTargetGhost ? null : runtimeGeometry;
            const moveLocked = selectionLocked || (positionUnknown && presentedGeometry === null);
            const localDelta = entityDragDelta(dragPreview, entity.id);
            const displayedScale = entityPreviewScale(scalePreview, entity);
            const semanticPreviewGeometry = entityPreviewGeometry(geometryPreview, entity);
            const compensatedRuntimeGeometry = runtimeGeometry
              ? compensatePreviewGeometryForSemanticScalesV1(runtimeGeometry, cameraScale, displayedScale)
              : null;
            // A pending Runtime Trace edit must move the semantic draft ghost,
            // not the retained base pixels. Keep the runtime AABB only as local
            // paint geometry so unknown Tex dimensions never collapse the ghost;
            // it is deliberately not written back into the projected entity.
            const runtimeTracePositionOnlyGhost =
              runtimeTraceTargetGhost &&
              (preview?.runtimeTraceTerminalEditAuthority?.profile === "opening-grid-title-terminal-v2" ||
                preview?.runtimeTraceValidationPending?.profile === "opening-grid-title-terminal-v2");
            const runtimeTraceGhostGeometry =
              runtimeTracePositionOnlyGhost && compensatedRuntimeGeometry?.dimensions
                ? { ...semanticPreviewGeometry, dimensions: compensatedRuntimeGeometry.dimensions }
                : null;
            const previewGeometry = presentedGeometry
              ? (compensatedRuntimeGeometry ?? semanticPreviewGeometry)
              : (runtimeTraceGhostGeometry ?? semanticPreviewGeometry);
            const position = {
              x: previewGeometry.position.x + localDelta.x,
              y: previewGeometry.position.y + localDelta.y,
            };
            const opacity = draftTransactionId === entity.transactionId && entity.opacity === 0 ? 0.35 : entity.opacity;
            const shape = resizeKindForType(entity.type);
            const runtimeUniformScaleOnly = boundedRuntimeEditAuthority?.studioEntityId === entity.id;
            const runtimePositionOnly =
              (preview?.runtimeTraceTerminalEditAuthority?.profile === "opening-grid-title-terminal-v2" &&
                preview.runtimeTraceTerminalEditAuthority.studioEntityId === entity.id) ||
              (preview?.initialEditRuntimeAuthority?.profile === "square-to-circle-v8" &&
                preview.initialEditRuntimeAuthority.studioEntityId === entity.id);
            // Runtime AABBs position and size the hit target, but are not
            // authoring evidence for a Circle radius or Rectangle dimensions.
            // Shape resizing remains gated by the semantic source projection.
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
                data-studio-entity-height={(presentedGeometry ?? previewGeometry).dimensions?.height?.toFixed(4)}
                data-studio-entity-radius={(presentedGeometry ?? previewGeometry).dimensions?.radius?.toFixed(4)}
                data-studio-entity-scale={displayedScale.toFixed(4)}
                data-studio-entity-width={(presentedGeometry ?? previewGeometry).dimensions?.width?.toFixed(4)}
                data-studio-entity-wrapper={entity.id}
                data-studio-runtime-binding={presentedIdentity?.bindingId}
                data-studio-runtime-entity={presentedIdentity?.runtimeEntityId}
                key={entity.id}
                style={{ ...viewportPositionStyle(position), opacity, touchAction: "none" }}
              >
                <div className="relative origin-center" style={{ scale: displayedScale }}>
                  <button
                    aria-label={`Move ${entityLabel(entity)}`}
                    aria-pressed={selected}
                    className={cn(
                      "block border outline-none",
                      presentedGeometry ? "box-border p-0" : shape ? "p-0" : "px-3 py-2",
                      moveLocked
                        ? "pointer-events-none border-dashed border-sky-800 bg-zinc-950/70"
                        : selectionOnlyEntity
                          ? "cursor-pointer"
                          : "cursor-grab active:cursor-grabbing",
                      selected
                        ? "border-sky-400 bg-sky-950/60 focus-visible:ring-2 focus-visible:ring-sky-400"
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
                    style={
                      presentedGeometry || runtimeTraceTargetGhost
                        ? entityDimensionStyle(previewGeometry.dimensions, frame)
                        : undefined
                    }
                    title={
                      selectionOnlyEntity
                        ? "This verified object can be selected, but source rewriting is unavailable."
                        : positionUnknown
                          ? entity.geometry.position.reason
                          : undefined
                    }
                    type="button"
                  >
                    <span
                      className={cn(
                        "block",
                        showingCanvasPixels && !runtimeTraceTargetGhost && "pointer-events-none opacity-0",
                        runtimeTraceTargetGhost && "opacity-60",
                      )}
                      data-studio-semantic-paint={
                        showingCanvasPixels && !runtimeTraceTargetGhost ? "deferred-to-canvas" : "painted"
                      }
                    >
                      <ObjectVisual dimensions={previewGeometry.dimensions} entity={entity} frame={frame} />
                    </span>
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
        {preview ? (
          <div
            className="absolute right-2 top-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300"
            data-studio-preview-status={preview.state.phase}
            title={preview.state.phase === "fallback" ? (preview.state.detail ?? undefined) : undefined}
          >
            {preview.runtimeTraceValidationPending
              ? preview.runtimeTraceValidationPending.profile === "updaters-terminal-v1"
                ? "Draft ghost · dependent updater validation pending"
                : "Draft ghost · OpeningManim validation pending"
              : preview.state.phase === "presented"
                ? `Canvas preview · ${preview.sourceLabel ?? "verified snapshot"} · ${
                    displayOnlyPreview
                      ? "display only"
                      : selectionOnlyPreview
                        ? "selection only"
                        : preview.interactionAuthority.kind === "bounded-interactive"
                          ? preview.interactionAuthority.reason === "runtime-trace-initial-edit"
                            ? "Runtime Trace initial move / uniform resize"
                            : preview.runtimeTraceTerminalEditAuthority?.profile === "opening-grid-title-terminal-v2"
                              ? "Grid title terminal edit at 14.00s"
                              : "Square terminal edit at 5.00s"
                          : "editing preview only"
                  }`
                : `Canvas preview fallback · ${describeStudioPreviewFallbackV1(preview.state.reason)}`}
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
