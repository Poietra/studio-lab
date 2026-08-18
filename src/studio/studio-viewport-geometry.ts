import type { EntityDimensions, Point, ProjectedEntity } from "./model";

export const STUDIO_VIEWPORT = { height: 360, width: 640 } as const;

export type InteractionMode = "animate" | "position";
export type EntityDragPreview = Readonly<{
  delta: Point;
  entityIds: readonly string[];
}>;
export type EntityScalePreview = Readonly<{
  entityId: string;
  scale: number;
}>;
export type EntityRotationPreview = Readonly<{
  angleRadians: number;
  entityId: string;
}>;
export type EntityGeometryPreview = Readonly<{
  dimensions: EntityDimensions;
  entityId: string;
  position: Point;
}>;

export type SurfaceBounds = Readonly<{
  height: number;
  left: number;
  top: number;
  width: number;
}>;

const ZERO_DELTA = { x: 0, y: 0 } as const;
const CANVAS_INTERACTION_SELECTOR =
  "[data-studio-entity], [data-motion-control], [data-studio-resize-handle], [data-studio-rotation-handle], [data-studio-inline-text-editor]";

export function entityDragDelta(preview: EntityDragPreview | null, entityId: string) {
  return preview?.entityIds.includes(entityId) ? preview.delta : ZERO_DELTA;
}

export function entityPreviewScale(
  preview: EntityScalePreview | null,
  entity: Readonly<Pick<ProjectedEntity, "id" | "scale">>,
) {
  return preview?.entityId === entity.id ? preview.scale : entity.scale;
}

export function entityPreviewRotation(preview: EntityRotationPreview | null, entityId: string) {
  return preview?.entityId === entityId ? preview.angleRadians : 0;
}

/** Returns a Manim-compatible counter-clockwise angle from client-space
 * pointers, whose positive Y axis points down. */
export function rotationDeltaFromClientPoints(
  center: Point,
  start: Point,
  current: Point,
  snapRadians: number | null = null,
) {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const currentAngle = Math.atan2(current.y - center.y, current.x - center.x);
  const counterClockwiseDelta = -Math.atan2(Math.sin(currentAngle - startAngle), Math.cos(currentAngle - startAngle));
  if (snapRadians === null || !Number.isFinite(snapRadians) || snapRadians <= 0) return counterClockwiseDelta;
  return Math.round(counterClockwiseDelta / snapRadians) * snapRadians;
}

export function clientPointToViewport(bounds: SurfaceBounds, clientPoint: Point): Point {
  return {
    x: bounds.width ? ((clientPoint.x - bounds.left) / bounds.width) * STUDIO_VIEWPORT.width : 0,
    y: bounds.height ? ((clientPoint.y - bounds.top) / bounds.height) * STUDIO_VIEWPORT.height : 0,
  };
}

export function viewportScaleForBounds(bounds: Readonly<Pick<SurfaceBounds, "height" | "width">> | null): Point {
  return {
    x: bounds?.width ? STUDIO_VIEWPORT.width / bounds.width : 1,
    y: bounds?.height ? STUDIO_VIEWPORT.height / bounds.height : 1,
  };
}

export function clientDeltaToViewport(delta: Point, scale: Point): Point {
  return {
    x: delta.x * scale.x,
    y: delta.y * scale.y,
  };
}

export function viewportPositionStyle(position: Point) {
  return {
    left: `${(position.x / STUDIO_VIEWPORT.width) * 100}%`,
    top: `${(position.y / STUDIO_VIEWPORT.height) * 100}%`,
  };
}

export function isCanvasInteractionTarget(target: unknown) {
  if (!target || typeof target !== "object" || !("closest" in target)) return false;
  const closest = (target as { closest?: unknown }).closest;
  return typeof closest === "function" && Boolean(closest.call(target, CANVAS_INTERACTION_SELECTOR));
}
