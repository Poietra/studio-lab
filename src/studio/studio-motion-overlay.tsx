import { type PointerEvent, useRef, useState } from "react";

import type { Point, ProjectedEntity } from "./model";
import { quadraticPathData, type StudioMotionPath } from "./motion-paths";
import {
  clientDeltaToViewport,
  type EntityDragPreview,
  type InteractionMode,
  viewportPositionStyle,
  viewportScaleForBounds,
} from "./studio-viewport-geometry";

const ZERO_DELTA = { x: 0, y: 0 } as const;

export type StudioMotionOverlayProps = Readonly<{
  dragPreview: EntityDragPreview | null;
  editableMotionIds: ReadonlySet<string>;
  entities: readonly ProjectedEntity[];
  interactionMode: InteractionMode;
  motionPaths: readonly StudioMotionPath[];
  onMotionControlChange: (path: StudioMotionPath, delta: Point) => void;
}>;

function MotionControlHandle({
  onChange,
  onPreviewChange,
  path,
  previewDelta,
}: Readonly<{
  onChange: (path: StudioMotionPath, delta: Point) => void;
  onPreviewChange: (path: StudioMotionPath, delta: Point | null) => void;
  path: Extract<StudioMotionPath, { kind: "quadratic" }>;
  previewDelta: Point;
}>) {
  const drag = useRef<Readonly<{
    pointerId: number;
    scale: Point;
    start: Point;
  }> | null>(null);
  const point = {
    x: path.control.x + previewDelta.x,
    y: path.control.y + previewDelta.y,
  };

  function deltaFromStart(event: PointerEvent<HTMLButtonElement>, start: Point, scale: Point) {
    return clientDeltaToViewport(
      {
        x: event.clientX - start.x,
        y: event.clientY - start.y,
      },
      scale,
    );
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = deltaFromStart(event, active.start, active.scale);
    drag.current = null;
    onPreviewChange(path, null);
    if (Math.hypot(delta.x, delta.y) >= 0.5) onChange(path, delta);
  }

  function cancel(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    onPreviewChange(path, null);
  }

  return (
    <button
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
      aria-label={`Adjust motion path for ${path.entityId}`}
      className="absolute z-30 size-4 touch-none -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-200 bg-sky-500 outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      data-motion-control={path.motionId}
      onKeyDown={(event) => {
        const amount = event.shiftKey ? 10 : 2;
        const delta = {
          ArrowDown: { x: 0, y: amount },
          ArrowLeft: { x: -amount, y: 0 },
          ArrowRight: { x: amount, y: 0 },
          ArrowUp: { x: 0, y: -amount },
        }[event.key];
        if (!delta) return;
        event.preventDefault();
        onChange(path, delta);
      }}
      onLostPointerCapture={finish}
      onPointerCancel={cancel}
      onPointerDown={(event) => {
        const bounds =
          event.currentTarget.closest<HTMLElement>("[data-studio-transform-layer]")?.getBoundingClientRect() ?? null;
        drag.current = {
          pointerId: event.pointerId,
          scale: viewportScaleForBounds(bounds),
          start: { x: event.clientX, y: event.clientY },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        onPreviewChange(path, deltaFromStart(event, active.start, active.scale));
      }}
      onPointerUp={finish}
      style={viewportPositionStyle(point)}
      title="Drag to bend the path · Arrow keys adjust precisely"
      type="button"
    />
  );
}

export function StudioMotionOverlay({
  dragPreview,
  editableMotionIds,
  entities,
  interactionMode,
  motionPaths,
  onMotionControlChange,
}: StudioMotionOverlayProps) {
  const [controlPreviews, setControlPreviews] = useState<ReadonlyMap<string, Point>>(() => new Map());
  const previewedMotionPaths = motionPaths.map((path) => {
    const preview = controlPreviews.get(path.motionId);
    return path.kind === "quadratic" && preview
      ? {
          ...path,
          control: { x: path.control.x + preview.x, y: path.control.y + preview.y },
        }
      : path;
  });
  const dragPaths =
    interactionMode === "animate" && dragPreview
      ? entities.flatMap((entity) => {
          if (!dragPreview.entityIds.includes(entity.id)) return [];
          const end = {
            x: entity.position.x + dragPreview.delta.x,
            y: entity.position.y + dragPreview.delta.y,
          };
          return [
            {
              control: {
                x: (entity.position.x + end.x) / 2,
                y: (entity.position.y + end.y) / 2,
              },
              end,
              entityId: entity.id,
              interval: { end: 0, start: 0 },
              kind: "quadratic" as const,
              motionId: `${entity.id}/drag-preview`,
              start: entity.position,
            } satisfies StudioMotionPath,
          ];
        })
      : [];
  return (
    <>
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 size-full" viewBox="0 0 640 360">
        <defs>
          <marker id="studio-motion-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#38bdf8" />
          </marker>
        </defs>
        {previewedMotionPaths.map((path) => (
          <g key={`${path.entityId}/${path.motionId}`}>
            <path
              d={
                path.kind === "quadratic"
                  ? quadraticPathData(path)
                  : [
                      `M ${path.path.start.x} ${path.path.start.y}`,
                      ...path.path.segments.map(
                        (segment) =>
                          `C ${segment.control1.x} ${segment.control1.y} ${segment.control2.x} ${segment.control2.y} ${segment.end.x} ${segment.end.y}`,
                      ),
                      ...(path.path.closed ? ["Z"] : []),
                    ].join(" ")
              }
              data-motion-path={path.motionId}
              data-motion-path-kind={path.kind}
              data-motion-path-source={path.kind === "cubic" ? path.pathEntityId : undefined}
              fill="none"
              markerEnd="url(#studio-motion-arrow)"
              stroke="#38bdf8"
              strokeDasharray="5 4"
              strokeWidth="1.5"
            />
            {path.kind === "quadratic" && editableMotionIds.has(path.motionId) ? (
              <path
                d={`M ${path.start.x} ${path.start.y} L ${path.control.x} ${path.control.y} L ${path.end.x} ${path.end.y}`}
                fill="none"
                opacity="0.5"
                stroke="#7dd3fc"
                strokeWidth="1"
              />
            ) : null}
          </g>
        ))}
        {dragPaths.map((path) => (
          <path
            d={quadraticPathData(path)}
            data-motion-preview={path.entityId}
            fill="none"
            key={path.motionId}
            markerEnd="url(#studio-motion-arrow)"
            stroke="#38bdf8"
            strokeDasharray="5 4"
            strokeWidth="1.5"
          />
        ))}
      </svg>
      {motionPaths
        .filter(
          (path): path is Extract<StudioMotionPath, { kind: "quadratic" }> =>
            path.kind === "quadratic" && editableMotionIds.has(path.motionId),
        )
        .map((path) => (
          <MotionControlHandle
            key={`${path.entityId}/${path.motionId}/control`}
            onChange={onMotionControlChange}
            onPreviewChange={(previewPath, delta) => {
              setControlPreviews((current) => {
                const next = new Map(current);
                if (delta) next.set(previewPath.motionId, delta);
                else next.delete(previewPath.motionId);
                return next;
              });
            }}
            path={path}
            previewDelta={controlPreviews.get(path.motionId) ?? ZERO_DELTA}
          />
        ))}
    </>
  );
}
