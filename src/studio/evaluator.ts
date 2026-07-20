import type {
  EntityContent,
  ProgramRecord,
  ProjectedEntity,
  PropertyChannel,
  PropertyChannelSample,
  PropertyValue,
  ProposedState,
  ProposedStateProjection,
  RuntimeSceneState,
  WorkingState,
} from "./model";
import { STUDIO_STATE_VERSION } from "./model";
import { evaluateOperation, type EvaluationDraft } from "./operation-registry";

function cloneScene(scene: RuntimeSceneState): EvaluationDraft {
  return {
    constraints: [...scene.constraintGraph.constraints],
    duration: scene.duration,
    entities: { ...scene.objectGraph.entities },
    events: [...scene.eventTrack.events],
    lineage: [...scene.objectGraph.lineage],
    propertyChannels: Object.fromEntries(Object.entries(scene.propertyChannels).map(([key, channel]) => [key, {
      ...channel,
      samples: [...channel.samples],
    }])),
    provenance: [...scene.provenanceGraph.records],
  };
}

function freezeScene(base: RuntimeSceneState, draft: EvaluationDraft): RuntimeSceneState {
  return {
    ...base,
    constraintGraph: { constraints: draft.constraints },
    eventTrack: { events: draft.events.sort((left, right) => (
      (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0)
    )) },
    objectGraph: { entities: draft.entities, lineage: draft.lineage },
    propertyChannels: draft.propertyChannels,
    provenanceGraph: { records: draft.provenance },
  };
}

export function evaluateWorkingState(workingState: WorkingState): ProposedState {
  const programs = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  const draft = cloneScene(workingState.runtimeSceneState);
  for (const record of programs) {
    if (record.validation.status !== "valid") continue;
    const operationById = new Map(record.program.operations.map((operation) => [operation.id, operation]));
    for (const operationId of record.program.schedule.order) {
      const operation = operationById.get(operationId);
      if (operation) evaluateOperation(draft, operation, record.program);
    }
  }
  return {
    base: workingState,
    evaluatedScene: freezeScene(workingState.runtimeSceneState, draft),
    issues: programs.flatMap((record) => record.validation.issues),
    programs,
    version: STUDIO_STATE_VERSION,
  };
}

function smooth(value: number) {
  return value * value * (3 - 2 * value);
}

function isPoint(value: PropertyValue | undefined): value is Readonly<{ x: number; y: number }> {
  return typeof value === "object" && value !== null && "x" in value && "y" in value;
}

function isContent(value: PropertyValue | undefined): value is EntityContent {
  return typeof value === "object" && value !== null && "displayLines" in value;
}

function valueAt(samples: readonly PropertyChannelSample[], time: number) {
  let value: PropertyValue | undefined;
  for (const sample of samples) {
    if (time < sample.interval.start) continue;
    if (sample.kind === "exact" || time >= sample.interval.end) {
      value = sample.value;
      continue;
    }
    const duration = sample.interval.end - sample.interval.start;
    const progress = duration <= 0 ? 1 : smooth(Math.min(1, Math.max(0, (time - sample.interval.start) / duration)));
    if (isPoint(sample.from) && isPoint(sample.value)) {
      const control = sample.control ?? {
        x: (sample.from.x + sample.value.x) / 2,
        y: (sample.from.y + sample.value.y) / 2,
      };
      const inverse = 1 - progress;
      value = {
        x: inverse * inverse * sample.from.x + 2 * inverse * progress * control.x + progress * progress * sample.value.x,
        y: inverse * inverse * sample.from.y + 2 * inverse * progress * control.y + progress * progress * sample.value.y,
      };
    } else if (typeof sample.from === "number" && typeof sample.value === "number") {
      value = sample.from + (sample.value - sample.from) * progress;
    } else {
      value = sample.value;
    }
  }
  return value;
}

function channelAt(scene: RuntimeSceneState, entityId: string, key: PropertyChannel["key"], time: number) {
  return valueAt(scene.propertyChannels[`${entityId}/${key}`]?.samples ?? [], time);
}

export function sampleProposedState(proposedState: ProposedState, time: number): readonly ProjectedEntity[] {
  return Object.values(proposedState.evaluatedScene.objectGraph.entities)
    .map((entity): ProjectedEntity => {
      const inLifetime = entity.lifetime.some((interval) => time >= interval.start && time < interval.end);
      const presence = channelAt(proposedState.evaluatedScene, entity.id, "presence", time);
      const position = channelAt(proposedState.evaluatedScene, entity.id, "position", time);
      const appearance = channelAt(proposedState.evaluatedScene, entity.id, "appearance", time);
      const content = channelAt(proposedState.evaluatedScene, entity.id, "content", time);
      return {
        content: isContent(content) ? content : entity.content,
        id: entity.id,
        opacity: typeof appearance === "number" ? appearance : 1,
        position: isPoint(position) ? position : { x: 0, y: 0 },
        present: inLifetime && presence !== false,
        provisional: entity.provisional,
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
  return {
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
    timeline: { events: proposedState.evaluatedScene.eventTrack.events, sampleId },
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
