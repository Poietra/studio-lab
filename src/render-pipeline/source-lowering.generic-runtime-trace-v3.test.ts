import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import {
  deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3,
  lowerGenericRuntimeTraceInitialPositionSourceV3,
} from "./source-lowering";

const sourcePath = "scene_runtime_trace_v3.py";
const sceneName = "StaticSquare";
const entityId = `source:${sourcePath}#${sceneName}:square`;
const frame = { height: 8, width: 128 / 9 } as const;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/scene_runtime_trace_v3.py", import.meta.url),
  "utf8",
);

function initialMoveProgram(value = { x: 410, y: 135 }): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId,
    id: "generic-v3-initial-position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["generic V3 initial root"], origin: "direct-manipulation" },
    value,
  };
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["generic V3 initial edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "generic-v3-initial-move",
    version: 1,
  };
}

function request(sourceText = source, program = initialMoveProgram()): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "generic-preview",
    sceneName,
    sourceBindings: [{ entityId, sourceVariable: "square" }],
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function lower(sourceText = source, renderRequest = request(sourceText)) {
  return lowerGenericRuntimeTraceInitialPositionSourceV3(
    sourceText,
    renderRequest,
    [{ program: renderRequest.program, sourceAnchor: 0 }],
    frame,
    null,
  );
}

describe("generic Runtime Trace V3 initial-move source lowering", () => {
  it("keeps the demo Scene on Studio's minimum duration and frame grid", () => {
    const imported = importManimScene(source, sourcePath, sceneName, frame);

    expect(imported?.runtimeSceneState.duration).toBe(0.1);
    expect(imported?.sourceVariables).toEqual({ [entityId]: "square" });
  });

  it("inserts one canonical move after the exact StaticSquare assignment and emits re-derivable evidence", () => {
    const lowered = lower();

    expect(lowered).not.toBeNull();
    expect(lowered?.insertedCode).toBe("        square.move_to((2, 1, 0))");
    expect(lowered?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.move_to((2, 1, 0))\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    expect(lowered?.preflight).toMatchObject({
      baseBinding: {
        id: expect.stringMatching(/^source-binding:[0-9a-f]{64}$/u),
        name: "square",
        ordinal: 1,
        span: { endColumn: 14, endLine: 6, startColumn: 8, startLine: 6 },
      },
      baseSourceHash: request().sourceHash,
      entityId,
      expectedWorldCenter: { x: 2, y: 1 },
      kind: "fast-manim-generic-initial-move-v3",
    });

    const derived = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(lowered!.source, sceneName, sourcePath);
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedWorldCenter).toEqual({ x: 2, y: 1 });
  });

  it("fails closed when SourceAnalysis projects multiple bindings or only a control-flow binding", () => {
    const multiple = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        circle = Circle()\n        square.set_stroke(WHITE, width=2)",
    );
    const controlled = source.replace(
      "        square = Square().set_fill(BLUE, opacity=0.6)",
      "        if True:\n            square = Square().set_fill(BLUE, opacity=0.6)",
    );

    expect(() => lower(multiple, request(multiple))).toThrow(/one projected top-level V3 source occurrence/i);
    expect(() => lower(controlled, request(controlled))).toThrow(/one projected top-level V3 source occurrence/i);
  });

  it("fails closed on a transition, resize, multi-operation edit, or multiple request bindings", () => {
    expect(() => lower(source, { ...request(), destination: { sceneName: "Other", sourcePath } })).toThrow(
      /Scene transitions/i,
    );

    const resize: CanonicalEditOperation = {
      dependsOn: [],
      entityId,
      from: { dimensions: { height: 2, width: 2 }, position: { x: 320, y: 180 } },
      id: "generic-v3-initial-resize",
      interval: { end: 0, start: 0 },
      kind: "ResizeEntity",
      provenance: { evidence: ["generic V3 root"], origin: "direct-manipulation" },
      scale: 1,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 3 }, position: { x: 320, y: 180 } },
    };
    const resizeProgram: CanonicalEditProgram = {
      ...initialMoveProgram(),
      operations: [resize],
      schedule: { edges: [], mode: "parallel", order: [resize.id] },
    };
    expect(() => lower(source, request(source, resizeProgram))).toThrow(/only one exact direct-manipulation/i);

    const first = initialMoveProgram().operations[0]!;
    const second = { ...first, id: "second-position", value: { x: 420, y: 145 } };
    const multiProgram: CanonicalEditProgram = {
      ...initialMoveProgram(),
      intentCount: 2,
      operations: [first, second],
      schedule: { edges: [], mode: "parallel", order: [first.id, second.id] },
    };
    expect(() => lower(source, request(source, multiProgram))).toThrow(/only one exact direct-manipulation/i);
    expect(() =>
      lower(source, {
        ...request(),
        sourceBindings: [
          { entityId, sourceVariable: "square" },
          { entityId: `${entityId}:extra`, sourceVariable: "extra" },
        ],
      }),
    ).toThrow(/one exact request binding/i);
  });

  it("rejects non-canonical or non-adjacent candidate move statements during independent derivation", () => {
    const lowered = lower();
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.move_to((2, 1, 0))", "square.move_to((2.0, 1, 0))");
    const nonAdjacent = lowered!.source.replace(
      "        square.move_to((2, 1, 0))\n        square.set_stroke",
      "        self.add(square)\n        square.move_to((2, 1, 0))\n        square.set_stroke",
    );

    expect(() => deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(nonCanonical, sceneName, sourcePath)).toThrow(
      /canonical finite bounded move_to/i,
    );
    expect(() => deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(nonAdjacent, sceneName, sourcePath)).toThrow(
      /candidate move/i,
    );
  });

  it("withholds the V3 candidate when a nested definition rebinds the projected name, keeping preview available", () => {
    const rebound = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        def helper(value=(square := Square())):\n            pass\n        square.set_stroke(WHITE, width=2)",
    );
    const imported = importManimScene(rebound, sourcePath, sceneName, frame);

    // Preview stays available: only the source-edit candidate is withheld, so
    // the producer never receives a binding its own inventory would reject.
    expect(imported?.runtimeSceneState.duration).toBe(0.1);
    expect(() => lower(rebound, request(rebound))).toThrow(/one projected top-level V3 source occurrence/i);
    expect(() => deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(rebound, sceneName, sourcePath)).toThrow(
      /exactly one unambiguous top-level V3 binding/i,
    );
  });

  it("leaves an explicit source-time-zero anchor to the established general lowerer", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );

    expect(lower(anchored, request(anchored))).toBeNull();
  });
});
