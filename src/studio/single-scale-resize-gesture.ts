import {
  type AlignmentGuide,
  type FrameSnapBasis,
  type FrameSnapBounds,
  type PreparedMoveSnapBasis,
  snapUniformResizeToFrame,
} from "./frame-alignment-snap";
import type { Point } from "./model";
import { uniformCornerResizeFactor } from "./shape-resize";
import { clientPointToViewport, type SurfaceBounds, viewportScaleForBounds } from "./studio-viewport-geometry";

export type SingleScaleResizeGesture = Readonly<{
  center: Point;
  fromScale: number;
  maximumFactor: number;
  minimumFactor: number;
  snapBasis: FrameSnapBasis;
  start: Point;
  surfaceBounds: SurfaceBounds;
}>;

function validBounds(bounds: FrameSnapBounds) {
  return (
    Number.isFinite(bounds.bottom) &&
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.top) &&
    bounds.bottom >= bounds.top &&
    bounds.right >= bounds.left
  );
}

/** Captures the renderer-prepared AABB at pointerdown. DOM layout is used
 * only to convert client pointer coordinates into the 640x360 viewport. */
export function createSingleScaleResizeGesture(
  input: Readonly<{
    basis: PreparedMoveSnapBasis;
    entityId: string;
    frame: FrameSnapBounds;
    fromScale: number;
    maximumScale: number;
    minimumScale: number;
    startClient: Point;
    surfaceBounds: SurfaceBounds;
  }>,
): SingleScaleResizeGesture | null {
  if (
    input.basis.entityIds.length !== 1 ||
    input.basis.entityIds[0] !== input.entityId ||
    !validBounds(input.basis.bounds) ||
    !validBounds(input.frame) ||
    !Number.isFinite(input.fromScale) ||
    input.fromScale <= 0 ||
    !Number.isFinite(input.minimumScale) ||
    !Number.isFinite(input.maximumScale) ||
    input.minimumScale <= 0 ||
    input.maximumScale < input.minimumScale
  )
    return null;
  return {
    center: {
      x: (input.basis.bounds.left + input.basis.bounds.right) / 2,
      y: (input.basis.bounds.top + input.basis.bounds.bottom) / 2,
    },
    fromScale: input.fromScale,
    maximumFactor: input.maximumScale / input.fromScale,
    minimumFactor: input.minimumScale / input.fromScale,
    snapBasis: {
      frame: input.frame,
      objects: input.basis.objects,
      selection: input.basis.bounds,
    },
    start: clientPointToViewport(input.surfaceBounds, input.startClient),
    surfaceBounds: input.surfaceBounds,
  };
}

export function resolveSingleScaleResize(
  resize: SingleScaleResizeGesture,
  currentClient: Point,
  disableSnap = false,
): Readonly<{ factor: number; guides: readonly AlignmentGuide[]; scale: number }> {
  const current = clientPointToViewport(resize.surfaceBounds, currentClient);
  if (Math.hypot(current.x - resize.start.x, current.y - resize.start.y) <= 0.001) {
    return { factor: 1, guides: [], scale: resize.fromScale };
  }
  const rawFactor = uniformCornerResizeFactor({
    current,
    maximum: resize.maximumFactor,
    minimum: resize.minimumFactor,
    pivot: resize.center,
    start: resize.start,
  });
  const snapped = snapUniformResizeToFrame({
    basis: resize.snapBasis,
    disabled: disableSnap,
    factor: rawFactor,
    maximumFactor: resize.maximumFactor,
    minimumFactor: resize.minimumFactor,
    pivot: resize.center,
    viewportUnitsPerCssPixel: viewportScaleForBounds(resize.surfaceBounds),
  });
  return { factor: snapped.factor, guides: snapped.guides, scale: resize.fromScale * snapped.factor };
}
