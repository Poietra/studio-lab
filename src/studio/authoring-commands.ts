import type { EntityContent, Point, ProgramRecord, ProjectedEntity, RuntimeSceneState } from "./model";
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
    requestedExecution?: "parallel" | "sequence";
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
    requestedExecution: input.requestedExecution ?? "parallel",
    schedule: { edges: [], mode: input.requestedExecution ?? "parallel", order: operations.map((operation) => operation.id) },
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

export function createTrimEntityLifetimeProgram(input: Readonly<{
  entityId: string;
  lifetimeStart: number;
  retainedDuration: number;
  scene: RuntimeSceneState;
  sourceAnchor: number;
  transactionId: string;
}>): ProgramValidationResult {
  const entity = input.scene.objectGraph.entities[input.entityId];
  if (!entity) throw new Error(`Object ${input.entityId} is no longer available.`);
  const lifetime = entity.lifetime.find((interval) => (
    Math.abs(interval.start - input.lifetimeStart) < 0.001
  ));
  if (!lifetime) throw new Error("The selected lifetime interval is no longer available.");
  const targetEnd = input.sourceAnchor;
  if (!Number.isFinite(input.retainedDuration) || input.retainedDuration < 0.1) {
    throw new Error("Keep at least 0.1 seconds of the selected object lifetime.");
  }
  if (targetEnd > lifetime.end + 0.001) {
    throw new Error("Lifetime extension is not supported yet; drag the right edge to the left.");
  }
  if (lifetime.end - targetEnd < 0.01) {
    throw new Error("Move the lifetime end at least 0.01 seconds earlier.");
  }

  if (
    !Number.isFinite(input.sourceAnchor)
    || input.sourceAnchor < 0
    || input.sourceAnchor < lifetime.start - 0.001
  ) {
    throw new Error("A safe source anchor is required inside the selected lifetime.");
  }
  const removeId = operationId(input.transactionId, "trim-lifetime-end");
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    effect: "remove",
    entityId: input.entityId,
    id: removeId,
    interval: { end: input.sourceAnchor, start: input.sourceAnchor },
    kind: "ChangePresence",
    persistent: true,
    provenance: provenance("direct-manipulation", ["lifetime right-edge trim", "safe source anchor", "persistent exit"]),
  };
  return authoringProgram([operation], {
    capturedPlayhead: input.sourceAnchor,
    origin: "direct-manipulation",
    requestedExecution: "sequence",
    scene: input.scene,
    transactionId: input.transactionId,
  });
}

const DURATION_EPSILON = 0.001;

function sceneDurationWait(program: CanonicalEditProgram) {
  if (program.provenance.origin !== "studio-default" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "InsertTimelineEvent"
    && operation.eventKind === "wait"
    && operation.purpose === "scene-duration"
    ? operation
    : null;
}

function sceneDurationTrim(program: CanonicalEditProgram) {
  if (program.provenance.origin !== "studio-default" || program.operations.length !== 1) return null;
  const operation = program.operations[0];
  return operation?.kind === "TrimSceneDuration" ? operation : null;
}

export type SceneDurationTrimAvailability = Readonly<{
  anchor: number | null;
  blocker: string | null;
  minimumDuration: number;
  removableDuration: number;
  waitOperationIds: readonly string[];
}>;

export function sceneDurationTrimAvailability(input: Readonly<{
  appliedPrograms: readonly ProgramRecord[];
  sceneDuration: number;
}>): SceneDurationTrimAvailability {
  const controls: Array<Readonly<{
    anchor: number;
    duration: number;
    kind: "trim" | "wait";
    waitOperationId?: string;
  }>> = [];
  let firstNonControlIndex = input.appliedPrograms.length - 1;
  for (; firstNonControlIndex >= 0; firstNonControlIndex -= 1) {
    const program = input.appliedPrograms[firstNonControlIndex]?.program;
    if (!program) continue;
    const wait = sceneDurationWait(program);
    if (wait) {
      controls.unshift({
        anchor: program.anchor.resolvedSeconds,
        duration: wait.interval.end - wait.interval.start,
        kind: "wait",
        waitOperationId: wait.id,
      });
      continue;
    }
    const trim = sceneDurationTrim(program);
    if (trim) {
      controls.unshift({
        anchor: program.anchor.resolvedSeconds,
        duration: trim.removedDuration,
        kind: "trim",
      });
      continue;
    }
    break;
  }

  const allDurationWaitIndexes = input.appliedPrograms.flatMap((record, index) => (
    sceneDurationWait(record.program) ? [index] : []
  ));
  if (controls.length === 0) {
    const later = allDurationWaitIndexes.length > 0
      ? input.appliedPrograms.at(-1)?.program
      : null;
    return {
      anchor: null,
      blocker: later
        ? `Program ${later.transactionId} was applied after the Studio duration wait. Undo later edits before shortening the Scene.`
        : "Only a Studio-added trailing Scene duration wait can be shortened; imported or animated content is never truncated.",
      minimumDuration: input.sceneDuration,
      removableDuration: 0,
      waitOperationIds: [],
    };
  }

  const anchors = new Set(controls.map((control) => control.anchor.toFixed(4)));
  const waitOperationIds = controls.flatMap((control) => (
    control.kind === "wait" && control.waitOperationId ? [control.waitOperationId] : []
  )).reverse();
  const removableDuration = controls.reduce((duration, control) => (
    control.kind === "wait" ? duration + control.duration : duration - control.duration
  ), 0);
  const anchor = controls.at(-1)?.anchor ?? null;
  if (anchors.size !== 1 || anchor === null) {
    return {
      anchor: null,
      blocker: "Studio duration waits at different source anchors cannot be shortened together. Undo the later duration changes first.",
      minimumDuration: input.sceneDuration,
      removableDuration: 0,
      waitOperationIds: [],
    };
  }
  if (removableDuration < 0.1 - DURATION_EPSILON) {
    return {
      anchor,
      blocker: "The Studio-added trailing wait is already fully removed.",
      minimumDuration: input.sceneDuration,
      removableDuration: 0,
      waitOperationIds,
    };
  }
  return {
    anchor,
    blocker: null,
    minimumDuration: input.sceneDuration - removableDuration,
    removableDuration,
    waitOperationIds,
  };
}

export function createSceneDurationProgram(input: Readonly<{
  appliedPrograms?: readonly ProgramRecord[];
  capturedPlayhead: number;
  scene: RuntimeSceneState;
  sourceAnchor: number;
  targetDuration: number;
  transactionId: string;
}>): ProgramValidationResult {
  const change = input.targetDuration - input.scene.duration;
  if (!Number.isFinite(input.targetDuration) || input.targetDuration < 0.1) {
    throw new Error("The new Scene duration must be a finite value of at least 0.1 seconds.");
  }
  if (Math.abs(change) < 0.1 - DURATION_EPSILON) {
    throw new Error("Change the Scene duration by at least 0.1 seconds.");
  }

  if (change < 0) {
    const availability = sceneDurationTrimAvailability({
      appliedPrograms: input.appliedPrograms ?? [],
      sceneDuration: input.scene.duration,
    });
    if (availability.blocker) throw new Error(availability.blocker);
    const removedDuration = -change;
    if (removedDuration > availability.removableDuration + DURATION_EPSILON) {
      throw new Error(
        `The shortest safe duration is ${availability.minimumDuration.toFixed(2)}s. `
          + `Only ${availability.removableDuration.toFixed(2)}s of Studio-added trailing wait can be removed; imported or animated content would be truncated.`,
      );
    }
    if (availability.anchor === null || availability.waitOperationIds.length === 0) {
      throw new Error("No Studio-added trailing Scene duration wait is available to shorten.");
    }
    const operation: CanonicalEditOperation = {
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
    const program: CanonicalEditProgram = {
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
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    eventKind: "wait",
    id: operationId(input.transactionId, "extend-scene-duration"),
    interval: { end: input.sourceAnchor + extension, start: input.sourceAnchor },
    kind: "InsertTimelineEvent",
    label: `Extend Scene to ${input.targetDuration.toFixed(2)}s`,
    purpose: "scene-duration",
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
