import type { EntityContent, Point, ProjectedEntity, RuntimeSceneState } from "./model";
import {
  EDIT_OPERATION_VERSION,
  operationId,
  provisionalEntityId,
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  type OperationOrigin,
} from "./operations";
import { validateAndScheduleProgram, type ProgramValidationResult } from "./program-validation";
import { resolveTimeAnchorOnce } from "./time";

export const INSERT_ENTITY_TYPES = [
  "Text",
  "MathTex",
  "Rectangle",
  "Circle",
  "Line",
  "Arrow",
] as const;

export type InsertEntityType = typeof INSERT_ENTITY_TYPES[number];

export type StudioEntityInput = Readonly<{
  content?: EntityContent;
  position: Point;
  type: InsertEntityType;
}>;

type AuthoringProgramResult = Readonly<{
  entityIds: readonly string[];
  validation: ProgramValidationResult;
}>;

function provenance(origin: OperationOrigin, evidence: readonly string[]) {
  return { evidence, origin } as const;
}

function authoringProgram(
  operations: readonly CanonicalEditOperation[],
  input: Readonly<{
    capturedPlayhead: number;
    origin: OperationOrigin;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): ProgramValidationResult {
  const resolution = resolveTimeAnchorOnce({
    kind: "playhead",
    referenceSeconds: input.capturedPlayhead,
  }, {
    capturedPlayhead: input.capturedPlayhead,
    sceneDuration: input.scene.duration,
  });
  if (resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  const program: CanonicalEditProgram = {
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: provenance(input.origin, ["manual Studio authoring"]),
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: operations.map((operation) => operation.id) },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, input.scene);
}

function appearanceEnd(scene: RuntimeSceneState, start: number) {
  return Math.min(scene.duration, start + 0.4);
}

export function createStudioEntitiesProgram(input: Readonly<{
  capturedPlayhead: number;
  entities: readonly StudioEntityInput[];
  origin?: OperationOrigin;
  scene: RuntimeSceneState;
  transactionId: string;
}>): AuthoringProgramResult {
  if (input.entities.length === 0) throw new Error("Choose at least one object to insert.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to insert an object.");
  }
  const origin = input.origin ?? "studio-default";
  const entityIds: string[] = [];
  const operations = input.entities.flatMap((entity, index): readonly CanonicalEditOperation[] => {
    const entityId = provisionalEntityId(input.transactionId, `insert-${index}`);
    const createId = operationId(input.transactionId, `create-${index}`);
    const positionId = operationId(input.transactionId, `position-${index}`);
    const appearId = operationId(input.transactionId, `appear-${index}`);
    entityIds.push(entityId);
    return [
      {
        dependsOn: [],
        entity: {
          content: entity.content,
          id: entityId,
          lifetime: { end: null, start: input.capturedPlayhead },
          type: entity.type,
        },
        id: createId,
        interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
        kind: "CreateEntity",
        provenance: provenance(origin, ["Insert tool", entity.type]),
      },
      {
        dependsOn: [createId],
        entityId,
        id: positionId,
        interval: { end: input.capturedPlayhead, start: input.capturedPlayhead },
        key: "position",
        kind: "SetProperty",
        provenance: provenance(origin, ["canvas placement"]),
        value: entity.position,
      },
      {
        dependsOn: [positionId],
        effect: "fade-in",
        entityId,
        id: appearId,
        interval: { end, start: input.capturedPlayhead },
        kind: "ChangePresence",
        persistent: true,
        provenance: provenance(origin, ["Insert tool", "visible creation"]),
      },
    ];
  });
  return {
    entityIds,
    validation: authoringProgram(operations, {
      capturedPlayhead: input.capturedPlayhead,
      origin,
      scene: input.scene,
      transactionId: input.transactionId,
    }),
  };
}

export function createRemoveEntitiesProgram(input: Readonly<{
  capturedPlayhead: number;
  entityIds: readonly string[];
  scene: RuntimeSceneState;
  transactionId: string;
}>): ProgramValidationResult {
  const entityIds = [...new Set(input.entityIds)];
  if (entityIds.length === 0) throw new Error("Select an object to delete.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to delete an object.");
  }
  const operations = entityIds.map((entityId, index): CanonicalEditOperation => ({
    dependsOn: [],
    effect: "remove",
    entityId,
    id: operationId(input.transactionId, `remove-${index}`),
    interval: { end, start: input.capturedPlayhead },
    kind: "ChangePresence",
    persistent: true,
    provenance: provenance("studio-default", ["Delete command"]),
  }));
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "studio-default",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function createSceneDurationProgram(input: Readonly<{
  capturedPlayhead: number;
  scene: RuntimeSceneState;
  sourceAnchor: number;
  targetDuration: number;
  transactionId: string;
}>): ProgramValidationResult {
  const extension = input.targetDuration - input.scene.duration;
  if (!Number.isFinite(input.targetDuration) || extension < 0.1) {
    throw new Error("The new Scene duration must extend the current content by at least 0.1 seconds.");
  }
  if (!Number.isFinite(input.sourceAnchor) || input.sourceAnchor < 0 || input.sourceAnchor > input.scene.duration) {
    throw new Error("A safe source anchor is required to extend the Scene duration.");
  }
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    eventKind: "wait",
    id: operationId(input.transactionId, "extend-scene-duration"),
    interval: { end: input.sourceAnchor + extension, start: input.sourceAnchor },
    kind: "InsertTimelineEvent",
    label: `Extend Scene to ${input.targetDuration.toFixed(2)}s`,
    provenance: provenance("studio-default", ["Scene duration control", `${extension.toFixed(3)} second wait`]),
  };
  const program: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: input.capturedPlayhead,
      evidence: [`source-anchor:${input.sourceAnchor.toFixed(3)}`],
      resolvedSeconds: input.sourceAnchor,
      source: { kind: "absolute", seconds: input.sourceAnchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: provenance("studio-default", ["manual Scene duration"]),
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, input.scene);
}

export function duplicateEntityInput(entity: ProjectedEntity, offset = 20): StudioEntityInput | null {
  if (!INSERT_ENTITY_TYPES.some((type) => type === entity.type)) return null;
  return {
    content: entity.content,
    position: { x: entity.position.x + offset, y: entity.position.y + offset },
    type: entity.type as InsertEntityType,
  };
}

export function defaultEntityContent(type: InsertEntityType, value: string): EntityContent | undefined {
  const normalized = value.trim();
  if (type === "Text") {
    const text = normalized || "Text";
    return { displayLines: [text], label: text, text };
  }
  if (type === "MathTex") {
    const tex = normalized || "x";
    return { displayLines: [tex], label: tex, texParts: [tex] };
  }
  return { displayLines: [type], label: type };
}
