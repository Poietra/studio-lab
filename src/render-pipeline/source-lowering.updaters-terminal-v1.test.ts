import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import {
  deriveUpdatersTerminalSourceEditPlanV1,
  lowerCanonicalProgramBatchSource,
  ProgramLoweringError,
  recoverUpdatersTerminalOfficialSourceV1,
} from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "UpdatersExample";
const frame = { height: 8, width: 14.222222222222221 } as const;
const viewport = { height: 360, width: 640 } as const;
const terminalTime = 5;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const sourceHash = createHash("sha256").update(source).digest("hex");
const imported = importManimScene(source, sourcePath, sceneName, frame)!;
const sourceBindings = Object.entries(imported.sourceVariables).map(([entityId, sourceVariable]) => ({
  entityId,
  sourceVariable,
}));
const squareEntityId = sourceBindings.find(({ sourceVariable }) => sourceVariable === "square")!.entityId;

function operationBase(id: string) {
  return {
    dependsOn: [],
    id,
    interval: { end: terminalTime, start: terminalTime },
    provenance: { evidence: ["UpdatersExample terminal edit"], origin: "direct-manipulation" as const },
  };
}

function positionOperation(
  value: Readonly<{ x: number; y: number }> = { x: 410, y: 135 },
  entityId = squareEntityId,
): CanonicalEditOperation {
  return {
    ...operationBase("updaters-terminal-position"),
    entityId,
    key: "position",
    kind: "SetProperty",
    value,
  };
}

function resizeOperation(
  factor = 1.5,
  overrides: Readonly<{
    entityId?: string;
    fromPosition?: Readonly<{ x: number; y: number }>;
    toHeight?: number;
    toPosition?: Readonly<{ x: number; y: number }>;
    toWidth?: number;
  }> = {},
): CanonicalEditOperation {
  const fromPosition = overrides.fromPosition ?? { x: 320, y: 45 };
  return {
    ...operationBase("updaters-terminal-resize"),
    entityId: overrides.entityId ?? squareEntityId,
    from: { dimensions: { height: 2, width: 2 }, position: fromPosition },
    kind: "ResizeEntity",
    scale: 1,
    shape: "rectangle",
    to: {
      dimensions: { height: overrides.toHeight ?? 2 * factor, width: overrides.toWidth ?? 2 * factor },
      position: overrides.toPosition ?? fromPosition,
    },
  };
}

function program(operation: CanonicalEditOperation, index = 0): CanonicalEditProgram {
  const mode = operation.kind === "ResizeEntity" ? "sequence" : "parallel";
  return {
    anchor: {
      capturedPlayhead: terminalTime,
      evidence: ["verified UpdatersExample five-second terminal boundary"],
      resolvedSeconds: terminalTime,
      source: { kind: "playhead", referenceSeconds: terminalTime },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["UpdatersExample terminal edit"], origin: "direct-manipulation" },
    requestedExecution: mode,
    schedule: { edges: [], mode, order: [operation.id] },
    transactionId: `updaters-terminal-v1-${index}`,
    version: 1,
  };
}

function request(editProgram: CanonicalEditProgram): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program: editProgram,
    projectId: "demo",
    sceneName,
    sourceBindings,
    sourceHash,
    sourcePath,
    viewport,
  };
}

function lower(
  operations: readonly CanonicalEditOperation[],
  overrides: Readonly<{
    programs?: readonly CanonicalEditProgram[];
    request?: Partial<ProgramRenderRequest>;
    source?: string;
    sourceAnchor?: number;
  }> = {},
) {
  const programs = overrides.programs ?? operations.map(program);
  const renderRequest: ProgramRenderRequest = {
    ...request(programs[0]!),
    ...(programs.length > 1 ? { programs } : {}),
    ...overrides.request,
  };
  return lowerCanonicalProgramBatchSource(
    overrides.source ?? source,
    renderRequest,
    programs.map((editProgram) => ({
      program: editProgram,
      sourceAnchor: overrides.sourceAnchor ?? terminalTime,
    })),
    frame,
    null,
  );
}

describe("UpdatersExample terminal edit V1 source lowering", () => {
  it("inserts a deterministic move then uniform scale after the five-second play and before the final wait", () => {
    const lowered = lower([resizeOperation(), positionOperation()]);

    expect(sourceHash).toBe("d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f");
    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-updaters-terminal-v1",
    });
    expect(lowered.insertedCode).toBe(
      "        square.move_to((2, 1, 0))\n        square.scale(1.5)\n        decimal.update(0)",
    );
    const playEnd = lowered.source.indexOf("            run_time=5,\n        )");
    const move = lowered.source.indexOf("        square.move_to((2, 1, 0))");
    const scale = lowered.source.indexOf("        square.scale(1.5)");
    const refresh = lowered.source.indexOf("        decimal.update(0)", scale);
    const wait = lowered.source.indexOf("        self.wait()", refresh);
    expect(playEnd).toBeGreaterThan(-1);
    expect(playEnd).toBeLessThan(move);
    expect(move).toBeLessThan(scale);
    expect(scale).toBeLessThan(refresh);
    expect(refresh).toBeLessThan(wait);
    expect(lowered.source.replace(`${lowered.insertedCode}\n`, "")).toBe(source);
    expect(deriveUpdatersTerminalSourceEditPlanV1(lowered.source, sceneName)).toEqual({
      anchorLine: 129,
      moveTo: { x: 2, y: 1, z: 0 },
      refreshDependentUpdater: true,
      scale: 1.5,
      sourceTime: 5,
    });
    expect(recoverUpdatersTerminalOfficialSourceV1(lowered.source, sceneName)).toBe(source);

    const reimported = importManimScene(lowered.source, sourcePath, sceneName, frame)!;
    expect(reimported.sourceVariables).toEqual(imported.sourceVariables);
    expect(reimported.runtimeSceneState.objectGraph.entities[squareEntityId]?.sourceIdentity).toEqual({
      kind: "known",
      value: "square",
    });
  });

  it.each([
    ["move only", [positionOperation()], "square.move_to((2, 1, 0))", "square.scale("],
    ["resize only", [resizeOperation()], "square.scale(1.5)", "square.move_to("],
  ] as const)("supports %s", (_label, operations, present, absent) => {
    const lowered = lower(operations);
    expect(lowered.source).toContain(present);
    expect(lowered.source).not.toContain(absent);
    expect(lowered.source.match(/^\s*decimal\.update\(0\)$/gmu)).toHaveLength(1);
  });

  it("rejects another target and every ambiguous source binding", () => {
    expect(() => lower([positionOperation(undefined, "runtime:decimal")])).toThrowError(
      /operation on `square` at source time five/,
    );
    expect(() => lower([positionOperation()], { request: { sourceBindings: [] } })).toThrowError(
      /one exact imported `square` source binding/,
    );
    expect(() =>
      lower([positionOperation()], {
        request: {
          sourceBindings: [...sourceBindings, { entityId: squareEntityId, sourceVariable: "square_alias" }],
        },
      }),
    ).toThrowError(/one exact imported `square` source binding/);
  });

  it("rejects another playhead, hidden operations, and non-direct metadata", () => {
    expect(() => lower([positionOperation()], { sourceAnchor: 4.999 })).toThrowError(/source time five/);
    const wrongAnchor = {
      ...program(positionOperation()),
      anchor: {
        ...program(positionOperation()).anchor,
        capturedPlayhead: 4,
        resolvedSeconds: 4,
        source: { kind: "playhead" as const, referenceSeconds: 4 },
      },
    } satisfies CanonicalEditProgram;
    expect(() => lower(wrongAnchor.operations, { programs: [wrongAnchor] })).toThrowError(/source time five/);
    const hidden = {
      ...program(positionOperation()),
      operations: [positionOperation(), resizeOperation()],
    } satisfies CanonicalEditProgram;
    expect(() => lower(hidden.operations, { programs: [hidden] })).toThrowError(
      /one exact direct-manipulation operation/,
    );
    const fixture = {
      ...program(positionOperation()),
      provenance: { evidence: [], origin: "fixture" as const },
    } satisfies CanonicalEditProgram;
    expect(() => lower(fixture.operations, { programs: [fixture] })).toThrowError(
      /one exact direct-manipulation operation/,
    );
  });

  it.each([
    ["negative resize", resizeOperation(-1)],
    ["out-of-domain resize", resizeOperation(1_000_000_001)],
    ["nonuniform resize", resizeOperation(1.5, { toHeight: 4 })],
    ["center-moving resize", resizeOperation(1.5, { toPosition: { x: 321, y: 45 } })],
    ["animated resize", { ...resizeOperation(), interval: { end: 5.25, start: 5 } }],
    ["wrong operation kind", { ...positionOperation(), key: "scale", value: 2 }],
  ] as const)("fails closed for %s", (_label, operation) => {
    expect(() => lower([operation as CanonicalEditOperation])).toThrow(ProgramLoweringError);
  });

  it("rejects a viewport point that lowers outside the Runtime Trace coordinate domain", () => {
    const worldX = 1_000_000_001;
    const viewportX = viewport.width * (0.5 + worldX / frame.width);
    expect(() => lower([positionOperation({ x: viewportX, y: viewport.height / 2 })])).toThrowError(
      /between -1000000000 and 1000000000/,
    );
  });

  it("rejects re-edit, control-flow/source changes, and copied profile identities", () => {
    const first = lower([positionOperation()]);
    expect(() => lower([resizeOperation()], { source: first.source })).toThrowError(
      /current source bytes are not the pinned official source generation/,
    );
    const nested = source.replace(
      "        self.play(\n            square.animate.to_edge(DOWN),",
      "        if True:\n            self.play(\n                square.animate.to_edge(DOWN),",
    );
    expect(() =>
      lower([positionOperation()], {
        request: { sourceHash: createHash("sha256").update(nested).digest("hex") },
        source: nested,
      }),
    ).toThrowError(/pinned official source generation/);
    expect(() => lower([positionOperation()], { request: { sceneName: "CopiedUpdatersExample" } })).toThrowError(
      /not imported|No # poietra:anchor/,
    );
    expect(() => lower([positionOperation()], { request: { sourcePath: "copied/basic.py" } })).toThrowError(
      /No # poietra:anchor/,
    );
  });

  it("independently rejects aliases, control flow, alternate targets, and reordered candidate statements", () => {
    expect(deriveUpdatersTerminalSourceEditPlanV1(source, sceneName)).toEqual({
      anchorLine: 129,
      moveTo: null,
      refreshDependentUpdater: false,
      scale: null,
      sourceTime: 5,
    });
    const boundary = "        )\n        self.wait()";
    for (const invalidStatement of [
      "        alias = square",
      "        decimal.move_to((2, 1, 0))",
      "        square.scale(factor)",
      "        square.scale(1e+308)",
      "        square.move_to((1e+308, 1, 0))",
      "        square.move_to((2.0, 1, 0))",
    ]) {
      const candidate = source.replace(boundary, `        )\n${invalidStatement}\n        self.wait()`);
      expect(() => deriveUpdatersTerminalSourceEditPlanV1(candidate, sceneName)).toThrow(ProgramLoweringError);
    }
    const reordered = source.replace(
      boundary,
      "        )\n        square.scale(1.5)\n        square.move_to((2, 1, 0))\n        decimal.update(0)\n        self.wait()",
    );
    expect(() => deriveUpdatersTerminalSourceEditPlanV1(reordered, sceneName)).toThrow(ProgramLoweringError);
    const nested = source.replace(
      boundary,
      "        )\n        if True:\n            square.scale(1.5)\n        self.wait()",
    );
    expect(() => deriveUpdatersTerminalSourceEditPlanV1(nested, sceneName)).toThrow(ProgramLoweringError);
    expect(() => deriveUpdatersTerminalSourceEditPlanV1(source, "OpeningManim")).toThrow(ProgramLoweringError);
  });

  it.each([
    ["missing", "        square.move_to((2, 1, 0))"],
    ["reordered", "        decimal.update(0)\n        square.move_to((2, 1, 0))"],
    ["repeated", "        square.move_to((2, 1, 0))\n        decimal.update(0)\n        decimal.update(0)"],
    ["wrong target", "        square.move_to((2, 1, 0))\n        square.update(0)"],
    ["wrong argument", "        square.move_to((2, 1, 0))\n        decimal.update(1)"],
  ] as const)("rejects a %s dependent-updater sentinel", (_label, statements) => {
    const boundary = "        )\n        self.wait()";
    const candidate = source.replace(boundary, `        )\n${statements}\n        self.wait()`);
    expect(() => deriveUpdatersTerminalSourceEditPlanV1(candidate, sceneName)).toThrow(ProgramLoweringError);
    expect(() => recoverUpdatersTerminalOfficialSourceV1(candidate, sceneName)).toThrow(ProgramLoweringError);
  });
});
