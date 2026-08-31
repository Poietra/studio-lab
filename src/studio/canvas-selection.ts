import type { Point } from "./model";

export type CanvasSelectionMode = "single" | "toggle";

export type CanvasMarqueeRect = Readonly<{
  bottom: number;
  left: number;
  right: number;
  top: number;
}>;

export function canvasMarqueeRect(start: Point, current: Point): CanvasMarqueeRect {
  return {
    bottom: Math.max(start.y, current.y),
    left: Math.min(start.x, current.x),
    right: Math.max(start.x, current.x),
    top: Math.min(start.y, current.y),
  };
}

export function canvasMarqueeIntersects(left: CanvasMarqueeRect, right: CanvasMarqueeRect) {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}

export function applyCanvasBatchSelection(
  selection: readonly string[],
  entityIds: readonly string[],
  mode: "add" | "replace",
) {
  return mode === "add" ? [...new Set([...selection, ...entityIds])] : [...entityIds];
}

export function toggleCanvasEntitySelection(selection: readonly string[], entityId: string): readonly string[] {
  return selection.includes(entityId) ? selection.filter((id) => id !== entityId) : [...selection, entityId];
}

export function canvasDragTargetEntityIds(
  selectedEditableIds: readonly string[],
  pressedEntityId: string,
  forceSingle = false,
): readonly string[] {
  return !forceSingle && selectedEditableIds.includes(pressedEntityId) ? selectedEditableIds : [pressedEntityId];
}
