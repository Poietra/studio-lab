import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import { importManimScene } from "../render-pipeline/source-import";
import { createSceneDurationProgram } from "./authoring-commands";
import { validateSuggestionDraft } from "./draft-validation";
import {
  canResolveSourceDurationMismatch,
  clampPlayheadToResolvedSourceDuration,
  resolveVerifiedSourceDurationBasis,
} from "./editor-revision-policy";
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
  it("adopts verified duration only while pristine and retains it across delayed provider reloads", () => {
    const unresolved = resolveVerifiedSourceDurationBasis({
      candidate: null,
      editorPristine: true,
      retained: null,
      sessionKey: "source-a",
    });
    expect(unresolved).toEqual({ adoption: null, duration: null, mismatch: false });

    const editedWhileUnresolved = resolveVerifiedSourceDurationBasis({
      candidate: null,
      editorPristine: false,
      retained: null,
      sessionKey: "source-a",
    });
    expect(editedWhileUnresolved).toEqual({ adoption: null, duration: null, mismatch: false });

    const verifiedWithoutAnAdoptedBasis = resolveVerifiedSourceDurationBasis({
      candidate: 1,
      editorPristine: false,
      retained: null,
      sessionKey: "source-a",
    });
    expect(verifiedWithoutAnAdoptedBasis).toEqual({ adoption: null, duration: null, mismatch: true });

    const pristineResolution = resolveVerifiedSourceDurationBasis({
      candidate: 1,
      editorPristine: true,
      retained: null,
      sessionKey: "source-a",
    });
    expect(pristineResolution).toEqual({
      adoption: { duration: 1, sessionKey: "source-a" },
      duration: 1,
      mismatch: false,
    });
    expect(
      resolveVerifiedSourceDurationBasis({
        candidate: null,
        editorPristine: false,
        retained: pristineResolution.adoption,
        sessionKey: "source-a",
      }),
    ).toEqual({ adoption: null, duration: 1, mismatch: false });
    expect(
      resolveVerifiedSourceDurationBasis({
        candidate: null,
        editorPristine: true,
        retained: pristineResolution.adoption,
        sessionKey: "source-b",
      }),
    ).toEqual({ adoption: null, duration: null, mismatch: false });

    expect(
      resolveVerifiedSourceDurationBasis({
        candidate: 2,
        editorPristine: false,
        retained: pristineResolution.adoption,
        sessionKey: "source-a",
      }),
    ).toEqual({ adoption: null, duration: 1, mismatch: true });
    expect(
      resolveVerifiedSourceDurationBasis({
        candidate: 2,
        editorPristine: true,
        retained: pristineResolution.adoption,
        sessionKey: "source-a",
      }),
    ).toEqual({
      adoption: { duration: 2, sessionKey: "source-a" },
      duration: 2,
      mismatch: false,
    });
  });

  it("does not clamp a restored playhead while explicit source metadata is pending", () => {
    expect(clampPlayheadToResolvedSourceDuration(0.8, 0.1, true)).toBe(0.8);
    expect(clampPlayheadToResolvedSourceDuration(0.8, 1, false)).toBe(0.8);
    expect(clampPlayheadToResolvedSourceDuration(0.8, 0.1, false)).toBe(0.1);
  });

  it("allows destructive timing recovery only for the still-mismatched source session that opened it", () => {
    expect(
      canResolveSourceDurationMismatch({
        currentSessionKey: "source-a",
        mismatch: true,
        targetSessionKey: "source-a",
      }),
    ).toBe(true);
    expect(
      canResolveSourceDurationMismatch({
        currentSessionKey: "source-b",
        mismatch: true,
        targetSessionKey: "source-a",
      }),
    ).toBe(false);
    expect(
      canResolveSourceDurationMismatch({
        currentSessionKey: "source-a",
        mismatch: false,
        targetSessionKey: "source-a",
      }),
    ).toBe(false);
  });

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
    const prefixWithoutFutureLifetime = projectVerifiedSourceDuration(invalid, 0.5);
    expect(prefixWithoutFutureLifetime.runtimeSceneState.duration).toBe(0.5);
    expect(prefixWithoutFutureLifetime.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([]);
    expect(projectVerifiedSourceDuration(projectedScene, 0.09)).toBe(projectedScene);
  });

  it("projects a shorter verified runtime as a safe source prefix", () => {
    const imported = workspaceScene("First", null);
    const [entityId, entity] = Object.entries(imported.runtimeSceneState.objectGraph.entities)[0]!;
    const futureEntityId = "source:scene.py#First:future";
    const sourceScene = {
      ...imported,
      anchors: [0, 2, 3, 4, 14],
      runtimeSceneState: {
        ...imported.runtimeSceneState,
        duration: 14,
        eventTrack: {
          events: [
            { at: 2, id: "before", kind: "wait", label: "Before verified end" },
            { id: "crossing", interval: { end: 5, start: 2 }, kind: "play", label: "Crossing verified end" },
            { at: 4, id: "future", kind: "wait", label: "After verified end" },
          ],
        },
        objectGraph: {
          entities: {
            [entityId]: { ...entity, lifetime: [{ end: 14, start: 0 }] },
            [futureEntityId]: { ...entity, id: futureEntityId, lifetime: [{ end: 14, start: 4 }] },
          },
          lineage: [
            { at: 2, from: entityId, operationId: "before", relation: "created", to: entityId },
            { at: 4, from: entityId, operationId: "future", relation: "created", to: futureEntityId },
          ],
        },
        propertyChannels: {
          [`${entityId}/position`]: {
            entityId,
            key: "position",
            samples: [
              {
                interval: { end: 14, start: 0 },
                kind: "exact",
                provenanceId: "imported-position",
                value: { x: 0, y: 0 },
              },
            ],
          },
          [`${futureEntityId}/position`]: {
            entityId: futureEntityId,
            key: "position",
            samples: [
              {
                interval: { end: 14, start: 4 },
                kind: "exact",
                provenanceId: "future-position",
                value: { x: 1, y: 1 },
              },
            ],
          },
        },
      },
    } satisfies ManimWorkspaceScene;

    const projected = projectVerifiedSourceDuration(sourceScene, 3);

    expect(projected.runtimeSceneState.duration).toBe(3);
    expect(projected.anchors).toEqual([0, 2, 3]);
    expect(projected.runtimeSceneState.objectGraph.entities[entityId]?.lifetime).toEqual([{ end: 3, start: 0 }]);
    expect(projected.runtimeSceneState.objectGraph.entities[futureEntityId]?.lifetime).toEqual([]);
    expect(projected.runtimeSceneState.eventTrack.events).toEqual([
      { at: 2, id: "before", kind: "wait", label: "Before verified end" },
      { id: "crossing", interval: { end: 3, start: 2 }, kind: "play", label: "Crossing verified end" },
    ]);
    expect(projected.runtimeSceneState.objectGraph.lineage.map(({ at }) => at)).toEqual([2]);
    expect(projected.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples[0]?.interval).toEqual({
      end: 3,
      start: 0,
    });
    expect(projected.runtimeSceneState.propertyChannels[`${futureEntityId}/position`]?.samples).toEqual([]);
    expect(sourceScene.runtimeSceneState.duration).toBe(14);
    expect(sourceScene.runtimeSceneState.objectGraph.entities[futureEntityId]?.lifetime).toEqual([
      { end: 14, start: 4 },
    ]);
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
    const operation = edit.program.operations[0]!;
    const workingInterval = operation.interval;

    const projected = projectStudioWorkspace({
      activeScene: projectVerifiedSourceDuration(imported, 1),
      appliedPrograms: [programRecord(edit.program, edit)],
      currentTime: 1.25,
      draftProgram: null,
      nextScene: null,
      selectedObjectIds: [],
      timelineProjection: {
        programProjections: [
          {
            operationId: operation.id,
            transactionId: edit.program.transactionId,
            workingAnchor: workingInterval.start,
            workingInterval,
          },
        ],
        projectedDuration: 1.5,
        transforms: [{ interval: workingInterval, kind: "insert", operationId: operation.id }],
      },
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
