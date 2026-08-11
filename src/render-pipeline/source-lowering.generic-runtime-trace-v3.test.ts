import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import {
  deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3,
  deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3,
  deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3,
  lowerCanonicalProgramBatchSource,
  lowerGenericRuntimeTraceInitialEditSourceV3,
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

function initialResizeProgram(relativeFactor = 1.5, from = 1): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    easing: "smooth",
    entityId,
    from,
    id: "generic-v3-initial-scale",
    interval: { end: 0, start: 0 },
    key: "scale",
    kind: "AnimateProperty",
    provenance: { evidence: ["generic V3 initial root"], origin: "direct-manipulation" },
    relativeFactor,
    to: from * relativeFactor,
  };
  return {
    ...initialMoveProgram(),
    operations: [operation],
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "generic-v3-initial-resize",
  };
}

function initialRotationProgram(angleRadians = 0.5): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    easing: "smooth",
    entityId,
    from: 0,
    id: "generic-v3-initial-rotation",
    interval: { end: 0, start: 0 },
    key: "rotation",
    kind: "AnimateProperty",
    provenance: { evidence: ["generic V3 initial root"], origin: "direct-manipulation" },
    relativeDelta: angleRadians,
    to: angleRadians,
  };
  return {
    ...initialMoveProgram(),
    operations: [operation],
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "generic-v3-initial-rotation",
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
  return lowerGenericRuntimeTraceInitialEditSourceV3(
    sourceText,
    renderRequest,
    [{ program: renderRequest.program, sourceAnchor: 0 }],
    frame,
    null,
  );
}

describe("generic Runtime Trace V3 initial-edit source lowering", () => {
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

    const derived = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(
      lowered!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedWorldCenter).toEqual({ x: 2, y: 1 });
  });

  it("selects the request-named binding among multiple projected candidates", () => {
    const multiple = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        circle = Circle()\n        square.set_stroke(WHITE, width=2)",
    );

    const lowered = lower(multiple, request(multiple));
    expect(lowered?.insertedCode).toBe("        square.move_to((2, 1, 0))");
    expect(lowered?.preflight).toMatchObject({
      baseBinding: { name: "square", ordinal: 1 },
      kind: "fast-manim-generic-initial-move-v3",
    });

    const derived = deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(
      lowered!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(multiple);
    expect(derived.expectedWorldCenter).toEqual({ x: 2, y: 1 });
    // The sibling candidate never authorizes the edit: deriving for it fails.
    expect(() =>
      deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(lowered!.source, sceneName, sourcePath, "circle"),
    ).toThrow(/canonical finite bounded move_to/i);
  });

  it("fails closed on a request row that cross-wires the gesture entity into a sibling binding", () => {
    const multiple = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        circle = Circle()\n        square.set_stroke(WHITE, width=2)",
    );

    // The row names the square gesture entity but retargets its variable to
    // the projected circle binding; the canonical-identity pin must reject
    // instead of lowering a circle edit for a square-authorized gesture.
    expect(() =>
      lower(multiple, {
        ...request(multiple),
        sourceBindings: [{ entityId, sourceVariable: "circle" }],
      }),
    ).toThrow(/canonical Studio identity of the selected binding/i);
  });

  it("fails closed on a control-flow binding or an unknown request name", () => {
    const controlled = source.replace(
      "        square = Square().set_fill(BLUE, opacity=0.6)",
      "        if True:\n            square = Square().set_fill(BLUE, opacity=0.6)",
    );

    expect(() => lower(controlled, request(controlled))).toThrow(/one exact request binding/i);
    expect(() => lower(source, { ...request(), sourceBindings: [{ entityId, sourceVariable: "missing" }] })).toThrow(
      /one exact request binding/i,
    );
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
    // A second binding for another entity no longer blocks selection; only a
    // duplicated entry for the edited entity stays ambiguous.
    expect(
      lower(source, {
        ...request(),
        sourceBindings: [
          { entityId, sourceVariable: "square" },
          { entityId: `${entityId}:extra`, sourceVariable: "extra" },
        ],
      })?.insertedCode,
    ).toBe("        square.move_to((2, 1, 0))");
    expect(() =>
      lower(source, {
        ...request(),
        sourceBindings: [
          { entityId, sourceVariable: "square" },
          { entityId, sourceVariable: "square" },
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

    expect(() =>
      deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(nonCanonical, sceneName, sourcePath, "square"),
    ).toThrow(/canonical finite bounded move_to/i);
    expect(() =>
      deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(nonAdjacent, sceneName, sourcePath, "square"),
    ).toThrow(/candidate move/i);
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
    expect(() =>
      deriveGenericRuntimeTraceInitialMoveSourceEditPlanV3(rebound, sceneName, sourcePath, "square"),
    ).toThrow(/exactly one unambiguous top-level V3 binding/i);
  });

  it("leaves an explicit source-time-zero anchor to the established general lowerer", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );

    expect(lower(anchored, request(anchored))).toBeNull();
  });

  it("fails closed instead of dropping rotation when an explicit zero anchor selects the general lowerer", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );
    const renderRequest = request(anchored, initialRotationProgram());

    expect(() =>
      lowerCanonicalProgramBatchSource(
        anchored,
        renderRequest,
        [{ program: renderRequest.program, sourceAnchor: 0 }],
        frame,
        null,
      ),
    ).toThrow(/rotation requires the bounded generic Runtime Trace V3 source lowerer/i);
  });

  it("inserts one canonical uniform resize after the exact assignment and emits re-derivable evidence", () => {
    const lowered = lower(source, request(source, initialResizeProgram()));

    expect(lowered).not.toBeNull();
    expect(lowered?.insertedCode).toBe("        square.scale(1.5)");
    expect(lowered?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.scale(1.5)\n" +
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
      expectedScaleFactor: 1.5,
      kind: "fast-manim-generic-initial-resize-v3",
    });

    const derived = deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(
      lowered!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedScaleFactor).toBe(1.5);
  });

  it("lowers the relative factor for shrink edits and non-unit execution scales", () => {
    // A rebased edit keeps its multiplicative intent: from=2, to=3 must lower
    // the relative factor 1.5, never the absolute channel value 3.
    const rebased = lower(source, request(source, initialResizeProgram(1.5, 2)));
    expect(rebased?.insertedCode).toBe("        square.scale(1.5)");
    expect(rebased?.preflight).toMatchObject({ expectedScaleFactor: 1.5 });

    const shrunk = lower(source, request(source, initialResizeProgram(0.5)));
    expect(shrunk?.insertedCode).toBe("        square.scale(0.5)");
    expect(shrunk?.preflight).toMatchObject({ expectedScaleFactor: 0.5 });
  });

  it("rejects an identity, non-positive, or non-relative uniform resize factor", () => {
    expect(() => lower(source, request(source, initialResizeProgram(1)))).toThrow(
      /positive non-identity bounded scale factor/i,
    );
    expect(() => lower(source, request(source, initialResizeProgram(-2)))).toThrow(
      /only one exact direct-manipulation/i,
    );
    const inconsistent: CanonicalEditProgram = (() => {
      const program = initialResizeProgram(1.5);
      const operation = { ...program.operations[0]!, relativeFactor: 2 } as CanonicalEditOperation;
      return { ...program, operations: [operation] };
    })();
    expect(() => lower(source, request(source, inconsistent))).toThrow(/only one exact direct-manipulation/i);
  });

  it("rejects non-canonical or non-adjacent candidate resize statements during independent derivation", () => {
    const lowered = lower(source, request(source, initialResizeProgram()));
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.scale(1.5)", "square.scale(1.50)");
    const identity = lowered!.source.replace("square.scale(1.5)", "square.scale(1)");
    const nonAdjacent = lowered!.source.replace(
      "        square.scale(1.5)\n        square.set_stroke",
      "        self.add(square)\n        square.scale(1.5)\n        square.set_stroke",
    );

    expect(() =>
      deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(nonCanonical, sceneName, sourcePath, "square"),
    ).toThrow(/canonical positive non-identity bounded scale/i);
    expect(() =>
      deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(identity, sceneName, sourcePath, "square"),
    ).toThrow(/canonical positive non-identity bounded scale/i);
    expect(() =>
      deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(nonAdjacent, sceneName, sourcePath, "square"),
    ).toThrow(/candidate resize/i);
  });

  it("inserts one canonical rotation after the exact assignment and emits re-derivable evidence", () => {
    const lowered = lower(source, request(source, initialRotationProgram(Math.PI / 4)));

    expect(lowered).not.toBeNull();
    expect(lowered?.insertedCode).toBe("        square.rotate(0.785398163397)");
    expect(lowered?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.rotate(0.785398163397)\n" +
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
      expectedAngleRadians: 0.785398163397,
      kind: "fast-manim-generic-initial-rotation-v3",
    });

    const derived = deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3(
      lowered!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedAngleRadians).toBe(0.785398163397);
  });

  it("accepts a negative rotation and rejects no-op, non-finite, or unbounded angles", () => {
    expect(lower(source, request(source, initialRotationProgram(-0.5)))?.insertedCode).toBe(
      "        square.rotate(-0.5)",
    );
    expect(() => lower(source, request(source, initialRotationProgram(0)))).toThrow(/finite non-noop bounded angle/i);
    expect(() => lower(source, request(source, initialRotationProgram(2 * Math.PI)))).toThrow(
      /finite non-noop bounded angle/i,
    );
    expect(() => lower(source, request(source, initialRotationProgram(Number.NaN)))).toThrow(
      /only one exact direct-manipulation/i,
    );
    expect(() => lower(source, request(source, initialRotationProgram(1e100)))).toThrow(
      /finite non-noop bounded angle/i,
    );

    const setProperty = initialMoveProgram();
    const operation: CanonicalEditOperation = {
      dependsOn: [],
      entityId,
      id: "unsupported-set-rotation",
      interval: { end: 0, start: 0 },
      key: "rotation",
      kind: "SetProperty",
      provenance: { evidence: ["legacy absolute rotation"], origin: "direct-manipulation" },
      value: 0.5,
    };
    expect(() => lower(source, request(source, { ...setProperty, operations: [operation] }))).toThrow(
      /only one exact direct-manipulation/i,
    );
  });

  it("rejects non-canonical or non-adjacent candidate rotation statements during independent derivation", () => {
    const lowered = lower(source, request(source, initialRotationProgram()));
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.rotate(0.5)", "square.rotate(0.50)");
    const identity = lowered!.source.replace("square.rotate(0.5)", "square.rotate(0)");
    const nonAdjacent = lowered!.source.replace(
      "        square.rotate(0.5)\n        square.set_stroke",
      "        self.add(square)\n        square.rotate(0.5)\n        square.set_stroke",
    );

    expect(() =>
      deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3(nonCanonical, sceneName, sourcePath, "square"),
    ).toThrow(/canonical finite non-noop bounded rotate/i);
    expect(() =>
      deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3(identity, sceneName, sourcePath, "square"),
    ).toThrow(/canonical finite non-noop bounded rotate/i);
    expect(() =>
      deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3(nonAdjacent, sceneName, sourcePath, "square"),
    ).toThrow(/candidate rotation/i);
  });

  it("re-derives sequential edits with the newest statement directly after the assignment", () => {
    // A resize on an already-moved base keeps the earlier canonical move as
    // plain base program text; only the newest inserted statement is removed.
    const moved = lower()!.source;
    const resized = lower(moved, request(moved, initialResizeProgram()));
    expect(resized).not.toBeNull();
    expect(resized?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.scale(1.5)\n" +
        "        square.move_to((2, 1, 0))\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveGenericRuntimeTraceInitialResizeSourceEditPlanV3(
      resized!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(moved);
    expect(derived.expectedScaleFactor).toBe(1.5);
  });

  it("appends a repeated relative rotation after the prior canonical rotation", () => {
    const first = lower(source, request(source, initialRotationProgram(0.3)))!.source;
    const second = lower(first, request(first, initialRotationProgram(0.5)));

    expect(second?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.rotate(0.3)\n" +
        "        square.rotate(0.5)\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveGenericRuntimeTraceInitialRotationSourceEditPlanV3(
      second!.source,
      sceneName,
      sourcePath,
      "square",
    );
    expect(derived.baseSource).toBe(first);
    expect(derived.expectedAngleRadians).toBe(0.5);
  });
});
