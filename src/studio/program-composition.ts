import { isSceneDurationOperation } from "./operations";
import type { SceneEdit, SceneEditOperation } from "./scene-edit-contract";

const ANCHOR_EPSILON = 0.0005;

type IdMaps = Readonly<{
  entities: ReadonlyMap<string, string>;
  operations: ReadonlyMap<string, string>;
}>;

export function insertedProgramDuration(program: SceneEdit) {
  const insertedAnimations = program.operations.filter(
    (operation) =>
      operation.kind === "ChangePresence" ||
      operation.kind === "CreateMotion" ||
      operation.kind === "ResizeEntity" ||
      operation.kind === "TransformContent" ||
      (operation.kind === "AnimateProperty" && operation.key === "scale" && operation.timelineTrack !== true) ||
      (operation.kind === "InsertTimelineEvent" &&
        !isSceneDurationOperation(operation) &&
        operation.eventKind === "wait"),
  );
  const end = Math.max(
    program.anchor.resolvedSeconds,
    ...insertedAnimations.map((operation) => operation.interval.end),
  );
  return Math.max(0, end - program.anchor.resolvedSeconds);
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

function sourceInsertions(programs: readonly SceneEdit[]) {
  const sceneDurationOperation = programs.flatMap((program) => program.operations).find(isSceneDurationOperation);
  if (sceneDurationOperation) {
    throw new TypeError(`${sceneDurationOperation.kind} requires the Rust timeline projection.`);
  }
  const sorted = programs
    .map((program, index) => ({ index, program }))
    .sort(
      (left, right) =>
        left.program.anchor.resolvedSeconds - right.program.anchor.resolvedSeconds || left.index - right.index,
    );
  const insertions: TimelineInsertion[] = [];
  for (const { program } of sorted) {
    const sourceAnchor = program.anchor.resolvedSeconds;
    const duration = insertedProgramDuration(program);
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
export function sourceTimeToWorkingTime(programs: readonly SceneEdit[], sourceTime: number) {
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
export function workingTimeToSourceTime(programs: readonly SceneEdit[], workingTime: number) {
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
  programs: readonly SceneEdit[],
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

function shiftedInterval(interval: SceneEditOperation["interval"], offset: number) {
  return { end: interval.end + offset, start: interval.start + offset };
}

function remapEntity(id: string, maps: IdMaps) {
  return maps.entities.get(id) ?? id;
}

function remapOperationId(id: string, maps: IdMaps) {
  return maps.operations.get(id) ?? id;
}

function remapOperation(operation: SceneEditOperation, offset: number, maps: IdMaps): SceneEditOperation {
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

export function rebaseProgramTime(program: SceneEdit, offset: number): SceneEdit {
  if (!Number.isFinite(offset) || offset < 0)
    throw new Error("A Program timeline offset must be finite and non-negative.");
  const sceneDurationOperation = program.operations.find(isSceneDurationOperation);
  if (sceneDurationOperation) {
    throw new TypeError(`${sceneDurationOperation.kind} requires the Rust timeline projection.`);
  }
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
