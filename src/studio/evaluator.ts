import type { StudioMotionProjectionV1 } from "../engine/scene-authoring";
import { UNKNOWN_EDITABLE_CONTENT } from "./editable-content";
import type {
  EntityContent,
  ProgramBatchAuthority,
  ProgramRecord,
  ProjectedEntity,
  PropertyChannel,
  PropertyValue,
  ProposedState,
  ProposedStateProjection,
  RuntimeEntity,
  RuntimeSceneState,
  TimelineObjectTrack,
  WorkingState,
} from "./model";
import { STUDIO_STATE_VERSION } from "./model";
import { type EvaluationDraft, evaluateOperation } from "./operation-registry";
import { isSceneDurationOperation } from "./operations";
import {
  insertedProgramDuration,
  rebaseProgramTime,
  shiftIntervalForInsertion,
  timelineInsertionOffset,
} from "./program-composition";
import { validateAndScheduleProgram } from "./program-validation";
import {
  isEntityDimensionsValue,
  isPointValue,
  normalizeContentSamples,
  normalizeDimensionsSamples,
  normalizePositionSamples,
  normalizeScaleSamples,
  samplePropertyKnowledge,
  samplePropertyValue,
} from "./property-sampling";

function cloneScene(scene: RuntimeSceneState): EvaluationDraft {
  return {
    constraints: [...scene.constraintGraph.constraints],
    duration: scene.duration,
    entities: { ...scene.objectGraph.entities },
    events: [...scene.eventTrack.events],
    lineage: [...scene.objectGraph.lineage],
    propertyChannels: Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([key, channel]) => [
        key,
        {
          ...channel,
          samples: [...channel.samples],
        },
      ]),
    ),
    provenance: [...scene.provenanceGraph.records],
  };
}

function freezeScene(base: RuntimeSceneState, draft: EvaluationDraft): RuntimeSceneState {
  return {
    ...base,
    constraintGraph: { constraints: draft.constraints },
    duration: draft.duration,
    eventTrack: {
      events: draft.events.sort(
        (left, right) => (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0),
      ),
    },
    objectGraph: { entities: draft.entities, lineage: draft.lineage },
    propertyChannels: draft.propertyChannels,
    provenanceGraph: { records: draft.provenance },
  };
}

export function insertSceneTime(draft: EvaluationDraft, at: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return;
  draft.duration += duration;
  draft.entities = Object.fromEntries(
    Object.entries(draft.entities).map(([id, entity]) => [
      id,
      {
        ...entity,
        lifetime: entity.lifetime.map((interval) => shiftIntervalForInsertion(interval, at, duration)),
      },
    ]),
  );
  draft.events = draft.events.map((event) => ({
    ...event,
    at: event.at === undefined ? undefined : event.at >= at - 0.0005 ? event.at + duration : event.at,
    interval: event.interval ? shiftIntervalForInsertion(event.interval, at, duration) : undefined,
  }));
  draft.lineage = draft.lineage.map((lineage) => ({
    ...lineage,
    at: lineage.at >= at - 0.0005 ? lineage.at + duration : lineage.at,
  }));
  draft.propertyChannels = Object.fromEntries(
    Object.entries(draft.propertyChannels).map(([id, channel]) => [
      id,
      {
        ...channel,
        samples: channel.samples.map((sample) => ({
          ...sample,
          interval: shiftIntervalForInsertion(sample.interval, at, duration),
        })),
      },
    ]),
  );
}

function normalizePropertyChannels(draft: EvaluationDraft) {
  draft.propertyChannels = Object.fromEntries(
    Object.entries(draft.propertyChannels).map(([id, channel]) => [
      id,
      channel.key === "content"
        ? { ...channel, samples: normalizeContentSamples(channel.samples) }
        : channel.key === "dimensions"
          ? { ...channel, samples: normalizeDimensionsSamples(channel.samples) }
          : channel.key === "position"
            ? { ...channel, samples: normalizePositionSamples(channel.samples) }
            : channel.key === "scale"
              ? { ...channel, samples: normalizeScaleSamples(channel.samples) }
              : channel,
    ]),
  );
}

export function evaluateWorkingState(
  workingState: WorkingState,
  programAuthority: ProgramBatchAuthority | null = null,
  rustMotionProjection: StudioMotionProjectionV1 | null = null,
): ProposedState {
  const programs = [
    ...workingState.appliedPrograms.map((record) => ({ applied: true, record })),
    ...workingState.stagedPrograms.map((record) => ({ applied: false, record })),
  ]
    .map((entry, inputIndex) => ({ ...entry, inputIndex }))
    .sort(
      (left, right) =>
        left.record.program.anchor.resolvedSeconds - right.record.program.anchor.resolvedSeconds ||
        left.inputIndex - right.inputIndex,
    );
  const sceneDurationOperation = programs
    .flatMap(({ record }) => record.program.operations)
    .find(isSceneDurationOperation);
  if (sceneDurationOperation) {
    throw new TypeError(`${sceneDurationOperation.kind} requires the Rust timeline projection.`);
  }
  const motionOperation = programs
    .flatMap(({ record }) => record.program.operations)
    .find(({ kind }) => kind === "CreateMotion");
  const rustProjectedMotionOperationIds = rustMotionProjection
    ? new Set(rustMotionProjection.motions.map(({ operationId }) => operationId))
    : null;
  if (motionOperation && !rustProjectedMotionOperationIds?.has(motionOperation.id)) {
    throw new TypeError("CreateMotion requires the Rust motion projection.");
  }
  const rustInsertionByTransactionId = new Map(
    (rustMotionProjection?.insertions ?? []).map((insertion) => [insertion.transactionId, insertion] as const),
  );
  if (rustInsertionByTransactionId.size !== (rustMotionProjection?.insertions.length ?? 0)) {
    throw new TypeError("The Rust motion projection contains duplicate Program insertions.");
  }
  const draft = cloneScene(workingState.runtimeSceneState);
  const evaluatedPrograms: Array<ProgramRecord | undefined> = new Array(programs.length);
  const insertions: Array<Readonly<{ duration: number; sourceAnchor: number }>> = [];
  const usedRustInsertionTransactionIds = new Set<string>();
  const usedRustMotionOperationIds = new Set<string>();
  let rustInsertionOffset = 0;
  for (const { applied, inputIndex, record } of programs) {
    const rustAuthorizedProgram = programAuthority !== null;
    const staticRootProjection = programAuthority === "static-imported-root";
    if (record.validation.status !== "valid" && !rustAuthorizedProgram) {
      evaluatedPrograms[inputIndex] = record;
      continue;
    }
    const sourceAnchor = record.program.anchor.resolvedSeconds;
    const rustInsertion = rustInsertionByTransactionId.get(record.program.transactionId);
    const priorInsertionOffset = rustMotionProjection
      ? rustInsertion
        ? rustInsertion.at - sourceAnchor
        : rustInsertionOffset
      : timelineInsertionOffset(insertions, sourceAnchor);
    if (!Number.isFinite(priorInsertionOffset) || priorInsertionOffset < 0) {
      throw new TypeError(`The Rust motion insertion for ${record.program.transactionId} has an invalid anchor.`);
    }
    const rebasedProgram = rebaseProgramTime(record.program, priorInsertionOffset);
    const validation = rustAuthorizedProgram
      ? { issues: [], kind: "valid" as const, program: rebasedProgram }
      : validateAndScheduleProgram(rebasedProgram, freezeScene(workingState.runtimeSceneState, draft));
    const evaluatedRecord = programRecord(validation.program, validation);
    evaluatedPrograms[inputIndex] = evaluatedRecord;
    if (validation.kind !== "valid") continue;
    const timelineDelta = rustMotionProjection
      ? (rustInsertion?.duration ?? 0)
      : insertedProgramDuration(validation.program);
    if (timelineDelta > 0) {
      const insertionAt = rustInsertion?.at ?? validation.program.anchor.resolvedSeconds;
      if (!Number.isFinite(insertionAt) || !Number.isFinite(timelineDelta)) {
        throw new TypeError(`The Rust motion insertion for ${record.program.transactionId} is invalid.`);
      }
      insertSceneTime(draft, insertionAt, timelineDelta);
      if (rustInsertion) {
        usedRustInsertionTransactionIds.add(record.program.transactionId);
        rustInsertionOffset = priorInsertionOffset + timelineDelta;
      }
    }
    const operationById = new Map(validation.program.operations.map((operation) => [operation.id, operation]));
    for (const operationId of validation.program.schedule.order) {
      const operation = operationById.get(operationId);
      if (operation) {
        if (operation.kind === "CreateMotion") {
          if (!rustProjectedMotionOperationIds?.has(operation.id)) {
            throw new TypeError(`CreateMotion ${operation.id} requires the Rust motion projection.`);
          }
          usedRustMotionOperationIds.add(operation.id);
          continue;
        }
        evaluateOperation(
          draft,
          staticRootProjection && operation.kind === "AnimateProperty" && operation.key === "scale"
            ? { ...operation, relativeFactor: undefined }
            : operation,
          validation.program,
        );
      }
    }
    normalizePropertyChannels(draft);
    if (applied) {
      for (const operation of validation.program.operations) {
        if (operation.kind !== "CreateEntity") continue;
        const entityId = operation.entity.id;
        if (!draft.entities[entityId]) continue;
        draft.entities[entityId] = { ...draft.entities[entityId], provisional: false };
      }
    }
    if (!rustMotionProjection) {
      insertions.push({ duration: timelineDelta, sourceAnchor });
    }
  }
  if (
    usedRustInsertionTransactionIds.size !== rustInsertionByTransactionId.size ||
    usedRustMotionOperationIds.size !== (rustProjectedMotionOperationIds?.size ?? 0)
  ) {
    throw new TypeError("The Rust motion projection does not match the evaluated Program batch.");
  }
  return {
    base: workingState,
    evaluatedScene: freezeScene(workingState.runtimeSceneState, draft),
    issues: evaluatedPrograms.flatMap((record) => record?.validation.issues ?? []),
    programs: evaluatedPrograms.filter((record): record is ProgramRecord => record !== undefined),
    version: STUDIO_STATE_VERSION,
  };
}

function isContent(value: PropertyValue | undefined): value is EntityContent {
  return typeof value === "object" && value !== null && "displayLines" in value;
}

function channelAt(scene: RuntimeSceneState, entityId: string, key: PropertyChannel["key"], time: number) {
  return samplePropertyValue(scene.propertyChannels[`${entityId}/${key}`]?.samples ?? [], time);
}

function timelineLabel(entity: RuntimeEntity) {
  return (
    entity.content?.label ??
    entity.content?.text ??
    (entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : null) ??
    entity.id.split(":").at(-1) ??
    entity.id
  );
}

function projectTimelineObjectTracks(scene: RuntimeSceneState): readonly TimelineObjectTrack[] {
  const animatedByEntity = new Map<string, Array<TimelineObjectTrack["animatedChannels"][number]>>();
  for (const channel of Object.values(scene.propertyChannels)) {
    const animated = channel.samples
      .filter((sample) => sample.kind === "animated" || sample.operationId)
      .map((sample) => ({
        interval: {
          end: Math.min(scene.duration, sample.interval.end),
          start: Math.max(0, sample.interval.start),
        },
        key: channel.key,
        operationId: sample.operationId,
      }))
      .filter((sample) => sample.interval.end > sample.interval.start);
    if (animated.length > 0) {
      animatedByEntity.set(channel.entityId, [...(animatedByEntity.get(channel.entityId) ?? []), ...animated]);
    }
  }
  return Object.values(scene.objectGraph.entities)
    .map(
      (entity): TimelineObjectTrack => ({
        animatedChannels: animatedByEntity.get(entity.id) ?? [],
        entityId: entity.id,
        label: timelineLabel(entity),
        lifetimes: entity.lifetime,
        provisional: entity.provisional,
        transactionId: entity.transactionId,
        type: entity.type,
      }),
    )
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function sampleProposedState(proposedState: ProposedState, time: number): readonly ProjectedEntity[] {
  return Object.values(proposedState.evaluatedScene.objectGraph.entities)
    .map((entity): ProjectedEntity => {
      const inLifetime = entity.lifetime.some((interval) => time >= interval.start && time < interval.end);
      const presence = channelAt(proposedState.evaluatedScene, entity.id, "presence", time);
      const position = channelAt(proposedState.evaluatedScene, entity.id, "position", time);
      const appearance = channelAt(proposedState.evaluatedScene, entity.id, "appearance", time);
      const content = channelAt(proposedState.evaluatedScene, entity.id, "content", time);
      const dimensions = channelAt(proposedState.evaluatedScene, entity.id, "dimensions", time);
      const scale = channelAt(proposedState.evaluatedScene, entity.id, "scale", time);
      const positionValue = isPointValue(position) ? position : undefined;
      const dimensionsValue = isEntityDimensionsValue(dimensions) ? dimensions : undefined;
      const scaleValue = typeof scale === "number" ? scale : undefined;
      const sampledPosition = positionValue ?? { x: 0, y: 0 };
      const sampledScale = scaleValue ?? 1;
      const positionSamples = proposedState.evaluatedScene.propertyChannels[`${entity.id}/position`]?.samples ?? [];
      const dimensionsSamples = proposedState.evaluatedScene.propertyChannels[`${entity.id}/dimensions`]?.samples ?? [];
      const scaleSamples = proposedState.evaluatedScene.propertyChannels[`${entity.id}/scale`]?.samples ?? [];
      const positionKnowledge = samplePropertyKnowledge(positionSamples, time, positionValue);
      const scaleKnowledge = samplePropertyKnowledge(scaleSamples, time, scaleValue);
      const dimensionsKnowledge = samplePropertyKnowledge(dimensionsSamples, time, dimensionsValue);
      const fallbackGeometry = {
        dimensions: { kind: "known" as const, value: {} },
        position: positionKnowledge ?? {
          kind: "unknown" as const,
          reason: "No exact source position is available at this time.",
        },
        scale:
          scaleKnowledge ??
          (scaleSamples.length === 0
            ? { kind: "known" as const, value: sampledScale }
            : {
                kind: "unknown" as const,
                reason: "No exact source scale is available at this time.",
              }),
        style: { kind: "known" as const, value: {} },
      };
      return {
        content: content === UNKNOWN_EDITABLE_CONTENT ? undefined : isContent(content) ? content : entity.content,
        geometry: {
          ...(entity.geometry ?? fallbackGeometry),
          dimensions: dimensionsKnowledge ?? entity.geometry?.dimensions ?? fallbackGeometry.dimensions,
          position: positionKnowledge ?? entity.geometry?.position ?? fallbackGeometry.position,
          scale: scaleKnowledge ?? entity.geometry?.scale ?? fallbackGeometry.scale,
        },
        id: entity.id,
        opacity: typeof appearance === "number" ? appearance : 1,
        position: sampledPosition,
        present: inLifetime && presence !== false,
        provisional: entity.provisional,
        scale: sampledScale,
        sourceIdentity: entity.sourceIdentity,
        transactionId: entity.transactionId,
        type: entity.type,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function projectProposedState(proposedState: ProposedState, time: number): ProposedStateProjection {
  const normalizedTime = Math.min(proposedState.evaluatedScene.duration, Math.max(0, time));
  const entities = sampleProposedState(proposedState, normalizedTime);
  const transactionIds = proposedState.programs.map((record) => record.program.transactionId).join(",");
  const sampleId = `${proposedState.evaluatedScene.sceneId}@${normalizedTime.toFixed(3)}[${transactionIds}]`;
  const cameraScale = channelAt(proposedState.evaluatedScene, "camera", "camera", normalizedTime);
  return {
    camera: { sampleId, scale: typeof cameraScale === "number" ? cameraScale : 1 },
    canvas: { entities, sampleId },
    inspector: { entities, issues: proposedState.issues, sampleId },
    objectList: { entities, sampleId },
    semanticThumbnail: { entities, sampleId },
    sourcePreview: {
      lowering: proposedState.programs.map((record) => ({
        status: record.program.loweringStatus,
        transactionId: record.program.transactionId,
      })),
      sampleId,
    },
    time: normalizedTime,
    timeline: {
      events: proposedState.evaluatedScene.eventTrack.events,
      objectTracks: projectTimelineObjectTracks(proposedState.evaluatedScene),
      sampleId,
    },
    workingPlayback: { entities, sampleId },
  };
}

export function programRecord(
  program: ProgramRecord["program"],
  validation: Readonly<{ issues: ProgramRecord["validation"]["issues"]; kind: "invalid" | "valid" }>,
): ProgramRecord {
  return {
    program,
    validation: { issues: validation.issues, status: validation.kind },
  };
}
