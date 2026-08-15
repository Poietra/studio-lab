import type { StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import { evaluateWorkingState, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import type { ProgramRecord, ProjectedEntity } from "./model";
import { isSceneDurationOperation } from "./operations";
import {
  correlateTimelineProgramBatch,
  isSceneDurationProgramBatch,
  projectLegacyTimelineProposedState,
} from "./timeline-projection";

export function isTransitionOverlay(entity: Pick<ProjectedEntity, "type">) {
  return entity.type.startsWith("TransitionOverlay:");
}

export function projectStudioWorkspace(
  input: Readonly<{
    activeScene: ManimWorkspaceScene;
    appliedPrograms: readonly ProgramRecord[];
    currentTime: number;
    draftProgram: ProgramRecord | null;
    nextScene: ManimWorkspaceScene | null;
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
  let proposedState;
  if (containsSceneDurationOperation) {
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
    proposedState = evaluateWorkingState(workingState);
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
