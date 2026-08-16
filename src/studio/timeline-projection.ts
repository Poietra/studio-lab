import {
  type ProjectStudioTimelineCompiler,
  type ProjectStudioTimelineWireCommandV1,
  projectStudioTimeline,
  type StudioTimelineProjectionV1,
} from "../engine/scene-authoring";
import {
  type Interval,
  type ProgramRecord,
  type ProposedState,
  type RuntimeSceneState,
  STUDIO_STATE_VERSION,
  type TimelineEvent,
  type WorkingState,
} from "./model";
import { isSceneDurationOperation, type SceneDurationOperation } from "./operations";
import type { SceneEdit } from "./scene-edit-contract";

export type SceneDurationProgram = Omit<SceneEdit, "operations"> &
  Readonly<{ operations: readonly [SceneDurationOperation] }>;

export type TimelineProgramBatchProjection = Readonly<{
  programs: readonly SceneDurationProgram[];
  projection: StudioTimelineProjectionV1;
}>;

export type SceneDurationTrimAvailability = Readonly<{
  anchor: number | null;
  blocker: string | null;
  minimumDuration: number;
  removableDuration: number;
  waitOperationIds: readonly string[];
}>;

const TIMELINE_EPSILON = 0.0005;

export function isSceneDurationProgram(program: SceneEdit): program is SceneDurationProgram {
  return program.operations.length === 1 && isSceneDurationOperation(program.operations[0]!);
}

export function isSceneDurationProgramBatch(
  programs: readonly SceneEdit[],
): programs is readonly SceneDurationProgram[] {
  return programs.length > 0 && programs.every(isSceneDurationProgram);
}

function assertSceneDurationProgramBatch(
  programs: readonly SceneEdit[],
): asserts programs is readonly SceneDurationProgram[] {
  const operations = programs.flatMap((program) => program.operations);
  const sceneDurationOperationCount = operations.filter(isSceneDurationOperation).length;
  if (sceneDurationOperationCount > 0 && sceneDurationOperationCount < operations.length) {
    throw new TypeError("A timeline projection batch must not mix Scene duration and other operation families.");
  }
  if (!isSceneDurationProgramBatch(programs)) {
    throw new TypeError("A timeline projection batch requires exactly one Scene duration operation per Program.");
  }
}

function timelineAnchorSource(
  program: SceneEdit,
): ProjectStudioTimelineWireCommandV1["programs"][number]["anchorSource"] {
  const source = program.anchor.source;
  if (source.kind === "absolute") return { kind: "absolute", seconds: source.seconds };
  if (source.kind === "playhead") return { kind: "playhead", referenceSeconds: source.referenceSeconds };
  return { kind: "unsupported" };
}

function timelineOperation(
  operation: SceneEdit["operations"][number],
): ProjectStudioTimelineWireCommandV1["programs"][number]["operations"][number] {
  const common = {
    dependsOn: operation.dependsOn,
    id: operation.id,
    interval: operation.interval,
    origin: operation.provenance.origin,
  };
  if (operation.kind === "InsertTimelineEvent") {
    return {
      ...common,
      eventKind: operation.eventKind,
      kind: "insert-wait",
      purpose: operation.purpose ?? null,
    };
  }
  if (operation.kind === "TrimSceneDuration") {
    return {
      ...common,
      kind: "trim-scene-duration",
      removedDuration: operation.removedDuration,
      targetDuration: operation.targetDuration,
      waitOperationIds: operation.waitOperationIds,
    };
  }
  return { ...common, kind: "unsupported" };
}

export function normalizeTimelineProjectionCommand(
  baseDuration: number,
  programs: readonly SceneEdit[],
): ProjectStudioTimelineWireCommandV1 {
  return {
    baseDuration,
    programs: programs.map((program) => ({
      anchorCapturedPlayhead: program.anchor.capturedPlayhead,
      anchorResolvedSeconds: program.anchor.resolvedSeconds,
      anchorSource: timelineAnchorSource(program),
      intentCount: program.intentCount,
      loweringSupported: program.loweringStatus === "supported",
      operations: program.operations.map(timelineOperation),
      origin: program.provenance.origin,
      requestedExecution: program.requestedExecution,
      scheduleEdgeCount: program.schedule.edges.length,
      scheduleMode: program.schedule.mode,
      scheduleOrder: program.schedule.order,
      transactionId: program.transactionId,
    })),
    schema: "poietra.project-studio-timeline",
    version: 1,
  };
}

function assertProjectionCorrelation(
  programs: readonly SceneDurationProgram[],
  projection: StudioTimelineProjectionV1,
) {
  if (projection.programProjections.length !== programs.length || projection.transforms.length !== programs.length) {
    throw new Error("Rust timeline projection did not return one correlated result per input Program.");
  }
  const operationIds = programs.map((program) => program.operations[0].id);
  if (new Set(operationIds).size !== operationIds.length) {
    throw new Error("A timeline projection batch must have unique operation IDs.");
  }
  projection.programProjections.forEach((projected, index) => {
    const program = programs[index]!;
    if (projected.transactionId !== program.transactionId || projected.operationId !== program.operations[0].id) {
      throw new Error(`Rust timeline projection lost input correlation at Program index ${index}.`);
    }
  });
  const transformedOperationIds = projection.transforms.map((transform) => transform.operationId);
  if (
    new Set(transformedOperationIds).size !== transformedOperationIds.length ||
    transformedOperationIds.some((operationId) => !operationIds.includes(operationId))
  ) {
    throw new Error("Rust timeline projection returned uncorrelated timeline transforms.");
  }
}

export async function projectTimelineProgramBatch(
  baseDuration: number,
  programs: readonly SceneEdit[],
  compiler: ProjectStudioTimelineCompiler = projectStudioTimeline,
): Promise<TimelineProgramBatchProjection> {
  assertSceneDurationProgramBatch(programs);
  const command = normalizeTimelineProjectionCommand(baseDuration, programs);
  const projection = await compiler(command);
  return correlateTimelineProgramBatch(programs, projection);
}

export function correlateTimelineProgramBatch(
  programs: readonly SceneEdit[],
  projection: StudioTimelineProjectionV1,
): TimelineProgramBatchProjection {
  assertSceneDurationProgramBatch(programs);
  assertProjectionCorrelation(programs, projection);
  return {
    programs: programs.map((program, index): SceneDurationProgram => {
      const projected = projection.programProjections[index]!;
      return {
        ...program,
        anchor: { ...program.anchor, resolvedSeconds: projected.workingAnchor },
        operations: [{ ...program.operations[0], interval: projected.workingInterval }],
      };
    }),
    projection,
  };
}

export function selectTimelineProgramBatchProjection(
  baseDuration: number,
  programs: readonly SceneEdit[],
  fullProjection: StudioTimelineProjectionV1,
): TimelineProgramBatchProjection {
  assertSceneDurationProgramBatch(programs);
  const selectedOperationIds = programs.map((program) => program.operations[0].id);
  if (new Set(selectedOperationIds).size !== selectedOperationIds.length) {
    throw new Error("A timeline projection batch must have unique operation IDs.");
  }

  const fullProgramProjectionsByOperationId = new Map(
    fullProjection.programProjections.map((projection) => [projection.operationId, projection] as const),
  );
  const fullTransformsByOperationId = new Map(
    fullProjection.transforms.map((transform) => [transform.operationId, transform] as const),
  );
  if (
    fullProgramProjectionsByOperationId.size !== fullProjection.programProjections.length ||
    fullTransformsByOperationId.size !== fullProjection.transforms.length ||
    fullProgramProjectionsByOperationId.size !== fullTransformsByOperationId.size ||
    [...fullProgramProjectionsByOperationId.keys()].some((operationId) => !fullTransformsByOperationId.has(operationId))
  ) {
    throw new Error("Rust timeline projection contains missing or duplicate correlations.");
  }

  const selectedOperationIdSet = new Set(selectedOperationIds);
  const transforms = fullProjection.transforms.slice(0, programs.length);
  if (
    transforms.length !== programs.length ||
    transforms.some((transform) => !selectedOperationIdSet.has(transform.operationId))
  ) {
    throw new Error("A selected timeline projection must be an execution prefix of the Rust transforms.");
  }

  const programProjections = programs.map((program) => {
    const operationId = program.operations[0].id;
    const projected = fullProgramProjectionsByOperationId.get(operationId);
    if (!projected || !fullTransformsByOperationId.has(operationId)) {
      throw new Error(`Rust timeline projection has no correlation for ${operationId}.`);
    }
    return projected;
  });
  const projectedDuration = transforms.reduce((duration, transform) => {
    const transformedDuration = transform.interval.end - transform.interval.start;
    return transform.kind === "insert" ? duration + transformedDuration : duration - transformedDuration;
  }, baseDuration);
  return correlateTimelineProgramBatch(programs, { programProjections, projectedDuration, transforms });
}

/** Maps a source timestamp through Rust-authorized timeline transforms in execution order. */
export function sourceTimeToWorkingTime(transforms: StudioTimelineProjectionV1["transforms"], sourceTime: number) {
  return transforms.reduce((time, transform) => {
    const duration = transform.interval.end - transform.interval.start;
    if (transform.kind === "insert") {
      return time >= transform.interval.start - TIMELINE_EPSILON ? time + duration : time;
    }
    return timeAfterRemoval(time, transform.interval);
  }, sourceTime);
}

/** Maps a working timestamp back through Rust-authorized transforms in reverse execution order. */
export function workingTimeToSourceTime(transforms: StudioTimelineProjectionV1["transforms"], workingTime: number) {
  return [...transforms].reverse().reduce((time, transform) => {
    const duration = transform.interval.end - transform.interval.start;
    if (transform.kind === "remove") {
      return time <= transform.interval.start + TIMELINE_EPSILON
        ? Math.min(time, transform.interval.start)
        : time + duration;
    }
    if (time < transform.interval.start - TIMELINE_EPSILON) return time;
    if (time <= transform.interval.end + TIMELINE_EPSILON) return transform.interval.start;
    return time - duration;
  }, workingTime);
}

/** Derives the safe trim suffix exclusively from a Rust timeline projection. */
export function sceneDurationTrimAvailabilityFromProjection(
  projection: StudioTimelineProjectionV1,
): SceneDurationTrimAvailability {
  const priorTransforms: StudioTimelineProjectionV1["transforms"][number][] = [];
  const waits: Array<{ anchor: number; operationId: string; remainingDuration: number }> = [];
  for (const transform of projection.transforms) {
    const duration = transform.interval.end - transform.interval.start;
    if (transform.kind === "insert") {
      waits.push({
        anchor: workingTimeToSourceTime(priorTransforms, transform.interval.start),
        operationId: transform.operationId,
        remainingDuration: duration,
      });
    } else {
      let reducedDuration = 0;
      const reducedOperationIds = new Set<string>();
      for (const reduction of transform.waitReductions) {
        const wait = waits.find(({ operationId }) => operationId === reduction.operationId);
        if (
          !wait ||
          reducedOperationIds.has(reduction.operationId) ||
          !Number.isFinite(reduction.removedDuration) ||
          reduction.removedDuration <= 0 ||
          reduction.removedDuration > wait.remainingDuration + TIMELINE_EPSILON
        ) {
          throw new Error("Rust timeline projection contains an invalid duration wait reduction.");
        }
        wait.remainingDuration = Math.max(0, wait.remainingDuration - reduction.removedDuration);
        reducedDuration += reduction.removedDuration;
        reducedOperationIds.add(reduction.operationId);
      }
      if (Math.abs(reducedDuration - duration) > TIMELINE_EPSILON) {
        throw new Error("Rust timeline projection wait reductions do not match the removed interval.");
      }
    }
    priorTransforms.push(transform);
  }

  if (waits.length === 0) {
    return {
      anchor: null,
      blocker:
        "Only a Rust-authorized trailing Scene duration wait can be shortened; imported or animated content is never truncated.",
      minimumDuration: projection.projectedDuration,
      removableDuration: 0,
      waitOperationIds: [],
    };
  }

  const waitOperationIds = waits.map((wait) => wait.operationId).reverse();
  const activeWaits = waits.filter((wait) => wait.remainingDuration > TIMELINE_EPSILON);
  const removableDuration = activeWaits.reduce((duration, wait) => duration + wait.remainingDuration, 0);
  if (activeWaits.length === 0) {
    return {
      anchor: null,
      blocker: "The Studio-added trailing wait is already fully removed.",
      minimumDuration: projection.projectedDuration,
      removableDuration: 0,
      waitOperationIds,
    };
  }

  const anchor = activeWaits.at(-1)!.anchor;
  if (activeWaits.some((wait) => Math.abs(wait.anchor - anchor) > TIMELINE_EPSILON)) {
    return {
      anchor: null,
      blocker:
        "Studio duration waits at different source anchors cannot be shortened together. Undo the later duration changes first.",
      minimumDuration: projection.projectedDuration,
      removableDuration: 0,
      waitOperationIds,
    };
  }

  if (removableDuration < 0.1 - TIMELINE_EPSILON) {
    return {
      anchor,
      blocker: "The Studio-added trailing wait is already fully removed.",
      minimumDuration: projection.projectedDuration,
      removableDuration: 0,
      waitOperationIds,
    };
  }
  return {
    anchor,
    blocker: null,
    minimumDuration: projection.projectedDuration - removableDuration,
    removableDuration,
    waitOperationIds,
  };
}

function shiftIntervalForInsertion(interval: Interval, insertion: Interval): Interval {
  const duration = insertion.end - insertion.start;
  if (interval.start >= insertion.start - TIMELINE_EPSILON) {
    return { end: interval.end + duration, start: interval.start + duration };
  }
  return interval.end > insertion.start ? { ...interval, end: interval.end + duration } : interval;
}

function timeAfterRemoval(time: number, removal: Interval) {
  if (time <= removal.start + TIMELINE_EPSILON) return Math.min(time, removal.start);
  if (time >= removal.end - TIMELINE_EPSILON) return time - (removal.end - removal.start);
  return removal.start;
}

function intervalAfterRemoval(interval: Interval, removal: Interval): Interval {
  const start = timeAfterRemoval(interval.start, removal);
  return { end: Math.max(start, timeAfterRemoval(interval.end, removal)), start };
}

function insertTimelineView(scene: RuntimeSceneState, insertion: Interval): RuntimeSceneState {
  const duration = insertion.end - insertion.start;
  return {
    ...scene,
    duration: scene.duration + duration,
    eventTrack: {
      events: scene.eventTrack.events.map((event) => ({
        ...event,
        at:
          event.at === undefined
            ? undefined
            : event.at >= insertion.start - TIMELINE_EPSILON
              ? event.at + duration
              : event.at,
        interval: event.interval ? shiftIntervalForInsertion(event.interval, insertion) : undefined,
      })),
    },
    objectGraph: {
      entities: Object.fromEntries(
        Object.entries(scene.objectGraph.entities).map(([id, entity]) => [
          id,
          { ...entity, lifetime: entity.lifetime.map((interval) => shiftIntervalForInsertion(interval, insertion)) },
        ]),
      ),
      lineage: scene.objectGraph.lineage.map((lineage) => ({
        ...lineage,
        at: lineage.at >= insertion.start - TIMELINE_EPSILON ? lineage.at + duration : lineage.at,
      })),
    },
    propertyChannels: Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([id, channel]) => [
        id,
        {
          ...channel,
          samples: channel.samples.map((sample) => ({
            ...sample,
            interval: shiftIntervalForInsertion(sample.interval, insertion),
          })),
        },
      ]),
    ),
  };
}

function removeTimelineView(
  scene: RuntimeSceneState,
  removal: Interval,
  removedWaitOperationIds: ReadonlySet<string>,
): RuntimeSceneState {
  return {
    ...scene,
    duration: scene.duration - (removal.end - removal.start),
    eventTrack: {
      events: scene.eventTrack.events
        .map((event) => ({
          ...event,
          at: event.at === undefined ? undefined : timeAfterRemoval(event.at, removal),
          interval: event.interval ? intervalAfterRemoval(event.interval, removal) : undefined,
        }))
        .filter(
          (event) =>
            !(
              event.operationId &&
              removedWaitOperationIds.has(event.operationId) &&
              event.interval &&
              event.interval.end - event.interval.start <= TIMELINE_EPSILON
            ),
        ),
    },
    objectGraph: {
      entities: Object.fromEntries(
        Object.entries(scene.objectGraph.entities).map(([id, entity]) => [
          id,
          {
            ...entity,
            lifetime: entity.lifetime
              .map((interval) => intervalAfterRemoval(interval, removal))
              .filter((interval) => interval.end - interval.start > TIMELINE_EPSILON),
          },
        ]),
      ),
      lineage: scene.objectGraph.lineage.map((lineage) => ({
        ...lineage,
        at: timeAfterRemoval(lineage.at, removal),
      })),
    },
    propertyChannels: Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([id, channel]) => [
        id,
        {
          ...channel,
          samples: channel.samples
            .map((sample) => ({ ...sample, interval: intervalAfterRemoval(sample.interval, removal) }))
            .filter((sample) => sample.interval.end - sample.interval.start > TIMELINE_EPSILON),
        },
      ]),
    ),
  };
}

function operationEvent(program: SceneDurationProgram): TimelineEvent {
  const operation = program.operations[0];
  return {
    id: `${operation.id}/event`,
    interval: operation.interval,
    kind: "operation",
    label: operation.kind,
    operationId: operation.id,
    transactionId: program.transactionId,
  };
}

function appendOperationView(scene: RuntimeSceneState, program: SceneDurationProgram): RuntimeSceneState {
  const operation = program.operations[0];
  const events: TimelineEvent[] = [...scene.eventTrack.events, operationEvent(program)];
  if (operation.kind === "InsertTimelineEvent") {
    events.push({
      id: `${operation.id}/timeline`,
      interval: operation.interval,
      kind: operation.eventKind,
      label: operation.label,
      operationId: operation.id,
      transactionId: program.transactionId,
    });
  }
  return {
    ...scene,
    eventTrack: { events },
    provenanceGraph: {
      records: [
        ...scene.provenanceGraph.records,
        {
          evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
          id: `${operation.id}/provenance`,
          operationId: operation.id,
          origin: operation.provenance.origin,
          transactionId: program.transactionId,
        },
      ],
    },
  };
}

function assertWorkingStateCorrelation(workingState: WorkingState, programs: readonly SceneDurationProgram[]) {
  const sourceRecords = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  if (sourceRecords.length !== programs.length) {
    throw new Error("The legacy timeline view does not match the projected WorkingState Program count.");
  }
  sourceRecords.forEach((record, index) => {
    const projected = programs[index]!;
    if (
      record.program.transactionId !== projected.transactionId ||
      record.program.operations[0]?.id !== projected.operations[0].id
    ) {
      throw new Error(`The legacy timeline view lost WorkingState correlation at Program index ${index}.`);
    }
  });
}

export function projectLegacyTimelineProposedState(
  workingState: WorkingState,
  projected: TimelineProgramBatchProjection,
): ProposedState {
  assertWorkingStateCorrelation(workingState, projected.programs);
  const programByOperationId = new Map(
    projected.programs.map((program) => [program.operations[0].id, program] as const),
  );
  let scene = workingState.runtimeSceneState;
  for (const transform of projected.projection.transforms) {
    const program = programByOperationId.get(transform.operationId);
    if (!program) throw new Error(`Timeline transform ${transform.operationId} has no correlated Program.`);
    const operation = program.operations[0];
    if (transform.kind === "insert") {
      if (operation.kind !== "InsertTimelineEvent") {
        throw new Error(`Timeline transform ${transform.operationId} does not match its projected operation kind.`);
      }
      scene = appendOperationView(insertTimelineView(scene, transform.interval), program);
    } else {
      if (operation.kind !== "TrimSceneDuration") {
        throw new Error(`Timeline transform ${transform.operationId} does not match its projected operation kind.`);
      }
      scene = removeTimelineView(
        appendOperationView(scene, program),
        transform.interval,
        new Set(operation.waitOperationIds),
      );
    }
  }
  const records: readonly ProgramRecord[] = projected.programs.map((program) => ({
    program,
    validation: { issues: [], status: "valid" },
  }));
  return {
    base: workingState,
    evaluatedScene: {
      ...scene,
      duration: projected.projection.projectedDuration,
      eventTrack: {
        events: [...scene.eventTrack.events].sort(
          (left, right) => (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0),
        ),
      },
    },
    issues: [],
    programs: records,
    version: STUDIO_STATE_VERSION,
  };
}
