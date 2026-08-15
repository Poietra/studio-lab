import type {
  StudioPersistentRemoveProjectionV1,
  StudioStaticRootMutationV1,
  StudioStaticRootProjectionV1,
  StudioTimelineProjectionV1,
} from "../engine/scene-authoring";
import { evaluateWorkingState, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import {
  type ProgramBatchAuthority,
  type ProgramRecord,
  type ProjectedEntity,
  type PropertyChannel,
  type PropertyChannelSample,
  type ProposedState,
  STUDIO_STATE_VERSION,
  type WorkingState,
} from "./model";
import {
  type CanonicalEditOperation,
  type CanonicalEditProgram,
  isExactStaticRootProjectionProgramBatch,
  isSceneDurationOperation,
} from "./operations";
import { normalizeContentSamples } from "./property-sampling";
import {
  correlateTimelineProgramBatch,
  isSceneDurationProgramBatch,
  projectLegacyTimelineProposedState,
} from "./timeline-projection";

export function isTransitionOverlay(entity: Pick<ProjectedEntity, "type">) {
  return entity.type.startsWith("TransitionOverlay:");
}

export function selectStudioWorkspaceProgramAuthority(
  records: readonly ProgramRecord[],
  previewRecords: readonly ProgramRecord[],
  authority: ProgramBatchAuthority | null,
) {
  if (records.length === 0) return null;
  if (isSceneDurationProgramBatch(records.map(({ program }) => program))) return null;
  if (!authority || records.length !== previewRecords.length) return undefined;
  return records.every((record, index) => record === previewRecords[index]) ? authority : undefined;
}

export function selectPersistentRemoveProjection(
  programs: readonly CanonicalEditProgram[],
  projection: StudioPersistentRemoveProjectionV1 | null,
): StudioPersistentRemoveProjectionV1 | null {
  const expected = programs.flatMap((program) =>
    program.operations.flatMap((operation) =>
      operation.kind === "ChangePresence" && operation.effect === "remove" && operation.persistent
        ? [{ entityId: operation.entityId, operationId: operation.id, transactionId: program.transactionId }]
        : [],
    ),
  );
  if (expected.length === 0) return null;
  if (!projection) {
    throw new TypeError("A Rust persistent remove projection is required to project persistent remove Programs.");
  }
  const removalsByOperationId = new Map(projection.removals.map((removal) => [removal.operationId, removal] as const));
  if (removalsByOperationId.size !== projection.removals.length) {
    throw new TypeError("The Rust persistent remove projection contains duplicate operation IDs.");
  }
  return {
    removals: expected.map(({ entityId, operationId, transactionId }) => {
      const removal = removalsByOperationId.get(operationId);
      if (!removal || removal.studioEntityId !== entityId || removal.transactionId !== transactionId) {
        throw new TypeError(`Persistent remove ${operationId} is not correlated with the Rust authoring projection.`);
      }
      return removal;
    }),
  };
}

type CorrelatedStaticRootMutation = Readonly<{
  mutation: StudioStaticRootMutationV1;
  operation: CanonicalEditOperation;
  program: CanonicalEditProgram;
}>;

function correlateStaticRootProjection(
  programs: readonly CanonicalEditProgram[],
  projection: StudioStaticRootProjectionV1 | null,
): readonly CorrelatedStaticRootMutation[] | null {
  if (!isExactStaticRootProjectionProgramBatch(programs)) return null;
  if (!projection) {
    throw new TypeError("A Rust static-root projection is required to project static imported-root Programs.");
  }
  const operations = programs.flatMap((program) =>
    program.operations.map((operation) => ({ operation, program }) as const),
  );
  const operationById = new Map(operations.map((entry) => [entry.operation.id, entry] as const));
  if (operationById.size !== operations.length || projection.mutations.length !== operations.length) {
    throw new TypeError("The Rust static-root projection does not contain the complete Program batch.");
  }
  const operationIds = new Set<string>();
  return projection.mutations.map((mutation) => {
    const expected = operationById.get(mutation.operationId);
    if (
      !expected ||
      operationIds.has(mutation.operationId) ||
      mutation.transactionId !== expected.program.transactionId
    ) {
      throw new TypeError(`Static-root operation ${mutation.operationId} is not correlated with the Rust projection.`);
    }
    operationIds.add(mutation.operationId);
    return { mutation, ...expected };
  });
}

export function selectStaticRootProjection(
  programs: readonly CanonicalEditProgram[],
  projection: StudioStaticRootProjectionV1 | null,
): StudioStaticRootProjectionV1 | null {
  if (!isExactStaticRootProjectionProgramBatch(programs)) return null;
  const correlated = correlateStaticRootProjection(programs, projection);
  return correlated ? { mutations: correlated.map(({ mutation }) => mutation) } : null;
}

function appendStaticRootSample(
  propertyChannels: Record<string, PropertyChannel>,
  entityId: string,
  key: PropertyChannel["key"],
  sample: PropertyChannelSample,
) {
  const id = `${entityId}/${key}`;
  const channel = propertyChannels[id];
  const samples = [...(channel?.samples ?? []), sample];
  propertyChannels[id] = {
    entityId,
    key,
    samples: key === "content" ? normalizeContentSamples(samples) : samples,
  };
}

function projectStaticRootWorkingState(
  workingState: WorkingState,
  projection: StudioStaticRootProjectionV1,
): ProposedState {
  const records = [...workingState.appliedPrograms, ...workingState.stagedPrograms];
  const programs = records.map(({ program }) => program);
  const correlated = correlateStaticRootProjection(programs, projection);
  if (!correlated) throw new TypeError("Only an exact static-root Program batch can use this projection.");
  const propertyChannels: Record<string, PropertyChannel> = Object.fromEntries(
    Object.entries(workingState.runtimeSceneState.propertyChannels).map(([id, channel]) => [
      id,
      { ...channel, samples: [...channel.samples] },
    ]),
  );
  const events = [...workingState.runtimeSceneState.eventTrack.events];
  const provenance = [...workingState.runtimeSceneState.provenanceGraph.records];
  correlated.forEach(({ mutation, operation, program }) => {
    if (!workingState.runtimeSceneState.objectGraph.entities[mutation.entityId]) {
      throw new TypeError(`Rust static-root projection target ${mutation.entityId} is not in the imported Scene.`);
    }
    const provenanceId = `${operation.id}/provenance`;
    provenance.push({
      evidence: [...program.anchor.evidence, ...operation.provenance.evidence],
      id: provenanceId,
      operationId: operation.id,
      origin: operation.provenance.origin,
      transactionId: program.transactionId,
    });
    events.push({
      id: `${operation.id}/event`,
      interval: mutation.interval,
      kind: "operation",
      label: operation.kind,
      operationId: operation.id,
      transactionId: program.transactionId,
    });
    if (mutation.kind === "position") {
      appendStaticRootSample(propertyChannels, mutation.entityId, "position", {
        interval: mutation.interval,
        kind: "exact",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.value,
      });
    } else if (mutation.kind === "uniform-scale") {
      appendStaticRootSample(propertyChannels, mutation.entityId, "scale", {
        easing: "smooth",
        from: mutation.from,
        interval: mutation.interval,
        kind: "animated",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.to,
      });
    } else if (mutation.kind === "resize") {
      const kind = mutation.interval.end > mutation.interval.start ? "animated" : "exact";
      appendStaticRootSample(propertyChannels, mutation.entityId, "dimensions", {
        from: mutation.fromDimensions,
        interval: mutation.interval,
        kind,
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.toDimensions,
      });
      appendStaticRootSample(propertyChannels, mutation.entityId, "position", {
        from: mutation.fromPosition,
        interval: mutation.interval,
        kind,
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.toPosition,
      });
    } else {
      appendStaticRootSample(propertyChannels, mutation.entityId, "content", {
        interval: mutation.interval,
        kind: "exact",
        operationId: mutation.operationId,
        provenanceId,
        value: mutation.content,
      });
    }
  });
  return {
    base: workingState,
    evaluatedScene: {
      ...workingState.runtimeSceneState,
      eventTrack: {
        events: events.sort(
          (left, right) => (left.at ?? left.interval?.start ?? 0) - (right.at ?? right.interval?.start ?? 0),
        ),
      },
      propertyChannels,
      provenanceGraph: { records: provenance },
    },
    issues: [],
    programs: records.map((record) => ({ ...record, validation: { issues: [], status: "valid" } })),
    version: STUDIO_STATE_VERSION,
  };
}

export function projectStudioWorkspace(
  input: Readonly<{
    activeScene: ManimWorkspaceScene;
    appliedPrograms: readonly ProgramRecord[];
    currentTime: number;
    draftProgram: ProgramRecord | null;
    nextScene: ManimWorkspaceScene | null;
    persistentRemoveProjection?: StudioPersistentRemoveProjectionV1 | null;
    programAuthority?: ProgramBatchAuthority | null;
    selectedObjectIds: readonly string[];
    staticRootProjection?: StudioStaticRootProjectionV1 | null;
    timelineProjection?: StudioTimelineProjectionV1 | null;
  }>,
) {
  const workingState = importedWorkingState(input.activeScene, {
    appliedPrograms: input.appliedPrograms,
    playhead: input.currentTime,
    selection: input.selectedObjectIds,
    stagedPrograms: input.draftProgram ? [input.draftProgram] : [],
  });
  const programs = [...workingState.appliedPrograms, ...workingState.stagedPrograms].map((record) => record.program);
  const containsSceneDurationOperation = programs.some((program) => program.operations.some(isSceneDurationOperation));
  const persistentRemoveProjection = selectPersistentRemoveProjection(
    programs,
    input.persistentRemoveProjection ?? null,
  );
  let proposedState;
  if (containsSceneDurationOperation) {
    if (persistentRemoveProjection) {
      throw new TypeError("Scene duration and persistent remove Programs cannot share one workspace projection.");
    }
    if (!isSceneDurationProgramBatch(programs)) {
      throw new TypeError(
        "Scene duration Programs cannot be mixed with another operation family in one workspace projection.",
      );
    }
    if (!input.timelineProjection) {
      throw new TypeError("A Rust timeline projection is required to project Scene duration Programs.");
    }
    proposedState = projectLegacyTimelineProposedState(
      workingState,
      correlateTimelineProgramBatch(programs, input.timelineProjection),
    );
  } else if (input.programAuthority === "static-imported-root" && isExactStaticRootProjectionProgramBatch(programs)) {
    if (!input.staticRootProjection) {
      throw new TypeError("A Rust static-root projection is required to project static imported-root Programs.");
    }
    proposedState = projectStaticRootWorkingState(workingState, input.staticRootProjection);
  } else {
    proposedState = evaluateWorkingState(workingState, persistentRemoveProjection, input.programAuthority ?? null);
  }
  const projection = projectProposedState(proposedState, input.currentTime);
  const boundary =
    projection.timeline.events
      .filter((event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= input.currentTime)
      .at(-1) ?? null;
  const incomingProjection =
    input.nextScene && boundary
      ? projectProposedState(
          evaluateWorkingState(
            importedWorkingState(input.nextScene, {
              playhead: 0,
              selection: [],
            }),
          ),
          0,
        )
      : null;
  const transitionEntities = projection.canvas.entities.filter(isTransitionOverlay);
  const visibleEntities =
    boundary && incomingProjection
      ? [...incomingProjection.canvas.entities, ...transitionEntities]
      : projection.canvas.entities;
  return {
    boundary,
    // The incoming Scene is a playback preview. Editing still targets the
    // active (outgoing) Scene, so exposing incoming identities as editable
    // would produce a guaranteed target-missing validation failure.
    editableEntities: boundary ? [] : projection.canvas.entities.filter((entity) => !isTransitionOverlay(entity)),
    projection,
    proposedState,
    visibleEntities,
  } as const;
}
