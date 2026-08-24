import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { createCircleProgram, mathTexTransformProgram } from "./manim-render-pipeline-test-fixtures";
import { lowerManimRenderRequest, type SnapshotProgramAuthorizer } from "./manim-render-request-lowering";

const frame = { height: 8, width: 14.222 } as const;
const sourcePath = "scene.py";
const entityId = "source:scene.py#GroupedEquation:equation";
const exampleScenesSourcePath = "example_scenes/basic.py";
const warpSquareEntityId = `source:${exampleScenesSourcePath}#WarpSquare:square`;
const exampleScenesSource = readFileSync(
  new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const updatersSceneName = "UpdatersExample";
const updatersSquareEntityId = `source:${exampleScenesSourcePath}#${updatersSceneName}:square`;
const openingSceneName = "OpeningManim";
const openingGridTitleEntityId = `source:${exampleScenesSourcePath}#${openingSceneName}:grid_title`;
const staticSquareSourcePath = "scenes/static_square.py";
const staticSquareSceneName = "StaticSquare";
const staticSquareEntityId = `source:${staticSquareSourcePath}#${staticSquareSceneName}:square`;
const staticSquareSource = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
const sceneSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;

const sceneSourceWithDestination = `${sceneSource}
class NextScene(Scene):
    def construct(self):
        title = Text("Next")
        self.add(title)
`;
const unsupportedProgramBatchError = {
  message: "The Rust Scene core does not support this complete Program batch.",
  status: 400,
} as const;

function motionProgram(anchor: number, transactionId: string, targetEntityId = entityId): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + 1, start: anchor },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: [targetEntityId],
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function staticRootMoveProgram(transactionId: string, anchor = 7): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId,
    id: `tx:${transactionId}/operation:position`,
    interval: { end: anchor, start: anchor },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["direct manipulation"], origin: "direct-manipulation" },
    value: { x: 320, y: 180 },
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["direct manipulation"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function mathTexContentProgram(transactionId: string): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId,
    id: `tx:${transactionId}/operation:content`,
    interval: { end: 0, start: 0 },
    key: "content",
    kind: "SetProperty",
    provenance: { evidence: ["Inspector MathTex content"], origin: "studio-default" },
    value: {
      displayLines: ["F = ma"],
      label: "F = ma",
      texParts: ["F", "=", "m", "a"],
    },
  };
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "playhead", referenceSeconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["Inspector MathTex content"], origin: "studio-default" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function sceneBoundaryProgram(anchor: number, transactionId: string): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    at: anchor,
    dependsOn: [],
    destination: "next-scene",
    id: `tx:${transactionId}/operation:scene-boundary`,
    interval: { end: anchor, start: anchor },
    kind: "InsertSceneBoundary",
    provenance: { evidence: [], origin: "direct-manipulation" },
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function request(program = motionProgram(7, "render-request-lowering")): ProgramRenderRequest {
  return {
    destination: null,
    program,
    projectId: "default",
    sceneName: "GroupedEquation",
    sourceBindings: [{ entityId, sourceVariable: "equation" }],
    sourceHash: createHash("sha256").update(sceneSource).digest("hex"),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function lower(
  renderRequest: ProgramRenderRequest,
  originalSource = sceneSource,
  snapshotProgramAuthorizer: SnapshotProgramAuthorizer | null = null,
) {
  return lowerManimRenderRequest({
    frame,
    originalSource,
    snapshotProgramAuthorizer,
    projectId: "default",
    request: renderRequest,
  });
}

describe("Manim render request lowering", () => {
  it("routes one generic StaticSquare source-time-zero move through fresh V3 source evidence", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: staticSquareEntityId,
      id: "generic-v3-position-edit",
      interval: { end: 0, start: 0 },
      key: "position",
      kind: "SetProperty",
      provenance: { evidence: ["Runtime Trace root"], origin: "direct-manipulation" },
      value: { x: 410, y: 135 },
    };
    const editProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["source-time zero"],
        resolvedSeconds: 0,
        source: { kind: "absolute", seconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["Runtime Trace edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-v3-move-edit",
      version: 1,
    };

    const result = await lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: staticSquareSource,
      snapshotProgramAuthorizer: null,
      projectId: "generic-preview",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "generic-preview",
        sceneName: staticSquareSceneName,
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId: staticSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(staticSquareSource, "utf8").digest("hex"),
        sourcePath: staticSquareSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.insertedCode).toBe("        square.move_to((2, 1, 0))");
    expect(result.lowered.preflight).toMatchObject({
      baseBinding: { name: "square", ordinal: 1 },
      entityId: staticSquareEntityId,
      expectedWorldCenter: { x: 2, y: 1 },
      kind: "runtime-trace-move-edit",
    });
    expect(result.lowered.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n        square.move_to((2, 1, 0))",
    );
  });

  it("routes one generic StaticSquare source-time-zero uniform resize through fresh V3 source evidence", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      easing: "smooth",
      entityId: staticSquareEntityId,
      from: 1,
      id: "generic-v3-scale-edit",
      interval: { end: 0, start: 0 },
      key: "scale",
      kind: "AnimateProperty",
      provenance: { evidence: ["Runtime Trace root"], origin: "direct-manipulation" },
      relativeFactor: 1.5,
      to: 1.5,
    };
    const editProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["source-time zero"],
        resolvedSeconds: 0,
        source: { kind: "absolute", seconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["Runtime Trace edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-v3-resize-edit",
      version: 1,
    };

    const result = await lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: staticSquareSource,
      snapshotProgramAuthorizer: null,
      projectId: "generic-preview",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "generic-preview",
        sceneName: staticSquareSceneName,
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId: staticSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(staticSquareSource, "utf8").digest("hex"),
        sourcePath: staticSquareSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.insertedCode).toBe("        square.scale(1.5)");
    expect(result.lowered.preflight).toMatchObject({
      baseBinding: { name: "square", ordinal: 1 },
      entityId: staticSquareEntityId,
      expectedScaleFactor: 1.5,
      kind: "runtime-trace-resize-edit",
    });
    expect(result.lowered.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n        square.scale(1.5)",
    );
  });

  it("routes a former pinned Scene name through generic Runtime Trace evidence", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: warpSquareEntityId,
      id: "warp-square-position",
      interval: { end: 0, start: 0 },
      key: "position",
      kind: "SetProperty",
      provenance: { evidence: ["verified generic source-time zero"], origin: "direct-manipulation" },
      value: { x: 410, y: 135 },
    };
    const editProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 0,
        evidence: ["verified generic source-time zero"],
        resolvedSeconds: 0,
        source: { kind: "absolute", seconds: 0 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["generic Runtime Trace edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-warp-square-transform-edit",
      version: 1,
    };
    const result = await lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: exampleScenesSource,
      snapshotProgramAuthorizer: null,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: "WarpSquare",
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId: warpSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.preflight?.kind).toBe("runtime-trace-move-edit");
    expect(result.lowered.source).toContain("        square.move_to((2, 1, 0))\n        self.play(");
  });

  it("routes a former Updaters profile resize through the generic five-second wait boundary", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      easing: "smooth",
      entityId: updatersSquareEntityId,
      from: 1,
      id: "updaters-terminal-resize",
      interval: { end: 5, start: 5 },
      key: "scale",
      kind: "AnimateProperty",
      provenance: { evidence: ["verified UpdatersExample terminal boundary"], origin: "direct-manipulation" },
      relativeFactor: 1.5,
      to: 1.5,
    };
    const editProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 5,
        evidence: ["verified UpdatersExample terminal boundary"],
        resolvedSeconds: 5,
        source: { kind: "playhead", referenceSeconds: 5 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["UpdatersExample terminal edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "updaters-terminal-v1-resize",
      version: 1,
    };
    const result = await lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: exampleScenesSource,
      snapshotProgramAuthorizer: null,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: updatersSceneName,
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId: updatersSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.preflight).toMatchObject({
      baseBinding: { name: "square" },
      entityId: updatersSquareEntityId,
      expectedScaleFactor: 1.5,
      kind: "runtime-trace-resize-edit",
      sourceAnchor: 5,
    });
    expect(result.lowered.source).toContain(
      "            run_time=5,\n        )\n        square.scale(1.5)\n        self.wait()",
    );
  });

  it("routes a former Opening profile move through its generic terminal wait boundary", async () => {
    const targetWorld = { x: 1.25, y: -0.5 };
    const viewport = { height: 360, width: 640 } as const;
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: openingGridTitleEntityId,
      id: "opening-terminal-position",
      interval: { end: 13, start: 13 },
      key: "position",
      kind: "SetProperty",
      provenance: { evidence: ["verified OpeningManim terminal root"], origin: "direct-manipulation" },
      value: {
        x: (targetWorld.x / (128 / 9) + 0.5) * viewport.width,
        y: (0.5 - targetWorld.y / 8) * viewport.height,
      },
    };
    const editProgram: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 13,
        evidence: ["verified final static wait start"],
        resolvedSeconds: 13,
        source: { kind: "playhead", referenceSeconds: 13 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["OpeningManim terminal edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "opening-terminal-v2-position",
      version: 1,
    };

    const result = await lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: exampleScenesSource,
      snapshotProgramAuthorizer: null,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: openingSceneName,
        sourceValidation: "runtime-trace",
        sourceBindings: [{ entityId: openingGridTitleEntityId, sourceVariable: "grid_title" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport,
      },
    });

    expect(result.lowered.preflight).toMatchObject({
      baseBinding: { name: "grid_title" },
      entityId: openingGridTitleEntityId,
      expectedWorldCenter: targetWorld,
      kind: "runtime-trace-move-edit",
      sourceAnchor: 13,
    });
    expect(result.lowered.insertedCode).toBe("        grid_title.move_to((1.25, -0.5, 0))");
    expect(result.lowered.source).toContain(
      "        self.play(Transform(grid_title, grid_transform_title))\n" +
        "        grid_title.move_to((1.25, -0.5, 0))\n" +
        "        self.wait()",
    );
  });

  it("routes a multi-motion batch through snapshot authorization in source-anchor order", async () => {
    const later = motionProgram(7, "batch-later");
    const earlier = motionProgram(5, "batch-earlier");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      programs: [later, earlier],
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(renderRequest, sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(renderRequest.programs?.map((program) => program.transactionId)).toEqual(["batch-later", "batch-earlier"]);
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs.map((program) => program.transactionId)).toEqual([
      "batch-earlier",
      "batch-later",
    ]);
    expect(result.renderRequest.program.transactionId).toBe("batch-earlier");
    expect(result.renderRequest.programs?.map((program) => program.transactionId)).toEqual([
      "batch-earlier",
      "batch-later",
    ]);
    expect(result.lowered.source.indexOf('poietra:transaction "batch-earlier"')).toBeLessThan(
      result.lowered.source.indexOf('poietra:transaction "batch-later"'),
    );
  });

  it("fails a multi-motion batch closed without snapshot authorization", async () => {
    const later = motionProgram(7, "batch-without-authority-later");
    const earlier = motionProgram(5, "batch-without-authority-earlier");

    await expect(lower({ ...request(later), programs: [later, earlier] })).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("routes one Program with multiple motion operations through exact snapshot authorization", async () => {
    const first = motionProgram(5, "multi-operation-motion");
    const secondOperation = motionProgram(6.5, "second-operation").operations[0];
    if (!secondOperation || secondOperation.kind !== "CreateMotion") {
      throw new Error("The second motion fixture is malformed.");
    }
    const combined: CanonicalEditProgram = {
      ...first,
      intentCount: 2,
      operations: [...first.operations, secondOperation],
      schedule: {
        edges: [{ from: first.operations[0]!.id, reason: "explicit", to: secondOperation.id }],
        mode: "sequence",
        order: [first.operations[0]!.id, secondOperation.id],
      },
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(combined), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([combined]);
    expect(result.lowered.source.match(/equation\.animate\.shift/g)).toHaveLength(2);
  });

  it("routes exactly one imported CreateMotion Program through snapshot authorization", async () => {
    const program = motionProgram(7, "single-motion-authority");
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(program), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({
      frame,
      programs: [program],
      projectId: "default",
      request: { sceneName: "GroupedEquation", sourcePath },
    });
    expect(authorizations[0]?.runtimeSceneState.objectGraph.entities[entityId]).toMatchObject({
      id: entityId,
      provisional: false,
      sourceIdentity: { kind: "known", value: "equation" },
    });
    expect(result.lowered.source).toContain("equation.animate.shift(1.4222 * RIGHT)");
  });

  it("fails exactly one imported CreateMotion Program closed without snapshot authorization", async () => {
    await expect(lower(request(motionProgram(7, "single-motion-without-authority")))).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("routes one complete MathTex A-to-B-to-A Program through snapshot authorization", async () => {
    const program = mathTexTransformProgram("authorized-mathtex-transform");
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(program), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([program]);
    expect(result.lowered.source.match(/TransformMatchingTex\(/g)).toHaveLength(2);
    expect(result.lowered.source.indexOf("poietra_authorized_mathtex_transform_1")).toBeLessThan(
      result.lowered.source.indexOf("poietra_authorized_mathtex_transform_2"),
    );
  });

  it("fails a complete MathTex transform Program closed without snapshot authorization", async () => {
    await expect(lower(request(mathTexTransformProgram("mathtex-transform-without-authority")))).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("fails an imported MathTex Inspector content replacement closed without snapshot authorization", async () => {
    await expect(lower(request(mathTexContentProgram("mathtex-content-without-authority")))).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("routes a MathTex transform chain followed by motion through one snapshot authorization", async () => {
    const transform = mathTexTransformProgram("mixed-mathtex-transform");
    const finalTargetEntityId = "tx:mixed-mathtex-transform/entity:restored";
    const motion = motionProgram(7, "motion-after-mathtex-transform", finalTargetEntityId);
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower({ ...request(transform), programs: [transform, motion] }, sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([transform, motion]);
    expect(result.lowered.source.match(/TransformMatchingTex\(/g)).toHaveLength(2);
    expect(result.lowered.source).toContain("poietra_mixed_mathtex_transform_2.animate.shift(");
    expect(result.lowered.source.lastIndexOf("TransformMatchingTex(")).toBeLessThan(
      result.lowered.source.indexOf("poietra_mixed_mathtex_transform_2.animate.shift("),
    );
  });

  it("does not dispatch a Runtime Trace MathTex transform to snapshot authorization", async () => {
    const program = mathTexTransformProgram("runtime-trace-mathtex-transform");
    let authorizerCalls = 0;

    await expect(
      lower({ ...request(program), sourceValidation: "runtime-trace" }, sceneSource, async () => {
        authorizerCalls += 1;
      }),
    ).rejects.toMatchObject({
      message: "The requested Runtime Trace validation does not support this edit.",
      status: 400,
    });
    expect(authorizerCalls).toBe(0);
  });

  it("routes the complete Studio creation family through snapshot authorization", async () => {
    const baseCreation = createCircleProgram("snapshot-created-circle");
    const creation: CanonicalEditProgram = {
      ...baseCreation,
      operations: baseCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? { ...operation, entity: { ...operation.entity, dimensions: { radius: 1 } } }
          : operation,
      ),
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(creation), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([creation]);
    expect(result.lowered.source).toContain("Circle(radius=1)");
  });

  it("routes Arrow creation through snapshot authorization and Manim lowering", async () => {
    const baseCreation = createCircleProgram("snapshot-created-arrow");
    const creation: CanonicalEditProgram = {
      ...baseCreation,
      operations: baseCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? { ...operation, entity: { ...operation.entity, dimensions: {}, type: "Arrow" } }
          : operation,
      ),
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(creation), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations[0]?.programs).toEqual([creation]);
    expect(result.lowered.source).toContain("Arrow(LEFT, RIGHT, buff=0)");
  });

  it("rejects dimensionless Circle creation without a Rust authorizer", async () => {
    const creation = createCircleProgram("legacy-dimensionless-circle");
    let authorizerCalls = 0;

    await expect(
      lower(request(creation), sceneSource, async () => {
        authorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);

    expect(authorizerCalls).toBe(0);
  });

  it("routes canonical Text creation through snapshot authorization and Manim lowering", async () => {
    const circleCreation = createCircleProgram("text-creation");
    const creation: CanonicalEditProgram = {
      ...circleCreation,
      operations: circleCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? {
              ...operation,
              entity: {
                ...operation.entity,
                content: { displayLines: ["Hello"], label: "Hello", text: "Hello" },
                type: "Text",
              },
            }
          : operation,
      ),
    };
    const fillOperation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: "tx:text-creation/entity:circle",
      id: "text-creation-fill/operation",
      interval: { end: 5, start: 5 },
      key: "fillColor",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "direct-manipulation" },
      value: "#22c55e",
    };
    const fill: CanonicalEditProgram = {
      ...creation,
      intentCount: 1,
      operations: [fillOperation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [fillOperation.id] },
      transactionId: "text-creation-fill",
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower({ ...request(creation), programs: [creation, fill] }, sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([creation, fill]);
    expect(result.lowered.source).toContain(
      'Text("Hello", font="DejaVu Sans", disable_ligatures=True).scale_to_fit_height(1)',
    );
    expect(result.lowered.source).toContain('.set_fill("#22c55e", opacity=1)');
    expect(result.lowered.source.indexOf('.set_fill("#22c55e", opacity=1)')).toBeLessThan(
      result.lowered.source.indexOf("FadeIn(", result.lowered.source.indexOf('.set_fill("#22c55e", opacity=1)')),
    );

    const secondFillOperation: CanonicalEditOperation = {
      ...fillOperation,
      id: "text-creation-second-fill/operation",
      value: "#ef4444",
    };
    const combinedFill: CanonicalEditProgram = {
      ...fill,
      intentCount: 2,
      operations: [fillOperation, secondFillOperation],
      schedule: {
        edges: [],
        mode: "parallel",
        order: [fillOperation.id, secondFillOperation.id],
      },
      transactionId: "text-creation-combined-fill",
    };
    let rejectedAuthorizerCalls = 0;
    await expect(
      lower({ ...request(creation), programs: [creation, combinedFill] }, sceneSource, async () => {
        rejectedAuthorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);
    expect(rejectedAuthorizerCalls).toBe(0);

    const mathTexBase = createCircleProgram("mathtex-creation");
    const mathTexEntityId = "tx:mathtex-creation/entity:circle";
    const mathTexOperations: CanonicalEditOperation[] = mathTexBase.operations.map((operation) => {
      if (operation.kind === "CreateEntity") {
        return {
          ...operation,
          entity: {
            ...operation.entity,
            content: { displayLines: ["E = mc^2"], texParts: ["E", "=", "m", "c^2"] },
            type: "MathTex",
          },
        };
      }
      if (operation.kind !== "ChangePresence") return operation;
      return {
        dependsOn: operation.dependsOn,
        easing: "linear",
        entityId: operation.entityId,
        id: operation.id,
        interval: operation.interval,
        kind: "WriteIn",
        provenance: operation.provenance,
      };
    });
    const mathTexCreation: CanonicalEditProgram = {
      ...mathTexBase,
      operations: mathTexOperations,
      schedule: { ...mathTexBase.schedule, order: mathTexOperations.map(({ id }) => id) },
    };
    const mathTexFillOperation: CanonicalEditOperation = {
      ...fillOperation,
      entityId: mathTexEntityId,
      id: "mathtex-creation-fill/operation",
    };
    const mathTexFill: CanonicalEditProgram = {
      ...fill,
      operations: [mathTexFillOperation],
      schedule: { edges: [], mode: "parallel", order: [mathTexFillOperation.id] },
      transactionId: "mathtex-creation-fill",
    };
    const transform = mathTexTransformProgram("created-mathtex-transform", mathTexEntityId);
    const mathTexAuthorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];
    const mathTexResult = await lower(
      { ...request(mathTexCreation), programs: [mathTexCreation, mathTexFill, transform] },
      sceneSource,
      async (input) => {
        mathTexAuthorizations.push(input);
      },
    );

    expect(mathTexAuthorizations[0]?.programs).toEqual([mathTexCreation, mathTexFill, transform]);
    expect(mathTexResult.lowered.source.match(/\.set_fill\("#22c55e", opacity=1\)/gu)).toHaveLength(3);
    expect(mathTexResult.lowered.source.indexOf('.set_fill("#22c55e", opacity=1)')).toBeLessThan(
      mathTexResult.lowered.source.indexOf("Write("),
    );
    expect(mathTexResult.lowered.source.lastIndexOf('.set_fill("#22c55e", opacity=1)')).toBeLessThan(
      mathTexResult.lowered.source.lastIndexOf("TransformMatchingTex("),
    );

    const invalidWriteOperations = mathTexOperations.map((operation) =>
      operation.kind === "WriteIn" ? { ...operation, interval: { end: 5.4, start: 5.1 } } : operation,
    );
    const invalidWriteCreation: CanonicalEditProgram = {
      ...mathTexCreation,
      operations: invalidWriteOperations,
      schedule: { ...mathTexCreation.schedule, order: invalidWriteOperations.map(({ id }) => id) },
    };
    let invalidWriteAuthorizerCalls = 0;
    await expect(
      lower(request(invalidWriteCreation), sceneSource, async () => {
        invalidWriteAuthorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);
    expect(invalidWriteAuthorizerCalls).toBe(0);
  });

  it("rejects non-canonical Text creation before snapshot authorization", async () => {
    const circleCreation = createCircleProgram("invalid-text-creation");
    const creation: CanonicalEditProgram = {
      ...circleCreation,
      operations: circleCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? {
              ...operation,
              entity: {
                ...operation.entity,
                content: { displayLines: ["two\tlines"], label: "two lines", text: "two\tlines" },
                type: "Text",
              },
            }
          : operation,
      ),
    };
    let authorizerCalls = 0;

    await expect(
      lower(request(creation), sceneSource, async () => {
        authorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);

    expect(authorizerCalls).toBe(0);
  });

  it("routes creation followed by motion through the same snapshot authorization", async () => {
    const baseCreation = createCircleProgram("created-before-motion");
    const creation: CanonicalEditProgram = {
      ...baseCreation,
      operations: baseCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? { ...operation, entity: { ...operation.entity, dimensions: { radius: 1 } } }
          : operation,
      ),
    };
    const createdEntityId = "tx:created-before-motion/entity:circle";
    const movement = motionProgram(7, "move-created-circle", createdEntityId);
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower({ ...request(creation), programs: [creation, movement] }, sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([creation, movement]);
    expect(result.lowered.source.indexOf("Circle(radius=1)")).toBeLessThan(
      result.lowered.source.indexOf(".animate.shift("),
    );
  });

  it("routes created-object appearance and rotation through the same snapshot authorization", async () => {
    const baseCreation = createCircleProgram("created-before-appearance");
    const creation: CanonicalEditProgram = {
      ...baseCreation,
      operations: baseCreation.operations.map((operation) =>
        operation.kind === "CreateEntity"
          ? { ...operation, entity: { ...operation.entity, dimensions: { radius: 1 } } }
          : operation,
      ),
    };
    const createdEntityId = "tx:created-before-appearance/entity:circle";
    const followup = (transactionId: string, operation: CanonicalEditOperation): CanonicalEditProgram => ({
      anchor: creation.anchor,
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId,
      version: 1,
    });
    const opacity = followup("created-opacity", {
      dependsOn: [],
      entityId: createdEntityId,
      id: "created-opacity/operation",
      interval: { end: 5, start: 5 },
      key: "appearance",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "direct-manipulation" },
      value: 0.4,
    });
    const rotation = followup("created-rotation", {
      dependsOn: [],
      easing: "smooth",
      entityId: createdEntityId,
      from: 0,
      id: "created-rotation/operation",
      interval: { end: 5, start: 5 },
      key: "rotation",
      kind: "AnimateProperty",
      provenance: { evidence: [], origin: "direct-manipulation" },
      relativeDelta: Math.PI / 6,
      to: Math.PI / 6,
    });
    const fill = followup("created-fill", {
      dependsOn: [],
      entityId: createdEntityId,
      id: "created-fill/operation",
      interval: { end: 5, start: 5 },
      key: "fillColor",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "direct-manipulation" },
      value: "#12abef",
    });
    const stroke = followup("created-stroke", {
      dependsOn: [],
      entityId: createdEntityId,
      id: "created-stroke/operation",
      interval: { end: 5, start: 5 },
      key: "strokeColor",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "direct-manipulation" },
      value: "#fedcba",
    });
    const programs = [creation, opacity, fill, stroke, rotation];
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower({ ...request(creation), programs }, sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations[0]?.programs).toEqual(programs);
    expect(result.lowered.source).toContain(".set_opacity(0.4)");
    expect(result.lowered.source).toContain('.set_fill("#12abef", opacity=0.4)');
    expect(result.lowered.source).toContain('.set_stroke("#fedcba")');
    expect(result.lowered.source).toContain(".rotate(0.5236)");

    const lineBase = createCircleProgram("created-line-style", "line");
    const lineEntityId = "tx:created-line-style/entity:line";
    const lineOperations = lineBase.operations.map((operation): CanonicalEditOperation => {
      if (operation.kind === "CreateEntity") {
        return { ...operation, entity: { ...operation.entity, dimensions: {}, type: "Line" } };
      }
      if (operation.kind !== "ChangePresence") return operation;
      return {
        dependsOn: operation.dependsOn,
        easing: "linear",
        entityId: operation.entityId,
        id: operation.id,
        interval: operation.interval,
        kind: "DrawIn",
        provenance: operation.provenance,
      };
    });
    const lineCreation: CanonicalEditProgram = {
      ...lineBase,
      operations: lineOperations,
      schedule: { ...lineBase.schedule, order: lineOperations.map(({ id }) => id) },
    };
    const lineStyle = (
      transactionId: string,
      key: "strokeCap" | "strokeColor" | "strokeWidth",
      value: string | number,
    ) => {
      const operation: CanonicalEditOperation = {
        dependsOn: [],
        entityId: lineEntityId,
        id: `${transactionId}/operation`,
        interval: { end: 5, start: 5 },
        key,
        kind: "SetProperty",
        provenance: { evidence: [], origin: "direct-manipulation" },
        value,
      };
      return {
        ...lineCreation,
        operations: [operation],
        schedule: { edges: [], mode: "parallel" as const, order: [operation.id] },
        transactionId,
      };
    };
    const lineStroke = lineStyle("created-line-stroke", "strokeColor", "#fedcba");
    const lineWidth = lineStyle("created-line-width", "strokeWidth", 0.08);
    const lineCap = lineStyle("created-line-cap", "strokeCap", "round");
    const lineAuthorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];
    const lineResult = await lower(
      { ...request(lineCreation), programs: [lineCreation, lineStroke, lineWidth, lineCap] },
      sceneSource,
      async (input) => {
        lineAuthorizations.push(input);
      },
    );

    expect(lineAuthorizations[0]?.programs).toEqual([lineCreation, lineStroke, lineWidth, lineCap]);
    const initialStroke = '.set_stroke("#fedcba", width=8)';
    const initialCap = ".set_cap_style(CapStyleType.ROUND)";
    expect(lineResult.lowered.source).toContain(initialStroke);
    expect(lineResult.lowered.source).toContain(initialCap);
    expect(lineResult.lowered.source.indexOf(initialStroke)).toBeLessThan(lineResult.lowered.source.indexOf("Create("));
    expect(lineResult.lowered.source.indexOf(initialCap)).toBeLessThan(lineResult.lowered.source.indexOf("Create("));

    const invalidLineWidth = lineStyle("invalid-line-width", "strokeWidth", 0.501);
    let invalidLineAuthorizerCalls = 0;
    await expect(
      lower({ ...request(lineCreation), programs: [lineCreation, invalidLineWidth] }, sceneSource, async () => {
        invalidLineAuthorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);
    expect(invalidLineAuthorizerCalls).toBe(0);

    const invalidLineCap = lineStyle("invalid-line-cap", "strokeCap", "projecting");
    let invalidLineCapAuthorizerCalls = 0;
    await expect(
      lower({ ...request(lineCreation), programs: [lineCreation, invalidLineCap] }, sceneSource, async () => {
        invalidLineCapAuthorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);
    expect(invalidLineCapAuthorizerCalls).toBe(0);

    const lateLineCap: CanonicalEditProgram = {
      ...lineStyle("late-line-cap", "strokeCap", "square"),
      operations: [
        {
          ...lineStyle("late-line-cap", "strokeCap", "square").operations[0]!,
          interval: { end: 6, start: 6 },
        },
      ],
    };
    let lateLineCapAuthorizerCalls = 0;
    await expect(
      lower({ ...request(lineCreation), programs: [lineCreation, lateLineCap] }, sceneSource, async () => {
        lateLineCapAuthorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);
    expect(lateLineCapAuthorizerCalls).toBe(0);
  });

  it("rejects a created entity plus an imported transform as an unsupported mixed family", async () => {
    const creation = createCircleProgram("created-with-imported-transform");
    const importedMove = staticRootMoveProgram("move-imported-after-create");
    let authorizerCalls = 0;

    await expect(
      lower({ ...request(creation), programs: [creation, importedMove] }, sceneSource, async () => {
        authorizerCalls += 1;
      }),
    ).rejects.toMatchObject(unsupportedProgramBatchError);

    expect(authorizerCalls).toBe(0);
  });

  it("requires snapshot authorization for an imported static-root transform-only batch", async () => {
    const program = staticRootMoveProgram("static-root-move");
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(request(program), sceneSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([program]);
    expect(result.lowered.source).toContain("equation.move_to((0, 0, 0))");
  });

  it("authorizes and lowers repeated imported selection rotation as one ordered final-render history", async () => {
    const groupSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        left = Circle()
        right = Circle()
        self.add(left, right)
        # poietra:anchor 0.000
        self.wait(1)
`;
    const leftId = "source:scene.py#GroupedEquation:left";
    const rightId = "source:scene.py#GroupedEquation:right";
    const groupProgram = (
      transactionId: string,
      left: Readonly<{ x: number; y: number }>,
      right: Readonly<{ x: number; y: number }>,
    ): CanonicalEditProgram => {
      const operations: CanonicalEditOperation[] = [
        {
          dependsOn: [],
          entityId: leftId,
          id: `tx:${transactionId}/operation:left-position`,
          interval: { end: 0, start: 0 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: ["selection move"], origin: "direct-manipulation" },
          value: left,
        },
        {
          dependsOn: [],
          entityId: rightId,
          id: `tx:${transactionId}/operation:right-position`,
          interval: { end: 0, start: 0 },
          key: "position",
          kind: "SetProperty",
          provenance: { evidence: ["selection move"], origin: "direct-manipulation" },
          value: right,
        },
      ];
      return {
        anchor: {
          capturedPlayhead: 0,
          evidence: ["captured-playhead:0.000"],
          resolvedSeconds: 0,
          source: { kind: "playhead", referenceSeconds: 0 },
        },
        intentCount: 1,
        loweringStatus: "supported",
        operations,
        provenance: { evidence: ["selection move"], origin: "direct-manipulation" },
        requestedExecution: "parallel",
        schedule: { edges: [], mode: "parallel", order: operations.map(({ id }) => id) },
        transactionId,
        version: 1,
      };
    };
    const first = groupProgram("move-selection", { x: 340, y: 170 }, { x: 420, y: 170 });
    const second = groupProgram("move-selection-again", { x: 370, y: 190 }, { x: 450, y: 190 });
    const rotationPositions = groupProgram("rotate-selection", { x: 410, y: 230 }, { x: 410, y: 150 });
    const rotations: CanonicalEditOperation[] = [leftId, rightId].map((targetEntityId, index) => ({
      dependsOn: [],
      easing: "smooth",
      entityId: targetEntityId,
      from: 0,
      id: `tx:rotate-selection/operation:rotation-${index}`,
      interval: { end: 0, start: 0 },
      key: "rotation",
      kind: "AnimateProperty",
      provenance: { evidence: ["selection rotation"], origin: "direct-manipulation" },
      relativeDelta: Math.PI / 2,
      to: Math.PI / 2,
    }));
    const rotation = {
      ...rotationPositions,
      operations: [...rotationPositions.operations, ...rotations],
      schedule: {
        ...rotationPositions.schedule,
        order: [...rotationPositions.schedule.order, ...rotations.map(({ id }) => id)],
      },
    } satisfies CanonicalEditProgram;
    const secondRotationPositions = groupProgram("rotate-selection-again", { x: 450, y: 190 }, { x: 370, y: 190 });
    const secondRotations: CanonicalEditOperation[] = [leftId, rightId].map((targetEntityId, index) => ({
      dependsOn: [],
      easing: "smooth",
      entityId: targetEntityId,
      from: 0,
      id: `tx:rotate-selection-again/operation:rotation-${index}`,
      interval: { end: 0, start: 0 },
      key: "rotation",
      kind: "AnimateProperty",
      provenance: { evidence: ["selection rotation"], origin: "direct-manipulation" },
      relativeDelta: Math.PI / 2,
      to: Math.PI / 2,
    }));
    const secondRotation = {
      ...secondRotationPositions,
      operations: [...secondRotationPositions.operations, ...secondRotations],
      schedule: {
        ...secondRotationPositions.schedule,
        order: [...secondRotationPositions.schedule.order, ...secondRotations.map(({ id }) => id)],
      },
    } satisfies CanonicalEditProgram;
    const programs = [first, second, rotation, secondRotation];
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(
      {
        ...request(first),
        programs,
        sourceBindings: [
          { entityId: leftId, sourceVariable: "left" },
          { entityId: rightId, sourceVariable: "right" },
        ],
        sourceHash: createHash("sha256").update(groupSource).digest("hex"),
      },
      groupSource,
      async (input) => {
        authorizations.push(input);
      },
    );

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual(programs);
    expect(result.lowered.insertedCode.match(/left\.move_to\(/g)).toHaveLength(4);
    expect(result.lowered.insertedCode.match(/right\.move_to\(/g)).toHaveLength(4);
    expect(result.lowered.insertedCode.match(/\.rotate\(/g)).toHaveLength(4);
    expect(result.lowered.insertedCode.indexOf('poietra:transaction "move-selection"')).toBeLessThan(
      result.lowered.insertedCode.indexOf('poietra:transaction "move-selection-again"'),
    );
    expect(result.lowered.insertedCode.indexOf('poietra:transaction "rotate-selection"')).toBeLessThan(
      result.lowered.insertedCode.indexOf('poietra:transaction "rotate-selection-again"'),
    );
  });

  it("routes an imported static transform followed by motion through one snapshot authorization", async () => {
    const transform = staticRootMoveProgram("static-before-motion", 0);
    const movement = motionProgram(7, "motion-after-static");
    const staticMotionSource = sceneSource.replace(
      "        self.add(equation)\n",
      "        self.add(equation)\n        # poietra:anchor 0.000\n",
    );
    const renderRequest = {
      ...request(transform),
      programs: [transform, movement],
      sourceHash: createHash("sha256").update(staticMotionSource).digest("hex"),
    };
    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];

    const result = await lower(renderRequest, staticMotionSource, async (input) => {
      authorizations.push(input);
    });

    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.programs).toEqual([transform, movement]);
    expect(result.lowered.source.indexOf("equation.move_to((0, 0, 0))")).toBeLessThan(
      result.lowered.source.indexOf("equation.animate.shift("),
    );
  });

  it("fails an imported static-root transform closed without snapshot authorization", async () => {
    await expect(lower(request(staticRootMoveProgram("static-root-without-authority")))).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("does not fall back to the TypeScript evaluator after snapshot authorization rejects a static-root batch", async () => {
    await expect(
      lower(request(staticRootMoveProgram("static-root-rust-rejection")), sceneSource, async () => {
        throw new Error("rejected by Rust");
      }),
    ).rejects.toMatchObject({
      message: "The Rust core rejected the snapshot Program batch: rejected by Rust",
      status: 400,
    });
  });

  it("authorizes the complete imported transform and persistent-remove batch with exact Scene facts", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      effect: "remove",
      entityId,
      id: "tx:persistent-remove/operation:remove",
      interval: { end: 7.4, start: 7 },
      kind: "ChangePresence",
      persistent: true,
      provenance: { evidence: ["Delete command"], origin: "studio-default" },
    };
    const program: CanonicalEditProgram = {
      anchor: {
        capturedPlayhead: 7,
        evidence: ["captured-playhead:7.000"],
        resolvedSeconds: 7,
        source: { kind: "playhead", referenceSeconds: 7 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: ["Delete command"], origin: "studio-default" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "persistent-remove",
      version: 1,
    };
    const moveProgram = staticRootMoveProgram("move-before-remove");
    const originalSource = sceneSource.replace(
      "        self.add(equation)\n",
      "        self.add(equation)\n        # poietra:anchor 0.000\n",
    );
    const renderRequest = {
      ...request(moveProgram),
      programs: [moveProgram, program],
      sourceHash: createHash("sha256").update(originalSource).digest("hex"),
    };

    const authorizations: Parameters<SnapshotProgramAuthorizer>[0][] = [];
    const result = await lower(renderRequest, originalSource, async (input) => {
      authorizations.push(input);
    });

    const authorization = authorizations[0];
    expect(authorization?.programs).toEqual([moveProgram, program]);
    expect(authorization?.runtimeSceneState.objectGraph.entities[entityId]).toMatchObject({
      id: entityId,
      provisional: false,
      sourceIdentity: { kind: "known", value: "equation" },
      type: "MathTex",
    });
    expect(result.renderRequest.program).toBe(moveProgram);
    expect(result.renderRequest.programs).toEqual([moveProgram, program]);
    expect(result.lowered.source).toContain("equation.move_to((0, 0, 0))");
    expect(result.lowered.source).toContain("FadeOut(equation)");
  });

  it("fails persistent remove closed without a Rust Scene authorizer", async () => {
    const program = request().program;
    const remove: CanonicalEditProgram = {
      ...program,
      operations: [
        {
          dependsOn: [],
          effect: "remove",
          entityId,
          id: "persistent-remove-without-authority",
          interval: { end: 7.4, start: 7 },
          kind: "ChangePresence",
          persistent: true,
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      schedule: { edges: [], mode: "sequence", order: ["persistent-remove-without-authority"] },
    };

    await expect(lower(request(remove))).rejects.toMatchObject({
      message: "This Program batch requires verified Rust Scene authorization.",
      status: 400,
    });
  });

  it("rejects Runtime Trace persistent remove before consulting the static authorizer", async () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      effect: "remove",
      entityId,
      id: "runtime-trace-persistent-remove",
      interval: { end: 7.4, start: 7 },
      kind: "ChangePresence",
      persistent: true,
      provenance: { evidence: [], origin: "studio-default" },
    };
    const program: CanonicalEditProgram = {
      ...request().program,
      operations: [operation],
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
    };
    let authorizerCalls = 0;

    await expect(
      lower({ ...request(program), sourceValidation: "runtime-trace" }, sceneSource, async () => {
        authorizerCalls += 1;
      }),
    ).rejects.toMatchObject({ message: "Runtime Trace does not authorize persistent remove Programs.", status: 400 });
    expect(authorizerCalls).toBe(0);
  });

  it("rejects a source binding that is not proven by the imported Scene", async () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      sourceBindings: [{ entityId, sourceVariable: "other_equation" }],
    };

    await expect(lower(renderRequest)).rejects.toThrow(
      expect.objectContaining({
        message: `Source target binding ${entityId} → other_equation does not match the imported Scene.`,
        status: 400,
      }),
    );
  });

  it("rejects a destination when the evaluated batch has no Scene boundary", async () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      destination: { sceneName: "NextScene", sourcePath },
    };

    await expect(lower(renderRequest, sceneSource, async () => undefined)).rejects.toThrow(
      expect.objectContaining({
        message: "A render without a Scene boundary must not include a destination Scene.",
        status: 400,
      }),
    );
  });

  it("rejects a terminal Scene boundary until Rust authorizes it", async () => {
    const boundary = sceneBoundaryProgram(7, "next-scene-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(boundary),
      destination: { sceneName: "NextScene", sourcePath },
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    await expect(lower(renderRequest, sceneSourceWithDestination)).rejects.toMatchObject(unsupportedProgramBatchError);
  });

  it("rejects a mixed Scene-boundary batch before source lowering", async () => {
    const later = motionProgram(7, "motion-after-boundary");
    const boundary = sceneBoundaryProgram(5, "non-terminal-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      destination: { sceneName: "NextScene", sourcePath },
      programs: [later, boundary],
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    await expect(lower(renderRequest, sceneSourceWithDestination)).rejects.toMatchObject(unsupportedProgramBatchError);
  });

  it("maps source lowering failures to a client-facing HttpError", async () => {
    const renderRequest = request(motionProgram(6, "missing-anchor"));

    await expect(lower(renderRequest, sceneSource, async () => undefined)).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/No # poietra:anchor 6\.000 .*marker exists/),
        status: 400,
      }),
    );
  });

  it("fails closed when an untrusted Runtime Trace validation request names an unsupported edit", async () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(motionProgram(7, "unsupported-runtime-trace-validation")),
      sourceValidation: "runtime-trace",
    };

    await expect(lower(renderRequest)).rejects.toThrow(
      expect.objectContaining({
        message: "The requested Runtime Trace validation does not support this edit.",
        status: 400,
      }),
    );
  });
});
