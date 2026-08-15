import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type { StudioMathTexTransformProjectionV1, StudioStaticRootProjectionV1 } from "../engine/scene-authoring";
import { importManimScene } from "../render-pipeline/source-import";
import { createInspectorEntityEditProgram, createSceneDurationProgram } from "./authoring-commands";
import { validateSuggestionDraft } from "./draft-validation";
import {
  canResolveSourceDurationMismatch,
  clampPlayheadToResolvedSourceDuration,
  resolveVerifiedSourceDurationBasis,
} from "./editor-revision-policy";
import { evaluateWorkingState, programRecord } from "./evaluator";
import { importedWorkingState, type ManimWorkspaceScene, projectVerifiedSourceDuration } from "./imported-workspace";
import type { Interval } from "./model";
import type { CanonicalEditProgram } from "./operations";
import { createDirectManipulationPositionProgram, createDirectManipulationScaleProgram } from "./suggestion-program";
import {
  projectStudioWorkspace,
  selectMathTexTransformProjection,
  selectStaticRootProjection,
  selectStudioWorkspaceProgramAuthority,
} from "./workspace-projection";

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

class MathFormula(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        self.wait(1)
`;

function workspaceScene(
  name: "First" | "MathFormula" | "Second" | "Static",
  nextSceneId: string | null,
): ManimWorkspaceScene {
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

function mathTexTransformProgram(sourceEntityId: string): CanonicalEditProgram {
  const firstOperationId = "tx:math-transform/operation:a-to-b";
  const secondOperationId = "tx:math-transform/operation:b-to-a";
  const firstTargetId = "tx:math-transform/entity:b";
  return {
    anchor: {
      capturedPlayhead: 0.25,
      evidence: ["playhead:0.250"],
      resolvedSeconds: 0.25,
      source: { kind: "playhead", referenceSeconds: 0.25 },
    },
    intentCount: 2,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        id: firstOperationId,
        interval: { end: 0.5, start: 0.25 },
        kind: "TransformContent",
        provenance: { evidence: ["A to B"], origin: "remote-model" },
        replacement: { displayLines: ["B"], label: "middle", texParts: ["B"] },
        sourceEntityId,
        strategy: "transform-matching-tex",
        targetEntityId: firstTargetId,
      },
      {
        dependsOn: [firstOperationId],
        id: secondOperationId,
        interval: { end: 0.75, start: 0.5 },
        kind: "TransformContent",
        provenance: { evidence: ["B to A"], origin: "remote-model" },
        replacement: { displayLines: ["A"], label: "final", texParts: ["A"] },
        sourceEntityId: firstTargetId,
        strategy: "transform-matching-tex",
        targetEntityId: "tx:math-transform/entity:a-prime",
        targetType: "MathTex",
      },
    ],
    provenance: { evidence: ["fixture"], origin: "remote-model" },
    requestedExecution: "sequence",
    schedule: {
      edges: [
        { from: firstOperationId, reason: "explicit", to: secondOperationId },
        { from: firstOperationId, reason: "identity", to: secondOperationId },
      ],
      mode: "sequence",
      order: [firstOperationId, secondOperationId],
    },
    transactionId: "math-transform",
    version: 1,
  };
}

function mathTexTransformProjection(
  program: CanonicalEditProgram,
  baseDuration: number,
): StudioMathTexTransformProjectionV1 {
  const [first, second] = program.operations;
  if (first?.kind !== "TransformContent" || second?.kind !== "TransformContent") {
    throw new Error("Expected a two-step MathTex transform fixture.");
  }
  return {
    insertions: [{ at: 0.3, duration: 0.5, transactionId: program.transactionId }],
    projectedDuration: baseDuration + 0.5,
    replacements: [
      {
        content: first.replacement as StudioMathTexTransformProjectionV1["replacements"][number]["content"],
        interval: { end: 0.55, start: 0.3 },
        operationId: first.id,
        sourceEntityId: first.sourceEntityId,
        targetEntityId: first.targetEntityId,
        targetLifetime: { end: 0.8, start: 0.3 },
        targetType: "math-tex",
        transactionId: program.transactionId,
      },
      {
        content: second.replacement as StudioMathTexTransformProjectionV1["replacements"][number]["content"],
        interval: { end: 0.8, start: 0.55 },
        operationId: second.id,
        sourceEntityId: second.sourceEntityId,
        targetEntityId: second.targetEntityId,
        targetLifetime: { end: baseDuration + 0.5, start: 0.55 },
        targetType: "math-tex",
        transactionId: program.transactionId,
      },
    ],
  };
}

describe("Studio workspace projection", () => {
  it("waits for exact Rust authority for non-timeline Program batches", () => {
    const imported = workspaceScene("Static", null);
    const [entityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!entityId) throw new Error("Static fixture has no entity.");
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 20, y: -10 },
      positions: { [entityId]: { x: 400, y: 225 } },
      scene: imported.runtimeSceneState,
      start: 0,
      targetEntityIds: [entityId],
      transactionId: "authority-target",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
    const record = programRecord(validation.program, validation);

    expect(selectStudioWorkspaceProgramAuthority([record], [record], null)).toBeUndefined();
    expect(selectStudioWorkspaceProgramAuthority([record], [record], "static-imported-root")).toBe(
      "static-imported-root",
    );
    expect(selectStudioWorkspaceProgramAuthority([record], [record], "source-bound-endpoint")).toBe(
      "source-bound-endpoint",
    );
    expect(selectStudioWorkspaceProgramAuthority([record], [], "rust-authorized-batch")).toBeUndefined();
    expect(selectStudioWorkspaceProgramAuthority([{ ...record }], [record], "rust-authorized-batch")).toBeUndefined();
    expect(selectStudioWorkspaceProgramAuthority([], [record], "rust-authorized-batch")).toBeNull();

    const wait = createSceneDurationProgram({
      capturedPlayhead: imported.runtimeSceneState.duration,
      scene: imported.runtimeSceneState,
      sourceAnchor: imported.runtimeSceneState.duration,
      targetDuration: imported.runtimeSceneState.duration + 1,
      transactionId: "timeline-prefix",
    });
    if (wait.kind !== "valid") throw new Error(JSON.stringify(wait.issues));
    const timelineRecord = programRecord(wait.program, wait);
    expect(selectStudioWorkspaceProgramAuthority([timelineRecord], [record], "rust-authorized-batch")).toBeNull();
  });

  it("requires and mechanically applies Rust's static-root scale projection", () => {
    const imported = workspaceScene("Static", null);
    const base = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: [],
      currentTime: 0,
      draftProgram: null,
      nextScene: null,
      selectedObjectIds: [],
    });
    const entity = base.projection.canvas.entities[0];
    if (!entity) throw new Error("Static fixture has no entity.");
    const scale = createDirectManipulationScaleProgram({
      capturedPlayhead: 0,
      interval: { end: 0, start: 0 },
      scales: { [entity.id]: { from: entity.scale, to: 2 } },
      scene: imported.runtimeSceneState,
      targetEntityIds: [entity.id],
      transactionId: "authorized-scale",
    });
    if (scale.kind !== "valid") throw new Error(JSON.stringify(scale.issues));
    const rebased = {
      ...imported,
      runtimeSceneState: {
        ...imported.runtimeSceneState,
        propertyChannels: {
          ...imported.runtimeSceneState.propertyChannels,
          [`${entity.id}/scale`]: {
            entityId: entity.id,
            key: "scale" as const,
            samples: [
              {
                interval: { end: imported.runtimeSceneState.duration, start: 0 },
                kind: "exact" as const,
                provenanceId: "rebased-scale",
                value: 3,
              },
            ],
          },
        },
      },
    } satisfies ManimWorkspaceScene;
    const record = programRecord(scale.program, scale);
    const operation = scale.program.operations[0];
    if (operation?.kind !== "AnimateProperty") throw new Error("Expected a scale operation.");
    const staticRootProjection: StudioStaticRootProjectionV1 = {
      mutations: [
        {
          entityId: entity.id,
          from: 3,
          interval: operation.interval,
          kind: "uniform-scale",
          operationId: operation.id,
          to: 7,
          transactionId: scale.program.transactionId,
        },
      ],
    };
    const project = (projection?: StudioStaticRootProjectionV1) =>
      projectStudioWorkspace({
        activeScene: rebased,
        appliedPrograms: [record],
        currentTime: rebased.runtimeSceneState.duration,
        draftProgram: null,
        nextScene: null,
        programAuthority: "static-imported-root",
        selectedObjectIds: [],
        staticRootProjection: projection,
      }).projection.canvas.entities[0]?.scale;

    expect(() => project()).toThrow("A Rust static-root projection is required");
    expect(project(staticRootProjection)).toBe(7);
    expect(
      projectStudioWorkspace({
        activeScene: rebased,
        appliedPrograms: [record],
        currentTime: rebased.runtimeSceneState.duration,
        draftProgram: null,
        nextScene: null,
        programAuthority: "source-bound-endpoint",
        selectedObjectIds: [],
      }).projection.canvas.entities[0]?.scale,
    ).toBe(6);
    expect(() =>
      selectStaticRootProjection([scale.program], {
        mutations: [{ ...staticRootProjection.mutations[0]!, transactionId: "stale-transaction" }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      project({
        mutations: [{ ...staticRootProjection.mutations[0]!, entityId: "source:missing" }],
      }),
    ).toThrow("is not in the imported Scene");
  });

  it("projects Rust-authorized MathTex content in source chronology", () => {
    const imported = workspaceScene("MathFormula", null);
    const initial = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: [],
      currentTime: 0,
      draftProgram: null,
      nextScene: null,
      selectedObjectIds: [],
    });
    const entity = initial.projection.canvas.entities[0];
    if (!entity) throw new Error("MathTex fixture has no entity.");
    const baseContent = { displayLines: ["E = mc^2"], label: "E = mc^2", texParts: ["E = mc^2"] } as const;
    const studioContent = { displayLines: ["F = ma"], label: "Force", texParts: ["F", "=", "ma"] } as const;
    const futureContent = { displayLines: ["a^2 + b^2 = c^2"], texParts: ["a^2 + b^2 = c^2"] } as const;
    const rebased = {
      ...imported,
      runtimeSceneState: {
        ...imported.runtimeSceneState,
        propertyChannels: {
          ...imported.runtimeSceneState.propertyChannels,
          [`${entity.id}/content`]: {
            entityId: entity.id,
            key: "content" as const,
            samples: [
              {
                interval: { end: imported.runtimeSceneState.duration, start: 0 },
                kind: "exact" as const,
                provenanceId: "imported-base-content",
                value: baseContent,
              },
              {
                interval: { end: 0.5, start: 0.5 },
                kind: "exact" as const,
                provenanceId: "imported-future-content",
                value: futureContent,
              },
            ],
          },
        },
      },
    } satisfies ManimWorkspaceScene;
    const edit = createInspectorEntityEditProgram({
      capturedPlayhead: 0,
      edits: { content: studioContent },
      entityId: entity.id,
      from: { position: entity.position, scale: entity.scale },
      scene: rebased.runtimeSceneState,
      transactionId: "replace-imported-mathtex-content",
    });
    if (edit.kind !== "valid") throw new Error(JSON.stringify(edit.issues));
    const operation = edit.program.operations[0];
    if (operation?.kind !== "SetProperty" || operation.key !== "content") {
      throw new Error("Expected one MathTex content operation.");
    }
    const staticRootProjection = {
      mutations: [
        {
          content: studioContent,
          entityId: entity.id,
          interval: operation.interval,
          kind: "math-tex-content",
          operationId: operation.id,
          transactionId: edit.program.transactionId,
        },
      ],
    } satisfies StudioStaticRootProjectionV1;
    const mutation = staticRootProjection.mutations[0];
    expect(() =>
      selectStaticRootProjection([edit.program], {
        mutations: [{ ...mutation, content: { ...studioContent, texParts: ["wrong"] } }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      selectStaticRootProjection([edit.program], {
        mutations: [{ ...mutation, interval: { end: 0.25, start: 0 } }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      selectStaticRootProjection([edit.program], {
        mutations: [{ ...mutation, entityId: "source:other" }],
      }),
    ).toThrow("is not correlated");
    const projected = projectStudioWorkspace({
      activeScene: rebased,
      appliedPrograms: [programRecord(edit.program, edit)],
      currentTime: 0.75,
      draftProgram: null,
      nextScene: null,
      programAuthority: "static-imported-root",
      selectedObjectIds: [],
      staticRootProjection,
    });

    expect(projected.projection.canvas.entities[0]?.content).toEqual(futureContent);
    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entity.id}/content`]?.samples.map(
        ({ operationId, provenanceId }) => operationId ?? provenanceId,
      ),
    ).toEqual(["imported-base-content", operation.id, "imported-future-content"]);
  });

  it("builds a two-step MathTex workspace from Rust projection facts without recomputing their timing", () => {
    const imported = workspaceScene("MathFormula", null);
    const [sourceEntityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!sourceEntityId) throw new Error("MathTex fixture has no entity.");
    const program = mathTexTransformProgram(sourceEntityId);
    const projection = mathTexTransformProjection(program, imported.runtimeSceneState.duration);
    const [first, second] = projection.replacements;
    if (!first || !second) throw new Error("Expected two projected replacements.");

    const singleProgram: CanonicalEditProgram = {
      ...program,
      intentCount: 1,
      operations: [program.operations[0]!],
      schedule: { edges: [], mode: "sequence", order: [program.operations[0]!.id] },
    };
    const singleProjection: StudioMathTexTransformProjectionV1 = {
      insertions: [{ at: first.interval.start, duration: 0.25, transactionId: program.transactionId }],
      projectedDuration: imported.runtimeSceneState.duration + 0.25,
      replacements: [
        {
          ...first,
          targetLifetime: { end: imported.runtimeSceneState.duration + 0.25, start: first.interval.start },
        },
      ],
    };
    expect(
      projectStudioWorkspace({
        activeScene: imported,
        appliedPrograms: [programRecord(singleProgram, { issues: [], kind: "valid" })],
        currentTime: first.interval.end + 0.01,
        draftProgram: null,
        mathTexTransformProjection: singleProjection,
        nextScene: null,
        programAuthority: "rust-authorized-batch",
        selectedObjectIds: [],
      }).projection.inspector.entities.find(({ id }) => id === first.targetEntityId)?.content,
    ).toEqual(first.content);

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: [programRecord(program, { issues: [], kind: "valid" })],
      currentTime: 0.9,
      draftProgram: null,
      mathTexTransformProjection: projection,
      nextScene: null,
      programAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });

    expect(projected.proposedState.evaluatedScene.duration).toBe(projection.projectedDuration);
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[sourceEntityId]?.lifetime).toEqual([
      { end: first.interval.end, start: 0 },
    ]);
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[first.targetEntityId]).toMatchObject({
      content: first.content,
      lifetime: [first.targetLifetime],
      provisional: false,
      type: "MathTex",
    });
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[second.targetEntityId]).toMatchObject({
      content: second.content,
      lifetime: [second.targetLifetime],
      provisional: false,
      type: "MathTex",
    });
    expect(projected.proposedState.evaluatedScene.objectGraph.lineage.slice(-2)).toEqual([
      {
        at: first.interval.end,
        from: first.sourceEntityId,
        operationId: first.operationId,
        relation: "replaces",
        to: first.targetEntityId,
      },
      {
        at: second.interval.end,
        from: second.sourceEntityId,
        operationId: second.operationId,
        relation: "replaces",
        to: second.targetEntityId,
      },
    ]);
    expect(
      projected.proposedState.evaluatedScene.eventTrack.events
        .filter(({ operationId }) => operationId === first.operationId || operationId === second.operationId)
        .map(({ interval }) => interval),
    ).toEqual([first.interval, second.interval]);
    expect(projected.projection.inspector.entities.find(({ id }) => id === second.targetEntityId)?.content).toEqual(
      second.content,
    );
    expect(projected.projection.objectList.entities.find(({ id }) => id === second.targetEntityId)?.present).toBe(true);
    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${second.targetEntityId}/appearance`]?.samples.map(
        ({ interval, value }) => ({ interval, value }),
      ),
    ).toEqual([
      { interval: first.interval, value: 1 },
      { interval: second.interval, value: 1 },
    ]);
  });

  it("fails closed for a missing, duplicate, or mismatched MathTex transform projection", () => {
    const imported = workspaceScene("MathFormula", null);
    const [sourceEntityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!sourceEntityId) throw new Error("MathTex fixture has no entity.");
    const program = mathTexTransformProgram(sourceEntityId);
    const projection = mathTexTransformProjection(program, imported.runtimeSceneState.duration);
    const record = programRecord(program, { issues: [], kind: "valid" });
    const project = (candidate?: StudioMathTexTransformProjectionV1) =>
      projectStudioWorkspace({
        activeScene: imported,
        appliedPrograms: [record],
        currentTime: 0.9,
        draftProgram: null,
        mathTexTransformProjection: candidate,
        nextScene: null,
        programAuthority: "rust-authorized-batch",
        selectedObjectIds: [],
      });

    expect(() => project()).toThrow("A Rust MathTex transform projection is required");
    expect(() =>
      selectMathTexTransformProjection(imported.runtimeSceneState.duration, [program], {
        ...projection,
        replacements: [projection.replacements[0]!, projection.replacements[0]!],
      }),
    ).toThrow("one unique result");
    expect(() =>
      selectMathTexTransformProjection(imported.runtimeSceneState.duration, [program], {
        ...projection,
        replacements: [
          { ...projection.replacements[0]!, content: { displayLines: ["stale"], texParts: ["stale"] } },
          projection.replacements[1]!,
        ],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      selectMathTexTransformProjection(imported.runtimeSceneState.duration, [program], {
        ...projection,
        projectedDuration: projection.projectedDuration + 1,
      }),
    ).toThrow("stale projected duration");
  });

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
