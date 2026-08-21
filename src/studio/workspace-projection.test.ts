import { describe, expect, it } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type {
  StudioBoundEntityProjectionV1,
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
  createStudioEntitiesProgram,
} from "./authoring-commands";
import { createCameraProgram } from "./camera-clip-edit";
import { replaceDrawInProgram } from "./draw-in-edit";
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
  selectCreationProjection,
  selectCreationProjectionProgramPrefix,
  selectMathTexTransformProjection,
  selectMotionProjection,
  selectStaticRootProjection,
  selectStudioWorkspaceEditAuthority,
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
    importOutcomes: imported.importOutcomes,
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
        easing: motion.easing === "smooth" ? "manim-smooth" : "linear",
        from: { x: 320, y: 180 },
        interval: resolvedMotionInterval,
        operationId: motion.id,
        orientToPath: false,
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
  it("correlates regular-polygon dimensions and keeps them as known Studio geometry", () => {
    const imported = workspaceScene("First", null);
    const authored = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ dimensions: { radius: 1.5, sides: 7 }, position: { x: 320, y: 180 }, type: "RegularPolygon" }],
      scene: imported.runtimeSceneState,
      transactionId: "polygon-correlation",
    });
    const create = authored.validation.program.operations.find(({ kind }) => kind === "CreateEntity");
    if (create?.kind !== "CreateEntity") throw new Error("Regular polygon creation fixture is incomplete.");
    const program: CanonicalEditProgram = {
      ...authored.validation.program,
      intentCount: 1,
      operations: [create],
      schedule: { edges: [], mode: "parallel", order: [create.id] },
    };
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: imported.runtimeSceneState.duration, start: 0 },
          entityId: create.entity.id,
          initialDimensions: { radius: 1.5, sides: 7 },
          initialRotation: 0,
          initialScale: 1,
          kind: "regular-polygon",
          operationId: create.id,
          transactionId: program.transactionId,
        },
      ],
      insertions: [],
      motions: [],
      mutations: [],
      projectedDuration: imported.runtimeSceneState.duration,
      removals: [],
    };

    expect(selectCreationProjection(imported.runtimeSceneState.duration, [program], projection)).toBe(projection);
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [program], {
        ...projection,
        entities: [{ ...projection.entities[0]!, initialDimensions: { radius: 1.5, sides: 8 } }],
      }),
    ).toThrow(/not correlated/);

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      creationProjection: projection,
      currentTime: 0,
      draftEdit: null,
      editAuthority: "rust-authorized-batch",
      nextScene: null,
      selectedObjectIds: [create.entity.id],
    });
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[create.entity.id]?.geometry?.dimensions).toEqual(
      {
        kind: "known",
        value: { radius: 1.5, sides: 7 },
      },
    );
  });

  it("correlates Draw from its exact Rust interval and easing", () => {
    const imported = workspaceScene("First", null);
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ position: { x: 320, y: 180 }, type: "Line" }],
      scene: imported.runtimeSceneState,
      transactionId: "draw-correlation",
    });
    const entityId = creation.entityIds[0]!;
    const drawn = replaceDrawInProgram({
      baseProgram: creation.validation.program,
      draw: { easing: "smooth", end: 1 },
      entityId,
      scene: imported.runtimeSceneState,
    }).program;
    const create = drawn.operations.find((operation) => operation.kind === "CreateEntity");
    const position = drawn.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const draw = drawn.operations.find((operation) => operation.kind === "DrawIn");
    if (create?.kind !== "CreateEntity" || position?.kind !== "SetProperty" || draw?.kind !== "DrawIn") {
      throw new Error("Draw correlation fixture is incomplete.");
    }
    const projectedDuration = imported.runtimeSceneState.duration + 1;
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: projectedDuration, start: 0 },
          entityId,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "line",
          operationId: create.id,
          transactionId: drawn.transactionId,
        },
      ],
      insertions: [{ at: 0, duration: 1, transactionId: drawn.transactionId }],
      motions: [],
      mutations: [
        {
          entityId,
          interval: { end: 0, start: 0 },
          kind: "position",
          operationId: position.id,
          transactionId: drawn.transactionId,
          value: { x: 320, y: 180 },
        },
        {
          easing: { kind: "manim-smooth" },
          entityId,
          from: 0,
          interval: { end: 1, start: 0 },
          kind: "draw-in",
          operationId: draw.id,
          to: 1,
          transactionId: drawn.transactionId,
        },
      ],
      projectedDuration,
      removals: [],
    };

    expect(selectCreationProjection(imported.runtimeSceneState.duration, [drawn], projection)).toBe(projection);
    const staleDraw = projection.mutations[1];
    if (!staleDraw || staleDraw.kind !== "draw-in") throw new Error("Draw projection fixture is incomplete.");
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [drawn], {
        ...projection,
        mutations: [projection.mutations[0]!, { ...staleDraw, easing: { kind: "linear" } }],
      }),
    ).toThrow(/not correlated/);
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [drawn], {
        ...projection,
        mutations: [projection.mutations[0]!, { ...staleDraw, interval: { end: 1.25, start: 0 } }],
      }),
    ).toThrow(/not correlated/);
  });

  it("correlates Camera animation from exact Rust views without an entity identity", () => {
    const imported = workspaceScene("First", null);
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ position: { x: 320, y: 180 }, type: "Line" }],
      scene: imported.runtimeSceneState,
      transactionId: "camera-creation",
    });
    const authoredCreationProgram = creation.validation.program;
    const retainedCreationOperations = authoredCreationProgram.operations.filter(
      (operation) => operation.kind === "CreateEntity" || operation.kind === "SetProperty",
    );
    const retainedCreationOperationIds = new Set(retainedCreationOperations.map(({ id }) => id));
    const creationProgram: CanonicalEditProgram = {
      ...authoredCreationProgram,
      intentCount: retainedCreationOperations.length,
      operations: retainedCreationOperations,
      schedule: {
        ...authoredCreationProgram.schedule,
        edges: authoredCreationProgram.schedule.edges.filter(
          ({ from, to }) => retainedCreationOperationIds.has(from) && retainedCreationOperationIds.has(to),
        ),
        order: authoredCreationProgram.schedule.order.filter((id) => retainedCreationOperationIds.has(id)),
      },
    };
    const cameraValidation = createCameraProgram({
      baseView: { center: { x: 0, y: 0 }, frameHeight: 8, frameWidth: 16 },
      capturedPlayhead: 1,
      easing: "smooth",
      end: 2,
      from: { center: { x: 0, y: 0 }, frameHeight: 8, frameWidth: 16 },
      scene: imported.runtimeSceneState,
      start: 1,
      to: { center: { x: 1, y: -0.5 }, frameHeight: 4, frameWidth: 8 },
      transactionId: "camera-focus",
      workspaceOrigin: "studio-native",
    });
    expect(cameraValidation.kind, JSON.stringify(cameraValidation.issues)).toBe("valid");
    const cameraProgram = cameraValidation.program;
    const create = creationProgram.operations.find((operation) => operation.kind === "CreateEntity");
    const position = creationProgram.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const camera = cameraProgram.operations[0];
    if (create?.kind !== "CreateEntity" || position?.kind !== "SetProperty" || camera?.kind !== "AnimateCamera") {
      throw new Error("Camera correlation fixture is incomplete.");
    }
    const projectedDuration = imported.runtimeSceneState.duration + 1;
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: projectedDuration, start: 0 },
          entityId: creation.entityIds[0]!,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "line",
          operationId: create.id,
          transactionId: creationProgram.transactionId,
        },
      ],
      insertions: [{ at: 1, duration: 1, transactionId: cameraProgram.transactionId }],
      motions: [],
      mutations: [
        {
          entityId: creation.entityIds[0]!,
          interval: { end: 0, start: 0 },
          kind: "position",
          operationId: position.id,
          transactionId: creationProgram.transactionId,
          value: { x: 320, y: 180 },
        },
        {
          easing: { kind: "manim-smooth" },
          fromView: camera.from,
          interval: { end: 2, start: 1 },
          kind: "animate-camera",
          operationId: camera.id,
          toView: camera.to,
          transactionId: cameraProgram.transactionId,
        },
      ],
      projectedDuration,
      removals: [],
    };

    expect(
      selectCreationProjection(imported.runtimeSceneState.duration, [creationProgram, cameraProgram], projection),
    ).toBe(projection);
    const projectedCamera = projection.mutations[1];
    if (!projectedCamera || projectedCamera.kind !== "animate-camera") {
      throw new Error("Camera projection fixture is incomplete.");
    }
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [creationProgram, cameraProgram], {
        ...projection,
        mutations: [
          projection.mutations[0]!,
          {
            ...projectedCamera,
            toView: { ...projectedCamera.toView, frameWidth: projectedCamera.toView.frameWidth + 1 },
          },
        ],
      }),
    ).toThrow(/not correlated/);
    expect("entityId" in projectedCamera).toBe(false);
  });

  it("correlates Image placement structurally and rejects a stale asset reference", () => {
    const imported = workspaceScene("First", null);
    const image = {
      asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
      localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
      sampler: "nearest" as const,
    };
    const program: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [
        {
          dependsOn: [],
          entity: {
            id: "tx:image/entity:image",
            image,
            lifetime: { end: null, start: 0 },
            type: "ImageMobject",
          },
          id: "tx:image/operation:create",
          interval: { end: 0, start: 0 },
          kind: "CreateEntity",
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["tx:image/operation:create"] },
      transactionId: "tx:image",
      version: 1,
    };
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: imported.runtimeSceneState.duration, start: 0 },
          entityId: "tx:image/entity:image",
          image: {
            localRect: { top: 0.5, right: 1, left: -1, bottom: -0.5 },
            sampler: "nearest",
            asset: { sha256: "4".repeat(64), assetId: "image-scene/asset:image.png" },
          },
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "image",
          operationId: "tx:image/operation:create",
          transactionId: "tx:image",
        },
      ],
      insertions: [],
      motions: [],
      mutations: [],
      projectedDuration: imported.runtimeSceneState.duration,
      removals: [],
    };

    expect(selectCreationProjection(imported.runtimeSceneState.duration, [program], projection)).toBe(projection);
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [program], {
        ...projection,
        entities: [
          {
            ...projection.entities[0]!,
            image: { ...image, asset: { ...image.asset, sha256: "5".repeat(64) } },
          },
        ],
      }),
    ).toThrow(/not correlated/);
  });

  it("projects Studio-created MathTex A-to-B-to-A on one logical root", () => {
    const imported = workspaceScene("First", null);
    const initialContent = { displayLines: ["A"], label: "A", texParts: ["A"] };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ content: initialContent, position: { x: 320, y: 180 }, type: "MathTex" }],
      scene: imported.runtimeSceneState,
      transactionId: "tx:create-math",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const creationProgram = creation.validation.program;
    const rootEntityId = creation.entityIds[0]!;
    const create = creationProgram.operations.find((operation) => operation.kind === "CreateEntity");
    const position = creationProgram.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const fade = creationProgram.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    if (create?.kind !== "CreateEntity" || position?.kind !== "SetProperty" || fade?.kind !== "ChangePresence") {
      throw new Error("Studio MathTex creation fixture is incomplete.");
    }
    const creationDuration = fade.interval.end - fade.interval.start;
    const firstTargetEntityId = "tx:transform-b/entity:math-tex-transform-target";
    const secondTargetEntityId = "tx:transform-a/entity:math-tex-transform-target";
    const transformProgram = (
      transactionId: string,
      sourceEntityId: string,
      targetEntityId: string,
      replacement: Readonly<{ displayLines: readonly string[]; label: string; texParts: readonly string[] }>,
      start: number,
      easing?: "linear" | "smooth",
    ): CanonicalEditProgram => {
      const operationId = `${transactionId}/operation:transform`;
      return {
        anchor: {
          capturedPlayhead: start,
          evidence: [],
          resolvedSeconds: start,
          source: { kind: "absolute", seconds: start },
        },
        intentCount: 1,
        loweringStatus: "supported",
        operations: [
          {
            dependsOn: [],
            ...(easing ? { easing } : {}),
            id: operationId,
            interval: { end: start + 1, start },
            kind: "TransformContent",
            provenance: { evidence: [], origin: "direct-manipulation" },
            replacement,
            sourceEntityId,
            strategy: "replacement-transform",
            targetEntityId,
            targetType: "MathTex",
          },
        ],
        provenance: { evidence: [], origin: "direct-manipulation" },
        requestedExecution: "sequence",
        schedule: { edges: [], mode: "sequence", order: [operationId] },
        transactionId,
        version: 1,
      };
    };
    const toB = transformProgram(
      "tx:transform-b",
      rootEntityId,
      firstTargetEntityId,
      { displayLines: ["B"], label: "B", texParts: ["B"] },
      1,
    );
    const backToA = transformProgram(
      "tx:transform-a",
      firstTargetEntityId,
      secondTargetEntityId,
      initialContent,
      2,
      "linear",
    );
    const first = toB.operations[0];
    const second = backToA.operations[0];
    if (first?.kind !== "TransformContent" || second?.kind !== "TransformContent") {
      throw new Error("Studio MathTex transform fixture is incomplete.");
    }
    const firstWorkingStart = 1 + creationDuration;
    const secondWorkingStart = 3 + creationDuration;
    const projectedDuration = imported.runtimeSceneState.duration + creationDuration + 2;
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: projectedDuration, start: 0 },
          entityId: rootEntityId,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "math-tex",
          operationId: create.id,
          texParts: initialContent.texParts,
          transactionId: creationProgram.transactionId,
        },
      ],
      insertions: [
        { at: 0, duration: creationDuration, transactionId: creationProgram.transactionId },
        { at: firstWorkingStart, duration: 1, transactionId: toB.transactionId },
        { at: secondWorkingStart, duration: 1, transactionId: backToA.transactionId },
      ],
      motions: [],
      mutations: [
        {
          entityId: rootEntityId,
          interval: { end: 0, start: 0 },
          kind: "position",
          operationId: position.id,
          transactionId: creationProgram.transactionId,
          value: { x: 320, y: 180 },
        },
        {
          entityId: rootEntityId,
          from: 0,
          interval: { end: creationDuration, start: 0 },
          kind: "fade-in",
          operationId: fade.id,
          to: 1,
          transactionId: creationProgram.transactionId,
        },
        {
          content: { displayLines: ["B"], label: "B", texParts: ["B"] },
          easing: { kind: "manim-smooth" },
          entityId: rootEntityId,
          interval: { end: firstWorkingStart + 1, start: firstWorkingStart },
          kind: "math-tex-transform",
          operationId: first.id,
          sourceEntityId: rootEntityId,
          targetEntityId: firstTargetEntityId,
          transactionId: toB.transactionId,
        },
        {
          content: initialContent,
          easing: { kind: "linear" },
          entityId: rootEntityId,
          interval: { end: secondWorkingStart + 1, start: secondWorkingStart },
          kind: "math-tex-transform",
          operationId: second.id,
          sourceEntityId: firstTargetEntityId,
          targetEntityId: secondTargetEntityId,
          transactionId: backToA.transactionId,
        },
      ],
      projectedDuration,
      removals: [],
    };

    expect(
      selectCreationProjection(imported.runtimeSceneState.duration, [creationProgram, toB, backToA], projection),
    ).toBe(projection);
    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [creationProgram, toB, backToA].map((program) =>
        programRecord(program, { issues: [], kind: "valid" }),
      ),
      creationProjection: projection,
      currentTime: projectedDuration,
      draftEdit: null,
      editAuthority: "rust-authorized-batch",
      nextScene: null,
      selectedObjectIds: [rootEntityId],
    });

    expect(projected.proposedState.evaluatedScene.objectGraph.entities[rootEntityId]).toBeDefined();
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[firstTargetEntityId]).toBeUndefined();
    expect(projected.proposedState.evaluatedScene.objectGraph.entities[secondTargetEntityId]).toBeUndefined();
    expect(projected.proposedState.evaluatedScene.propertyChannels[`${rootEntityId}/content`]?.samples).toEqual([
      expect.objectContaining({
        interval: { end: projectedDuration, start: firstWorkingStart + 1 },
        value: { displayLines: ["B"], label: "B", texParts: ["B"] },
      }),
      expect.objectContaining({
        interval: { end: projectedDuration, start: secondWorkingStart + 1 },
        value: initialContent,
      }),
    ]);
    const staleSecond = projection.mutations[3];
    if (!staleSecond || staleSecond.kind !== "math-tex-transform") {
      throw new Error("Studio MathTex projection fixture is incomplete.");
    }
    expect(() =>
      selectCreationProjection(imported.runtimeSceneState.duration, [creationProgram, toB, backToA], {
        ...projection,
        mutations: [...projection.mutations.slice(0, 3), { ...staleSecond, entityId: secondTargetEntityId }],
      }),
    ).toThrow(/not correlated/);
  });

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
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 2, start: 1 },
          operationId: "motion/standalone",
          orientToPath: false,
          sourceInterval: { end: 2, start: 1 },
          targetEntityId: entityId,
          to: { x: 360, y: 160 },
          transactionId: program.transactionId,
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 1,
    };

    const project = (motionProjection: StudioMotionProjectionV1) =>
      projectStudioWorkspace({
        activeScene: imported,
        appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
        currentTime: 2,
        draftEdit: null,
        motionProjection,
        nextScene: null,
        editAuthority: "rust-authorized-batch",
        selectedObjectIds: [],
      });
    const projected = project(projection);

    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples.at(-1),
    ).toMatchObject({
      control: projection.motions[0]?.control,
      easing: "manim-smooth",
      from: projection.motions[0]?.from,
      value: projection.motions[0]?.to,
    });
    expect(projected.proposedState.evaluatedScene.duration).toBe(projection.projectedDuration);
    expect(() => project({ ...projection, insertions: [] })).toThrow("one unique insertion per Program");
    expect(() => project({ ...projection, insertions: [{ ...projection.insertions[0]!, at: -1 }] })).toThrow(
      "one unique insertion per Program",
    );
    expect(() => project({ ...projection, motions: [{ ...projection.motions[0]!, easing: "linear" }] })).toThrow(
      "is not correlated",
    );
  });

  it("records one operation event for one motion that targets multiple entities", () => {
    const original = workspaceScene("First", null);
    const [firstEntityId, firstEntity] = Object.entries(original.runtimeSceneState.objectGraph.entities)[0] ?? [];
    if (!firstEntityId || !firstEntity) throw new Error("Static fixture has no entity.");
    const secondEntityId = `${firstEntityId}:second`;
    const imported: ManimWorkspaceScene = {
      ...original,
      runtimeSceneState: {
        ...original.runtimeSceneState,
        objectGraph: {
          ...original.runtimeSceneState.objectGraph,
          entities: {
            ...original.runtimeSceneState.objectGraph.entities,
            [secondEntityId]: { ...firstEntity, id: secondEntityId },
          },
        },
      },
    };
    const program: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          controlOffset: { x: 8, y: -4 },
          delta: { x: 24, y: 12 },
          dependsOn: [],
          easing: "smooth",
          id: "motion/multi-target",
          interval: { end: 2, start: 1 },
          kind: "CreateMotion",
          provenance: { evidence: [], origin: "direct-manipulation" },
          targetEntityIds: [firstEntityId, secondEntityId],
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["motion/multi-target"] },
      transactionId: "motion-multi-target",
      version: 1,
    };
    const projection: StudioMotionProjectionV1 = {
      insertions: [{ at: 1, duration: 1, transactionId: program.transactionId }],
      motions: [firstEntityId, secondEntityId].map((targetEntityId, index) => ({
        control: { x: 340 + index * 20, y: 182 },
        controlOffset: { x: 8, y: -4 },
        delta: { x: 24, y: 12 },
        easing: "manim-smooth" as const,
        from: { x: 320 + index * 20, y: 180 },
        interval: { end: 2, start: 1 },
        operationId: "motion/multi-target",
        orientToPath: false,
        sourceInterval: { end: 2, start: 1 },
        targetEntityId,
        to: { x: 344 + index * 20, y: 192 },
        transactionId: program.transactionId,
      })),
      projectedDuration: imported.runtimeSceneState.duration + 1,
    };

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      currentTime: 2,
      draftEdit: null,
      motionProjection: projection,
      nextScene: null,
      editAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });

    expect(
      projected.proposedState.evaluatedScene.eventTrack.events.filter(
        ({ operationId }) => operationId === "motion/multi-target",
      ),
    ).toHaveLength(1);
    expect(
      projected.proposedState.evaluatedScene.provenanceGraph.records.filter(
        ({ operationId }) => operationId === "motion/multi-target",
      ),
    ).toHaveLength(1);
    for (const entityId of [firstEntityId, secondEntityId]) {
      expect(
        projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples.filter(
          ({ operationId }) => operationId === "motion/multi-target",
        ),
      ).toHaveLength(1);
    }
  });

  it("rejects a Program family with no Rust workspace projection instead of evaluating it in TypeScript", () => {
    const imported = workspaceScene("First", null);
    const [entityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!entityId) throw new Error("Static fixture has no entity.");
    const unsupported: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          effect: "fade-in",
          entityId,
          id: "presence/fade-in",
          interval: { end: 2, start: 1 },
          kind: "ChangePresence",
          persistent: true,
          provenance: { evidence: [], origin: "direct-manipulation" },
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["presence/fade-in"] },
      transactionId: "presence-fade-in",
      version: 1,
    };

    expect(() =>
      projectStudioWorkspace({
        activeScene: imported,
        appliedEdits: [programRecord(unsupported, { issues: [], kind: "valid" })],
        currentTime: 2,
        draftEdit: null,
        nextScene: null,
        editAuthority: "rust-authorized-batch",
        selectedObjectIds: [],
      }),
    ).toThrow(/no supported Rust workspace projection/i);
  });

  it("keeps one motion insertion correlated after move, scale, or resize Programs", () => {
    const imported = workspaceScene("Static", null);
    const [entityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!entityId) throw new Error("Static fixture has no entity.");
    const common = {
      dependsOn: [] as readonly string[],
      interval: { end: 0, start: 0 },
      provenance: { evidence: [] as readonly string[], origin: "direct-manipulation" as const },
    };
    const staticOperations: readonly CanonicalEditProgram["operations"][number][] = [
      { ...common, entityId, id: "static/move", key: "position", kind: "SetProperty", value: { x: 360, y: 180 } },
      {
        ...common,
        easing: "smooth",
        entityId,
        from: 1,
        id: "static/scale",
        key: "scale",
        kind: "AnimateProperty",
        relativeFactor: 2,
        to: 2,
      },
      {
        ...common,
        entityId,
        from: { dimensions: { radius: 1 }, position: { x: 320, y: 180 } },
        id: "static/resize",
        kind: "ResizeEntity",
        scale: 1,
        shape: "circle",
        to: { dimensions: { radius: 2 }, position: { x: 360, y: 180 } },
      },
    ];
    const motionProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          dependsOn: [],
          easing: "smooth",
          id: "motion/after-static",
          interval: { end: 1, start: 0 },
          kind: "CreateMotion",
          provenance: { evidence: [], origin: "direct-manipulation" },
          targetEntityIds: [entityId],
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["motion/after-static"] },
      transactionId: "motion-after-static",
      version: 1,
    };
    const projection: StudioMotionProjectionV1 = {
      insertions: [{ at: 0, duration: 1, transactionId: motionProgram.transactionId }],
      motions: [
        {
          control: { x: 350, y: 175 },
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 1, start: 0 },
          operationId: "motion/after-static",
          orientToPath: false,
          sourceInterval: { end: 1, start: 0 },
          targetEntityId: entityId,
          to: { x: 360, y: 160 },
          transactionId: motionProgram.transactionId,
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 1,
    };

    for (const operation of staticOperations) {
      const staticProgram: CanonicalEditProgram = {
        anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
        intentCount: 1,
        loweringStatus: "supported",
        operations: [operation],
        provenance: { evidence: [], origin: "direct-manipulation" },
        requestedExecution: "parallel",
        schedule: { edges: [], mode: "parallel", order: [operation.id] },
        transactionId: operation.id,
        version: 1,
      };
      expect(
        selectMotionProjection(imported.runtimeSceneState.duration, [staticProgram, motionProgram], projection),
      ).toEqual(projection);
    }
  });

  it("installs a Studio-created Arrow and its follow-up motion from the same Rust projection", () => {
    const imported = workspaceScene("First", null);
    const entityId = "tx:create/entity:arrow";
    const creationProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 3,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entity: { id: entityId, lifetime: { end: null, start: 0 }, type: "Arrow" },
          id: "create/arrow",
          interval: { end: 0, start: 0 },
          kind: "CreateEntity",
          provenance: { evidence: [], origin: "studio-default" },
        },
        {
          dependsOn: ["create/arrow"],
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
          { from: "create/arrow", reason: "explicit", to: "create/position" },
          { from: "create/position", reason: "explicit", to: "create/fade" },
        ],
        mode: "sequence",
        order: ["create/arrow", "create/position", "create/fade"],
      },
      transactionId: "create",
      version: 1,
    };
    const motionProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          controlOffset: { x: 0, y: 10 },
          delta: { x: 50, y: 20 },
          dependsOn: [],
          easing: "smooth",
          id: "create/motion",
          interval: { end: 2, start: 1 },
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
    const staticPositionProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0.5,
        evidence: [],
        resolvedSeconds: 0.5,
        source: { kind: "absolute", seconds: 0.5 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId,
          id: "create/static-position",
          interval: { end: 0.5, start: 0.5 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "direct-manipulation" },
          value: { x: 120, y: 120 },
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["create/static-position"] },
      transactionId: "static-position-created",
      version: 1,
    };
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: imported.runtimeSceneState.duration + 1.4, start: 0 },
          entityId,
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "arrow",
          operationId: "create/arrow",
          transactionId: creationProgram.transactionId,
        },
      ],
      insertions: [
        { at: 0, duration: 0.4, transactionId: creationProgram.transactionId },
        { at: 1.4, duration: 1, transactionId: motionProgram.transactionId },
      ],
      motions: [
        {
          control: { x: 145, y: 140 },
          controlOffset: { x: 0, y: 10 },
          delta: { x: 50, y: 20 },
          easing: "manim-smooth",
          from: { x: 120, y: 120 },
          interval: { end: 2.4, start: 1.4 },
          operationId: "create/motion",
          orientToPath: false,
          sourceInterval: { end: 2, start: 1 },
          targetEntityId: entityId,
          to: { x: 170, y: 140 },
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
        {
          entityId,
          interval: { end: 0.9, start: 0.9 },
          kind: "position",
          operationId: "create/static-position",
          transactionId: staticPositionProgram.transactionId,
          value: { x: 120, y: 120 },
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 1.4,
      removals: [
        {
          affectedSceneEntityIds: [entityId],
          fadeInterval: { end: 3.8, start: 3.6 },
          operationId: "create/remove",
          removedAt: 3.8,
          resultingLifetimeEnd: 3.8,
          sceneEntityId: entityId,
          studioEntityId: entityId,
          transactionId: "remove-created",
        },
      ],
    };
    const removeProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 2.2,
        evidence: [],
        resolvedSeconds: 2.2,
        source: { kind: "absolute", seconds: 2.2 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          effect: "remove",
          entityId,
          id: "create/remove",
          interval: { end: 2.4, start: 2.2 },
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
        programs: [creationProgram, staticPositionProgram, motionProgram, removeProgram],
      }).programs[0]?.operations[0],
    ).toMatchObject({ entity: { dimensions: {}, kind: "arrow" }, kind: "create" });
    const prefixProjection = selectCreationProjectionProgramPrefix(
      imported.runtimeSceneState.duration,
      [creationProgram, staticPositionProgram],
      [creationProgram, staticPositionProgram, motionProgram, removeProgram],
      projection,
    );
    expect(prefixProjection).toMatchObject({
      entities: [{ createdLifetime: { end: imported.runtimeSceneState.duration + 0.4, start: 0 } }],
      insertions: [{ duration: 0.4, transactionId: creationProgram.transactionId }],
      motions: [],
      mutations: [
        { operationId: "create/position" },
        { operationId: "create/fade" },
        { interval: { end: 0.9, start: 0.9 }, operationId: "create/static-position" },
      ],
      projectedDuration: imported.runtimeSceneState.duration + 0.4,
      removals: [],
    });
    expect(() =>
      selectCreationProjectionProgramPrefix(
        imported.runtimeSceneState.duration,
        [creationProgram, staticPositionProgram],
        [
          creationProgram,
          staticPositionProgram,
          {
            ...motionProgram,
            anchor: {
              ...motionProgram.anchor,
              capturedPlayhead: 0.25,
              resolvedSeconds: 0.25,
              source: { kind: "absolute", seconds: 0.25 },
            },
          },
        ],
        projection,
      ),
    ).toThrow(/execution prefix/u);
    expect(() =>
      selectCreationProjectionProgramPrefix(
        imported.runtimeSceneState.duration,
        [creationProgram, staticPositionProgram],
        [
          creationProgram,
          staticPositionProgram,
          { ...motionProgram, anchor: { ...motionProgram.anchor, resolvedSeconds: 0.5 } },
        ],
        null,
      ),
    ).toThrow(/Rust creation projection is required/u);
    expect(
      projectStudioWorkspace({
        activeScene: imported,
        appliedEdits: [
          programRecord(creationProgram, { issues: [], kind: "valid" }),
          programRecord(staticPositionProgram, { issues: [], kind: "valid" }),
        ],
        creationProjection: prefixProjection,
        currentTime: 1,
        draftEdit: null,
        editAuthority: "rust-authorized-batch",
        nextScene: null,
        selectedObjectIds: [entityId],
      }).proposedState.evaluatedScene,
    ).toMatchObject({
      duration: imported.runtimeSceneState.duration + 0.4,
      objectGraph: { entities: { [entityId]: { lifetime: [{ end: imported.runtimeSceneState.duration + 0.4 }] } } },
    });
    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [
        programRecord(creationProgram, { issues: [], kind: "valid" }),
        programRecord(staticPositionProgram, { issues: [], kind: "valid" }),
        programRecord(motionProgram, { issues: [], kind: "valid" }),
        programRecord(removeProgram, { issues: [], kind: "valid" }),
      ],
      creationProjection: projection,
      currentTime: 1,
      draftEdit: null,
      nextScene: null,
      editAuthority: "rust-authorized-batch",
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
      { end: 3.8, start: 0 },
    ]);
  });

  it("correlates a Studio-created motion spin as one atomic operation record", () => {
    const imported = workspaceScene("First", null);
    const initialPosition = { x: 100, y: 120 };
    const creation = createStudioEntitiesProgram({
      capturedPlayhead: 0,
      entities: [{ content: undefined, position: initialPosition, type: "Circle" }],
      scene: imported.runtimeSceneState,
      transactionId: "spin-create",
    });
    expect(creation.validation.kind, JSON.stringify(creation.validation.issues)).toBe("valid");
    const creationProgram = creation.validation.program;
    const entityId = creation.entityIds[0];
    const createOperation = creationProgram.operations.find((operation) => operation.kind === "CreateEntity");
    const positionOperation = creationProgram.operations.find(
      (operation) => operation.kind === "SetProperty" && operation.key === "position",
    );
    const fadeOperation = creationProgram.operations.find(
      (operation) => operation.kind === "ChangePresence" && operation.effect === "fade-in",
    );
    if (
      !entityId ||
      createOperation?.kind !== "CreateEntity" ||
      positionOperation?.kind !== "SetProperty" ||
      positionOperation.key !== "position" ||
      fadeOperation?.kind !== "ChangePresence" ||
      fadeOperation.effect !== "fade-in"
    ) {
      throw new Error("Studio creation fixture is incomplete.");
    }
    const creationDuration = fadeOperation.interval.end - fadeOperation.interval.start;
    const motionOperation = {
      controlOffset: { x: 0, y: 10 },
      delta: { x: 50, y: 20 },
      dependsOn: [],
      easing: "smooth" as const,
      id: "spin-motion/create-motion",
      interval: { end: 2, start: 1 },
      kind: "CreateMotion" as const,
      orientToPath: true,
      provenance: { evidence: [], origin: "direct-manipulation" as const },
      rotationDeltaRadians: Math.PI * 2,
      targetEntityIds: [entityId],
    };
    const motionProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
      intentCount: 1,
      loweringStatus: "unsupported",
      operations: [motionOperation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [motionOperation.id] },
      transactionId: "spin-motion",
      version: 1,
    };
    const projectedMotionInterval = {
      end: motionOperation.interval.end + creationDuration,
      start: motionOperation.interval.start + creationDuration,
    };
    const projectedDuration = imported.runtimeSceneState.duration + creationDuration + 1;
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: projectedDuration, start: 0 },
          entityId,
          initialDimensions: { radius: 1 },
          initialRotation: 0,
          initialScale: 1,
          kind: "circle",
          operationId: createOperation.id,
          transactionId: creationProgram.transactionId,
        },
      ],
      insertions: [
        { at: 0, duration: creationDuration, transactionId: creationProgram.transactionId },
        {
          at: motionOperation.interval.start + creationDuration,
          duration: 1,
          transactionId: motionProgram.transactionId,
        },
      ],
      motions: [
        {
          control: { x: 125, y: 140 },
          controlOffset: motionOperation.controlOffset,
          delta: motionOperation.delta,
          easing: "manim-smooth",
          from: initialPosition,
          interval: projectedMotionInterval,
          operationId: motionOperation.id,
          orientToPath: true,
          sourceInterval: motionOperation.interval,
          targetEntityId: entityId,
          to: { x: 150, y: 140 },
          transactionId: motionProgram.transactionId,
        },
      ],
      mutations: [
        {
          entityId,
          interval: positionOperation.interval,
          kind: "position",
          operationId: positionOperation.id,
          transactionId: creationProgram.transactionId,
          value: initialPosition,
        },
        {
          entityId,
          from: 0,
          interval: fadeOperation.interval,
          kind: "fade-in",
          operationId: fadeOperation.id,
          to: 1,
          transactionId: creationProgram.transactionId,
        },
        {
          easing: { kind: "manim-smooth" },
          entityId,
          from: 0,
          interval: projectedMotionInterval,
          kind: "rotation-keyframes",
          operationId: motionOperation.id,
          to: motionOperation.rotationDeltaRadians,
          transactionId: motionProgram.transactionId,
        },
      ],
      projectedDuration,
      removals: [],
    };

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [
        programRecord(creationProgram, { issues: [], kind: "valid" }),
        programRecord(motionProgram, { issues: [], kind: "valid" }),
      ],
      creationProjection: projection,
      currentTime: projectedMotionInterval.start,
      draftEdit: null,
      editAuthority: "rust-authorized-batch",
      nextScene: null,
      selectedObjectIds: [entityId],
    });

    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/position`]?.samples.at(-1),
    ).toMatchObject({
      control: projection.motions[0]?.control,
      operationId: motionOperation.id,
      value: projection.motions[0]?.to,
    });
    expect(
      projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/rotation`]?.samples.at(-1),
    ).toMatchObject({
      easing: { kind: "manim-smooth" },
      from: 0,
      interval: projectedMotionInterval,
      operationId: motionOperation.id,
      value: Math.PI * 2,
    });
    expect(
      projected.proposedState.evaluatedScene.eventTrack.events.filter(
        ({ operationId }) => operationId === motionOperation.id,
      ),
    ).toHaveLength(1);
    expect(
      projected.proposedState.evaluatedScene.provenanceGraph.records.filter(
        ({ operationId }) => operationId === motionOperation.id,
      ),
    ).toHaveLength(1);
  });

  it("installs Studio-created shape color and ordering channels from the Rust projection", () => {
    const imported = workspaceScene("First", null);
    const entityId = "tx:create-color/entity:circle";
    const creationProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entity: {
            dimensions: { radius: 1 },
            id: entityId,
            lifetime: { end: null, start: 0 },
            type: "Circle",
          },
          id: "create-color/circle",
          interval: { end: 0, start: 0 },
          kind: "CreateEntity",
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      provenance: { evidence: [], origin: "studio-default" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["create-color/circle"] },
      transactionId: "create-color",
      version: 1,
    };
    const colorProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId,
          id: "fill-color/circle",
          interval: { end: 0, start: 0 },
          key: "fillColor",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "direct-manipulation" },
          value: "#12abef",
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["fill-color/circle"] },
      transactionId: "fill-color",
      version: 1,
    };
    const orderingProgram: CanonicalEditProgram = {
      ...colorProgram,
      operations: [
        {
          dependsOn: [],
          entityId,
          id: "ordering/circle",
          interval: { end: 0, start: 0 },
          key: "sourceZIndex",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "direct-manipulation" },
          value: -2.5,
        },
      ],
      schedule: { edges: [], mode: "parallel", order: ["ordering/circle"] },
      transactionId: "ordering",
    };
    const projection: StudioCreationProjectionV1 = {
      entities: [
        {
          createdLifetime: { end: imported.runtimeSceneState.duration, start: 0 },
          entityId,
          initialDimensions: { radius: 1 },
          initialRotation: 0,
          initialScale: 1,
          kind: "circle",
          operationId: "create-color/circle",
          transactionId: "create-color",
        },
      ],
      insertions: [],
      motions: [],
      mutations: [
        {
          entityId,
          interval: { end: imported.runtimeSceneState.duration, start: 0 },
          kind: "fill-color",
          operationId: "fill-color/circle",
          transactionId: "fill-color",
          value: "#12abef",
        },
        {
          entityId,
          interval: { end: 0, start: 0 },
          kind: "source-z-index",
          operationId: "ordering/circle",
          sourceZIndex: -2.5,
          transactionId: "ordering",
        },
      ],
      projectedDuration: imported.runtimeSceneState.duration,
      removals: [],
    };

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [
        programRecord(creationProgram, { issues: [], kind: "valid" }),
        programRecord(colorProgram, { issues: [], kind: "valid" }),
        programRecord(orderingProgram, { issues: [], kind: "valid" }),
      ],
      creationProjection: projection,
      currentTime: 0,
      draftEdit: null,
      editAuthority: "rust-authorized-batch",
      nextScene: null,
      selectedObjectIds: [entityId],
    });

    expect(projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/fillColor`]?.samples).toEqual([
      expect.objectContaining({ interval: { end: projection.projectedDuration, start: 0 }, value: "#12abef" }),
    ]);
    expect(projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/sourceZIndex`]?.samples).toEqual([
      expect.objectContaining({ interval: { end: projection.projectedDuration, start: 0 }, value: -2.5 }),
    ]);
    expect(projected.projection.inspector.entities.find((entity) => entity.id === entityId)?.geometry.style).toEqual({
      kind: "known",
      value: { fillColor: "#12abef" },
    });
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

    expect(selectStudioWorkspaceEditAuthority([record], [record], null)).toBeUndefined();
    expect(selectStudioWorkspaceEditAuthority([record], [record], "static-imported-root")).toBe("static-imported-root");
    expect(selectStudioWorkspaceEditAuthority([record], [record], "source-bound-endpoint")).toBe(
      "source-bound-endpoint",
    );
    expect(selectStudioWorkspaceEditAuthority([record], [], "rust-authorized-batch")).toBeUndefined();
    expect(selectStudioWorkspaceEditAuthority([{ ...record }], [record], "rust-authorized-batch")).toBeUndefined();
    expect(selectStudioWorkspaceEditAuthority([], [record], "rust-authorized-batch")).toBeNull();

    const suffixRecord = programRecord(
      { ...validation.program, transactionId: "authority-suffix" },
      { issues: [], kind: "valid" },
    );
    expect(selectStudioWorkspaceEditAuthority([record], [record, suffixRecord], "rust-authorized-batch")).toBe(
      "rust-authorized-batch",
    );
    expect(
      selectStudioWorkspaceEditAuthority([record, suffixRecord], [suffixRecord, record], "rust-authorized-batch"),
    ).toBeUndefined();
    expect(
      selectStudioWorkspaceEditAuthority([record], [{ ...record }, suffixRecord], "rust-authorized-batch"),
    ).toBeUndefined();

    const wait = createSceneDurationProgram({
      capturedPlayhead: imported.runtimeSceneState.duration,
      scene: imported.runtimeSceneState,
      sourceAnchor: imported.runtimeSceneState.duration,
      targetDuration: imported.runtimeSceneState.duration + 1,
      transactionId: "timeline-prefix",
    });
    if (wait.kind !== "valid") throw new Error(JSON.stringify(wait.issues));
    const timelineRecord = programRecord(wait.program, wait);
    expect(selectStudioWorkspaceEditAuthority([timelineRecord], [record], "rust-authorized-batch")).toBeNull();
  });

  it("materializes the four source-bound endpoint results only from a correlated Rust projection", () => {
    const imported = workspaceScene("Static", null);
    const [entityId] = Object.keys(imported.runtimeSceneState.objectGraph.entities);
    if (!entityId) throw new Error("Static fixture has no entity.");
    const operation = (id: string, mutation: object) =>
      ({
        dependsOn: [],
        entityId,
        id,
        interval: { end: 0, start: 0 },
        provenance: { evidence: [], origin: "direct-manipulation" },
        ...mutation,
      }) as unknown as CanonicalEditProgram["operations"][number];
    const program = (edit: CanonicalEditProgram["operations"][number]): CanonicalEditProgram => ({
      anchor: {
        capturedPlayhead: 0,
        evidence: [],
        resolvedSeconds: 0,
        source: { kind: "playhead", referenceSeconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [edit],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [edit.id] },
      transactionId: edit.id,
      version: 1,
    });
    const position = { x: 400, y: 220 };
    const cases = [
      {
        edit: operation("bound-position", { key: "position", kind: "SetProperty", value: position }),
        expectedSample: { value: position },
        key: "position",
        mutation: { kind: "position" as const, value: position },
      },
      {
        edit: operation("bound-opacity", { key: "appearance", kind: "SetProperty", value: 0.25 }),
        expectedSample: { value: 0.25 },
        key: "appearance",
        mutation: { kind: "opacity" as const, value: 0.25 },
      },
      {
        edit: operation("bound-rotation", {
          easing: "smooth",
          from: 0,
          key: "rotation",
          kind: "AnimateProperty",
          relativeDelta: 0.5,
          to: 0.5,
        }),
        expectedSample: { from: 0, value: 0.5 },
        key: "rotation",
        mutation: { from: 0, kind: "rotation" as const, to: 0.5 },
      },
      {
        edit: operation("bound-scale", {
          easing: "smooth",
          from: 1,
          key: "scale",
          kind: "AnimateProperty",
          relativeFactor: 1.5,
          to: 1.5,
        }),
        expectedSample: { from: 1, value: 1.5 },
        key: "scale",
        mutation: { from: 1, kind: "uniform-scale" as const, to: 1.5 },
      },
    ];

    for (const { edit, expectedSample, key, mutation } of cases) {
      const sourceProgram = program(edit);
      const projection: StudioBoundEntityProjectionV1 = {
        ...mutation,
        interval: edit.interval,
        operationId: edit.id,
        studioEntityId: entityId,
        transactionId: sourceProgram.transactionId,
      };
      const projected = projectStudioWorkspace({
        activeScene: imported,
        appliedEdits: [programRecord(sourceProgram, { issues: [], kind: "valid" })],
        boundEntityProjection: projection,
        currentTime: 0,
        draftEdit: null,
        nextScene: null,
        editAuthority: "source-bound-endpoint",
        selectedObjectIds: [],
      });
      expect(
        projected.proposedState.evaluatedScene.propertyChannels[`${entityId}/${key}`]?.samples.at(-1),
      ).toMatchObject(expectedSample);
    }

    const firstProgram = program(cases[0]!.edit);
    expect(() =>
      projectStudioWorkspace({
        activeScene: imported,
        appliedEdits: [programRecord(firstProgram, { issues: [], kind: "valid" })],
        currentTime: 0,
        draftEdit: null,
        nextScene: null,
        editAuthority: "source-bound-endpoint",
        selectedObjectIds: [],
      }),
    ).toThrow("A Rust bound-entity projection is required");
  });

  it("requires and mechanically composes Rust's static-root and persistent-remove projections", () => {
    const imported = workspaceScene("Static", null);
    const base = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [],
      currentTime: 0,
      draftEdit: null,
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
        appliedEdits: [record],
        currentTime: rebased.runtimeSceneState.duration,
        draftEdit: null,
        nextScene: null,
        editAuthority: "static-imported-root",
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
      appliedEdits: [record, removeRecord],
      currentTime: 1.5,
      draftEdit: null,
      nextScene: null,
      persistentRemoveProjection,
      editAuthority: "static-imported-root",
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
        appliedEdits: [programRecord(magic.program, magic)],
        currentTime,
        draftEdit: null,
        nextScene: null,
        persistentRemoveProjection: magicRemoveProjection,
        editAuthority: "static-imported-root",
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
      appliedEdits: [removeRecord],
      currentTime: 1.5,
      draftEdit: null,
      nextScene: null,
      persistentRemoveProjection,
      editAuthority: "rust-authorized-batch",
      selectedObjectIds: [],
    });
    expect(pureRemoval.projection.canvas.entities[0]).toMatchObject({ opacity: 0, present: false, scale: 3 });
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
      appliedEdits: [],
      currentTime: 0,
      draftEdit: null,
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
      appliedEdits: [programRecord(edit.program, edit)],
      currentTime: 0.75,
      draftEdit: null,
      nextScene: null,
      editAuthority: "static-imported-root",
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
        appliedEdits: [programRecord(singleProgram, { issues: [], kind: "valid" })],
        currentTime: first.interval.end + 0.01,
        draftEdit: null,
        mathTexTransformProjection: singleProjection,
        nextScene: null,
        editAuthority: "rust-authorized-batch",
        selectedObjectIds: [],
      }).projection.inspector.entities.find(({ id }) => id === first.targetEntityId)?.content,
    ).toEqual(first.content);

    const projected = projectStudioWorkspace({
      activeScene: imported,
      appliedEdits: [programRecord(program, { issues: [], kind: "valid" })],
      currentTime: 0.9,
      draftEdit: null,
      mathTexTransformProjection: projection,
      nextScene: null,
      editAuthority: "rust-authorized-batch",
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
      appliedEdits: programs.map((program) => programRecord(program, { issues: [], kind: "valid" })),
      currentTime: projection.motions[0]!.interval.end,
      draftEdit: null,
      mathTexTransformProjection: projection,
      nextScene: null,
      editAuthority: "rust-authorized-batch",
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
        appliedEdits: [record],
        currentTime: 0.9,
        draftEdit: null,
        mathTexTransformProjection: candidate,
        nextScene: null,
        editAuthority: "rust-authorized-batch",
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
      appliedEdits: [],
      currentTime: 0.75,
      draftEdit: null,
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
      appliedEdits: [programRecord(edit.program, edit)],
      currentTime: 1.25,
      draftEdit: null,
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
      appliedEdits: [],
      currentTime: 6,
      draftEdit: null,
      nextScene,
      selectedObjectIds: [],
    });

    expect(projected.boundary).not.toBeNull();
    expect(projected.editableEntities).toEqual([]);
    expect(projected.visibleEntities.some((entity) => entity.type.startsWith("TransitionOverlay:"))).toBe(true);
  });
});
