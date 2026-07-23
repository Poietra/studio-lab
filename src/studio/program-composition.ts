import type { CanonicalEditOperation, CanonicalEditProgram } from "./operations";
import { operationId, provisionalEntityId } from "./operations";

const ANCHOR_EPSILON = 0.0005;
const MAX_COMPOSED_INTENTS = 16;
const MAX_COMPOSED_OPERATIONS = 64;

export type ProgramCompositionResult =
  | Readonly<{
      kind: "empty";
    }>
  | Readonly<{
      kind: "incompatible";
      message: string;
    }>
  | Readonly<{
      kind: "composed";
      program: CanonicalEditProgram;
    }>;

type IdMaps = Readonly<{
  entities: ReadonlyMap<string, string>;
  operations: ReadonlyMap<string, string>;
}>;

export function insertedProgramDuration(program: CanonicalEditProgram) {
  const insertedAnimations = program.operations.filter(
    (operation) =>
      operation.kind === "ChangePresence" ||
      operation.kind === "CreateMotion" ||
      operation.kind === "ResizeEntity" ||
      operation.kind === "TransformContent" ||
      (operation.kind === "AnimateProperty" && operation.key === "scale") ||
      (operation.kind === "InsertTimelineEvent" && operation.eventKind === "wait"),
  );
  const end = Math.max(
    program.anchor.resolvedSeconds,
    ...insertedAnimations.map((operation) => operation.interval.end),
  );
  return Math.max(0, end - program.anchor.resolvedSeconds);
}

/** Signed change to working time; Scene duration trims deliberately return a negative delta. */
export function programTimelineDelta(program: CanonicalEditProgram) {
  const removedDuration = program.operations.reduce(
    (duration, operation) => (operation.kind === "TrimSceneDuration" ? duration + operation.removedDuration : duration),
    0,
  );
  return insertedProgramDuration(program) - removedDuration;
}

export type TimelineInsertion = Readonly<{
  duration: number;
  sourceAnchor: number;
}>;

export function timelineInsertionOffset(insertions: readonly TimelineInsertion[], sourceAnchor: number) {
  return insertions.reduce(
    (offset, insertion) =>
      insertion.sourceAnchor <= sourceAnchor + ANCHOR_EPSILON ? offset + insertion.duration : offset,
    0,
  );
}

export function shiftIntervalForInsertion(
  interval: Readonly<{ end: number; start: number }>,
  at: number,
  duration: number,
) {
  if (!Number.isFinite(duration) || duration <= 0) return interval;
  if (interval.start >= at - ANCHOR_EPSILON) {
    return { end: interval.end + duration, start: interval.start + duration };
  }
  return interval.end > at ? { ...interval, end: interval.end + duration } : interval;
}

function sourceInsertions(programs: readonly CanonicalEditProgram[]) {
  const sorted = programs
    .map((program, index) => ({ index, program }))
    .sort(
      (left, right) =>
        left.program.anchor.resolvedSeconds - right.program.anchor.resolvedSeconds || left.index - right.index,
    );
  const insertions: TimelineInsertion[] = [];
  for (const { program } of sorted) {
    const sourceAnchor = program.anchor.resolvedSeconds;
    const duration = programTimelineDelta(program);
    const current = insertions.at(-1);
    if (current && Math.abs(current.sourceAnchor - sourceAnchor) < ANCHOR_EPSILON) {
      insertions[insertions.length - 1] = {
        duration: current.duration + duration,
        sourceAnchor: current.sourceAnchor,
      };
    } else {
      insertions.push({ duration, sourceAnchor });
    }
  }
  return insertions;
}

/** Maps an original source timestamp to the working timeline after applied insertions. */
export function sourceTimeToWorkingTime(programs: readonly CanonicalEditProgram[], sourceTime: number) {
  return (
    sourceTime +
    sourceInsertions(programs).reduce(
      (offset, insertion) =>
        insertion.sourceAnchor <= sourceTime + ANCHOR_EPSILON ? offset + insertion.duration : offset,
      0,
    )
  );
}

/**
 * Maps the expanded working timeline back to source time. Times inside an
 * inserted block resolve to that block's source anchor so a new edit appends to
 * the same safe insertion point instead of receiving the offset twice.
 */
export function workingTimeToSourceTime(programs: readonly CanonicalEditProgram[], workingTime: number) {
  let offset = 0;
  for (const insertion of sourceInsertions(programs)) {
    const insertionStart = insertion.sourceAnchor + offset;
    const insertionEnd = insertionStart + insertion.duration;
    if (workingTime < insertionStart - ANCHOR_EPSILON) return workingTime - offset;
    if (workingTime <= insertionEnd + ANCHOR_EPSILON) return insertion.sourceAnchor;
    offset += insertion.duration;
  }
  return workingTime - offset;
}

/**
 * Resolves the latest source-backed insertion boundary at or before a working
 * playhead. `workingTime` deliberately points after every Program already
 * inserted at that source anchor, which is the only truthful append position.
 */
export function latestSafeSourceAnchor(
  programs: readonly CanonicalEditProgram[],
  sourceAnchors: readonly number[],
  workingTime: number,
) {
  const sourceTime = workingTimeToSourceTime(programs, workingTime);
  const sourceAnchor = sourceAnchors
    .filter((anchor) => Number.isFinite(anchor) && anchor <= sourceTime + ANCHOR_EPSILON)
    .sort((left, right) => left - right)
    .at(-1);
  if (sourceAnchor === undefined) return null;
  return {
    sourceTime: sourceAnchor,
    workingTime: sourceTimeToWorkingTime(programs, sourceAnchor),
  } as const;
}

function shiftedInterval(interval: CanonicalEditOperation["interval"], offset: number) {
  return { end: interval.end + offset, start: interval.start + offset };
}

function remapEntity(id: string, maps: IdMaps) {
  return maps.entities.get(id) ?? id;
}

function remapOperationId(id: string, maps: IdMaps) {
  return maps.operations.get(id) ?? id;
}

function remapOperation(operation: CanonicalEditOperation, offset: number, maps: IdMaps): CanonicalEditOperation {
  const base = {
    dependsOn: operation.dependsOn.map((id) => remapOperationId(id, maps)),
    id: remapOperationId(operation.id, maps),
    interval: shiftedInterval(operation.interval, offset),
    provenance: operation.provenance,
  };
  switch (operation.kind) {
    case "CreateEntity":
      return {
        ...operation,
        ...base,
        entity: {
          ...operation.entity,
          id: remapEntity(operation.entity.id, maps),
          lifetime: {
            end: operation.entity.lifetime.end === null ? null : operation.entity.lifetime.end + offset,
            start: operation.entity.lifetime.start + offset,
          },
        },
      };
    case "SetProperty":
    case "AnimateProperty":
    case "ResizeEntity":
    case "ChangePresence":
      return { ...operation, ...base, entityId: remapEntity(operation.entityId, maps) };
    case "CreateMotion":
      return {
        ...operation,
        ...base,
        targetEntityIds: operation.targetEntityIds.map((id) => remapEntity(id, maps)),
      };
    case "ModifyMotion":
      return { ...operation, ...base, motionId: remapOperationId(operation.motionId, maps) };
    case "TransformContent":
      return {
        ...operation,
        ...base,
        sourceEntityId: remapEntity(operation.sourceEntityId, maps),
        targetEntityId: remapEntity(operation.targetEntityId, maps),
      };
    case "SetRelation":
      return {
        ...operation,
        ...base,
        sourceEntityId: remapEntity(operation.sourceEntityId, maps),
        targetEntityId: remapEntity(operation.targetEntityId, maps),
      };
    case "InsertSceneBoundary":
      return { ...operation, ...base, at: operation.at + offset };
    case "InsertTimelineEvent":
    case "ChangeConstraint":
    case "ChangeCamera":
      return { ...operation, ...base };
    case "TrimSceneDuration":
      return {
        ...operation,
        ...base,
        waitOperationIds: operation.waitOperationIds.map((id) => remapOperationId(id, maps)),
      };
  }
}

export function rebaseProgramTime(program: CanonicalEditProgram, offset: number): CanonicalEditProgram {
  if (!Number.isFinite(offset) || offset < 0)
    throw new Error("A Program timeline offset must be finite and non-negative.");
  if (offset < ANCHOR_EPSILON) return program;
  const identityMaps: IdMaps = { entities: new Map(), operations: new Map() };
  return {
    ...program,
    anchor: {
      ...program.anchor,
      evidence: [...program.anchor.evidence.slice(0, 31), `inserted-timeline-offset:${offset.toFixed(3)}`],
      resolvedSeconds: program.anchor.resolvedSeconds + offset,
    },
    operations: program.operations.map((operation) => remapOperation(operation, offset, identityMaps)),
  };
}

function compositionTransactionId(programs: readonly CanonicalEditProgram[]) {
  let hash = 2_166_136_261;
  for (const character of JSON.stringify(programs)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `composition-${programs.length}-${(hash >>> 0).toString(36)}`;
}

function loweringStatus(programs: readonly CanonicalEditProgram[]) {
  if (programs.some((program) => program.loweringStatus === "unsupported")) return "unsupported" as const;
  if (programs.some((program) => program.loweringStatus === "illustrative")) return "illustrative" as const;
  return "supported" as const;
}

function orderedOperations(program: CanonicalEditProgram) {
  const byId = new Map(program.operations.map((operation) => [operation.id, operation]));
  return [
    ...program.schedule.order.flatMap((id) => {
      const operation = byId.get(id);
      return operation ? [operation] : [];
    }),
    ...program.operations.filter((operation) => !program.schedule.order.includes(operation.id)),
  ];
}

export function composeProgramsAtSourceAnchor(programs: readonly CanonicalEditProgram[]): ProgramCompositionResult {
  if (programs.length === 0) return { kind: "empty" };
  if (programs.length === 1) return { kind: "composed", program: programs[0] };

  const sourceAnchor = programs[0].anchor.resolvedSeconds;
  if (programs.some((program) => Math.abs(program.anchor.resolvedSeconds - sourceAnchor) >= ANCHOR_EPSILON)) {
    return {
      kind: "incompatible",
      message: "Programs from different source anchors cannot be rendered or exported as one source insertion.",
    };
  }

  const intentCount = programs.reduce((count, program) => count + program.intentCount, 0);
  const operationCount = programs.reduce((count, program) => count + program.operations.length, 0);
  if (intentCount > MAX_COMPOSED_INTENTS || operationCount > MAX_COMPOSED_OPERATIONS) {
    return {
      kind: "incompatible",
      message: `One render can compose at most ${MAX_COMPOSED_INTENTS} intents and ${MAX_COMPOSED_OPERATIONS} Canonical operations.`,
    };
  }

  const transactionId = compositionTransactionId(programs);
  const operationIds = new Map<string, string>();
  const entityIds = new Map<string, string>();
  let producerIndex = 0;
  for (const [programIndex, program] of programs.entries()) {
    for (const [index, operation] of program.operations.entries()) {
      if (operationIds.has(operation.id)) {
        return { kind: "incompatible", message: `Operation ID ${operation.id} occurs in more than one Program.` };
      }
      operationIds.set(operation.id, operationId(transactionId, `p${programIndex}-${index}`));
      const producedEntityId =
        operation.kind === "CreateEntity"
          ? operation.entity.id
          : operation.kind === "TransformContent"
            ? operation.targetEntityId
            : null;
      if (!producedEntityId) continue;
      if (entityIds.has(producedEntityId)) {
        return { kind: "incompatible", message: `Entity ID ${producedEntityId} is produced more than once.` };
      }
      entityIds.set(producedEntityId, provisionalEntityId(transactionId, `p${producerIndex}`));
      producerIndex += 1;
    }
  }

  const maps: IdMaps = { entities: entityIds, operations: operationIds };
  const operations: CanonicalEditOperation[] = [];
  let offset = 0;
  for (const program of programs) {
    operations.push(...orderedOperations(program).map((operation) => remapOperation(operation, offset, maps)));
    offset += programTimelineDelta(program);
  }
  const anchor = programs[0].anchor;
  const evidence = [...anchor.evidence.slice(0, 31), `composed-transactions:${programs.length}`];
  return {
    kind: "composed",
    program: {
      anchor: { ...anchor, evidence },
      intentCount,
      loweringStatus: loweringStatus(programs),
      operations,
      provenance: {
        evidence: [`composed ${programs.length} applied Programs at one source anchor`],
        origin: programs[0].provenance.origin,
      },
      requestedExecution: "sequence",
      schedule: {
        edges: [],
        mode: "sequence",
        order: operations.map((operation) => operation.id),
      },
      transactionId,
      version: programs[0].version,
    },
  };
}
