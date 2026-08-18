import {
  importedLifetimeEditEvidence,
  MIN_OBJECT_LIFETIME_SECONDS,
  type ProgramSourceAnchorBounds,
} from "./lifetime-editing";
import type {
  EntityContent,
  EntityDimensions,
  Interval,
  Point,
  ProgramRecord,
  ProjectedEntity,
  RuntimeSceneState,
} from "./model";
import { EDIT_OPERATION_VERSION, type OperationOrigin, operationId, provisionalEntityId } from "./operations";
import { type SceneEditValidationResult, validateAndScheduleProgram } from "./program-validation";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";
import { STUDIO_STYLE_PROFILE, type StyleProfileRef, styleProfileRef } from "./style-profile";
import { resolveTimeAnchorOnce } from "./time";
import type { SceneDurationTrimAvailability } from "./timeline-projection";

export const INSERT_ENTITY_TYPES = ["Text", "MathTex", "Rectangle", "Circle", "Line", "Arrow"] as const;

export type InsertEntityType = (typeof INSERT_ENTITY_TYPES)[number];

export type StudioEntityInput = Readonly<{
  content?: EntityContent;
  dimensions?: EntityDimensions;
  position: Point;
  type: InsertEntityType;
}>;

export function defaultEntityDimensions(type: InsertEntityType): EntityDimensions | undefined {
  if (type === "Circle") return { radius: 1 };
  if (type === "Rectangle") return { height: 2, width: 4 };
  return undefined;
}

type AuthoringProgramResult = Readonly<{
  entityIds: readonly string[];
  validation: SceneEditValidationResult;
}>;

export type InspectorEntityEdits = Readonly<{
  content?: EntityContent;
  dimensions?: EntityDimensions;
  position?: Point;
}>;

function provenance(origin: OperationOrigin, evidence: readonly string[]) {
  return { evidence, origin } as const;
}

function authoringProgram(
  operations: readonly SceneEditOperation[],
  input: Readonly<{
    capturedPlayhead: number;
    origin: OperationOrigin;
    programEvidence?: readonly string[];
    styleProfileRef?: StyleProfileRef;
    requestedExecution?: "parallel" | "sequence";
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const resolution = resolveTimeAnchorOnce(
    {
      kind: "playhead",
      referenceSeconds: input.capturedPlayhead,
    },
    {
      capturedPlayhead: input.capturedPlayhead,
      sceneDuration: input.scene.duration,
    },
  );
  if (resolution.kind === "invalid") {
    throw new Error(resolution.message);
  }
  const program: SceneEdit = {
    anchor: resolution.anchor,
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: {
      ...provenance(input.origin, ["manual Studio authoring", ...(input.programEvidence ?? [])]),
      ...(input.styleProfileRef ? { styleProfileRef: input.styleProfileRef } : {}),
    },
    requestedExecution: input.requestedExecution ?? "parallel",
    schedule: {
      edges: [],
      mode: input.requestedExecution ?? "parallel",
      order: operations.map((operation) => operation.id),
    },
    transactionId: input.transactionId,
    version: EDIT_OPERATION_VERSION,
  };
  return validateAndScheduleProgram(program, input.scene);
}

function appearanceEnd(scene: RuntimeSceneState, start: number) {
  return Math.min(scene.duration, start + STUDIO_STYLE_PROFILE.durationSeconds.brief);
}

export function createStudioEntitiesProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entities: readonly StudioEntityInput[];
    origin?: OperationOrigin;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): AuthoringProgramResult {
  if (input.entities.length === 0) throw new Error("Choose at least one object to insert.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to insert an object.");
  }
  const origin = input.origin ?? "studio-default";
  const entityIds: string[] = [];
  const operations = input.entities.flatMap((entity, index): readonly SceneEditOperation[] => {
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
          dimensions: entity.dimensions ?? defaultEntityDimensions(entity.type),
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
      styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
      transactionId: input.transactionId,
    }),
  };
}

export function createInspectorEntityEditProgram(
  input: Readonly<{
    capturedPlayhead: number;
    edits: InspectorEntityEdits;
    entityId: string;
    from: Readonly<{
      dimensions?: EntityDimensions;
      position: Point;
      scale: number;
    }>;
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entity = input.scene.objectGraph.entities[input.entityId];
  if (!entity) throw new Error(`Object ${input.entityId} is no longer available.`);
  if (
    !entity.lifetime.some(
      (interval) => input.capturedPlayhead >= interval.start && input.capturedPlayhead < interval.end,
    )
  ) {
    throw new Error("The selected object is not present at the source anchor.");
  }
  const shape = entity.type === "Circle" ? "circle" : entity.type === "Rectangle" ? "rectangle" : null;
  if (input.edits.dimensions && !shape) {
    throw new Error(`${entity.type} does not support shape geometry editing.`);
  }
  if (input.edits.dimensions && !input.from.dimensions) {
    throw new Error("Shape geometry editing requires known current dimensions.");
  }
  if (input.edits.content && entity.type !== "Text" && entity.type !== "MathTex") {
    throw new Error(`${entity.type} does not support content editing.`);
  }
  if (input.edits.content && entity.sourceIdentity.kind === "unknown" && !entity.transactionId) {
    throw new Error("Studio cannot edit content without a known or Studio-generated source identity.");
  }
  if (Object.keys(input.edits).length === 0) {
    throw new Error("Change at least one Inspector field before creating a draft.");
  }

  const interval = { end: input.capturedPlayhead, start: input.capturedPlayhead };
  const operations: SceneEditOperation[] = [];
  if (input.edits.dimensions && input.from.dimensions && shape) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      from: { dimensions: input.from.dimensions, position: input.from.position },
      id: operationId(input.transactionId, "set-geometry"),
      interval,
      kind: "ResizeEntity",
      provenance: provenance("studio-default", ["Inspector geometry fields", "center anchored"]),
      scale: input.from.scale,
      shape,
      to: {
        dimensions: input.edits.dimensions,
        position: input.edits.position ?? input.from.position,
      },
    });
  } else if (input.edits.position) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      id: operationId(input.transactionId, "set-position"),
      interval,
      key: "position",
      kind: "SetProperty",
      provenance: provenance("studio-default", ["Inspector position fields", "one-shot position"]),
      value: input.edits.position,
    });
  }
  if (input.edits.content) {
    operations.push({
      dependsOn: [],
      entityId: input.entityId,
      id: operationId(input.transactionId, "set-content"),
      interval,
      key: "content",
      kind: "SetProperty",
      provenance: provenance("studio-default", ["Inspector content field", entity.type]),
      value: input.edits.content,
    });
  }
  if (operations.length === 0) {
    throw new Error("Change at least one Inspector field before creating a draft.");
  }
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "studio-default",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

export function createRemoveEntitiesProgram(
  input: Readonly<{
    capturedPlayhead: number;
    entityIds: readonly string[];
    scene: RuntimeSceneState;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entityIds = [...new Set(input.entityIds)];
  if (entityIds.length === 0) throw new Error("Select an object to delete.");
  const end = appearanceEnd(input.scene, input.capturedPlayhead);
  if (end - input.capturedPlayhead < 0.1) {
    throw new Error("Move the playhead at least 0.1 seconds before the Scene end to delete an object.");
  }
  const operations = entityIds.map(
    (entityId, index): SceneEditOperation => ({
      dependsOn: [],
      effect: "remove",
      entityId,
      id: operationId(input.transactionId, `remove-${index}`),
      interval: { end, start: input.capturedPlayhead },
      kind: "ChangePresence",
      persistent: true,
      provenance: provenance("studio-default", ["Delete command"]),
    }),
  );
  return authoringProgram(operations, {
    capturedPlayhead: input.capturedPlayhead,
    origin: "studio-default",
    scene: input.scene,
    styleProfileRef: styleProfileRef(STUDIO_STYLE_PROFILE),
    transactionId: input.transactionId,
  });
}

export function createImportedEntityLifetimeProgram(
  input: Readonly<{
    entityId: string;
    original: Interval;
    scene: RuntimeSceneState;
    sourceAnchor: number;
    sourceAnchorBounds?: ProgramSourceAnchorBounds;
    targetEnd: number;
    transactionId: string;
  }>,
): SceneEditValidationResult {
  const entity = input.scene.objectGraph.entities[input.entityId];
  if (!entity) throw new Error(`Object ${input.entityId} is no longer available.`);
  const original = entity.lifetime.find(
    (interval) =>
      Math.abs(interval.start - input.original.start) < 0.001 && Math.abs(interval.end - input.original.end) < 0.001,
  );
  if (!original) throw new Error("The imported lifetime interval changed. Reimport before editing it again.");
  if (!Number.isFinite(input.targetEnd) || input.targetEnd - original.start < MIN_OBJECT_LIFETIME_SECONDS - 0.001) {
    throw new Error(`Keep at least ${MIN_OBJECT_LIFETIME_SECONDS.toFixed(1)} seconds of the selected object lifetime.`);
  }
  if (input.targetEnd > original.end + 0.001) {
    throw new Error("An imported lifetime cannot extend beyond its original source interval.");
  }
  if (
    !Number.isFinite(input.sourceAnchor) ||
    input.sourceAnchor < original.start - 0.001 ||
    input.sourceAnchor > original.end + 0.001
  ) {
    throw new Error("A safe source anchor is required inside the selected lifetime.");
  }
  const restoringOriginal = Math.abs(input.targetEnd - original.end) < 0.001;
  if (
    !restoringOriginal &&
    (input.sourceAnchor < (input.sourceAnchorBounds?.minimum ?? -Infinity) - 0.001 ||
      input.sourceAnchor > (input.sourceAnchorBounds?.maximum ?? Infinity) + 0.001)
  ) {
    throw new Error("This lifetime would place its applied Program out of source order relative to another edit.");
  }

  if (!restoringOriginal && Math.abs(input.sourceAnchor - input.targetEnd) >= 0.001) {
    throw new Error("The imported lifetime end must snap to its safe source anchor.");
  }
  const operation: SceneEditOperation = restoringOriginal
    ? {
        dependsOn: [],
        eventKind: "wait",
        id: operationId(input.transactionId, "restore-lifetime-end"),
        interval: { end: input.sourceAnchor, start: input.sourceAnchor },
        kind: "InsertTimelineEvent",
        label: "Restore imported lifetime",
        provenance: provenance("direct-manipulation", ["lifetime end restore", "source interval unchanged"]),
      }
    : {
        dependsOn: [],
        effect: "remove",
        entityId: input.entityId,
        id: operationId(input.transactionId, "trim-lifetime-end"),
        interval: { end: input.targetEnd, start: input.targetEnd },
        kind: "ChangePresence",
        persistent: true,
        provenance: provenance("direct-manipulation", [
          "lifetime right-edge edit",
          "safe source anchor",
          "persistent exit",
        ]),
      };
  return authoringProgram([operation], {
    capturedPlayhead: input.sourceAnchor,
    origin: "direct-manipulation",
    programEvidence: [
      importedLifetimeEditEvidence({
        entityId: input.entityId,
        kind: "imported-end",
        original,
      }),
    ],
    requestedExecution: "sequence",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

function shiftInterval(interval: Interval, delta: number): Interval {
  return { end: interval.end + delta, start: interval.start + delta };
}

function shiftStudioCreationOperation(
  operation: SceneEditOperation,
  delta: number,
  entityId: string,
  target: Interval,
  sceneDuration: number,
): SceneEditOperation {
  const interval = shiftInterval(operation.interval, delta);
  if (operation.kind === "CreateEntity") {
    return {
      ...operation,
      entity: {
        ...operation.entity,
        lifetime:
          operation.entity.id === entityId
            ? {
                end: Math.abs(target.end - sceneDuration) < 0.001 ? null : target.end,
                start: target.start,
              }
            : {
                end: operation.entity.lifetime.end === null ? null : operation.entity.lifetime.end + delta,
                start: operation.entity.lifetime.start + delta,
              },
      },
      interval,
    };
  }
  if (
    operation.kind === "ChangePresence" &&
    operation.entityId === entityId &&
    operation.effect === "fade-in" &&
    interval.end > target.end
  ) {
    return { ...operation, interval: { ...interval, end: target.end } };
  }
  if (operation.kind === "InsertSceneBoundary") {
    return { ...operation, at: operation.at + delta, interval };
  }
  return { ...operation, interval };
}

function operationTargetsEntity(operation: SceneEditOperation, entityId: string) {
  if (operation.kind === "CreateEntity") return operation.entity.id === entityId;
  if (operation.kind === "SetProperty" || operation.kind === "AnimateProperty" || operation.kind === "ChangePresence")
    return operation.entityId === entityId;
  if (operation.kind === "CreateMotion") return operation.targetEntityIds.includes(entityId);
  if (operation.kind === "TransformContent") {
    return operation.sourceEntityId === entityId || operation.targetEntityId === entityId;
  }
  if (operation.kind === "SetRelation") {
    return operation.sourceEntityId === entityId || operation.targetEntityId === entityId;
  }
  return false;
}

export function replaceStudioEntityLifetimeProgram(
  input: Readonly<{
    entityId: string;
    owner: ProgramRecord;
    scene: RuntimeSceneState;
    sourceAnchorBounds?: ProgramSourceAnchorBounds;
    sourceAnchors: readonly number[];
    target: Interval;
  }>,
): SceneEditValidationResult {
  const created = input.owner.program.operations.filter((operation) => operation.kind === "CreateEntity");
  const create = created.find((operation) => operation.entity.id === input.entityId);
  if (!create) throw new Error("The Studio creation Program no longer owns this object.");
  if (
    !Number.isFinite(input.target.start) ||
    !Number.isFinite(input.target.end) ||
    input.target.start < 0 ||
    input.target.end > input.scene.duration + 0.001 ||
    input.target.end - input.target.start < MIN_OBJECT_LIFETIME_SECONDS - 0.001
  ) {
    throw new Error(
      `Keep the lifetime within the Scene and at least ${MIN_OBJECT_LIFETIME_SECONDS.toFixed(1)} seconds wide.`,
    );
  }
  const delta = input.target.start - create.entity.lifetime.start;
  const movesProgram = Math.abs(delta) >= 0.001;
  if (movesProgram && created.length !== 1) {
    throw new Error("This object shares one creation Program with other objects and cannot move independently.");
  }
  if (movesProgram && Math.abs(create.entity.lifetime.start - input.owner.program.anchor.resolvedSeconds) >= 0.001) {
    throw new Error("This object is created after its Program begins and cannot move independently.");
  }
  const replacementAnchor = input.owner.program.anchor.resolvedSeconds + delta;
  const sourceOrderRequired = movesProgram || Math.abs(input.target.end - input.scene.duration) >= 0.001;
  if (
    sourceOrderRequired &&
    (replacementAnchor < (input.sourceAnchorBounds?.minimum ?? -Infinity) - 0.001 ||
      replacementAnchor > (input.sourceAnchorBounds?.maximum ?? Infinity) + 0.001)
  ) {
    throw new Error("This lifetime would place its applied Program out of source order relative to another edit.");
  }
  const hasAnchor = (time: number) => input.sourceAnchors.some((anchor) => Math.abs(anchor - time) < 0.001);
  if (movesProgram && !hasAnchor(replacementAnchor)) {
    throw new Error("The Studio-owned lifetime start must snap to a safe .py source anchor.");
  }
  if (Math.abs(input.target.end - input.scene.duration) >= 0.001 && !hasAnchor(input.target.end)) {
    throw new Error("The Studio-owned lifetime end must snap to a safe .py source anchor or the Scene end.");
  }

  const operations = input.owner.program.operations.map((operation) =>
    shiftStudioCreationOperation(operation, delta, input.entityId, input.target, input.scene.duration),
  );
  const outsideLifetime = operations.find(
    (operation) =>
      operation.kind !== "CreateEntity" &&
      (movesProgram || operationTargetsEntity(operation, input.entityId)) &&
      (operation.interval.start < input.target.start - 0.001 || operation.interval.end > input.target.end + 0.001),
  );
  if (outsideLifetime) {
    throw new Error("The creation Program contains work outside the requested lifetime interval.");
  }
  const replacement = {
    ...input.owner.program,
    anchor: {
      capturedPlayhead: input.owner.program.anchor.capturedPlayhead + delta,
      evidence: [
        ...input.owner.program.anchor.evidence.filter((entry) => !entry.startsWith("lifetime-start:")),
        `lifetime-start:${input.target.start.toFixed(3)}`,
      ].slice(-32),
      resolvedSeconds: replacementAnchor,
      source: { kind: "absolute", seconds: replacementAnchor } as const,
    },
    operations,
    provenance: {
      ...input.owner.program.provenance,
      evidence: [
        ...input.owner.program.provenance.evidence.filter((entry) => entry !== "Studio-owned lifetime replacement"),
        "Studio-owned lifetime replacement",
      ],
    },
  };
  return validateAndScheduleProgram(replacement, input.scene);
}

const DURATION_EPSILON = 0.001;

export function createSceneDurationProgram(
  input: Readonly<{
    capturedPlayhead: number;
    scene: RuntimeSceneState;
    sourceAnchor: number;
    targetDuration: number;
    transactionId: string;
    trimAvailability?: SceneDurationTrimAvailability;
  }>,
): SceneEditValidationResult {
  const change = input.targetDuration - input.scene.duration;
  if (!Number.isFinite(input.targetDuration) || input.targetDuration < 0.1) {
    throw new Error("The new Scene duration must be a finite value of at least 0.1 seconds.");
  }
  if (Math.abs(change) < 0.1 - DURATION_EPSILON) {
    throw new Error("Change the Scene duration by at least 0.1 seconds.");
  }

  if (change < 0) {
    const availability = input.trimAvailability;
    if (!availability) {
      throw new Error("A Rust timeline projection is required to shorten the Scene duration.");
    }
    if (availability.blocker) throw new Error(availability.blocker);
    const removedDuration = -change;
    if (removedDuration > availability.removableDuration + DURATION_EPSILON) {
      throw new Error(
        `The shortest safe duration is ${availability.minimumDuration.toFixed(2)}s. ` +
          `Only ${availability.removableDuration.toFixed(2)}s of Studio-added trailing wait can be removed; imported or animated content would be truncated.`,
      );
    }
    if (availability.anchor === null || availability.waitOperationIds.length === 0) {
      throw new Error("No Studio-added trailing Scene duration wait is available to shorten.");
    }
    const operation: SceneEditOperation = {
      dependsOn: [],
      id: operationId(input.transactionId, "trim-scene-duration"),
      interval: { end: availability.anchor, start: availability.anchor },
      kind: "TrimSceneDuration",
      provenance: provenance("studio-default", [
        "Scene duration control",
        `${removedDuration.toFixed(3)} second Studio wait reduction`,
      ]),
      removedDuration,
      targetDuration: input.targetDuration,
      waitOperationIds: availability.waitOperationIds,
    };
    const program: SceneEdit = {
      anchor: {
        capturedPlayhead: input.capturedPlayhead,
        evidence: [`source-anchor:${availability.anchor.toFixed(3)}`, "Studio duration wait suffix"],
        resolvedSeconds: availability.anchor,
        source: { kind: "absolute", seconds: availability.anchor },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: provenance("studio-default", ["manual Scene duration", "safe Studio wait reduction"]),
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: input.transactionId,
      version: EDIT_OPERATION_VERSION,
    };
    return validateAndScheduleProgram(program, input.scene);
  }

  const extension = change;
  if (!Number.isFinite(input.sourceAnchor) || input.sourceAnchor < 0 || input.sourceAnchor > input.scene.duration) {
    throw new Error("A safe source anchor is required to extend the Scene duration.");
  }
  const operation: SceneEditOperation = {
    dependsOn: [],
    eventKind: "wait",
    id: operationId(input.transactionId, "extend-scene-duration"),
    interval: { end: input.sourceAnchor + extension, start: input.sourceAnchor },
    kind: "InsertTimelineEvent",
    label: `Extend Scene to ${input.targetDuration.toFixed(2)}s`,
    purpose: "scene-duration",
    provenance: provenance("studio-default", ["Scene duration control", `${extension.toFixed(3)} second wait`]),
  };
  const program: SceneEdit = {
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
  const knownDimensions = entity.geometry.dimensions.kind === "known" ? entity.geometry.dimensions.value : null;
  const dimensions =
    entity.type === "Circle" &&
    knownDimensions?.radius !== undefined &&
    knownDimensions.height === undefined &&
    knownDimensions.width === undefined
      ? { radius: knownDimensions.radius }
      : entity.type === "Rectangle" &&
          knownDimensions?.height !== undefined &&
          knownDimensions.width !== undefined &&
          knownDimensions.radius === undefined
        ? { height: knownDimensions.height, width: knownDimensions.width }
        : undefined;
  return {
    content: entity.content,
    ...(dimensions ? { dimensions } : {}),
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
