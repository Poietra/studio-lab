import type { EntityContent, Interval, MotionEasing, Point } from "./model";
import type { ResolvedTimeAnchor } from "./time";

export const EDIT_OPERATION_VERSION = 1 as const;

export type PropertyChannelKey =
  | "appearance"
  | "camera"
  | "content"
  | "identity"
  | "ordering"
  | "position"
  | "presence"
  | "rotation"
  | "scale";

export type ChannelAccess = Readonly<{
  channel: PropertyChannelKey;
  entityId: string;
}>;

export type OperationOrigin = "direct-manipulation" | "fixture" | "remote-model" | "studio-default";

export type OperationBase = Readonly<{
  dependsOn: readonly string[];
  id: string;
  interval: Interval;
  provenance: Readonly<{ evidence: readonly string[]; origin: OperationOrigin }>;
}>;

export type CreateEntityOperation = OperationBase &
  Readonly<{
    entity: Readonly<{
      content?: EntityContent;
      id: string;
      lifetime: Readonly<{ end: number | null; start: number }>;
      type: string;
    }>;
    kind: "CreateEntity";
  }>;

export type SetPropertyOperation = OperationBase &
  Readonly<{
    entityId: string;
    key: Exclude<PropertyChannelKey, "identity">;
    kind: "SetProperty";
    value: boolean | number | string | Point | EntityContent;
  }>;

export type AnimatePropertyOperation = OperationBase &
  Readonly<{
    control?: Point;
    easing: "smooth";
    entityId: string;
    from?: Point | number;
    key: "appearance" | "position" | "rotation" | "scale";
    kind: "AnimateProperty";
    to: Point | number;
  }>;

export type CreateMotionOperation = OperationBase &
  Readonly<{
    controlOffset: Point;
    delta: Point;
    easing: MotionEasing;
    kind: "CreateMotion";
    targetEntityIds: readonly string[];
  }>;

export type ModifyMotionOperation = OperationBase &
  Readonly<{
    controlOffset: Point;
    kind: "ModifyMotion";
    motionId: string;
    preserve: readonly ("duration" | "end" | "start")[];
  }>;

export type TransformContentOperation = OperationBase &
  Readonly<{
    kind: "TransformContent";
    replacement: EntityContent;
    sourceEntityId: string;
    strategy: "replacement-transform" | "transform-matching-tex";
    targetEntityId: string;
    targetType?: string;
  }>;

export type SetRelationOperation = OperationBase &
  Readonly<{
    kind: "SetRelation";
    mode: "live" | "snapshot";
    offset: Point;
    placement: "above" | "below" | "left" | "right";
    relation: "next-to";
    sourceEntityId: string;
    targetEntityId: string;
  }>;

export type ChangePresenceOperation = OperationBase &
  Readonly<{
    effect: "cover" | "fade-in" | "remove" | "reveal";
    entityId: string;
    kind: "ChangePresence";
    persistent: boolean;
  }>;

export type InsertTimelineEventOperation = OperationBase &
  Readonly<{
    eventKind: "play" | "wait";
    kind: "InsertTimelineEvent";
    label: string;
    purpose?: "scene-duration";
  }>;

export type TrimSceneDurationOperation = OperationBase &
  Readonly<{
    kind: "TrimSceneDuration";
    removedDuration: number;
    targetDuration: number;
    waitOperationIds: readonly string[];
  }>;

export type InsertSceneBoundaryOperation = OperationBase &
  Readonly<{
    at: number;
    destination: "next-scene";
    kind: "InsertSceneBoundary";
  }>;

export type ChangeConstraintOperation = OperationBase &
  Readonly<{
    action: "remove" | "replace";
    constraintId: string;
    kind: "ChangeConstraint";
  }>;

export type ChangeCameraOperation = OperationBase &
  Readonly<{
    kind: "ChangeCamera";
    property: "position" | "rotation" | "scale";
    value: number | Point;
  }>;

export type CanonicalEditOperation =
  | AnimatePropertyOperation
  | ChangeCameraOperation
  | ChangeConstraintOperation
  | ChangePresenceOperation
  | CreateEntityOperation
  | CreateMotionOperation
  | InsertSceneBoundaryOperation
  | InsertTimelineEventOperation
  | ModifyMotionOperation
  | SetPropertyOperation
  | SetRelationOperation
  | TransformContentOperation
  | TrimSceneDurationOperation;

export type DependencyReason = "explicit" | "identity" | "lifetime" | "read-after-write" | "write-conflict";

export type DependencyEdge = Readonly<{
  from: string;
  reason: DependencyReason;
  to: string;
}>;

export type ProgramValidationIssue = Readonly<{
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
    | "target-missing";
  field: string;
  message: string;
  operationId?: string;
  severity: "error" | "warning";
}>;

export type CanonicalEditProgram = Readonly<{
  anchor: ResolvedTimeAnchor;
  intentCount: number;
  loweringStatus: "illustrative" | "supported" | "unsupported";
  operations: readonly CanonicalEditOperation[];
  provenance: Readonly<{ evidence: readonly string[]; origin: OperationOrigin }>;
  requestedExecution: "parallel" | "sequence";
  schedule: Readonly<{
    edges: readonly DependencyEdge[];
    mode: "dependency-dag" | "parallel" | "sequence";
    order: readonly string[];
  }>;
  transactionId: string;
  version: typeof EDIT_OPERATION_VERSION;
}>;

export function provisionalEntityId(transactionId: string, localName: string) {
  return `tx:${transactionId}/entity:${localName}`;
}

export function operationId(transactionId: string, localName: string) {
  return `tx:${transactionId}/operation:${localName}`;
}

export function channelKey(access: ChannelAccess) {
  return `${access.entityId}/${access.channel}`;
}
