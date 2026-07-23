import type {
  EntityContent,
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
import { evaluateOperation, type EvaluationDraft } from "./operation-registry";
import {
  isEntityDimensionsValue,
  isPointValue,
  normalizePositionSamples,
  normalizeScaleSamples,
  samplePropertyKnowledge,
  samplePropertyValue,
} from "./property-sampling";
import {
  programTimelineDelta,
  rebaseProgramTime,
  shiftIntervalForInsertion,
  timelineInsertionOffset,
} from "./program-composition";
import { validateAndScheduleProgram } from "./program-validation";

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

function normalizeRelativeChannels(draft: EvaluationDraft) {
  draft.propertyChannels = Object.fromEntries(
    Object.entries(draft.propertyChannels).map(([id, channel]) => [
      id,
      channel.key === "position"
        ? { ...channel, samples: normalizePositionSamples(channel.samples) }
        : channel.key === "scale"
          ? { ...channel, samples: normalizeScaleSamples(channel.samples) }
          : channel,
    ]),
  );
}

export function evaluateWorkingState(workingState: WorkingState): ProposedState {
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
  const draft = cloneScene(workingState.runtimeSceneState);
  const evaluatedPrograms: Array<ProgramRecord | undefined> = new Array(programs.length);
  const insertions: Array<Readonly<{ duration: number; sourceAnchor: number }>> = [];
  for (const { applied, inputIndex, record } of programs) {
    if (record.validation.status !== "valid") {
      evaluatedPrograms[inputIndex] = record;
      continue;
    }
    const sourceAnchor = record.program.anchor.resolvedSeconds;
    const priorInsertionOffset = timelineInsertionOffset(insertions, sourceAnchor);
    const rebasedProgram = rebaseProgramTime(record.program, priorInsertionOffset);
    const validation = validateAndScheduleProgram(rebasedProgram, freezeScene(workingState.runtimeSceneState, draft));
    const evaluatedRecord = programRecord(validation.program, validation);
    evaluatedPrograms[inputIndex] = evaluatedRecord;
    if (validation.kind !== "valid") continue;
    const timelineDelta = programTimelineDelta(validation.program);
    if (timelineDelta > 0) {
      insertSceneTime(draft, validation.program.anchor.resolvedSeconds, timelineDelta);
    }
    const operationById = new Map(validation.program.operations.map((operation) => [operation.id, operation]));
    for (const operationId of validation.program.schedule.order) {
      const operation = operationById.get(operationId);
      if (operation) evaluateOperation(draft, operation, validation.program);
    }
    normalizeRelativeChannels(draft);
    if (applied) {
      for (const operation of validation.program.operations) {
        const entityId =
          operation.kind === "CreateEntity"
            ? operation.entity.id
            : operation.kind === "TransformContent"
              ? operation.targetEntityId
              : null;
        if (!entityId || !draft.entities[entityId]) continue;
        draft.entities[entityId] = { ...draft.entities[entityId], provisional: false };
      }
    }
    insertions.push({ duration: timelineDelta, sourceAnchor });
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
        content: isContent(content) ? content : entity.content,
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
