import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_TERMINAL_CENTER_V2 } from "./fast-manim-runtime-trace-v2-profile";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";

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

function motionProgram(anchor: number, transactionId: string): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + 1, start: anchor },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: [entityId],
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

function lower(renderRequest: ProgramRenderRequest, originalSource = sceneSource) {
  return lowerManimRenderRequest({
    frame,
    originalSource,
    projectId: "default",
    request: renderRequest,
  });
}

describe("Manim render request lowering", () => {
  it("routes one generic StaticSquare source-time-zero move through fresh V3 source evidence", () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: staticSquareEntityId,
      id: "generic-v3-initial-position",
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
      provenance: { evidence: ["Runtime Trace initial edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-v3-initial-move",
      version: 1,
    };

    const result = lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: staticSquareSource,
      projectId: "generic-preview",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "generic-preview",
        sceneName: staticSquareSceneName,
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
      kind: "runtime-trace-initial-move",
    });
    expect(result.lowered.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n        square.move_to((2, 1, 0))",
    );
  });

  it("routes one generic StaticSquare source-time-zero uniform resize through fresh V3 source evidence", () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      easing: "smooth",
      entityId: staticSquareEntityId,
      from: 1,
      id: "generic-v3-initial-scale",
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
      provenance: { evidence: ["Runtime Trace initial edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-v3-initial-resize",
      version: 1,
    };

    const result = lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: staticSquareSource,
      projectId: "generic-preview",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "generic-preview",
        sceneName: staticSquareSceneName,
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
      kind: "runtime-trace-initial-resize",
    });
    expect(result.lowered.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n        square.scale(1.5)",
    );
  });

  it("routes a former pinned Scene name through generic Runtime Trace evidence", () => {
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
      provenance: { evidence: ["generic Runtime Trace initial edit"], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: [operation.id] },
      transactionId: "generic-warp-square-initial-transform",
      version: 1,
    };
    const result = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: exampleScenesSource,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: "WarpSquare",
        sourceBindings: [{ entityId: warpSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.preflight?.kind).toBe("runtime-trace-initial-move");
    expect(result.lowered.source).toContain("        square.move_to((2, 1, 0))\n        self.play(");
  });

  it("routes one five-second UpdatersExample resize through the bounded early lowerer", () => {
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: updatersSquareEntityId,
      from: { dimensions: { height: 2, width: 2 }, position: { x: 320, y: 45 } },
      id: "updaters-terminal-resize",
      interval: { end: 5, start: 5 },
      kind: "ResizeEntity",
      provenance: { evidence: ["verified UpdatersExample terminal boundary"], origin: "direct-manipulation" },
      scale: 1,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 3 }, position: { x: 320, y: 45 } },
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
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "updaters-terminal-v1-resize",
      version: 1,
    };
    const result = lowerManimRenderRequest({
      frame: { height: 8, width: 14.222222222222221 },
      originalSource: exampleScenesSource,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: updatersSceneName,
        sourceBindings: [{ entityId: updatersSquareEntityId, sourceVariable: "square" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport: { height: 360, width: 640 },
      },
    });

    expect(result.lowered.preflight?.kind).toBe("fast-manim-updaters-terminal-v1");
    expect(result.lowered.source).toContain(
      "            run_time=5,\n        )\n        square.scale(1.5)\n        decimal.update(0)\n        self.wait()",
    );
  });

  it("routes the exact OpeningManim terminal position through its server-owned V2 center", () => {
    const targetWorld = {
      x: FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_TERMINAL_CENTER_V2.x + 1.25,
      y: FAST_MANIM_RUNTIME_TRACE_GRID_TITLE_TERMINAL_CENTER_V2.y - 0.5,
    };
    const viewport = { height: 360, width: 640 } as const;
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId: openingGridTitleEntityId,
      id: "opening-terminal-position",
      interval: { end: 14, start: 14 },
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
        capturedPlayhead: 14,
        evidence: ["verified final Transform play-end"],
        resolvedSeconds: 14,
        source: { kind: "playhead", referenceSeconds: 14 },
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

    const result = lowerManimRenderRequest({
      frame: { height: 8, width: 128 / 9 },
      originalSource: exampleScenesSource,
      projectId: "default",
      request: {
        cameraCenter: { x: 0, y: 0 },
        destination: null,
        program: editProgram,
        projectId: "default",
        sceneName: openingSceneName,
        sourceBindings: [{ entityId: openingGridTitleEntityId, sourceVariable: "grid_title" }],
        sourceHash: createHash("sha256").update(exampleScenesSource).digest("hex"),
        sourcePath: exampleScenesSourcePath,
        viewport,
      },
    });

    expect(result.lowered.preflight).toEqual({
      baseSourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      kind: "fast-manim-opening-terminal-v2",
    });
    expect(result.lowered.insertedCode).toBe("        grid_title.shift((1.25, -0.5, 0))");
    expect(result.lowered.source.match(/grid_title\.shift\(/gu)).toHaveLength(1);
  });

  it("evaluates an out-of-order batch in source-anchor order without mutating the input", () => {
    const later = motionProgram(7, "batch-later");
    const earlier = motionProgram(5, "batch-earlier");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      programs: [later, earlier],
    };

    const result = lower(renderRequest);

    expect(renderRequest.programs?.map((program) => program.transactionId)).toEqual(["batch-later", "batch-earlier"]);
    expect(result.renderRequest.program.transactionId).toBe("batch-earlier");
    expect(result.renderRequest.programs?.map((program) => program.transactionId)).toEqual([
      "batch-earlier",
      "batch-later",
    ]);
    expect(result.lowered.source.indexOf('poietra:transaction "batch-earlier"')).toBeLessThan(
      result.lowered.source.indexOf('poietra:transaction "batch-later"'),
    );
  });

  it("rejects a source binding that is not proven by the imported Scene", () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      sourceBindings: [{ entityId, sourceVariable: "other_equation" }],
    };

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: `Source target binding ${entityId} → other_equation does not match the imported Scene.`,
        status: 400,
      }),
    );
  });

  it("rejects a destination when the evaluated batch has no Scene boundary", () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      destination: { sceneName: "NextScene", sourcePath },
    };

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: "A render without a Scene boundary must not include a destination Scene.",
        status: 400,
      }),
    );
  });

  it("lowers a terminal Scene boundary into the next imported Scene", () => {
    const boundary = sceneBoundaryProgram(7, "next-scene-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(boundary),
      destination: { sceneName: "NextScene", sourcePath },
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    const result = lower(renderRequest, sceneSourceWithDestination);

    expect(result.renderRequest.destination).toEqual({ sceneName: "NextScene", sourcePath });
    expect(result.lowered.insertedCode).toContain(
      '# poietra:scene-boundary {"at":7,"destination":"scene.py#NextScene"}',
    );
    expect(result.lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(result.lowered.insertedCode).toContain('title = Text("Next")');
    expect(result.lowered.insertedCode).toContain("return  # The imported next Scene now owns the composition.");
  });

  it("rejects a Scene-boundary Program before the end of a batch", () => {
    const later = motionProgram(7, "motion-after-boundary");
    const boundary = sceneBoundaryProgram(5, "non-terminal-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      destination: { sceneName: "NextScene", sourcePath },
      programs: [later, boundary],
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    expect(() => lower(renderRequest, sceneSourceWithDestination)).toThrow(
      expect.objectContaining({
        message: "A Scene-boundary Program must be the final Program in a render batch.",
        status: 400,
      }),
    );
  });

  it("maps source lowering failures to a client-facing HttpError", () => {
    const renderRequest = request(motionProgram(6, "missing-anchor"));

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/No # poietra:anchor 6\.000 .*marker exists/),
        status: 400,
      }),
    );
  });
});
