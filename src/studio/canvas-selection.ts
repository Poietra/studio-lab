export type CanvasSelectionMode = "single" | "toggle";

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
