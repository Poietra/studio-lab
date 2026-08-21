import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import {
  deriveRuntimeTraceMoveSourceEditPlan,
  deriveRuntimeTraceOpacitySourceEditPlan,
  deriveRuntimeTraceResizeSourceEditPlan,
  deriveRuntimeTraceRotationSourceEditPlan,
  lowerCanonicalProgramBatchSource,
  lowerRuntimeTraceEditSource,
} from "./source-lowering";

const sourcePath = "scene_runtime_trace_v3.py";
const sceneName = "StaticSquare";
const entityId = `source:${sourcePath}#${sceneName}:square`;
const frame = { height: 8, width: 128 / 9 } as const;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/scene_runtime_trace_v3.py", import.meta.url),
  "utf8",
);
const officialSourcePath = "example_scenes/basic.py";
const officialSource = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const officialSourceHash = createHash("sha256").update(officialSource, "utf8").digest("hex");
const numberPlaneSourcePath = "static_number_plane.py";
const numberPlaneSceneName = "StaticNumberPlane";
const numberPlaneEntityId = `source:${numberPlaneSourcePath}#${numberPlaneSceneName}:grid`;
const numberPlaneSource = `from manim import *

class StaticNumberPlane(Scene):
    def construct(self):
        grid = NumberPlane()
        self.add(grid)
        self.wait(2)
`;

function moveEditProgram(
  value = { x: 410, y: 135 },
  sourceAnchor = 0,
  targetEntityId = entityId,
): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId: targetEntityId,
    id: "runtime-trace-position-edit",
    interval: { end: sourceAnchor, start: sourceAnchor },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
    value,
  };
  return {
    anchor: {
      capturedPlayhead: sourceAnchor,
      evidence: [`source-time ${sourceAnchor}`],
      resolvedSeconds: sourceAnchor,
      source: { kind: "absolute", seconds: sourceAnchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["Runtime Trace edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "runtime-trace-move-edit",
    version: 1,
  };
}

function resizeEditProgram(
  relativeFactor = 1.5,
  from = 1,
  sourceAnchor = 0,
  targetEntityId = entityId,
): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    easing: "smooth",
    entityId: targetEntityId,
    from,
    id: "runtime-trace-scale-edit",
    interval: { end: sourceAnchor, start: sourceAnchor },
    key: "scale",
    kind: "AnimateProperty",
    provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
    relativeFactor,
    to: from * relativeFactor,
  };
  return {
    ...moveEditProgram(undefined, sourceAnchor),
    operations: [operation],
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "runtime-trace-resize-edit",
  };
}

function rotationEditProgram(angleRadians = 0.5, sourceAnchor = 0): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    easing: "smooth",
    entityId,
    from: 0,
    id: "runtime-trace-rotation-edit",
    interval: { end: sourceAnchor, start: sourceAnchor },
    key: "rotation",
    kind: "AnimateProperty",
    provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
    relativeDelta: angleRadians,
    to: angleRadians,
  };
  return {
    ...moveEditProgram(undefined, sourceAnchor),
    operations: [operation],
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "runtime-trace-rotation-edit",
  };
}

function opacityEditProgram(opacity: number | string = 0.25, sourceAnchor = 0): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    dependsOn: [],
    entityId,
    id: "runtime-trace-opacity-edit",
    interval: { end: sourceAnchor, start: sourceAnchor },
    key: "appearance",
    kind: "SetProperty",
    provenance: { evidence: ["Runtime Trace edit target"], origin: "direct-manipulation" },
    value: opacity,
  };
  return {
    ...moveEditProgram(undefined, sourceAnchor),
    operations: [operation],
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "runtime-trace-opacity-edit",
  };
}

function request(sourceText = source, program = moveEditProgram()): ProgramRenderRequest {
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
  return lowerRuntimeTraceEditSource(
    sourceText,
    renderRequest,
    [{ program: renderRequest.program, sourceAnchor: renderRequest.program.anchor.resolvedSeconds }],
    frame,
    null,
  );
}

function officialRequest(
  targetSceneName: string,
  bindingName: string,
  targetEntityId: string,
  program: CanonicalEditProgram,
): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "generic-preview",
    sceneName: targetSceneName,
    sourceBindings: [{ entityId: targetEntityId, sourceVariable: bindingName }],
    sourceHash: officialSourceHash,
    sourcePath: officialSourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function roundTripOfficialEdit(
  targetSceneName: string,
  bindingName: string,
  targetEntityId: string,
  program: CanonicalEditProgram,
) {
  const renderRequest = officialRequest(targetSceneName, bindingName, targetEntityId, program);
  const lowered = lowerRuntimeTraceEditSource(
    officialSource,
    renderRequest,
    [{ program: renderRequest.program, sourceAnchor: renderRequest.program.anchor.resolvedSeconds }],
    frame,
    null,
  );
  if (!lowered) throw new Error(`${targetSceneName} did not lower through the Runtime Trace source route.`);
  const imported = importManimScene(lowered.source, officialSourcePath, targetSceneName, frame);
  if (!imported) throw new Error(`${targetSceneName} emitted source did not reimport.`);
  return { imported, lowered };
}

function numberPlaneRequest(sourceText: string, program: CanonicalEditProgram): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
    projectId: "number-plane-preview",
    sceneName: numberPlaneSceneName,
    sourceBindings: [{ entityId: numberPlaneEntityId, sourceVariable: "grid" }],
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath: numberPlaneSourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function lowerNumberPlane(sourceText: string, program: CanonicalEditProgram) {
  const renderRequest = numberPlaneRequest(sourceText, program);
  return lowerRuntimeTraceEditSource(
    sourceText,
    renderRequest,
    [{ program, sourceAnchor: program.anchor.resolvedSeconds }],
    frame,
    null,
  );
}

describe("Runtime Trace edit source lowering", () => {
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
      kind: "runtime-trace-move-edit",
      sourceAnchor: 0,
    });

    const derived = deriveRuntimeTraceMoveSourceEditPlan(lowered!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedWorldCenter).toEqual({ x: 2, y: 1 });
  });

  it("inserts and independently re-derives a move at a later static wait boundary", () => {
    const temporalSource = source.replace("        self.wait(0.1)", "        self.wait(5)\n        self.wait(2)");
    const renderRequest = request(temporalSource, moveEditProgram({ x: 410, y: 135 }, 5));
    const lowered = lower(temporalSource, renderRequest);

    expect(lowered?.source).toContain(
      "        self.wait(5)\n" + "        square.move_to((2, 1, 0))\n" + "        self.wait(2)",
    );
    expect(lowered?.preflight).toMatchObject({
      expectedWorldCenter: { x: 2, y: 1 },
      kind: "runtime-trace-move-edit",
      sourceAnchor: 5,
    });

    const derived = deriveRuntimeTraceMoveSourceEditPlan(lowered!.source, sceneName, sourcePath, "square", 5);
    expect(derived.baseSource).toBe(temporalSource);
    expect(derived.sourceAnchor).toBe(5);
  });

  it("rejects a nonzero source time inside, rather than at the start of, a static wait", () => {
    const temporalSource = source.replace("        self.wait(0.1)", "        self.wait(5)\n        self.wait(2)");
    const renderRequest = request(temporalSource, moveEditProgram({ x: 410, y: 135 }, 5.5));

    expect(() => lower(temporalSource, renderRequest)).toThrow(/start of the final statically imported/i);
  });

  it("rejects the start of a static wait that is not the terminal settled wait", () => {
    const temporalSource = source.replace(
      "        self.wait(0.1)",
      "        self.wait(2)\n        self.wait(3)\n        self.wait(2)",
    );
    const renderRequest = request(temporalSource, moveEditProgram({ x: 410, y: 135 }, 2));

    expect(() => lower(temporalSource, renderRequest)).toThrow(/final statically imported/i);
  });

  it("fails closed when a later source time is not contained by one statically imported wait", () => {
    const dynamicWait = source.replace("        self.wait(0.1)", "        duration = 2\n        self.wait(duration)");
    const renderRequest = request(dynamicWait, moveEditProgram({ x: 410, y: 135 }, 1));

    expect(() => lower(dynamicWait, renderRequest)).toThrow(/statically imported construct-level wait/i);
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
      kind: "runtime-trace-move-edit",
    });

    const derived = deriveRuntimeTraceMoveSourceEditPlan(lowered!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(multiple);
    expect(derived.expectedWorldCenter).toEqual({ x: 2, y: 1 });
    // The sibling candidate never authorizes the edit: deriving for it fails.
    expect(() => deriveRuntimeTraceMoveSourceEditPlan(lowered!.source, sceneName, sourcePath, "circle")).toThrow(
      /canonical finite bounded move_to/i,
    );
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
      id: "runtime-trace-resize-edit",
      interval: { end: 0, start: 0 },
      kind: "ResizeEntity",
      provenance: { evidence: ["Runtime Trace root"], origin: "direct-manipulation" },
      scale: 1,
      shape: "rectangle",
      to: { dimensions: { height: 3, width: 3 }, position: { x: 320, y: 180 } },
    };
    const resizeProgram: CanonicalEditProgram = {
      ...moveEditProgram(),
      operations: [resize],
      schedule: { edges: [], mode: "parallel", order: [resize.id] },
    };
    expect(() => lower(source, request(source, resizeProgram))).toThrow(/only one exact direct-manipulation/i);

    const first = moveEditProgram().operations[0]!;
    const second = { ...first, id: "second-position", value: { x: 420, y: 145 } };
    const multiProgram: CanonicalEditProgram = {
      ...moveEditProgram(),
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

    expect(() => deriveRuntimeTraceMoveSourceEditPlan(nonCanonical, sceneName, sourcePath, "square")).toThrow(
      /canonical finite bounded move_to/i,
    );
    expect(() => deriveRuntimeTraceMoveSourceEditPlan(nonAdjacent, sceneName, sourcePath, "square")).toThrow(
      /candidate move/i,
    );
  });

  it("withholds the candidate when a nested definition rebinds the projected name, keeping preview available", () => {
    const rebound = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        def helper(value=(square := Square())):\n            pass\n        square.set_stroke(WHITE, width=2)",
    );
    const imported = importManimScene(rebound, sourcePath, sceneName, frame);

    // Preview stays available: only the source-edit candidate is withheld, so
    // the producer never receives a binding its own inventory would reject.
    expect(imported?.runtimeSceneState.duration).toBe(0.1);
    expect(() => lower(rebound, request(rebound))).toThrow(/one projected top-level source occurrence/i);
    expect(() => deriveRuntimeTraceMoveSourceEditPlan(rebound, sceneName, sourcePath, "square")).toThrow(
      /exactly one unambiguous top-level binding/i,
    );
  });

  it("keeps Runtime Trace validation authoritative when an explicit source anchor exists at the same time", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );

    const lowered = lower(anchored, request(anchored));

    expect(lowered?.preflight).toMatchObject({ kind: "runtime-trace-move-edit", sourceAnchor: 0 });
    expect(lowered?.source).toContain("        square.move_to((2, 1, 0))");
  });

  it("fails closed instead of dropping rotation when an explicit zero anchor selects the general lowerer", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );
    const renderRequest = request(anchored, rotationEditProgram());

    expect(() =>
      lowerCanonicalProgramBatchSource(
        anchored,
        renderRequest,
        [{ program: renderRequest.program, sourceAnchor: 0 }],
        frame,
        null,
      ),
    ).toThrow(/rotation requires the Runtime Trace source lowerer/i);
  });

  it("fails closed instead of dropping opacity when an explicit zero anchor selects the general lowerer", () => {
    const anchored = source.replace(
      "        square.set_stroke(WHITE, width=2)",
      "        # poietra:anchor 0.000\n        square.set_stroke(WHITE, width=2)",
    );
    const renderRequest = request(anchored, opacityEditProgram());

    expect(() =>
      lowerCanonicalProgramBatchSource(
        anchored,
        renderRequest,
        [{ program: renderRequest.program, sourceAnchor: 0 }],
        frame,
        null,
      ),
    ).toThrow(/opacity requires the Runtime Trace source lowerer/i);
  });

  it("inserts one canonical uniform resize after the exact assignment and emits re-derivable evidence", () => {
    const lowered = lower(source, request(source, resizeEditProgram()));

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
      kind: "runtime-trace-resize-edit",
      sourceAnchor: 0,
    });

    const derived = deriveRuntimeTraceResizeSourceEditPlan(lowered!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedScaleFactor).toBe(1.5);
  });

  it("inserts and independently re-derives a resize before a later static wait boundary", () => {
    const temporalSource = source.replace("        self.wait(0.1)", "        self.wait(5)\n        self.wait(2)");
    const renderRequest = request(temporalSource, resizeEditProgram(1.5, 1, 5));
    const lowered = lower(temporalSource, renderRequest);

    expect(lowered?.source).toContain(
      "        self.wait(5)\n" + "        square.scale(1.5)\n" + "        self.wait(2)",
    );
    expect(lowered?.preflight).toMatchObject({
      expectedScaleFactor: 1.5,
      kind: "runtime-trace-resize-edit",
      sourceAnchor: 5,
    });

    const derived = deriveRuntimeTraceResizeSourceEditPlan(lowered!.source, sceneName, sourcePath, "square", 5);
    expect(derived.baseSource).toBe(temporalSource);
    expect(derived.sourceAnchor).toBe(5);
  });

  it("lowers the relative factor for shrink edits and non-unit execution scales", () => {
    // A rebased edit keeps its multiplicative intent: from=2, to=3 must lower
    // the relative factor 1.5, never the absolute channel value 3.
    const rebased = lower(source, request(source, resizeEditProgram(1.5, 2)));
    expect(rebased?.insertedCode).toBe("        square.scale(1.5)");
    expect(rebased?.preflight).toMatchObject({ expectedScaleFactor: 1.5 });

    const shrunk = lower(source, request(source, resizeEditProgram(0.5)));
    expect(shrunk?.insertedCode).toBe("        square.scale(0.5)");
    expect(shrunk?.preflight).toMatchObject({ expectedScaleFactor: 0.5 });
  });

  it("rejects an identity, non-positive, or non-relative uniform resize factor", () => {
    expect(() => lower(source, request(source, resizeEditProgram(1)))).toThrow(
      /positive non-identity bounded scale factor/i,
    );
    expect(() => lower(source, request(source, resizeEditProgram(-2)))).toThrow(/only one exact direct-manipulation/i);
    const inconsistent: CanonicalEditProgram = (() => {
      const program = resizeEditProgram(1.5);
      const operation = { ...program.operations[0]!, relativeFactor: 2 } as CanonicalEditOperation;
      return { ...program, operations: [operation] };
    })();
    expect(() => lower(source, request(source, inconsistent))).toThrow(/only one exact direct-manipulation/i);
  });

  it("rejects non-canonical or non-adjacent candidate resize statements during independent derivation", () => {
    const lowered = lower(source, request(source, resizeEditProgram()));
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.scale(1.5)", "square.scale(1.50)");
    const identity = lowered!.source.replace("square.scale(1.5)", "square.scale(1)");
    const nonAdjacent = lowered!.source.replace(
      "        square.scale(1.5)\n        square.set_stroke",
      "        self.add(square)\n        square.scale(1.5)\n        square.set_stroke",
    );

    expect(() => deriveRuntimeTraceResizeSourceEditPlan(nonCanonical, sceneName, sourcePath, "square")).toThrow(
      /canonical positive non-identity bounded scale/i,
    );
    expect(() => deriveRuntimeTraceResizeSourceEditPlan(identity, sceneName, sourcePath, "square")).toThrow(
      /canonical positive non-identity bounded scale/i,
    );
    expect(() => deriveRuntimeTraceResizeSourceEditPlan(nonAdjacent, sceneName, sourcePath, "square")).toThrow(
      /candidate resize/i,
    );
  });

  it("inserts one canonical opacity after the exact assignment and emits re-derivable evidence", () => {
    const lowered = lower(source, request(source, opacityEditProgram(0.25)));

    expect(lowered).not.toBeNull();
    expect(lowered?.insertedCode).toBe("        square.set_opacity(0.25)");
    expect(lowered?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.set_opacity(0.25)\n" +
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
      expectedOpacity: 0.25,
      kind: "runtime-trace-opacity-edit",
      sourceAnchor: 0,
    });

    const derived = deriveRuntimeTraceOpacitySourceEditPlan(lowered!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedOpacity).toBe(0.25);
  });

  it("accepts opacity endpoints and rejects non-finite, out-of-range, or non-numeric values", () => {
    expect(lower(source, request(source, opacityEditProgram(0)))?.insertedCode).toBe("        square.set_opacity(0)");
    expect(lower(source, request(source, opacityEditProgram(1)))?.insertedCode).toBe("        square.set_opacity(1)");
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01, "0.5"] as const) {
      expect(() => lower(source, request(source, opacityEditProgram(invalid)))).toThrow(
        /only one exact direct-manipulation/i,
      );
    }
  });

  it("keeps opacity and rotation restricted to source time zero", () => {
    const temporalSource = source.replace("        self.wait(0.1)", "        self.wait(2)");

    expect(() => lower(temporalSource, request(temporalSource, opacityEditProgram(0.5, 1)))).toThrow(
      /opacity and rotation remain restricted to source time zero/i,
    );
    expect(() => lower(temporalSource, request(temporalSource, rotationEditProgram(0.5, 1)))).toThrow(
      /opacity and rotation remain restricted to source time zero/i,
    );
  });

  it("rejects non-canonical or non-adjacent candidate opacity statements during independent derivation", () => {
    const lowered = lower(source, request(source, opacityEditProgram()));
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.set_opacity(0.25)", "square.set_opacity(0.250)");
    const nonAdjacent = lowered!.source.replace(
      "        square.set_opacity(0.25)\n        square.set_stroke",
      "        self.add(square)\n        square.set_opacity(0.25)\n        square.set_stroke",
    );

    expect(() => deriveRuntimeTraceOpacitySourceEditPlan(nonCanonical, sceneName, sourcePath, "square")).toThrow(
      /canonical finite opacity between zero and one/i,
    );
    expect(() => deriveRuntimeTraceOpacitySourceEditPlan(nonAdjacent, sceneName, sourcePath, "square")).toThrow(
      /candidate opacity/i,
    );
  });

  it("inserts one canonical rotation after the exact assignment and emits re-derivable evidence", () => {
    const lowered = lower(source, request(source, rotationEditProgram(Math.PI / 4)));

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
      kind: "runtime-trace-rotation-edit",
      sourceAnchor: 0,
    });

    const derived = deriveRuntimeTraceRotationSourceEditPlan(lowered!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(source);
    expect(derived.baseBinding).toEqual(
      lowered?.preflight && "baseBinding" in lowered.preflight ? lowered.preflight.baseBinding : null,
    );
    expect(derived.candidateBinding.id).not.toBe(derived.baseBinding.id);
    expect(derived.expectedAngleRadians).toBe(0.785398163397);
  });

  it("round-trips every advertised StaticSquare edit through Python and the static importer", () => {
    const cases = [
      {
        assertImported: (imported: NonNullable<ReturnType<typeof importManimScene>>) =>
          expect(imported.runtimeSceneState.propertyChannels[`${entityId}/position`]?.samples.at(-1)?.value).toEqual({
            x: 410,
            y: 135,
          }),
        derive: (candidate: string) => deriveRuntimeTraceMoveSourceEditPlan(candidate, sceneName, sourcePath, "square"),
        label: "move",
        program: moveEditProgram(),
      },
      {
        assertImported: (imported: NonNullable<ReturnType<typeof importManimScene>>) =>
          expect(imported.runtimeSceneState.propertyChannels[`${entityId}/scale`]?.samples.at(-1)?.value).toBe(1.5),
        derive: (candidate: string) =>
          deriveRuntimeTraceResizeSourceEditPlan(candidate, sceneName, sourcePath, "square"),
        label: "uniform resize",
        program: resizeEditProgram(),
      },
      {
        assertImported: (imported: NonNullable<ReturnType<typeof importManimScene>>) =>
          expect(imported.runtimeSceneState.propertyChannels[`${entityId}/rotation`]?.samples.at(-1)?.value).toBe(0.5),
        derive: (candidate: string) =>
          deriveRuntimeTraceRotationSourceEditPlan(candidate, sceneName, sourcePath, "square"),
        label: "rotation",
        program: rotationEditProgram(),
      },
      {
        assertImported: (imported: NonNullable<ReturnType<typeof importManimScene>>) =>
          expect(imported.runtimeSceneState.propertyChannels[`${entityId}/appearance`]?.samples.at(-1)?.value).toBe(
            0.25,
          ),
        derive: (candidate: string) =>
          deriveRuntimeTraceOpacitySourceEditPlan(candidate, sceneName, sourcePath, "square"),
        label: "opacity",
        program: opacityEditProgram(),
      },
    ];

    for (const testCase of cases) {
      const lowered = lower(source, request(source, testCase.program));
      expect(lowered, testCase.label).not.toBeNull();
      const imported = importManimScene(lowered!.source, sourcePath, sceneName, frame);
      expect(imported, testCase.label).not.toBeNull();
      expect(imported?.sourceVariables, testCase.label).toEqual({ [entityId]: "square" });
      testCase.assertImported(imported!);
      expect(testCase.derive(lowered!.source).baseSource, testCase.label).toBe(source);
    }
  });

  it("round-trips a default static NumberPlane move as the same source-bound root", () => {
    const program = moveEditProgram({ x: 410, y: 135 }, 0, numberPlaneEntityId);
    const lowered = lowerNumberPlane(numberPlaneSource, program);

    expect(lowered?.insertedCode).toBe("        grid.move_to((2, 1, 0))");
    expect(lowered?.source).toContain(
      "        grid = NumberPlane()\n" + "        grid.move_to((2, 1, 0))\n" + "        self.add(grid)",
    );
    expect(lowered?.preflight).toMatchObject({
      baseBinding: { name: "grid", ordinal: 1 },
      baseSourceHash: createHash("sha256").update(numberPlaneSource, "utf8").digest("hex"),
      entityId: numberPlaneEntityId,
      expectedWorldCenter: { x: 2, y: 1 },
      kind: "runtime-trace-move-edit",
      sourceAnchor: 0,
    });

    const imported = importManimScene(lowered!.source, numberPlaneSourcePath, numberPlaneSceneName, frame);
    expect(imported?.sourceVariables).toEqual({ [numberPlaneEntityId]: "grid" });
    expect(imported?.runtimeSceneState.objectGraph.entities[numberPlaneEntityId]).toMatchObject({
      sourceIdentity: { kind: "known", value: "grid" },
      type: "NumberPlane",
    });
    expect(
      imported?.runtimeSceneState.propertyChannels[`${numberPlaneEntityId}/position`]?.samples.at(-1)?.value,
    ).toEqual({ x: 410, y: 135 });
    expect(
      deriveRuntimeTraceMoveSourceEditPlan(lowered!.source, numberPlaneSceneName, numberPlaneSourcePath, "grid"),
    ).toMatchObject({
      baseSource: numberPlaneSource,
      expectedWorldCenter: { x: 2, y: 1 },
      sourceAnchor: 0,
    });
  });

  it("round-trips a positive uniform NumberPlane scale after reimporting a prior move", () => {
    const moved = lowerNumberPlane(
      numberPlaneSource,
      moveEditProgram({ x: 410, y: 135 }, 0, numberPlaneEntityId),
    )!.source;
    const resize = resizeEditProgram(1.5, 1, 0, numberPlaneEntityId);
    const lowered = lowerNumberPlane(moved, resize);

    expect(lowered?.insertedCode).toBe("        grid.scale(1.5)");
    expect(lowered?.source).toContain(
      "        grid = NumberPlane()\n" +
        "        grid.scale(1.5)\n" +
        "        grid.move_to((2, 1, 0))\n" +
        "        self.add(grid)",
    );
    expect(lowered?.preflight).toMatchObject({
      baseBinding: { name: "grid", ordinal: 1 },
      entityId: numberPlaneEntityId,
      expectedScaleFactor: 1.5,
      kind: "runtime-trace-resize-edit",
      sourceAnchor: 0,
    });

    const imported = importManimScene(lowered!.source, numberPlaneSourcePath, numberPlaneSceneName, frame);
    expect(imported?.sourceVariables).toEqual({ [numberPlaneEntityId]: "grid" });
    expect(imported?.runtimeSceneState.objectGraph.entities[numberPlaneEntityId]).toMatchObject({
      sourceIdentity: { kind: "known", value: "grid" },
      type: "NumberPlane",
    });
    expect(imported?.runtimeSceneState.propertyChannels[`${numberPlaneEntityId}/scale`]?.samples.at(-1)?.value).toBe(
      1.5,
    );
    expect(
      deriveRuntimeTraceResizeSourceEditPlan(lowered!.source, numberPlaneSceneName, numberPlaneSourcePath, "grid"),
    ).toMatchObject({
      baseSource: moved,
      expectedScaleFactor: 1.5,
      sourceAnchor: 0,
    });
  });

  it("round-trips the advertised OpeningManim terminal move through Python and fresh derivation", () => {
    const targetEntityId = `source:${officialSourcePath}#OpeningManim:grid_title`;
    const targetWorld = { x: 1.25, y: -0.5 };
    const { imported, lowered } = roundTripOfficialEdit(
      "OpeningManim",
      "grid_title",
      targetEntityId,
      moveEditProgram(
        {
          x: (targetWorld.x / frame.width + 0.5) * 640,
          y: (0.5 - targetWorld.y / frame.height) * 360,
        },
        13,
        targetEntityId,
      ),
    );

    expect(imported.sourceVariables[targetEntityId]).toBe("grid_title");
    expect(imported.runtimeSceneState.propertyChannels[`${targetEntityId}/position`]?.samples.at(-1)).toMatchObject({
      interval: { end: 14, start: 13 },
      knowledge: { kind: "known", value: { x: 376.25, y: 202.5 } },
      value: { x: 376.25, y: 202.5 },
    });
    expect(
      deriveRuntimeTraceMoveSourceEditPlan(lowered.source, "OpeningManim", officialSourcePath, "grid_title", 13),
    ).toMatchObject({
      baseSource: officialSource,
      baseSourceHash: officialSourceHash,
      expectedWorldCenter: targetWorld,
      sourceAnchor: 13,
    });
  });

  it("round-trips the advertised WarpSquare move through Python and fresh derivation", () => {
    const targetEntityId = `source:${officialSourcePath}#WarpSquare:square`;
    const { imported, lowered } = roundTripOfficialEdit(
      "WarpSquare",
      "square",
      targetEntityId,
      moveEditProgram({ x: 410, y: 135 }, 0, targetEntityId),
    );

    expect(imported.sourceVariables[targetEntityId]).toBe("square");
    expect(imported.runtimeSceneState.propertyChannels[`${targetEntityId}/position`]?.samples.at(-1)).toMatchObject({
      interval: { end: 2, start: 0 },
      knowledge: { kind: "known", value: { x: 410, y: 135 } },
      value: { x: 410, y: 135 },
    });
    expect(
      deriveRuntimeTraceMoveSourceEditPlan(lowered.source, "WarpSquare", officialSourcePath, "square"),
    ).toMatchObject({
      baseSource: officialSource,
      baseSourceHash: officialSourceHash,
      expectedWorldCenter: { x: 2, y: 1 },
      sourceAnchor: 0,
    });
  });

  it("round-trips the advertised UpdatersExample terminal resize through Python and fresh derivation", () => {
    const targetEntityId = `source:${officialSourcePath}#UpdatersExample:square`;
    const { imported, lowered } = roundTripOfficialEdit(
      "UpdatersExample",
      "square",
      targetEntityId,
      resizeEditProgram(1.5, 1, 5, targetEntityId),
    );

    expect(imported.sourceVariables[targetEntityId]).toBe("square");
    expect(imported.runtimeSceneState.propertyChannels[`${targetEntityId}/scale`]?.samples.at(-1)).toMatchObject({
      from: 1,
      interval: { end: 6, start: 5 },
      knowledge: { kind: "known", value: 1.5 },
      relative: true,
      value: 1.5,
    });
    expect(
      deriveRuntimeTraceResizeSourceEditPlan(lowered.source, "UpdatersExample", officialSourcePath, "square", 5),
    ).toMatchObject({
      baseSource: officialSource,
      baseSourceHash: officialSourceHash,
      expectedScaleFactor: 1.5,
      sourceAnchor: 5,
    });
  });

  it("accepts a negative rotation and rejects no-op, non-finite, or unbounded angles", () => {
    expect(lower(source, request(source, rotationEditProgram(-0.5)))?.insertedCode).toBe("        square.rotate(-0.5)");
    expect(() => lower(source, request(source, rotationEditProgram(0)))).toThrow(/finite non-noop bounded angle/i);
    expect(() => lower(source, request(source, rotationEditProgram(2 * Math.PI)))).toThrow(
      /finite non-noop bounded angle/i,
    );
    expect(() => lower(source, request(source, rotationEditProgram(Number.NaN)))).toThrow(
      /only one exact direct-manipulation/i,
    );
    expect(() => lower(source, request(source, rotationEditProgram(1e100)))).toThrow(/finite non-noop bounded angle/i);

    const setProperty = moveEditProgram();
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
    const lowered = lower(source, request(source, rotationEditProgram()));
    expect(lowered).not.toBeNull();
    const nonCanonical = lowered!.source.replace("square.rotate(0.5)", "square.rotate(0.50)");
    const identity = lowered!.source.replace("square.rotate(0.5)", "square.rotate(0)");
    const nonAdjacent = lowered!.source.replace(
      "        square.rotate(0.5)\n        square.set_stroke",
      "        self.add(square)\n        square.rotate(0.5)\n        square.set_stroke",
    );

    expect(() => deriveRuntimeTraceRotationSourceEditPlan(nonCanonical, sceneName, sourcePath, "square")).toThrow(
      /canonical finite non-noop bounded rotate/i,
    );
    expect(() => deriveRuntimeTraceRotationSourceEditPlan(identity, sceneName, sourcePath, "square")).toThrow(
      /canonical finite non-noop bounded rotate/i,
    );
    expect(() => deriveRuntimeTraceRotationSourceEditPlan(nonAdjacent, sceneName, sourcePath, "square")).toThrow(
      /candidate rotation/i,
    );
  });

  it("re-derives sequential edits with the newest statement directly after the assignment", () => {
    // A resize on an already-moved base keeps the earlier canonical move as
    // plain base program text; only the newest inserted statement is removed.
    const moved = lower()!.source;
    const resized = lower(moved, request(moved, resizeEditProgram()));
    expect(resized).not.toBeNull();
    expect(resized?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.scale(1.5)\n" +
        "        square.move_to((2, 1, 0))\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveRuntimeTraceResizeSourceEditPlan(resized!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(moved);
    expect(derived.expectedScaleFactor).toBe(1.5);
  });

  it("appends a repeated absolute move after the prior move", () => {
    const first = lower(source, request(source, moveEditProgram({ x: 410, y: 135 })))!.source;
    const second = lower(first, request(first, moveEditProgram({ x: 500, y: 225 })));

    expect(second?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.move_to((2, 1, 0))\n" +
        "        square.move_to((4, -1, 0))\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveRuntimeTraceMoveSourceEditPlan(second!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(first);
    expect(derived.expectedWorldCenter).toEqual({ x: 4, y: -1 });
  });

  it("appends a repeated relative rotation after the prior canonical rotation", () => {
    const first = lower(source, request(source, rotationEditProgram(0.3)))!.source;
    const second = lower(first, request(first, rotationEditProgram(0.5)));

    expect(second?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.rotate(0.3)\n" +
        "        square.rotate(0.5)\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveRuntimeTraceRotationSourceEditPlan(second!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(first);
    expect(derived.expectedAngleRadians).toBe(0.5);
  });

  it("appends a repeated absolute opacity after the prior canonical opacity", () => {
    const first = lower(source, request(source, opacityEditProgram(0.4)))!.source;
    const second = lower(first, request(first, opacityEditProgram(0.75)));

    expect(second?.source).toContain(
      "        square = Square().set_fill(BLUE, opacity=0.6)\n" +
        "        square.set_opacity(0.4)\n" +
        "        square.set_opacity(0.75)\n" +
        "        square.set_stroke(WHITE, width=2)",
    );
    const derived = deriveRuntimeTraceOpacitySourceEditPlan(second!.source, sceneName, sourcePath, "square");
    expect(derived.baseSource).toBe(first);
    expect(derived.expectedOpacity).toBe(0.75);
  });
});
