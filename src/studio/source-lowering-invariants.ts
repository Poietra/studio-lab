import type { SceneEditOperation } from "./scene-edit-contract";

const EPSILON = 0.001;

function operationEntityIds(operation: SceneEditOperation) {
  if (operation.kind === "TransformContent") {
    return [operation.sourceEntityId, operation.targetEntityId];
  }
  if (operation.kind === "AnimateProperty" && operation.key === "scale") {
    return [operation.entityId];
  }
  return [];
}

export function scaleTransformViolation(operations: readonly SceneEditOperation[]) {
  const transforms = operations.filter(
    (
      operation,
    ): operation is Extract<
      SceneEditOperation,
      {
        kind: "TransformContent";
      }
    > => operation.kind === "TransformContent",
  );
  if (transforms.length === 0) return null;
  const related = new Map<string, Set<string>>();
  for (const transform of transforms) {
    const merged = new Set([
      transform.sourceEntityId,
      transform.targetEntityId,
      ...(related.get(transform.sourceEntityId) ?? []),
      ...(related.get(transform.targetEntityId) ?? []),
    ]);
    for (const entityId of merged) related.set(entityId, merged);
  }
  for (const operation of operations) {
    if (operation.kind !== "AnimateProperty" || operation.key !== "scale") continue;
    const transform = transforms.find((candidate) =>
      (related.get(candidate.sourceEntityId) ?? new Set(operationEntityIds(candidate))).has(operation.entityId),
    );
    if (transform) return { scaleOperationId: operation.id, transformOperationId: transform.id } as const;
  }
  return null;
}

function isTransitionInternalOperation(
  operation: SceneEditOperation,
  boundary: Extract<SceneEditOperation, { kind: "InsertSceneBoundary" }>,
  overlayEntityIds: ReadonlySet<string>,
) {
  if (operation.id === boundary.id) return true;
  if (operation.kind === "CreateEntity" && overlayEntityIds.has(operation.entity.id)) {
    return operation.interval.end <= boundary.at + EPSILON;
  }
  if (operation.kind !== "ChangePresence" || !overlayEntityIds.has(operation.entityId)) return false;
  if (operation.effect === "cover") return operation.interval.end <= boundary.at + EPSILON;
  return (
    operation.effect === "reveal" &&
    Math.abs(operation.interval.start - boundary.at) < EPSILON &&
    operation.dependsOn.includes(boundary.id)
  );
}

export function sceneBoundaryViolation(operations: readonly SceneEditOperation[]) {
  const boundaries = operations.filter(
    (
      operation,
    ): operation is Extract<
      SceneEditOperation,
      {
        kind: "InsertSceneBoundary";
      }
    > => operation.kind === "InsertSceneBoundary",
  );
  const overlayEntityIds = new Set(
    operations.flatMap((operation) =>
      operation.kind === "CreateEntity" && operation.entity.type.startsWith("TransitionOverlay:")
        ? [operation.entity.id]
        : [],
    ),
  );
  for (const boundary of boundaries) {
    for (const operation of operations) {
      if (isTransitionInternalOperation(operation, boundary, overlayEntityIds)) continue;
      if (operation.interval.start >= boundary.at - EPSILON || operation.interval.end > boundary.at + EPSILON) {
        return { boundaryOperationId: boundary.id, operationId: operation.id } as const;
      }
    }
  }
  return null;
}
