import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type {
  StudioCreationProjectionV1,
  StudioMathTexTransformProjectionV1,
  StudioMotionProjectionV1,
  StudioPersistentRemoveProjectionV1,
  StudioStaticRootProjectionV1,
} from "../engine/scene-authoring";
import { importManimScene } from "../render-pipeline/source-import";
import {
  createInspectorEntityEditProgram,
  createRemoveEntitiesProgram,
  createSceneDurationProgram,
} from "./authoring-commands";
import {
  canResolveSourceDurationMismatch,
  clampPlayheadToResolvedSourceDuration,
  resolveVerifiedSourceDurationBasis,
} from "./editor-revision-policy";
import { programRecord } from "./evaluator";
import { type ManimWorkspaceScene, projectVerifiedSourceDuration } from "./imported-workspace";
import type { Interval } from "./model";
import type { CanonicalEditProgram } from "./operations";
import { buildStudioCreationProjectionCommand } from "./scene-authoring-wire";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationScaleProgram,
} from "./suggestion-program";
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
    insertions: [{ at: 0.25, duration: 0.5, transactionId: program.transactionId }],
    motions: [],
    projectedDuration: baseDuration + 0.5,
    replacements: [
      {
        content: first.replacement as StudioMathTexTransformProjectionV1["replacements"][number]["content"],
        interval: { end: 0.5, start: 0.25 },
        operationId: first.id,
        sourceEntityId: first.sourceEntityId,
        targetEntityId: first.targetEntityId,
        targetLifetime: { end: 0.75, start: 0.25 },
        targetType: "math-tex",
        transactionId: program.transactionId,
      },
      {
        content: second.replacement as StudioMathTexTransformProjectionV1["replacements"][number]["content"],
        interval: { end: 0.75, start: 0.5 },
        operationId: second.id,
        sourceEntityId: second.sourceEntityId,
        targetEntityId: second.targetEntityId,
        targetLifetime: { end: baseDuration + 0.5, start: 0.5 },
        targetType: "math-tex",
        transactionId: program.transactionId,
      },
    ],
  };
}

function mathTexTransformMotionFixture(sourceEntityId: string, splitMotionProgram: boolean, baseDuration: number) {
  const transformProgram = mathTexTransformProgram(sourceEntityId);
  const finalTarget = transformProgram.operations[1];
  if (finalTarget?.kind !== "TransformContent") throw new Error("Expected a final MathTex transform target.");
  const motion = {
    controlOffset: { x: 10, y: 5 },
    delta: { x: 40, y: -20 },
    dependsOn: splitMotionProgram ? [] : [finalTarget.id],
    easing: "smooth" as const,
    id: "tx:math-transform/operation:move-final",
    interval: { end: 1, start: 0.75 },
    kind: "CreateMotion" as const,
    provenance: { evidence: ["move final"], origin: "remote-model" as const },
    targetEntityIds: [finalTarget.targetEntityId],
  };
  const motionProgram: CanonicalEditProgram = {
    anchor: {
      capturedPlayhead: 0.75,
      evidence: ["playhead:0.750"],
      resolvedSeconds: 0.75,
      source: { kind: "playhead", referenceSeconds: 0.75 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [motion],
    provenance: { evidence: ["fixture"], origin: "remote-model" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [motion.id] },
    transactionId: "math-motion",
    version: 1,
  };
  const programs: readonly CanonicalEditProgram[] = splitMotionProgram
    ? [transformProgram, motionProgram]
    : [
        {
          ...transformProgram,
          intentCount: 3,
          operations: [...transformProgram.operations, motion],
          schedule: {
            edges: [
              ...transformProgram.schedule.edges,
              { from: finalTarget.id, reason: "explicit" as const, to: motion.id },
              { from: finalTarget.id, reason: "identity" as const, to: motion.id },
            ],
            mode: "sequence",
            order: [...transformProgram.schedule.order, motion.id],
          },
        },
      ];
  const transformProjection = mathTexTransformProjection(transformProgram, baseDuration);
  const resolvedMotionInterval = splitMotionProgram ? { end: 1.5, start: 1.25 } : { end: 1, start: 0.75 };
  const projectedDuration = baseDuration + 0.75;
  const projection: StudioMathTexTransformProjectionV1 = {
    ...transformProjection,
    insertions: splitMotionProgram
      ? [...transformProjection.insertions, { at: 1.25, duration: 0.25, transactionId: motionProgram.transactionId }]
      : [{ at: 0.25, duration: 0.75, transactionId: transformProgram.transactionId }],
    motions: [
      {
        control: { x: 350, y: 175 },
        controlOffset: motion.controlOffset,
        delta: motion.delta,
        easing: motion.easing,
        from: { x: 320, y: 180 },
        interval: resolvedMotionInterval,
        operationId: motion.id,
        sourceInterval: motion.interval,
        targetEntityId: finalTarget.targetEntityId,
        to: { x: 360, y: 160 },
        transactionId: splitMotionProgram ? motionProgram.transactionId : transformProgram.transactionId,
      },
    ],
    projectedDuration,
    replacements: transformProjection.replacements.map((replacement, index, replacements) =>
      index === replacements.length - 1
        ? { ...replacement, targetLifetime: { ...replacement.targetLifetime, end: projectedDuration } }
        : replacement,
    ),
  };
  return { motion, programs, projection };
}

describe("Studio workspace projection", () => {
  it("installs one standalone motion only from correlated Rust facts", () => {
    const imported = workspaceScene("First", null);
    const [entityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!entityId) throw new Error("Static fixture has no entity.");
    const program: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          dependsOn: [],
          easing: "smooth",
          id: "motion/standalone",
          interval: { end: 2, start: 1 },
          kind: "CreateMotion",
          provenance: { evidence: [], origin: "direct-manipulation" },
          targetEntityIds: [entityId],
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["motion/standalone"] },
      transactionId: "motion",
      version: 1,
    };
    const projection: StudioMotionProjectionV1 = {
      insertions: [{ at: 1, duration: 1, transactionId: program.transactionId }],
      motions: [
        {
          control: { x: 350, y: 175 },
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          easing: "smooth",
          from: { x: 320, y: 180 },
          interval: { end: 2, start: 1 },
          operationId: "motion/standalone",
          sourceInterval: { end: 2, start: 1 },
          targetEntityId: entityId,
          to: { x: 360, y: 160 },
          transactionId: program.transactionId,
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 1,
    };

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: [programRecord(program, { issues: [], kind: "valid" })],
      currentTime: 2,
      draftProgram: null,
      motionProjection: projection,
      nextScene: null,
      programAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });

    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples.at(-1),
    ).toMatchObject({
      control: projection.motions[0]?.control,
      from: projection.motions[0]?.from,
      value: projection.motions[0]?.to,
    });
  });

  it("installs a Studio-created Line and its follow-up motion from the same Rust projection", () => {
    const imported = workspaceScene("First", null);
    const entityId = "tx:create/entity:line";
    const creationProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 3,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entity: { id: entityId, lifetime: { end: null, start: 0 }, type: "Line" },
          id: "create/line",
          interval: { end: 0, start: 0 },
          kind: "CreateEntity",
          provenance: { evidence: [], origin: "studio-default" },
        },
        {
          dependsOn: ["create/line"],
          entityId,
          id: "create/position",
          interval: { end: 0, start: 0 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "studio-default" },
          value: { x: 100, y: 120 },
        },
        {
          dependsOn: ["create/position"],
          effect: "fade-in",
          entityId,
          id: "create/fade",
          interval: { end: 0.4, start: 0 },
          kind: "ChangePresence",
          persistent: true,
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: {
        edges: [
          { from: "create/line", reason: "explicit", to: "create/position" },
          { from: "create/position", reason: "explicit", to: "create/fade" },
        ],
        mode: "sequence",
        order: ["create/line", "create/position", "create/fade"],
      },
      transactionId: "create",
      version: 1,
    };
    const motionProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          controlOffset: { x: 0, y: 10 },
          delta: { x: 50, y: 20 },
          dependsOn: [],
          easing: "smooth",
          id: "create/motion",
          interval: { end: 1, start: 0 },
          kind: "CreateMotion",
          provenance: { evidence: [], origin: "direct-manipulation" },
          targetEntityIds: [entityId],
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["create/motion"] },
      transactionId: "motion-created",
      version: 1,
    };
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: imported.runtimeSceneState.duration + 1.4, start: 0 },
          entityId,
          initialDimensions: {},
          initialScale: 1,
          kind: "line",
          operationId: "create/line",
          transactionId: creationProgram.transactionId,
        },
      ],
      insertions: [
        { at: 0, duration: 0.4, transactionId: creationProgram.transactionId },
        { at: 0.4, duration: 1, transactionId: motionProgram.transactionId },
      ],
      motions: [
        {
          control: { x: 125, y: 140 },
          controlOffset: { x: 0, y: 10 },
          delta: { x: 50, y: 20 },
          easing: "smooth",
          from: { x: 100, y: 120 },
          interval: { end: 1.4, start: 0.4 },
          operationId: "create/motion",
          sourceInterval: { end: 1, start: 0 },
          targetEntityId: entityId,
          to: { x: 150, y: 140 },
          transactionId: motionProgram.transactionId,
        },
      ],
      mutations: [
        {
          entityId,
          interval: { end: 0, start: 0 },
          kind: "position",
          operationId: "create/position",
          transactionId: creationProgram.transactionId,
          value: { x: 100, y: 120 },
        },
        {
          entityId,
          from: 0,
          interval: { end: 0.4, start: 0 },
          kind: "fade-in",
          operationId: "create/fade",
          to: 1,
          transactionId: creationProgram.transactionId,
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 1.4,
      removals: [
        {
          affectedSceneEntityIds: [entityId],
          fadeInterval: { end: 2.7, start: 2.5 },
          operationId: "create/remove",
          removedAt: 2.7,
          resultingLifetimeEnd: 2.7,
          sceneEntityId: entityId,
          studioEntityId: entityId,
          transactionId: "remove-created",
        },
      ],
    };
    const removeProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 1.1,
        evidence: [],
        resolvedSeconds: 1.1,
        source: { kind: "absolute", seconds: 1.1 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          effect: "remove",
          entityId,
          id: "create/remove",
          interval: { end: 1.3, start: 1.1 },
          kind: "ChangePresence",
          persistent: true,
          provenance: { evidence: [], origin: "direct-manipulation" },
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["create/remove"] },
      transactionId: "remove-created",
      version: 1,
    };
    expect(
      buildStudioCreationProjectionCommand({
        baseDuration: imported.runtimeSceneState.duration,
        programs: [creationProgram, motionProgram, removeProgram],
      }).programs[0]?.operations[0],
    ).toMatchObject({ entity: { dimensions: {}, kind: "line" }, kind: "create" });
    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: [
        programRecord(creationProgram, { issues: [], kind: "valid" }),
        programRecord(motionProgram, { issues: [], kind: "valid" }),
        programRecord(removeProgram, { issues: [], kind: "valid" }),
      ],
      creationProjection: projection,
      currentTime: 1,
      draftProgram: null,
      nextScene: null,
      programAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });

    expect(projected.proposedState.evaluatedScene.duration).toBe(projection.projectedDuration);
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[entityId]).toBeDefined();
    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples.at(-1),
    ).toMatchObject({
      control: projection.motions[0]?.control,
      from: projection.motions[0]?.from,
      value: projection.motions[0]?.to,
    });
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[entityId]?.lifetime).toEqual([
      { end: 2.7, start: 0 },
    ]);
  });

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

  it("requires and mechanically composes Rust's static-root and persistent-remove projections", () => {
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
        duration: 2,
        objectGraph: {
          ...imported.runtimeSceneState.objectGraph,
          entities: {
            ...imported.runtimeSceneState.objectGraph.entities,
            [entity.id]: {
              ...imported.runtimeSceneState.objectGraph.entities[entity.id]!,
              lifetime: [{ end: 2, start: 0 }],
            },
          },
        },
        propertyChannels: {
          ...imported.runtimeSceneState.propertyChannels,
          [`${entity.id}/scale`]: {
            entityId: entity.id,
            key: "scale" as const,
            samples: [
              {
                interval: { end: 2, start: 0 },
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
      insertions: [],
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
      projectedDuration: rebased.runtimeSceneState.duration,
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
    const removal = createRemoveEntitiesProgram({
      capturedPlayhead: 1,
      entityIds: [entity.id],
      scene: rebased.runtimeSceneState,
      transactionId: "authorized-remove",
    });
    if (removal.kind !== "valid") throw new Error(JSON.stringify(removal.issues));
    const removeOperation = removal.program.operations[0];
    if (removeOperation?.kind !== "ChangePresence") throw new Error("Expected a persistent remove operation.");
    const removeRecord = programRecord(removal.program, removal);
    const persistentRemoveProjection: StudioPersistentRemoveProjectionV1 = {
      removals: [
        {
          affectedSceneEntityIds: [entity.id],
          fadeInterval: removeOperation.interval,
          operationId: removeOperation.id,
          removedAt: removeOperation.interval.end,
          resultingLifetimeEnd: removeOperation.interval.end,
          sceneEntityId: entity.id,
          studioEntityId: entity.id,
          transactionId: removal.program.transactionId,
        },
      ],
    };
    const combined = projectStudioWorkspace({
      activeScene: rebased,
      appliedPrograms: [record, removeRecord],
      currentTime: 1.5,
      draftProgram: null,
      nextScene: null,
      persistentRemoveProjection,
      programAuthority: "static-imported-root",
      selectedObjectIds: [],
      staticRootProjection,
    });
    expect(combined.projection.canvas.entities[0]).toMatchObject({ opacity: 0, present: false, scale: 7 });
    expect(combined.proposedState.evaluatedScene.objectGraph.entities[entity.id]?.lifetime).toEqual([
      { end: removeOperation.interval.end, start: 0 },
    ]);
    expect(combined.proposedState.evaluatedScene.objectGraph.lineage.at(-1)).toMatchObject({
      operationId: removeOperation.id,
      relation: "removed",
    });

    const magicOperation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 0.5 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 1,
          factor: 1.5,
          kind: "scale-objects",
          start: 0.5,
          targetObjectIds: [entity.id],
        },
        {
          animation: "fade-out",
          end: 1.4,
          kind: "delete-objects",
          start: 1,
          targetObjectIds: [entity.id],
        },
      ],
    };
    const magic = canonicalizeSuggestionProgram(magicOperation, {
      capturedPlayhead: 0.5,
      origin: "remote-model",
      scene: rebased.runtimeSceneState,
      transactionId: "magic-scale-remove",
    });
    if (magic.kind !== "valid") throw new Error(JSON.stringify(magic.issues));
    const [magicScale, magicRemove] = magic.program.operations;
    if (
      magicScale?.kind !== "AnimateProperty" ||
      magicScale.key !== "scale" ||
      typeof magicScale.from !== "number" ||
      typeof magicScale.to !== "number" ||
      magicRemove?.kind !== "ChangePresence"
    ) {
      throw new Error("Expected an animated scale followed by persistent remove.");
    }
    const magicStaticProjection: StudioStaticRootProjectionV1 = {
      insertions: [{ at: 0.5, duration: 0.9, transactionId: magic.program.transactionId }],
      mutations: [
        {
          easing: "manim-smooth",
          entityId: entity.id,
          from: magicScale.from,
          interval: magicScale.interval,
          kind: "uniform-scale",
          operationId: magicScale.id,
          to: magicScale.to,
          transactionId: magic.program.transactionId,
        },
      ],
      projectedDuration: 2.9,
    };
    const magicRemoveProjection: StudioPersistentRemoveProjectionV1 = {
      removals: [
        {
          affectedSceneEntityIds: [entity.id],
          fadeInterval: magicRemove.interval,
          operationId: magicRemove.id,
          removedAt: magicRemove.interval.end,
          resultingLifetimeEnd: magicRemove.interval.end,
          sceneEntityId: entity.id,
          studioEntityId: entity.id,
          transactionId: magic.program.transactionId,
        },
      ],
    };
    const projectMagicAt = (currentTime: number) =>
      projectStudioWorkspace({
        activeScene: rebased,
        appliedPrograms: [programRecord(magic.program, magic)],
        currentTime,
        draftProgram: null,
        nextScene: null,
        persistentRemoveProjection: magicRemoveProjection,
        programAuthority: "static-imported-root",
        selectedObjectIds: [],
        staticRootProjection: magicStaticProjection,
      });
    expect(projectMagicAt(0.625).projection.canvas.entities[0]?.scale).toBeCloseTo(3.105155574817662);
    expect(projectMagicAt(0.75).projection.canvas.entities[0]?.scale).toBeCloseTo(3.75);
    expect(projectMagicAt(1.2).projection.canvas.entities[0]?.opacity).toBeCloseTo(0.5);
    const removed = projectMagicAt(1.4);
    expect(removed.projection.canvas.entities[0]).toMatchObject({ opacity: 0, present: false, scale: 4.5 });
    expect(removed.proposedState.evaluatedScene.duration).toBeCloseTo(2.9);
    expect(removed.proposedState.evaluatedScene.objectGraph.entities[entity.id]?.lifetime).toEqual([
      { end: 1.4, start: 0 },
    ]);

    const pureRemoval = projectStudioWorkspace({
      activeScene: rebased,
      appliedPrograms: [removeRecord],
      currentTime: 1.5,
      draftProgram: null,
      nextScene: null,
      persistentRemoveProjection,
      programAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });
    expect(pureRemoval.projection.canvas.entities[0]).toMatchObject({ opacity: 0, present: false, scale: 3 });
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
        ...staticRootProjection,
        mutations: [{ ...staticRootProjection.mutations[0]!, transactionId: "stale-transaction" }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      project({
        ...staticRootProjection,
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
      insertions: [],
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
      projectedDuration: rebased.runtimeSceneState.duration,
    } satisfies StudioStaticRootProjectionV1;
    const mutation = staticRootProjection.mutations[0];
    expect(() =>
      selectStaticRootProjection([edit.program], {
        ...staticRootProjection,
        mutations: [{ ...mutation, content: { ...studioContent, texParts: ["wrong"] } }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      selectStaticRootProjection([edit.program], {
        ...staticRootProjection,
        mutations: [{ ...mutation, interval: { end: 0.25, start: 0 } }],
      }),
    ).toThrow("is not correlated");
    expect(() =>
      selectStaticRootProjection([edit.program], {
        ...staticRootProjection,
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
      motions: [],
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
      projected.proposedState.evaluatedScene.propertyChannels[`${first.targetEntityId}/content`]?.samples.at(-1)
        ?.interval,
    ).toEqual({ end: first.targetLifetime.end, start: first.interval.end });
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

  it.each([
    ["same Program", false],
    ["later Program", true],
  ] as const)("installs Rust-projected final-target motion from a %s", (_label, splitMotionProgram) => {
    const imported = workspaceScene("MathFormula", null);
    const [sourceEntityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!sourceEntityId) throw new Error("MathTex fixture has no entity.");
    const { motion, programs, projection } = mathTexTransformMotionFixture(
      sourceEntityId,
      splitMotionProgram,
      imported.runtimeSceneState.duration,
    );
    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedPrograms: programs.map((program) => programRecord(program, { issues: [], kind: "valid" })),
      currentTime: projection.motions[0]!.interval.end,
      draftProgram: null,
      mathTexTransformProjection: projection,
      nextScene: null,
      programAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });
    const projectedMotion = projection.motions[0]!;
    const samples =
      projected.proposedState.evaluatedScene.propertyChannels[`${projectedMotion.targetEntityId}/position`]?.samples;

    expect(samples?.at(-1)).toMatchObject({
      control: projectedMotion.control,
      easing: projectedMotion.easing,
      from: projectedMotion.from,
      interval: projectedMotion.interval,
      kind: "animated",
      operationId: motion.id,
      value: projectedMotion.to,
    });
    expect(
      projected.projection.canvas.entities.find(({ id }) => id === projectedMotion.targetEntityId)?.position,
    ).toEqual(projectedMotion.to);
  });

  it("rejects a stale Rust MathTex motion delta or control correlation", () => {
    const imported = workspaceScene("MathFormula", null);
    const [sourceEntityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!sourceEntityId) throw new Error("MathTex fixture has no entity.");
    const { programs, projection } = mathTexTransformMotionFixture(
      sourceEntityId,
      false,
      imported.runtimeSceneState.duration,
    );
    const select = (motion: StudioMathTexTransformProjectionV1["motions"][number]) =>
      selectMathTexTransformProjection(imported.runtimeSceneState.duration, programs, {
        ...projection,
        motions: [motion],
      });

    expect(() => select({ ...projection.motions[0]!, delta: { x: 41, y: -20 } })).toThrow("is not correlated");
    expect(() => select({ ...projection.motions[0]!, controlOffset: { x: 11, y: 5 } })).toThrow("is not correlated");
    expect(() => select({ ...projection.motions[0]!, sourceInterval: { end: 1.04, start: 0.79 } })).toThrow(
      "is not correlated",
    );
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
    const overlayId = "transition-overlay";
    const activeSceneWithBoundary: ManimWorkspaceScene = {
      ...activeScene,
      runtimeSceneState: {
        ...activeScene.runtimeSceneState,
        eventTrack: {
          events: [
            ...activeScene.runtimeSceneState.eventTrack.events,
            { at: 5, id: "scene-boundary", kind: "scene-boundary", label: "Next Scene" },
          ],
        },
        objectGraph: {
          ...activeScene.runtimeSceneState.objectGraph,
          entities: {
            ...activeScene.runtimeSceneState.objectGraph.entities,
            [overlayId]: {
              id: overlayId,
              lifetime: [{ end: 6.5, start: 5 }],
              provisional: false,
              sourceIdentity: { kind: "unknown", reason: "Transition overlay is a presentation fixture." },
              type: "TransitionOverlay:circle:sky",
            },
          },
        },
      },
    };

    const projected = projectStudioWorkspace({
      activeScene: activeSceneWithBoundary,
      appliedPrograms: [],
      currentTime: 6,
      draftProgram: null,
      nextScene,
      selectedObjectIds: [],
    });

    expect(projected.boundary).not.toBeNull();
    expect(projected.editableEntities).toEqual([]);
    expect(projected.visibleEntities.some((entity) => entity.type.startsWith("TransitionOverlay:"))).toBe(true);
  });
});
