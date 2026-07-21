import { evaluateWorkingState, projectProposedState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
import type { ProgramRecord, ProjectedEntity } from "./model";

export function isTransitionOverlay(entity: Pick<ProjectedEntity, "type">) {
  return entity.type.startsWith("TransitionOverlay:");
}

export function projectStudioWorkspace(input: Readonly<{
  activeScene: ManimWorkspaceScene;
  appliedPrograms: readonly ProgramRecord[];
  currentTime: number;
  draftProgram: ProgramRecord | null;
  nextScene: ManimWorkspaceScene | null;
  selectedObjectIds: readonly string[];
}>) {
  const workingState = importedWorkingState(input.activeScene, {
    appliedPrograms: input.appliedPrograms,
    playhead: input.currentTime,
    selection: input.selectedObjectIds,
    stagedPrograms: input.draftProgram ? [input.draftProgram] : [],
  });
  const proposedState = evaluateWorkingState(workingState);
  const projection = projectProposedState(proposedState, input.currentTime);
  const boundary = projection.timeline.events
    .filter((event) => event.kind === "scene-boundary" && event.at !== undefined && event.at <= input.currentTime)
    .at(-1) ?? null;
  const incomingProjection = input.nextScene && boundary
    ? projectProposedState(evaluateWorkingState(importedWorkingState(input.nextScene, {
        playhead: 0,
        selection: [],
      })), 0)
    : null;
  const transitionEntities = projection.canvas.entities.filter(isTransitionOverlay);
  const visibleEntities = boundary && incomingProjection
    ? [...incomingProjection.canvas.entities, ...transitionEntities]
    : projection.canvas.entities;
  return {
    boundary,
    editableEntities: visibleEntities.filter((entity) => !isTransitionOverlay(entity)),
    projection,
    proposedState,
    visibleEntities,
  } as const;
}
