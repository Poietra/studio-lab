import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { importManimScene } from "../render-pipeline/source-import";
import { validateSuggestionDraft } from "./draft-validation";
import { evaluateWorkingState } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene } from "./imported-workspace";
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
`;

function workspaceScene(name: "First" | "Second", nextSceneId: string | null): ManimWorkspaceScene {
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

describe("Studio workspace projection", () => {
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
    expect(projected.editableEntities.map((entity) => entity.id)).toEqual([
      "source:scene.py#Second:incoming",
    ]);
    expect(projected.visibleEntities.some((entity) => entity.type.startsWith("TransitionOverlay:"))).toBe(true);
  });
});
