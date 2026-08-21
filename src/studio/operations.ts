import { canonicalEditableContent } from "./editable-content";
import type { SceneEdit, SceneEditOperation, SceneEditOrigin } from "./scene-edit-contract";

export type { SceneEdit, SceneEditOperation, SceneEditOrigin } from "./scene-edit-contract";
export { SCENE_EDIT_VERSION as EDIT_OPERATION_VERSION } from "./scene-edit-contract";

export type PropertyChannelKey =
  | "appearance"
  | "camera"
  | "content"
  | "dimensions"
  | "fillColor"
  | "identity"
  | `materialParameter:${string}:${number}`
  | "pathTrim"
  | "sourceZIndex"
  | "position"
  | "presence"
  | "rotation"
  | "scale"
  | "shape"
  | "strokeColor"
  | "visibility";

export type ChannelAccess = Readonly<{
  channel: PropertyChannelKey;
  entityId: string;
}>;

export type OperationOrigin = SceneEditOrigin;
export type OperationBase = Pick<SceneEditOperation, "dependsOn" | "id" | "interval" | "provenance">;
export type CreateEntityOperation = Extract<SceneEditOperation, { kind: "CreateEntity" }>;
export type DrawInOperation = Extract<SceneEditOperation, { kind: "DrawIn" }>;
export type WriteInOperation = Extract<SceneEditOperation, { kind: "WriteIn" }>;
export type ResizeEntityOperation = Extract<SceneEditOperation, { kind: "ResizeEntity" }>;
export type SetPropertyOperation = Extract<SceneEditOperation, { kind: "SetProperty" }>;
export type AnimatePropertyOperation = Extract<SceneEditOperation, { kind: "AnimateProperty" }>;
export type CreateMotionOperation = Extract<SceneEditOperation, { kind: "CreateMotion" }>;
export type TransformContentOperation = Extract<SceneEditOperation, { kind: "TransformContent" }>;
export type TransformShapeOperation = Extract<SceneEditOperation, { kind: "TransformShape" }>;
export type SetRelationOperation = Extract<SceneEditOperation, { kind: "SetRelation" }>;
export type ChangePresenceOperation = Extract<SceneEditOperation, { kind: "ChangePresence" }>;
export type InsertTimelineEventOperation = Extract<SceneEditOperation, { kind: "InsertTimelineEvent" }>;
export type TrimSceneDurationOperation = Extract<SceneEditOperation, { kind: "TrimSceneDuration" }>;

export type SceneDurationWaitOperation = InsertTimelineEventOperation &
  Readonly<{
    eventKind: "wait";
    provenance: InsertTimelineEventOperation["provenance"] & Readonly<{ origin: "studio-default" }>;
    purpose: "scene-duration";
  }>;

export type SceneDurationOperation = SceneDurationWaitOperation | TrimSceneDurationOperation;

export type InsertSceneBoundaryOperation = Extract<SceneEditOperation, { kind: "InsertSceneBoundary" }>;
export type ChangeCameraOperation = Extract<SceneEditOperation, { kind: "ChangeCamera" }>;
export type CanonicalEditOperation = SceneEditOperation;

export function isSceneDurationOperation(operation: SceneEditOperation): operation is SceneDurationOperation {
  return (
    operation.kind === "TrimSceneDuration" ||
    (operation.kind === "InsertTimelineEvent" &&
      operation.eventKind === "wait" &&
      operation.purpose === "scene-duration" &&
      operation.provenance.origin === "studio-default")
  );
}

export function isStaticRootTransformOperation(operation: SceneEditOperation) {
  return (
    operation.kind === "ResizeEntity" ||
    (operation.kind === "SetProperty" && operation.key === "position") ||
    (operation.kind === "AnimateProperty" && (operation.key === "rotation" || operation.key === "scale"))
  );
}

export function isExactStaticRootTransformProgramBatch(programs: readonly SceneEdit[]) {
  return (
    programs.length > 0 &&
    programs.every(
      (program) => program.operations.length > 0 && program.operations.every(isStaticRootTransformOperation),
    )
  );
}

export function isExactStudioMathTexContentProgramBatch(programs: readonly SceneEdit[]) {
  if (programs.length !== 1 || programs[0]?.operations.length !== 1) return false;
  const program = programs[0];
  const operation = program.operations[0];
  return (
    program.anchor.capturedPlayhead === 0 &&
    program.anchor.resolvedSeconds === 0 &&
    operation?.kind === "SetProperty" &&
    operation.key === "content" &&
    operation.interval.start === 0 &&
    operation.interval.end === 0 &&
    canonicalEditableContent(operation.value, "MathTex") !== null
  );
}

export function isExactStaticRootProjectionProgramBatch(programs: readonly SceneEdit[]) {
  return isExactStaticRootTransformProgramBatch(programs) || isExactStudioMathTexContentProgramBatch(programs);
}

export function hasImportedRootTransformTarget(programs: readonly SceneEdit[]) {
  const operations = programs.flatMap((program) => program.operations);
  const createdEntityIds = new Set(
    operations.flatMap((operation) => (operation.kind === "CreateEntity" ? [operation.entity.id] : [])),
  );
  return operations.some(
    (operation) =>
      "entityId" in operation && !createdEntityIds.has(operation.entityId) && isStaticRootTransformOperation(operation),
  );
}

export type DependencyReason = "explicit" | "identity" | "lifetime" | "read-after-write" | "write-conflict";

export type DependencyEdge = Readonly<{
  from: string;
  reason: DependencyReason;
  to: string;
}>;

export type SceneEditValidationIssue = Readonly<{
  code:
    | "anchor-invalid"
    | "cycle"
    | "identity-unknown"
    | "interval-invalid"
    | "lifetime-unknown"
    | "lowering-unsupported"
    | "operation-count"
    | "parallel-conflict"
    | "provisional-id-invalid"
    | "schema-invalid"
    | "style-profile-deviation"
    | "target-missing";
  field: string;
  message: string;
  operationId?: string;
  severity: "error" | "warning";
}>;

export type CanonicalEditProgram = SceneEdit;
export type ProgramValidationIssue = SceneEditValidationIssue;

/** Shared tolerance for preserving applied Program source order. */
export const APPLIED_PROGRAM_SOURCE_ORDER_EPSILON_V1 = 0.0005;

export function provisionalEntityId(transactionId: string, localName: string) {
  return `tx:${transactionId}/entity:${localName}`;
}

export function operationId(transactionId: string, localName: string) {
  return `tx:${transactionId}/operation:${localName}`;
}

export function initialAppearanceEnd(
  operations: readonly SceneEditOperation[],
  entityId: string,
  lifetimeStart: number,
) {
  return operations.reduce(
    (end, operation) =>
      "entityId" in operation &&
      operation.entityId === entityId &&
      (operation.kind === "DrawIn" ||
        operation.kind === "WriteIn" ||
        (operation.kind === "ChangePresence" && operation.effect === "fade-in"))
        ? Math.max(end, operation.interval.end)
        : end,
    lifetimeStart,
  );
}

export function channelKey(access: ChannelAccess) {
  return `${access.entityId}/${access.channel}`;
}
