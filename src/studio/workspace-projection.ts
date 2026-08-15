import type { StudioPersistentRemoveProjectionV1, StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import { evaluateWorkingState, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import type { ProgramBatchAuthority, ProgramRecord, ProjectedEntity } from "./model";
import { type CanonicalEditProgram, isSceneDurationOperation } from "./operations";
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
