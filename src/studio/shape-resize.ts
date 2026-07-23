import type { EntityDimensions, Point } from "./model";

export type ResizeHandleDirection = "e" | "n" | "ne" | "nw" | "s" | "se" | "sw" | "w";
export type ShapeResizeKind = "circle" | "rectangle";

export type ShapeGeometry = Readonly<{
  dimensions: EntityDimensions;
  position: Point;
}>;

const MIN_DIMENSION = 0.1;

export function resizeKindForType(type: string): ShapeResizeKind | null {
  if (type === "Circle") return "circle";
  if (type === "Rectangle") return "rectangle";
  return null;
}

export function hasShapeDimensions(shape: ShapeResizeKind, dimensions: EntityDimensions) {
  return shape === "circle"
    ? typeof dimensions.radius === "number" && Number.isFinite(dimensions.radius) && dimensions.radius > 0
    : typeof dimensions.width === "number" && Number.isFinite(dimensions.width) && dimensions.width > 0
      && typeof dimensions.height === "number" && Number.isFinite(dimensions.height) && dimensions.height > 0;
}

function directionSign(direction: ResizeHandleDirection, negative: "n" | "w", positive: "e" | "s") {
  if (direction.includes(negative)) return -1;
  if (direction.includes(positive)) return 1;
  return 0;
}

export function resizeShapeByViewportDelta(input: Readonly<{
  cameraScale: number;
  direction: ResizeHandleDirection;
  frame: Readonly<{ height: number; width: number }>;
  from: ShapeGeometry;
  scale: number;
  shape: ShapeResizeKind;
  viewport: Readonly<{ height: number; width: number }>;
  viewportDelta: Point;
}>): ShapeGeometry {
  const horizontal = directionSign(input.direction, "w", "e");
  const vertical = directionSign(input.direction, "n", "s");
  const pixelsPerUnit = {
    x: input.viewport.width / input.frame.width,
    y: input.viewport.height / input.frame.height,
  };
  const entityScale = Math.max(input.scale, Number.EPSILON);
  const renderedScale = Math.max(entityScale * input.cameraScale, Number.EPSILON);

  if (input.shape === "circle") {
    const radius = input.from.dimensions.radius ?? MIN_DIMENSION;
    const horizontalChange = horizontal === 0
      ? null
      : horizontal * input.viewportDelta.x / pixelsPerUnit.x / renderedScale;
    const verticalChange = vertical === 0
      ? null
      : vertical * input.viewportDelta.y / pixelsPerUnit.y / renderedScale;
    const diameterChange = horizontalChange === null ? verticalChange ?? 0
      : verticalChange === null ? horizontalChange
        : Math.abs(horizontalChange) >= Math.abs(verticalChange) ? horizontalChange : verticalChange;
    const targetRadius = Math.max(MIN_DIMENSION, radius + diameterChange / 2);
    const appliedDiameterChange = 2 * (targetRadius - radius);
    return {
      dimensions: { radius: targetRadius },
      position: {
        x: input.from.position.x + horizontal * appliedDiameterChange * pixelsPerUnit.x * entityScale / 2,
        y: input.from.position.y + vertical * appliedDiameterChange * pixelsPerUnit.y * entityScale / 2,
      },
    };
  }

  const width = input.from.dimensions.width ?? MIN_DIMENSION;
  const height = input.from.dimensions.height ?? MIN_DIMENSION;
  const targetWidth = horizontal === 0
    ? width
    : Math.max(MIN_DIMENSION, width + horizontal * input.viewportDelta.x / pixelsPerUnit.x / renderedScale);
  const targetHeight = vertical === 0
    ? height
    : Math.max(MIN_DIMENSION, height + vertical * input.viewportDelta.y / pixelsPerUnit.y / renderedScale);
  const appliedHorizontalDelta = horizontal * (targetWidth - width) * pixelsPerUnit.x * entityScale;
  const appliedVerticalDelta = vertical * (targetHeight - height) * pixelsPerUnit.y * entityScale;
  return {
    dimensions: { height: targetHeight, width: targetWidth },
    position: {
      x: input.from.position.x + appliedHorizontalDelta / 2,
      y: input.from.position.y + appliedVerticalDelta / 2,
    },
  };
}

export function centeredShapeGeometry(
  from: ShapeGeometry,
  dimensions: EntityDimensions,
): ShapeGeometry {
  return { dimensions, position: from.position };
}
