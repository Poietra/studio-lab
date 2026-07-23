import type { KeyboardEvent, PointerEvent } from "react";

import { cn } from "../lib/cn";
import type { Point, ProjectedEntity } from "./model";
import type { StudioMotionPath } from "./motion-paths";
import { EquationContent } from "./prototype-rendering";
import { StudioMotionOverlay } from "./studio-motion-overlay";
import type { StudioTool } from "./studio-toolbar";
import {
  clientPointToViewport,
  entityDragDelta,
  type EntityDragPreview,
  entityPreviewScale,
  type EntityScalePreview,
  type InteractionMode,
  isCanvasInteractionTarget,
  viewportPositionStyle,
} from "./studio-viewport-geometry";
import { isTransitionOverlay } from "./workspace-projection";

export type StudioCanvasProps = Readonly<{
  appliedTransactionIds: ReadonlySet<string>;
  boundaryActive: boolean;
  cameraScale: number;
  draftTransactionId: string | null;
  dragPreview: EntityDragPreview | null;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
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
  onEntityResizeKeyDown: (event: KeyboardEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityResizePointerDown: (event: PointerEvent<HTMLButtonElement>, entityId: string) => void;
  onEntityResizePointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onEntityResizePointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
  readOnly: boolean;
  sampleId: string;
  scalePreview: EntityScalePreview | null;
  selectedIds: ReadonlySet<string>;
}>;

export function entityLabel(entity: ProjectedEntity) {
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
    style: { opacity: entity.opacity, scale: 0.05 + entity.opacity * 14 },
  };
}

function ObjectVisual({ entity }: Readonly<{ entity: ProjectedEntity }>) {
  if (entity.type === "MathTex") {
    return <EquationContent lines={entity.content?.displayLines ?? [entityLabel(entity)]} texParts={entity.content?.texParts} />;
  }
  if (entity.type === "Text") {
    return <span className="block max-w-56 text-pretty text-center text-sm leading-5">{entity.content?.text ?? entityLabel(entity)}</span>;
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
    return <span aria-hidden="true" className="block h-14 w-32 border border-zinc-500" />;
  }
  if (entity.type === "Circle" || entity.type === "Dot") {
    return <span aria-hidden="true" className="block size-16 rounded-full border border-zinc-500" />;
  }
  if (entity.type === "RegularPolygon") {
    return <span aria-hidden="true" className="block size-16 border border-zinc-500 [clip-path:polygon(50%_0%,93%_25%,93%_75%,50%_100%,7%_75%,7%_25%)]" />;
  }
  return <span className="block border border-zinc-600 px-3 py-2 text-xs text-zinc-300">{entityLabel(entity)}</span>;
}

export function StudioCanvas({
  appliedTransactionIds,
  boundaryActive,
  cameraScale,
  draftTransactionId,
  dragPreview,
  editableMotionIds,
  entities,
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
  readOnly,
  sampleId,
  scalePreview,
  selectedIds,
}: StudioCanvasProps) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
      <div
        className="relative aspect-video w-full max-w-5xl overflow-hidden border border-zinc-700 bg-black"
        data-studio-canvas
        data-proposed-state-sample={sampleId}
        data-scene-phase={boundaryActive ? "incoming" : "outgoing"}
        onPointerDown={(event) => {
          if (insertTool === "select" || boundaryActive || isCanvasInteractionTarget(event.target)) return;
          onCanvasPlace(clientPointToViewport(
            event.currentTarget.getBoundingClientRect(),
            { x: event.clientX, y: event.clientY },
          ));
        }}
      >
        <div className="absolute inset-0 origin-center" data-studio-transform-layer style={{ scale: cameraScale }}>
          <svg aria-hidden="true" className="absolute inset-0 size-full opacity-10" viewBox="0 0 640 360">
            <g stroke="#a1a1aa" strokeWidth="1">
              {[80, 160, 240, 320, 400, 480, 560].map((x) => <line key={`x-${x}`} x1={x} x2={x} y1="0" y2="360" />)}
              {[90, 180, 270].map((y) => <line key={`y-${y}`} x1="0" x2="640" y1={y} y2={y} />)}
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
            if (!entity.present) return null;
            if (isTransitionOverlay(entity)) {
              const transition = transitionStyle(entity);
              return <div className={transition.className} key={entity.id} style={transition.style} />;
            }
            const selected = selectedIds.has(entity.id);
            const locked = readOnly
              || (entity.provisional && !(entity.transactionId && appliedTransactionIds.has(entity.transactionId)));
            const localDelta = entityDragDelta(dragPreview, entity.id);
            const position = { x: entity.position.x + localDelta.x, y: entity.position.y + localDelta.y };
            const opacity = draftTransactionId === entity.transactionId && entity.opacity === 0 ? 0.35 : entity.opacity;
            const displayedScale = entityPreviewScale(scalePreview, entity);
            return (
              <div
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2",
                  selected ? "z-20" : "z-10",
                )}
                data-studio-entity-scale={displayedScale.toFixed(4)}
                data-studio-entity-wrapper={entity.id}
                key={entity.id}
                style={{ ...viewportPositionStyle(position), opacity, touchAction: "none" }}
              >
                <div className="relative origin-center" style={{ scale: displayedScale }}>
                  <button
                    aria-label={`Move ${entityLabel(entity)}`}
                    aria-pressed={selected}
                    className={cn(
                      "block border px-3 py-2 outline-none",
                      locked ? "pointer-events-none border-dashed border-sky-800 bg-zinc-950/70" : "cursor-grab active:cursor-grabbing",
                      selected ? "border-sky-400 bg-sky-950/60 focus-visible:ring-2 focus-visible:ring-sky-400" : "border-transparent hover:border-zinc-600",
                    )}
                    data-studio-entity={entity.id}
                    disabled={locked}
                    onKeyDown={(event) => onEntityKeyDown(event, entity.id)}
                    onLostPointerCapture={onEntityPointerCancel}
                    onPointerCancel={onEntityPointerCancel}
                    onPointerDown={(event) => onEntityPointerDown(event, entity.id)}
                    onPointerMove={onEntityPointerMove}
                    onPointerUp={onEntityPointerUp}
                    type="button"
                  >
                    <ObjectVisual entity={entity} />
                    {selected ? (
                      <span className="absolute -top-6 left-0 max-w-56 truncate bg-sky-400 px-1.5 py-0.5 text-[10px] font-medium text-sky-950">
                        {entityLabel(entity)}
                      </span>
                    ) : null}
                  </button>
                  {selected && selectedIds.size === 1 && !locked ? (
                    <button
                      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                      aria-label={`Resize ${entityLabel(entity)}`}
                      className="absolute -bottom-2 -right-2 z-30 size-4 touch-none cursor-nwse-resize border-2 border-sky-950 bg-sky-400 outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                      data-studio-resize-handle={entity.id}
                      onKeyDown={(event) => onEntityResizeKeyDown(event, entity.id)}
                      onLostPointerCapture={onEntityResizeCancel}
                      onPointerCancel={onEntityResizeCancel}
                      onPointerDown={(event) => onEntityResizePointerDown(event, entity.id)}
                      onPointerMove={onEntityResizePointerMove}
                      onPointerUp={onEntityResizePointerUp}
                      style={{ scale: 1 / displayedScale }}
                      title="Drag to resize uniformly · Arrow keys adjust precisely"
                      type="button"
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {boundaryActive && incomingSceneName ? (
          <div className="absolute bottom-2 left-2 z-30 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] text-zinc-300">
            Incoming Scene · {incomingSceneName}
          </div>
        ) : null}
      </div>
    </div>
  );
}
