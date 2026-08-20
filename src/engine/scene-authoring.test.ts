import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseVerifiedSceneIrBundleV1 } from "./contracts";
import {
  type ApplyStaticRootTransformEditWireCommandV1,
  type ApplyStudioBoundEntityEditWireCommandV1,
  type ApplyStudioCreationEditWireCommandV1,
  type ApplyStudioMathTexTransformEditWireCommandV1,
  type ApplyStudioMotionEditWireCommandV1,
  type ApplyStudioTimelineEditWireCommandV1,
  createApplyStaticRootTransformEditCompiler,
  createApplyStudioBoundEntityEditCompiler,
  createApplyStudioCreationEditCompiler,
  createApplyStudioMathTexTransformEditCompiler,
  createApplyStudioMotionEditCompiler,
  createApplyStudioTimelineEditCompiler,
  createProjectStudioCreationCompiler,
  createProjectStudioMathTexTransformCompiler,
  createProjectStudioMotionCompiler,
  createProjectStudioTimelineCompiler,
  type ProjectStudioMathTexTransformWireCommandV1,
  type ProjectStudioMotionEditWireCommandV1,
  type ProjectStudioTimelineWireCommandV1,
} from "./scene-authoring";

const staticRootTransformEditCommand: ApplyStaticRootTransformEditWireCommandV1 = {
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  mathTexOutlines: [],
  nextRevision: "7".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 0,
      anchorResolvedSeconds: 0,
      anchorSource: { kind: "playhead", referenceSeconds: 0 },
      intentCount: 1,
      loweringSupported: true,
      origin: "direct-manipulation",
      operations: [
        {
          dependsOn: [],
          entityId: "source:circle",
          id: "move-circle",
          interval: { end: 0, start: 0 },
          kind: "position",
          origin: "direct-manipulation",
          position: { x: 400, y: 180 },
        },
      ],
      requestedExecution: "parallel",
      scheduleEdgeCount: 0,
      scheduleMode: "parallel",
      scheduleOrder: ["move-circle"],
      transactionId: "move-circle",
    },
  ],
  schema: "poietra.apply-static-root-transform-edit",
  sourceRuntimeBindings: [{ runtimeEntityId: "later", sourceIdentityKey: "circle", sourceName: "circle" }],
  studioEntities: [
    {
      dimensions: { radius: 0.5 },
      id: "source:circle",
      kind: "circle",
      objectGraphKey: "source:circle",
      position: { x: 360, y: 180 },
      provisional: false,
      scale: 1,
      sourceIdentity: "circle",
    },
  ],
  version: 1,
  viewport: { height: 360, width: 640 },
};

const creationEditCommand: ApplyStudioCreationEditWireCommandV1 = {
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  mathTexOutlines: [],
  nextRevision: "d".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 0.5,
      anchorResolvedSeconds: 0.5,
      anchorSource: { kind: "playhead", referenceSeconds: 0.5 },
      intentCount: 1,
      loweringSupported: true,
      operations: [
        {
          dependsOn: [],
          entity: {
            dimensions: {},
            id: "tx:create/entity:line",
            kind: "line",
            layout: null,
            lifetimeEnd: null,
            lifetimeStart: 0.5,
            text: null,
            texParts: null,
          },
          id: "create-line",
          interval: { end: 0.5, start: 0.5 },
          kind: "create",
          origin: "studio-default",
        },
        {
          dependsOn: ["create-line"],
          entityId: "tx:create/entity:line",
          id: "position-line",
          interval: { end: 0.5, start: 0.5 },
          kind: "position",
          origin: "studio-default",
          position: { x: 320, y: 180 },
        },
        {
          dependsOn: ["position-line"],
          entityId: "tx:create/entity:line",
          id: "fade-line",
          interval: { end: 0.9, start: 0.5 },
          kind: "fade-in",
          origin: "studio-default",
          persistent: true,
        },
      ],
      origin: "studio-default",
      requestedExecution: "parallel",
      scheduleEdgeCount: 4,
      scheduleMode: "dependency-dag",
      scheduleOrder: ["create-line", "position-line", "fade-line"],
      transactionId: "create",
    },
  ],
  schema: "poietra.apply-studio-creation-edit",
  textOutlines: [],
  version: 1,
  viewport: { height: 360, width: 640 },
};

const mathTexContent = { displayLines: ["F = ma"], label: "Force", texParts: ["F", "=", "ma"] } as const;
const mathTexContentEditCommand: ApplyStaticRootTransformEditWireCommandV1 = {
  ...staticRootTransformEditCommand,
  mathTexOutlines: [
    {
      entityId: "source:equation",
      path: {
        subpaths: [
          {
            closed: true,
            segments: [
              {
                control1: { x: 0.3, y: 0 },
                control2: { x: 0.7, y: 0 },
                end: { x: 1, y: 0 },
              },
            ],
            start: { x: 0, y: 0 },
          },
        ],
      },
      texParts: ["F", "=", "ma"],
    },
  ],
  nextRevision: "e".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 0,
      anchorResolvedSeconds: 0,
      anchorSource: { kind: "absolute", seconds: 0 },
      intentCount: 1,
      loweringSupported: true,
      operations: [
        {
          content: mathTexContent,
          dependsOn: [],
          entityId: "source:equation",
          id: "replace-equation",
          interval: { end: 0, start: 0 },
          kind: "math-tex-content",
          origin: "studio-default",
        },
      ],
      origin: "studio-default",
      requestedExecution: "parallel",
      scheduleEdgeCount: 0,
      scheduleMode: "parallel",
      scheduleOrder: ["replace-equation"],
      transactionId: "replace-equation",
    },
  ],
  sourceRuntimeBindings: [
    { runtimeEntityId: "runtime:equation", sourceIdentityKey: "equation", sourceName: "equation" },
  ],
  studioEntities: [
    {
      dimensions: {},
      id: "source:equation",
      kind: "math-tex",
      objectGraphKey: "source:equation",
      position: { x: 320, y: 180 },
      provisional: false,
      scale: 1,
      sourceIdentity: "equation",
    },
  ],
};

const studioMotionEditCommand: ApplyStudioMotionEditWireCommandV1 = {
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  nextRevision: "9".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 0.5,
      anchorResolvedSeconds: 0.5,
      anchorSource: { kind: "playhead", referenceSeconds: 0.5 },
      intentCount: 1,
      loweringSupported: true,
      operations: [
        {
          controlOffset: { x: 20, y: -40 },
          delta: { x: 120, y: 80 },
          dependsOn: [],
          easing: "smooth",
          id: "motion-1",
          interval: { end: 2, start: 0.5 },
          kind: "create-motion",
          origin: "direct-manipulation",
          targetEntityIds: ["source:circle"],
        },
      ],
      origin: "direct-manipulation",
      requestedExecution: "parallel",
      scheduleEdgeCount: 0,
      scheduleMode: "parallel",
      scheduleOrder: ["motion-1"],
      transactionId: "motion",
    },
  ],
  schema: "poietra.apply-studio-motion-edit",
  sourceRuntimeBindings: [{ runtimeEntityId: "later", sourceIdentityKey: "circle", sourceName: "circle" }],
  studioEntities: [{ objectGraphKey: "source:circle", provisional: false, sourceIdentity: "circle" }],
  version: 1,
  viewport: { height: 360, width: 640 },
};

const studioMotionProjectionCommand: ProjectStudioMotionEditWireCommandV1 = {
  baseDuration: 2,
  batch: {
    kind: "standalone",
    programs: studioMotionEditCommand.programs,
    studioEntities: [
      {
        lifetime: [{ end: 2, start: 0 }],
        objectGraphKey: "source:circle",
        position: { x: 320, y: 180 },
        provisional: false,
        sourceIdentity: "circle",
      },
    ],
  },
  schema: "poietra.project-studio-motion-edit",
  version: 1,
};

const boundEntityEditCommand: ApplyStudioBoundEntityEditWireCommandV1 = {
  candidates: [
    {
      baseCenter: { x: 320, y: 180 },
      baseOpacity: 1,
      capabilities: { paintOpacity: true, rotation: true, uniformScale: true },
      evidenceId: "binding:circle",
      phase: "construction",
      sceneEntityId: "later",
      sourceAnchor: 0,
      studioEntityId: "source:circle",
    },
  ],
  expectedBaseRevision: "a".repeat(64),
  frame: { height: 9, width: 16 },
  nextRevision: "b".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 0,
      anchorResolvedSeconds: 0,
      anchorSource: { kind: "absolute", seconds: 0 },
      intentCount: 1,
      loweringSupported: true,
      operations: [
        {
          dependsOn: [],
          entityId: "source:circle",
          id: "move-circle",
          interval: { end: 0, start: 0 },
          kind: "move",
          origin: "direct-manipulation",
          position: { x: 400, y: 180 },
        },
      ],
      origin: "direct-manipulation",
      requestedExecution: "parallel",
      scheduleEdgeCount: 0,
      scheduleMode: "parallel",
      scheduleOrder: ["move-circle"],
      transactionId: "move-circle",
    },
  ],
  schema: "poietra.apply-studio-bound-entity-edit",
  version: 1,
  viewport: { height: 360, width: 640 },
};

const studioTimelineEditCommand: ApplyStudioTimelineEditWireCommandV1 = {
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "c".repeat(64),
  programs: [
    {
      anchorCapturedPlayhead: 2,
      anchorResolvedSeconds: 2,
      anchorSource: { kind: "absolute", seconds: 2 },
      intentCount: 1,
      loweringSupported: true,
      operations: [
        {
          dependsOn: [],
          eventKind: "wait",
          id: "wait-1",
          interval: { end: 3.5, start: 2 },
          kind: "insert-wait",
          origin: "studio-default",
          purpose: "scene-duration",
        },
      ],
      origin: "studio-default",
      requestedExecution: "sequence",
      scheduleEdgeCount: 0,
      scheduleMode: "sequence",
      scheduleOrder: ["wait-1"],
      transactionId: "duration",
    },
  ],
  schema: "poietra.apply-studio-timeline-edit",
  version: 1,
};

const studioTimelineProjectionCommand: ProjectStudioTimelineWireCommandV1 = {
  baseDuration: 2,
  programs: studioTimelineEditCommand.programs,
  schema: "poietra.project-studio-timeline",
  version: 1,
};

const studioMathTexTransformProjectionCommand: ProjectStudioMathTexTransformWireCommandV1 = {
  baseDuration: 2,
  programs: [],
  schema: "poietra.project-studio-math-tex-transform",
  studioEntities: [],
  version: 1,
};

async function fixtureBundle() {
  const fixture = JSON.parse(
    await readFile(new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url), "utf8"),
  ) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

describe("Scene authoring WASM adapter", () => {
  it("forwards complete static imported-root commands without reconstructing them", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const transformResponse = {
      bundle,
      persistentRemoveProjection: {
        removals: [
          {
            affectedSceneEntityIds: ["later"],
            fadeInterval: { end: 1, start: 0.5 },
            operationId: "remove-circle",
            removedAt: 1,
            resultingLifetimeEnd: 1,
            sceneEntityId: "later",
            studioEntityId: "source:circle",
            transactionId: "remove-circle",
          },
        ],
      },
      staticRootProjection: {
        insertions: [],
        mutations: [
          {
            entityId: "source:circle",
            interval: { end: 0, start: 0 },
            kind: "position",
            operationId: "move-circle",
            transactionId: "move-circle",
            value: { x: 400, y: 180 },
          },
        ],
        projectedDuration: bundle.scene.duration,
      },
    } as const;
    const contentResponse = {
      bundle,
      persistentRemoveProjection: { removals: [] },
      staticRootProjection: {
        insertions: [],
        mutations: [
          {
            content: mathTexContent,
            entityId: "source:equation",
            interval: { end: 0, start: 0 },
            kind: "math-tex-content",
            operationId: "replace-equation",
            transactionId: "replace-equation",
          },
        ],
        projectedDuration: bundle.scene.duration,
      },
    } as const;
    const responses = [transformResponse, contentResponse];
    let responseIndex = 0;
    const compile = createApplyStaticRootTransformEditCompiler(async () => ({
      applyStaticRootTransformEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(responses[responseIndex++]));
      },
    }));

    await expect(compile(bundle, staticRootTransformEditCommand)).resolves.toEqual(transformResponse);
    expect(calls[1]).toEqual(staticRootTransformEditCommand);
    await expect(compile(bundle, mathTexContentEditCommand)).resolves.toEqual(contentResponse);
    expect(calls[3]).toEqual(mathTexContentEditCommand);
  });

  it("forwards one complete normalized Studio creation edit and base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const response = {
      bundle,
      creationProjection: {
        entities: [
          {
            createdLifetime: { end: bundle.scene.duration, start: 0.5 },
            entityId: "tx:create/entity:line",
            initialDimensions: {},
            initialRotation: 0,
            initialScale: 1,
            kind: "line",
            operationId: "create-line",
            transactionId: "create",
          },
        ],
        insertions: [],
        motions: [],
        mutations: [],
        projectedDuration: bundle.scene.duration,
        removals: [],
      },
      persistentRemoveProjection: { removals: [] },
    } as const;
    const compile = createApplyStudioCreationEditCompiler(async () => ({
      applyStudioCreationEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(response));
      },
    }));

    const result = await compile(bundle, creationEditCommand);
    expect(result).toEqual(response);
    expect(calls[1]).toEqual(creationEditCommand);
  });

  it("accepts Arrow in a Studio creation projection", async () => {
    const response = {
      entities: [
        {
          createdLifetime: { end: 2, start: 0 },
          entityId: "entity:arrow",
          initialDimensions: {},
          initialRotation: 0,
          initialScale: 1,
          kind: "arrow",
          operationId: "create:arrow",
          transactionId: "create:arrow",
        },
      ],
      insertions: [],
      motions: [],
      mutations: [
        {
          entityId: "entity:arrow",
          interval: { end: 0, start: 0 },
          kind: "opacity",
          operationId: "opacity:arrow",
          transactionId: "opacity:arrow",
          value: 0.4,
        },
        {
          entityId: "entity:arrow",
          from: 0,
          interval: { end: 0, start: 0 },
          kind: "rotation",
          operationId: "rotation:arrow",
          to: Math.PI / 6,
          transactionId: "rotation:arrow",
        },
      ],
      projectedDuration: 2,
      removals: [],
    } as const;
    const compile = createProjectStudioCreationCompiler(async () => ({
      projectStudioCreationEditV1: () => new TextEncoder().encode(JSON.stringify(response)),
    }));

    await expect(
      compile({
        baseDuration: 2,
        programs: [],
        schema: "poietra.project-studio-creation-edit",
        version: 1,
      }),
    ).resolves.toEqual(response);
  });

  it("returns the MathTex transform projection from the existing adapter", async () => {
    const bundle = await fixtureBundle();
    const command = {
      expectedBaseRevision: "a".repeat(64),
      frame: { height: 9, width: 16 },
      mathTexOutlines: [],
      nextRevision: "f".repeat(64),
      programs: [],
      schema: "poietra.apply-studio-math-tex-transform-edit",
      sourceRuntimeBindings: [],
      studioEntities: [],
      version: 1,
      viewport: { height: 360, width: 640 },
    } satisfies ApplyStudioMathTexTransformEditWireCommandV1;
    const response = {
      bundle,
      mathTexTransformProjection: { insertions: [], motions: [], projectedDuration: 2, replacements: [] },
      persistentRemoveProjection: { removals: [] },
    } as const;
    const calls: unknown[] = [];
    const compile = createApplyStudioMathTexTransformEditCompiler(async () => ({
      applyStudioMathTexTransformEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(response));
      },
    }));

    await expect(compile(bundle, command)).resolves.toEqual(response);
    expect(calls[1]).toEqual(command);
  });

  it("forwards one complete source-bound endpoint edit without reconstructing it", async () => {
    const bundle = await fixtureBundle();
    const response = {
      bundle,
      projection: {
        interval: { end: 0, start: 0 },
        kind: "position",
        operationId: "move-circle",
        studioEntityId: "source:circle",
        transactionId: "move-circle",
        value: { x: 400, y: 180 },
      },
    } as const;
    const calls: unknown[] = [];
    const compile = createApplyStudioBoundEntityEditCompiler(async () => ({
      applyStudioBoundEntityEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(response));
      },
    }));

    const result = await compile(bundle, boundEntityEditCommand);
    expect(result).toEqual(response);
    expect(result.bundle).toEqual(calls[0]);
    expect(calls[1]).toEqual(boundEntityEditCommand);
  });

  it("forwards one complete Studio motion edit and base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createApplyStudioMotionEditCompiler(async () => ({
      applyStudioMotionEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, studioMotionEditCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(studioMotionEditCommand);
  });

  it("forwards one complete normalized Studio timeline edit and base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createApplyStudioTimelineEditCompiler(async () => ({
      applyStudioTimelineEditV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, studioTimelineEditCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(studioTimelineEditCommand);
  });

  it("projects normalized Studio timeline Programs without reconstructing Rust semantics", async () => {
    const calls: unknown[] = [];
    const projection = {
      programProjections: [
        {
          operationId: "wait-1",
          transactionId: "duration",
          workingAnchor: 2,
          workingInterval: { end: 3.5, start: 2 },
        },
      ],
      projectedDuration: 3.5,
      transforms: [
        {
          interval: { end: 3.5, start: 2 },
          kind: "insert",
          operationId: "wait-1",
        },
      ],
    } as const;
    const project = createProjectStudioTimelineCompiler(async () => ({
      projectStudioTimelineV1: (commandJson) => {
        calls.push(JSON.parse(new TextDecoder().decode(commandJson)));
        return new TextEncoder().encode(JSON.stringify(projection));
      },
    }));

    await expect(project(studioTimelineProjectionCommand)).resolves.toEqual(projection);
    expect(calls).toEqual([studioTimelineProjectionCommand]);
  });

  it("projects normalized MathTex transform Programs without a Scene snapshot", async () => {
    const calls: unknown[] = [];
    const projection = {
      insertions: [],
      motions: [
        {
          control: { x: 340, y: 180 },
          controlOffset: { x: 0, y: 0 },
          delta: { x: 40, y: 0 },
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 1, start: 0 },
          operationId: "motion",
          sourceInterval: { end: 1, start: 0 },
          targetEntityId: "replacement",
          to: { x: 360, y: 180 },
          transactionId: "transform-motion",
        },
      ],
      projectedDuration: 2,
      replacements: [],
    } as const;
    const project = createProjectStudioMathTexTransformCompiler(async () => ({
      projectStudioMathTexTransformV1: (commandJson) => {
        calls.push(JSON.parse(new TextDecoder().decode(commandJson)));
        return new TextEncoder().encode(JSON.stringify(projection));
      },
    }));

    await expect(project(studioMathTexTransformProjectionCommand)).resolves.toEqual(projection);
    expect(calls).toEqual([studioMathTexTransformProjectionCommand]);
  });

  it("projects normalized motion Programs without a Scene snapshot", async () => {
    const calls: unknown[] = [];
    const projection = {
      insertions: [{ at: 0.5, duration: 1.5, transactionId: "motion" }],
      motions: [
        {
          control: { x: 400, y: 180 },
          controlOffset: { x: 20, y: -40 },
          delta: { x: 120, y: 80 },
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 2, start: 0.5 },
          operationId: "motion-1",
          sourceInterval: { end: 2, start: 0.5 },
          targetEntityId: "source:circle",
          to: { x: 440, y: 260 },
          transactionId: "motion",
        },
      ],
      projectedDuration: 3.5,
    } as const;
    const project = createProjectStudioMotionCompiler(async () => ({
      projectStudioMotionEditV1: (commandJson) => {
        calls.push(JSON.parse(new TextDecoder().decode(commandJson)));
        return new TextEncoder().encode(JSON.stringify(projection));
      },
    }));

    await expect(project(studioMotionProjectionCommand)).resolves.toEqual(projection);
    expect(calls).toEqual([studioMotionProjectionCommand]);
  });

  it("rejects malformed or incomplete Rust responses", async () => {
    const bundle = await fixtureBundle();
    const compileCreation = createApplyStudioCreationEditCompiler(async () => ({
      applyStudioCreationEditV1: () => new TextEncoder().encode("null"),
    }));
    const compileBoundEntity = createApplyStudioBoundEntityEditCompiler(async () => ({
      applyStudioBoundEntityEditV1: () => new TextEncoder().encode('{"scene":{}}'),
    }));
    const projectTimeline = createProjectStudioTimelineCompiler(async () => ({
      projectStudioTimelineV1: () =>
        new TextEncoder().encode(
          JSON.stringify({
            programProjections: [],
            projectedDuration: Number.NaN,
            transforms: [],
          }),
        ),
    }));
    const projectMathTex = createProjectStudioMathTexTransformCompiler(async () => ({
      projectStudioMathTexTransformV1: () =>
        new TextEncoder().encode(
          JSON.stringify({ insertions: [], projectedDuration: 2, replacements: [{ targetType: "text" }] }),
        ),
    }));
    await expect(compileCreation(bundle, creationEditCommand)).rejects.toThrow();
    await expect(compileBoundEntity(bundle, boundEntityEditCommand)).rejects.toThrow();
    await expect(projectTimeline(studioTimelineProjectionCommand)).rejects.toThrow();
    await expect(projectMathTex(studioMathTexTransformProjectionCommand)).rejects.toThrow();
  });
});
