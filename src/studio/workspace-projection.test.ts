import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { importManimScene } from "../render-pipeline/source-import";
import { createSceneDurationProgram } from "./authoring-commands";
import { validateSuggestionDraft } from "./draft-validation";
import { evaluateWorkingState, programRecord } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene, projectVerifiedSourceDuration } from "./imported-workspace";
import type { Interval } from "./model";
import { projectStudioWorkspace } from "./workspace-projection";

const source = `from manim import *

class First(Scene):
    def construct(self):
        outgoing = Text("Outgoing")
        self.add(outgoing)
        # poietra:anchor 5.000
        self.wait(8)

class Second(Scene):
    def construct(self):
        incoming = Text("Incoming")
        self.add(incoming)

class Static(Scene):
    def construct(self):
        shape = Circle()
        self.add(shape)
`;

function workspaceScene(name: "First" | "Second" | "Static", nextSceneId: string | null): ManimWorkspaceScene {
  const imported = importManimScene(source, "scene.py", name);
  if (!imported) throw new Error(`Could not import ${name}.`);
  return {
    anchors: imported.anchors,
    name,
    nextSceneId,
    runtimeSceneState: imported.runtimeSceneState,
    sceneId: imported.sceneId,
    sourceHash: imported.sourceHash,
    sourcePath: "scene.py",
    sourceVariables: imported.sourceVariables,
    staticSemanticState: imported.staticSemanticState,
  };
}

function withOnlyEntityLifetimes(scene: ManimWorkspaceScene, lifetime: readonly Interval[]) {
  const [entityId, entity] = Object.entries(scene.runtimeSceneState.objectGraph.entities)[0]!;
  return {
    ...scene,
    runtimeSceneState: {
      ...scene.runtimeSceneState,
      objectGraph: {
        ...scene.runtimeSceneState.objectGraph,
        entities: { [entityId]: { ...entity, lifetime } },
      },
    },
  } satisfies ManimWorkspaceScene;
}

describe("Studio workspace projection", () => {
  it("projects verified source duration through playback and only extends terminal imported lifetimes", () => {
    const imported = withOnlyEntityLifetimes(workspaceScene("Static", null), [
      { end: 0.05, start: 0 },
      { end: 0.1, start: 0.05 },
    ]);
    expect(projectVerifiedSourceDuration(imported, null)).toBe(imported);
    const entityId = Object.keys(imported.runtimeSceneState.objectGraph.entities)[0]!;
    expect(imported.runtimeSceneState.duration).toBe(0.1);
    const projectedScene = projectVerifiedSourceDuration(imported, 1);
    const projected = projectStudioWorkspace({
      activeScene: projectedScene,
      appliedPrograms: [],
      currentTime: 0.75,
      draftProgram: null,
      nextScene: null,
      selectedObjectIds: [],
    });

    expect(projected.proposedState.evaluatedScene.duration).toBe(1);
    expect(projected.projection.time).toBe(0.75);
    expect(projected.projection.canvas.entities.find((entity) => entity.id === entityId)?.present).toBe(true);
    expect(projectedScene.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([
      { end: 0.05, start: 0 },
      { end: 1, start: 0.05 },
    ]);
    expect(imported.runtimeSceneState.duration).toBe(0.1);

    const shortened = projectVerifiedSourceDuration(projectedScene, 0.5);
    expect(shortened.runtimeSceneState.duration).toBe(0.5);
    expect(shortened.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([
      { end: 0.05, start: 0 },
      { end: 0.5, start: 0.05 },
    ]);
    const invalid = withOnlyEntityLifetimes(projectedScene, [{ end: 1, start: 0.75 }]);
    expect(projectVerifiedSourceDuration(invalid, 0.5)).toBe(invalid);
    expect(projectVerifiedSourceDuration(projectedScene, 0.09)).toBe(projectedScene);
  });

  it("evaluates an existing canonical duration edit on top of verified source time", () => {
    const imported = workspaceScene("Static", null);
    const edit = createSceneDurationProgram({
      capturedPlayhead: 0.1,
      scene: imported.runtimeSceneState,
      sourceAnchor: 0.1,
      targetDuration: 0.6,
      transactionId: "duration-before-runtime-snapshot",
    });
    expect(edit.kind).toBe("valid");

    const projected = projectStudioWorkspace({
      activeScene: projectVerifiedSourceDuration(imported, 1),
      appliedPrograms: [programRecord(edit.program, edit)],
      currentTime: 1.25,
      draftProgram: null,
      nextScene: null,
      selectedObjectIds: [],
    });

    expect(projected.proposedState.evaluatedScene.duration).toBe(1.5);
    expect(projected.projection.time).toBe(1.25);
    expect(projected.proposedState.programs[0]?.validation.status).toBe("valid");
  });

  it("replaces outgoing objects with the actual imported next Scene after the boundary", () => {
    const nextScene = workspaceScene("Second", null);
    const activeScene = workspaceScene("First", nextScene.sceneId);
    const transition: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      color: "sky",
      destination: "next-scene",
      easing: "smooth",
      end: 6.5,
      kind: "create-scene-transition",
      shape: "circle",
      start: 5,
      style: "cover-reveal",
    };
    const draft = validateSuggestionDraft(transition, {
      capturedPlayhead: 5,
      hasNextScene: true,
      origin: "remote-model",
      proposedState: evaluateWorkingState(importedWorkingState(activeScene, { playhead: 5, selection: [] })),
      selectedObjectIds: [],
      transactionId: "transition",
    });
    if (draft.kind !== "valid") throw new Error(draft.message);

    const projected = projectStudioWorkspace({
      activeScene,
      appliedPrograms: [],
      currentTime: 6,
      draftProgram: draft.record,
      nextScene,
      selectedObjectIds: [],
    });

    expect(projected.boundary).not.toBeNull();
    expect(projected.editableEntities).toEqual([]);
    expect(projected.visibleEntities.some((entity) => entity.type.startsWith("TransitionOverlay:"))).toBe(true);
  });
});
