import type { Point } from "./model";
import { oppositeResizeCorner, type ResizeHandleDirection, uniformCornerResizeFactor } from "./shape-resize";
import type { EntityGroupResizePreview, SurfaceBounds } from "./studio-viewport-geometry";

export type PreparedSelectionResizeBasis = Readonly<{
  bounds: Readonly<{ bottom: number; left: number; right: number; top: number }>;
  entities: readonly Readonly<{ center: Point; entityId: string }>[];
}>;

export type SelectionResizeGesture = Readonly<{
  cameraScale: number;
  entities: readonly Readonly<{
    center: Point;
    entityId: string;
    fromPosition: Point;
    fromScale: number;
  }>[];
  maximumFactor: number;
  minimumFactor: number;
  pivot: Point;
  pointerId: number;
  sourceAnchor: number;
  start: Point;
  surfaceBounds: SurfaceBounds;
}>;

export function createSelectionResizeGesture(
  input: Readonly<{
    basis: PreparedSelectionResizeBasis;
    cameraScale: number;
    direction: ResizeHandleDirection;
    maximumScale: number;
    minimumScale: number;
    pointerId: number;
    sourceAnchor: number;
    start: Point;
    surfaceBounds: SurfaceBounds;
    targets: readonly Readonly<{ entityId: string; fromPosition: Point; fromScale: number }>[];
  }>,
): SelectionResizeGesture | null {
  const centers = new Map(input.basis.entities.map((entity) => [entity.entityId, entity.center]));
  const entities = input.targets.flatMap((target) => {
    const center = centers.get(target.entityId);
    return center ? [{ ...target, center }] : [];
  });
  if (entities.length !== input.targets.length) return null;
  return {
    cameraScale: Math.max(Math.abs(input.cameraScale), Number.EPSILON),
    entities,
    maximumFactor: Math.min(...entities.map(({ fromScale }) => input.maximumScale / fromScale)),
    minimumFactor: Math.max(...entities.map(({ fromScale }) => input.minimumScale / fromScale)),
    pivot: oppositeResizeCorner(input.direction, input.basis.bounds),
    pointerId: input.pointerId,
    sourceAnchor: input.sourceAnchor,
    start: input.start,
    surfaceBounds: input.surfaceBounds,
  };
}

export function selectionResizePreviewAtFactor(resize: SelectionResizeGesture, factor: number) {
  return {
    entities: resize.entities.map((entity) => ({
      // Prepared centers, ProjectedEntity.position, and direct-manipulation
      // deltas all use the 640x360 Studio viewport. The Rust authoring
      // boundary performs the single viewport-to-Scene conversion.
      delta: {
        x: ((entity.center.x - resize.pivot.x) * (factor - 1)) / resize.cameraScale,
        y: ((entity.center.y - resize.pivot.y) * (factor - 1)) / resize.cameraScale,
      },
      entityId: entity.entityId,
      scale: entity.fromScale * factor,
    })),
  } satisfies EntityGroupResizePreview;
}

export function resizeSelectionAtPoint(resize: SelectionResizeGesture, point: Point) {
  const factor = uniformCornerResizeFactor({
    current: point,
    maximum: resize.maximumFactor,
    minimum: resize.minimumFactor,
    pivot: resize.pivot,
    start: resize.start,
  });
  return { factor, preview: selectionResizePreviewAtFactor(resize, factor) };
}

export function selectionResizeCommandTargets(resize: SelectionResizeGesture, preview: EntityGroupResizePreview) {
  const transforms = new Map(preview.entities.map((entity) => [entity.entityId, entity]));
  if (preview.entities.length !== resize.entities.length || transforms.size !== resize.entities.length) {
    throw new Error("Selection resize preview must cover every selected object exactly once.");
  }
  return resize.entities.map((entity) => {
    const transform = transforms.get(entity.entityId);
    if (!transform) throw new Error("Selection resize preview must cover every selected object exactly once.");
    return {
      entityId: entity.entityId,
      fromScale: entity.fromScale,
      toPosition: {
        x: entity.fromPosition.x + transform.delta.x,
        y: entity.fromPosition.y + transform.delta.y,
      },
      toScale: transform.scale,
    };
  });
}
