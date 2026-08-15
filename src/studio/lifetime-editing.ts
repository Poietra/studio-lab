import type { Interval, ProgramRecord, RuntimeSceneState, TimelineObjectTrack } from "./model";
import { type CanonicalEditOperation, isSceneDurationOperation } from "./operations";
import {
  insertedProgramDuration,
  shiftIntervalForInsertion,
  type TimelineInsertion,
  timelineInsertionOffset,
  workingTimeToSourceTime,
} from "./program-composition";

const LIFETIME_EDIT_EVIDENCE_PREFIX = "studio-lifetime-edit:";

export const MIN_OBJECT_LIFETIME_SECONDS = 0.1;

export type ImportedLifetimeEditMetadata = Readonly<{
  entityId: string;
  kind: "imported-end";
  original: Interval;
}>;

export type StudioLifetimeOwner = Readonly<{
  index: number;
  record: ProgramRecord;
}>;

export type ProgramSourceAnchorBounds = Readonly<{
  maximum?: number;
  minimum?: number;
}>;

export type LifetimeEditTarget = Readonly<{
  source: Interval;
  working: Interval;
}>;

export type LifetimeEditControls = Readonly<{
  endTargets: readonly LifetimeEditTarget[];
  moveTargets: readonly LifetimeEditTarget[];
  reason: string | null;
  startTargets: readonly LifetimeEditTarget[];
}>;

export function lifetimeControlKey(entityId: string, index: number) {
  return `${entityId}/lifetime/${index}`;
}

function isInterval(value: unknown): value is Interval {
  return (
    typeof value === "object" &&
    value !== null &&
    "start" in value &&
    "end" in value &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    typeof value.end === "number" &&
    Number.isFinite(value.end)
  );
}

export function importedLifetimeEditEvidence(metadata: ImportedLifetimeEditMetadata) {
  return `${LIFETIME_EDIT_EVIDENCE_PREFIX}${JSON.stringify(metadata)}`;
}

export function importedLifetimeEditMetadata(record: ProgramRecord): ImportedLifetimeEditMetadata | null {
  const evidence = record.program.provenance.evidence.find((entry) => entry.startsWith(LIFETIME_EDIT_EVIDENCE_PREFIX));
  if (!evidence) return null;
  try {
    const parsed: unknown = JSON.parse(evidence.slice(LIFETIME_EDIT_EVIDENCE_PREFIX.length));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("kind" in parsed) ||
      parsed.kind !== "imported-end" ||
      !("entityId" in parsed) ||
      typeof parsed.entityId !== "string" ||
      !("original" in parsed) ||
      !isInterval(parsed.original)
    )
      return null;
    return {
      entityId: parsed.entityId,
      kind: parsed.kind,
      original: parsed.original,
    };
  } catch {
    return null;
  }
}

export function findImportedLifetimeEdit(programs: readonly ProgramRecord[], entityId: string, originalStart: number) {
  const index = programs.findIndex((record) => {
    const metadata = importedLifetimeEditMetadata(record);
    return metadata?.entityId === entityId && Math.abs(metadata.original.start - originalStart) < 0.001;
  });
  return index < 0 ? null : ({ index, record: programs[index]! } as const);
}

export function findStudioLifetimeOwner(
  programs: readonly ProgramRecord[],
  entityId: string,
): StudioLifetimeOwner | null {
  const index = programs.findIndex((record) =>
    record.program.operations.some(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === entityId,
    ),
  );
  return index < 0 ? null : { index, record: programs[index]! };
}

export function studioLifetimeOwnerReason(owner: StudioLifetimeOwner) {
  const created = owner.record.program.operations.filter((operation) => operation.kind === "CreateEntity");
  if (created.length !== 1) {
    return "This object shares one creation Program with other objects, so its start and interval cannot move independently yet.";
  }
  return Math.abs(created[0]!.entity.lifetime.start - owner.record.program.anchor.resolvedSeconds) < 0.001
    ? null
    : "This object is created after its Program begins, so its start and interval cannot move independently yet.";
}

function uniqueTimes(times: readonly number[]) {
  return [...new Set(times.map((time) => Number(time.toFixed(6))))].sort((left, right) => left - right);
}

export function programSourceAnchorBounds(
  programs: readonly ProgramRecord[],
  index: number,
): ProgramSourceAnchorBounds {
  return {
    maximum: Math.min(Infinity, ...programs.slice(index + 1).map(({ program }) => program.anchor.resolvedSeconds)),
    minimum: Math.max(-Infinity, ...programs.slice(0, index).map(({ program }) => program.anchor.resolvedSeconds)),
  };
}

function sourceAnchorInProgramOrder(programs: readonly ProgramRecord[], index: number, candidate: number) {
  const bounds = programSourceAnchorBounds(programs, index);
  return candidate >= (bounds.minimum ?? -Infinity) - 0.001 && candidate <= (bounds.maximum ?? Infinity) + 0.001;
}

function ownerAnchorInOrder(
  programs: readonly ProgramRecord[],
  owner: StudioLifetimeOwner,
  entityId: string,
  targetStart: number,
) {
  const create = owner.record.program.operations.find((operation) => createsEntity(operation, entityId));
  if (!create) return false;
  const candidate = owner.record.program.anchor.resolvedSeconds + targetStart - create.entity.lifetime.start;
  return sourceAnchorInProgramOrder(programs, owner.index, candidate);
}

function projectImportedInterval(source: Interval, programs: readonly ProgramRecord[]) {
  let working = source;
  const insertions: TimelineInsertion[] = [];
  for (const { program } of programs) {
    const duration = insertedProgramDuration(program);
    const at = program.anchor.resolvedSeconds + timelineInsertionOffset(insertions, program.anchor.resolvedSeconds);
    working = shiftIntervalForInsertion(working, at, duration);
    insertions.push({ duration, sourceAnchor: program.anchor.resolvedSeconds });
  }
  return working;
}

function createsEntity(
  operation: CanonicalEditOperation,
  entityId: string,
): operation is Extract<CanonicalEditOperation, { kind: "CreateEntity" }> {
  return operation.kind === "CreateEntity" && operation.entity.id === entityId;
}

function ownerDuration(owner: StudioLifetimeOwner, entityId: string, source: Interval) {
  const program = owner.record.program;
  const create = program.operations.find((operation) => createsEntity(operation, entityId));
  if (!create) return insertedProgramDuration(program);
  const delta = source.start - create.entity.lifetime.start;
  const anchor = program.anchor.resolvedSeconds + delta;
  const ends = program.operations.flatMap((operation) => {
    const inserted =
      operation.kind === "ChangePresence" ||
      operation.kind === "CreateMotion" ||
      operation.kind === "TransformContent" ||
      (operation.kind === "AnimateProperty" && operation.key === "scale");
    if (!inserted) return [];
    const end =
      operation.kind === "ChangePresence" && operation.entityId === entityId && operation.effect === "fade-in"
        ? Math.min(source.end, operation.interval.end + delta)
        : operation.interval.end + delta;
    return [end];
  });
  return Math.max(0, Math.max(anchor, ...ends) - anchor);
}

function projectOwnedInterval(
  source: Interval,
  programs: readonly ProgramRecord[],
  owner: StudioLifetimeOwner,
  entityId: string,
  sourceDuration: number,
) {
  const create = owner.record.program.operations.find((operation) => createsEntity(operation, entityId));
  if (!create) return projectImportedInterval(source, programs);
  const delta = source.start - create.entity.lifetime.start;
  const candidateAnchor = owner.record.program.anchor.resolvedSeconds + delta;
  const candidateDuration = ownerDuration(owner, entityId, source);
  const insertions: TimelineInsertion[] = [];
  let working: Interval | null = null;
  for (const [index, { program }] of programs.entries()) {
    const sourceAnchor = index === owner.index ? candidateAnchor : program.anchor.resolvedSeconds;
    const duration = index === owner.index ? candidateDuration : insertedProgramDuration(program);
    const offset = timelineInsertionOffset(insertions, sourceAnchor);
    const at = sourceAnchor + offset;
    if (index === owner.index) {
      working = {
        end:
          Math.abs(source.end - sourceDuration) < 0.001
            ? sourceDuration + insertions.reduce((total, insertion) => total + insertion.duration, 0) + duration
            : source.end + offset + duration,
        start: source.start + offset,
      };
    } else if (working) {
      working = shiftIntervalForInsertion(working, at, duration);
    }
    insertions.push({ duration, sourceAnchor });
  }
  return working ?? source;
}

function targetFor(
  source: Interval,
  programs: readonly ProgramRecord[],
  owner: StudioLifetimeOwner | null,
  entityId: string,
  sourceDuration: number,
): LifetimeEditTarget {
  return {
    source,
    working: owner
      ? projectOwnedInterval(source, programs, owner, entityId, sourceDuration)
      : projectImportedInterval(source, programs),
  };
}

function importedSourceInterval(
  baseScene: RuntimeSceneState,
  programs: readonly ProgramRecord[],
  track: TimelineObjectTrack,
  workingInterval: Interval,
) {
  const canonical = programs.map((record) => record.program);
  const projectedStart = workingTimeToSourceTime(canonical, workingInterval.start);
  const projectedEnd = workingTimeToSourceTime(canonical, workingInterval.end);
  const original = baseScene.objectGraph.entities[track.entityId]?.lifetime.find(
    (interval) => Math.abs(interval.start - projectedStart) < 0.001 && interval.end >= projectedEnd - 0.001,
  );
  return original
    ? {
        current: { end: Math.min(original.end, projectedEnd), start: original.start },
        maximumEnd: original.end,
      }
    : null;
}

function programChangesEntityLifetime(record: ProgramRecord, entityId: string) {
  return (
    record.validation.status === "valid" &&
    record.program.operations.some(
      (operation) =>
        (operation.kind === "ChangePresence" &&
          operation.entityId === entityId &&
          operation.effect === "remove" &&
          operation.persistent) ||
        (operation.kind === "TransformContent" && operation.sourceEntityId === entityId),
    )
  );
}

export function findCompetingImportedLifetimeOwner(programs: readonly ProgramRecord[], entityId: string) {
  return (
    programs.find((record) => {
      const metadata = importedLifetimeEditMetadata(record);
      return metadata?.entityId !== entityId && programChangesEntityLifetime(record, entityId);
    }) ?? null
  );
}

export function findCompetingStudioLifetimeOwner(
  programs: readonly ProgramRecord[],
  entityId: string,
  ownerIndex: number,
) {
  return (
    programs.find((record, index) => index !== ownerIndex && programChangesEntityLifetime(record, entityId)) ?? null
  );
}

export function buildLifetimeEditControls(
  input: Readonly<{
    anchors: readonly number[];
    baseScene: RuntimeSceneState;
    programs: readonly ProgramRecord[];
    sourceDuration: number;
    tracks: readonly TimelineObjectTrack[];
  }>,
): Readonly<Record<string, LifetimeEditControls>> {
  if (input.programs.some((record) => record.program.operations.some(isSceneDurationOperation))) {
    throw new TypeError("Lifetime controls require the Rust timeline projection for timeline Programs.");
  }
  const safeTimes = uniqueTimes(input.anchors);
  const result: Record<string, LifetimeEditControls> = {};
  for (const track of input.tracks) {
    const owner = findStudioLifetimeOwner(input.programs, track.entityId);
    const create = owner?.record.program.operations.find(
      (operation) => operation.kind === "CreateEntity" && operation.entity.id === track.entityId,
    );
    for (const [index, workingInterval] of track.lifetimes.entries()) {
      const imported = owner ? null : importedSourceInterval(input.baseScene, input.programs, track, workingInterval);
      const source =
        create?.kind === "CreateEntity"
          ? {
              end: create.entity.lifetime.end ?? input.sourceDuration,
              start: create.entity.lifetime.start,
            }
          : (imported?.current ?? null);
      if (!source) {
        result[lifetimeControlKey(track.entityId, index)] = {
          endTargets: [],
          moveTargets: [],
          reason: "Studio cannot map this interval back to one source-backed lifetime.",
          startTargets: [],
        };
        continue;
      }
      const importedEdit = owner ? null : findImportedLifetimeEdit(input.programs, track.entityId, source.start);
      const competingImportedOwner = owner ? null : findCompetingImportedLifetimeOwner(input.programs, track.entityId);
      const untrackedImportedOwner = !owner && !importedEdit && source.end < imported!.maximumEnd - 0.001;
      const expectedOwnedWorking = owner
        ? targetFor(source, input.programs, owner, track.entityId, input.sourceDuration).working
        : null;
      const competingStudioOwner = owner
        ? findCompetingStudioLifetimeOwner(input.programs, track.entityId, owner.index)
        : null;
      const studioProjectionMismatch =
        expectedOwnedWorking !== null &&
        (Math.abs(expectedOwnedWorking.start - workingInterval.start) >= 0.001 ||
          Math.abs(expectedOwnedWorking.end - workingInterval.end) >= 0.001);
      if (competingImportedOwner || untrackedImportedOwner || competingStudioOwner || studioProjectionMismatch) {
        result[lifetimeControlKey(track.entityId, index)] = {
          endTargets: [],
          moveTargets: [],
          reason: owner
            ? "Another applied Program controls this object's lifetime end. Edit or remove that Program before changing the lifetime interval."
            : "Another applied Program controls this imported object's lifetime end. Edit or remove that Program before changing the lifetime interval.",
          startTargets: [],
        };
        continue;
      }
      const maximumEnd = owner ? input.sourceDuration : imported!.maximumEnd;
      const ownerInSourceOrder = owner ? ownerAnchorInOrder(input.programs, owner, track.entityId, source.start) : true;
      const ownershipReason = owner
        ? (studioLifetimeOwnerReason(owner) ??
          (!ownerInSourceOrder
            ? "This creation Program is outside applied source order, so only restoring an open-ended lifetime is safe."
            : null))
        : null;
      const editableStart = owner !== null && ownershipReason === null;
      const startTimes = editableStart
        ? safeTimes.filter(
            (time) =>
              time >= 0 &&
              source.end - time >= MIN_OBJECT_LIFETIME_SECONDS - 0.001 &&
              Math.abs(time - source.start) >= 0.001 &&
              ownerAnchorInOrder(input.programs, owner, track.entityId, time),
          )
        : [];
      const candidateEndTimes = uniqueTimes([...safeTimes, maximumEnd]).filter(
        (time) =>
          time <= maximumEnd + 0.001 &&
          time - source.start >= MIN_OBJECT_LIFETIME_SECONDS - 0.001 &&
          Math.abs(time - source.end) >= 0.001 &&
          (!owner || ownerInSourceOrder || Math.abs(time - maximumEnd) < 0.001),
      );
      const endTimes = candidateEndTimes.filter((time) => {
        if (owner) return true;
        if (importedEdit && Math.abs(time - maximumEnd) < 0.001) return true;
        const editIndex = importedEdit?.index ?? input.programs.length;
        const sourceAnchor =
          Math.abs(time - maximumEnd) < 0.001 ? (importedEdit?.record.program.anchor.resolvedSeconds ?? time) : time;
        return sourceAnchorInProgramOrder(input.programs, editIndex, sourceAnchor);
      });
      const importedSourceOrderLimited = !owner && endTimes.length < candidateEndTimes.length;
      const width = source.end - source.start;
      const moveTargets = editableStart
        ? safeTimes.flatMap((start) => {
            const end = start + width;
            const endIsSafe =
              safeTimes.some((time) => Math.abs(time - end) < 0.001) || Math.abs(end - maximumEnd) < 0.001;
            return end <= maximumEnd + 0.001 &&
              endIsSafe &&
              Math.abs(start - source.start) >= 0.001 &&
              ownerAnchorInOrder(input.programs, owner, track.entityId, start)
              ? [targetFor({ end, start }, input.programs, owner, track.entityId, input.sourceDuration)]
              : [];
          })
        : [];
      result[lifetimeControlKey(track.entityId, index)] = {
        endTargets: endTimes.map((end) =>
          targetFor({ end, start: source.start }, input.programs, owner, track.entityId, input.sourceDuration),
        ),
        moveTargets,
        reason: owner
          ? ownershipReason
          : `Imported creation timing is read-only because Studio cannot safely move the original Python statement. Its end can still be trimmed or restored${importedSourceOrderLimited ? ", but some endpoints would move the lifetime Program out of applied source order" : ""}.`,
        startTargets: startTimes.map((start) =>
          targetFor({ end: source.end, start }, input.programs, owner, track.entityId, input.sourceDuration),
        ),
      };
    }
  }
  return result;
}
