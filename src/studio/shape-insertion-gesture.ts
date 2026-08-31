import type { EntityDimensions, Point } from "./model";
import { clientPointToViewport, STUDIO_VIEWPORT, type SurfaceBounds } from "./studio-viewport-geometry";

export type ShapeInsertionTool = "Circle" | "Rectangle";

export type ShapeInsertionPlacement = Readonly<{
  dimensions?: EntityDimensions;
  point: Point;
}>;

export const SHAPE_INSERTION_MINIMUM_CLIENT_DISTANCE = 4;

const MINIMUM_SHAPE_DIMENSION = 0.1;

/** Converts one blank-canvas pointer gesture into placement geometry only.
 * Scene creation and validation remain owned by the canonical authoring path. */
export function shapeInsertionPlacement(
  input: Readonly<{
    bounds: SurfaceBounds;
    currentClientPoint: Point;
    frame: Readonly<{ height: number; width: number }>;
    startClientPoint: Point;
    tool: ShapeInsertionTool;
  }>,
): ShapeInsertionPlacement {
  const start = clientPointToViewport(input.bounds, input.startClientPoint);
  if (
    Math.hypot(
      input.currentClientPoint.x - input.startClientPoint.x,
      input.currentClientPoint.y - input.startClientPoint.y,
    ) < SHAPE_INSERTION_MINIMUM_CLIENT_DISTANCE
  ) {
    return { point: start };
  }

  const current = clientPointToViewport(input.bounds, input.currentClientPoint);
  const width = Math.max(
    MINIMUM_SHAPE_DIMENSION,
    (Math.abs(current.x - start.x) / STUDIO_VIEWPORT.width) * input.frame.width,
  );
  const height = Math.max(
    MINIMUM_SHAPE_DIMENSION,
    (Math.abs(current.y - start.y) / STUDIO_VIEWPORT.height) * input.frame.height,
  );
  const point = { x: (start.x + current.x) / 2, y: (start.y + current.y) / 2 };

  return input.tool === "Circle"
    ? { dimensions: { radius: Math.max(MINIMUM_SHAPE_DIMENSION, Math.max(width, height) / 2) }, point }
    : { dimensions: { height, width }, point };
}
