import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { samplePropertyValue } from "../studio/property-sampling";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import { lowerCanonicalProgramBatchSource, ProgramLoweringError } from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "SquareToCircle";
const frame = { height: 8, width: 14.222222222222221 } as const;
const viewport = { height: 360, width: 640 } as const;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const sourceHash = createHash("sha256").update(source).digest("hex");
const imported = importManimScene(source, sourcePath, sceneName, frame)!;
const sourceEntityId = (name: "circle" | "square") =>
  Object.entries(imported.sourceVariables).find(([, variable]) => variable === name)?.[0] ??
  (() => {
    throw new Error(`The official SquareToCircle source lost its ${name} binding.`);
  })();
const circleEntityId = sourceEntityId("circle");
const squareEntityId = sourceEntityId("square");

function positionOperation(
  value: Readonly<{ x: number; y: number }> = { x: 410, y: 135 },
  overrides: Partial<CanonicalEditOperation> = {},
): CanonicalEditOperation {
  return {
    dependsOn: [],
    entityId: squareEntityId,
    id: "square-to-circle-v8-position",
    interval: { end: 0, start: 0 },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["verified SquareToCircle V8 source-time zero"], origin: "direct-manipulation" },
    value,
    ...overrides,
  } as CanonicalEditOperation;
}

function program(
  operation: CanonicalEditOperation = positionOperation(),
  overrides: Partial<CanonicalEditProgram> = {},
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["verified SquareToCircle V8 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["SquareToCircle V8 initial position"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "square-to-circle-v8-position",
    version: 1,
    ...overrides,
  };
}

function request(editProgram: CanonicalEditProgram = program()): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program: editProgram,
    projectId: "demo",
    sceneName,
    sourceBindings: [
      { entityId: circleEntityId, sourceVariable: "circle" },
      { entityId: squareEntityId, sourceVariable: "square" },
    ],
    sourceHash,
    sourcePath,
    viewport,
  };
}

function lower(
  input: Readonly<{
    editProgram?: CanonicalEditProgram;
    request?: Partial<ProgramRenderRequest>;
    source?: string;
    sourceAnchor?: number;
  }> = {},
) {
  const editProgram = input.editProgram ?? program();
  const renderRequest = { ...request(editProgram), ...input.request };
  const programs = renderRequest.programs ?? [renderRequest.program];
  return lowerCanonicalProgramBatchSource(
    input.source ?? source,
    renderRequest,
    programs.map((candidate) => ({ program: candidate, sourceAnchor: input.sourceAnchor ?? 0 })),
    frame,
    null,
  );
}

describe("SquareToCircle V8 initial position source lowering", () => {
  it("inserts one canonical equal move_to pair before Create and removing it restores official bytes", () => {
    const lowered = lower();

    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-square-to-circle-v8",
    });
    expect(lowered.anchorLine).toBe(78);
    expect(lowered.anchorLines).toEqual([78]);
    expect(lowered.insertedCode).toBe("        square.move_to((2, 1, 0))\n        circle.move_to((2, 1, 0))");
    expect(lowered.source.match(/square\.move_to/g)).toHaveLength(1);
    expect(lowered.source.match(/circle\.move_to/g)).toHaveLength(1);
    expect(lowered.source.indexOf("circle.set_fill(PINK, opacity=0.5)")).toBeLessThan(
      lowered.source.indexOf("square.move_to((2, 1, 0))"),
    );
    expect(lowered.source.indexOf("square.move_to((2, 1, 0))")).toBeLessThan(
      lowered.source.indexOf("circle.move_to((2, 1, 0))"),
    );
    expect(lowered.source.indexOf("circle.move_to((2, 1, 0))")).toBeLessThan(
      lowered.source.indexOf("self.play(Create(square))"),
    );
    expect(lowered.source.replace(`${lowered.insertedCode}\n`, "")).toBe(source);

    const reimported = importManimScene(lowered.source, sourcePath, sceneName, frame)!;
    for (const sourceVariable of ["circle", "square"] as const) {
      const entityId = Object.entries(reimported.sourceVariables).find(([, value]) => value === sourceVariable)?.[0];
      expect(entityId, `${sourceVariable} must remain source-bound`).toBeDefined();
      expect(
        samplePropertyValue(reimported.runtimeSceneState.propertyChannels[`${entityId}/position`]!.samples, 0),
      ).toEqual({ x: 410, y: 135 });
    }
  });

  it("rejects stale source bytes or source authority before emitting a candidate", () => {
    const changed = source.replace("circle.set_fill(PINK, opacity=0.5)", "circle.set_fill(PINK, opacity=0.6)");
    expect(() => lower({ source: changed })).toThrowError(/current source bytes are not the pinned official/);
    expect(() =>
      lower({
        request: { sourceHash: createHash("sha256").update(changed).digest("hex") },
        source: changed,
      }),
    ).toThrowError(/edit must be rebased from the pinned official/);
  });

  it.each([
    ["a circle target", positionOperation(undefined, { entityId: circleEntityId })],
    [
      "a scale edit",
      {
        ...positionOperation(),
        easing: "smooth",
        from: 1,
        key: "scale",
        kind: "AnimateProperty",
        relativeFactor: 1.5,
        to: 1.5,
      } as CanonicalEditOperation,
    ],
    ["a timed edit", positionOperation(undefined, { interval: { end: 1, start: 0 } })],
    ["a non-finite point", positionOperation({ x: Number.NaN, y: 135 })],
  ] as const)("fails closed for %s", (_label, operation) => {
    expect(() => lower({ editProgram: program(operation) })).toThrow(ProgramLoweringError);
  });

  it("rejects no-op and out-of-range positions", () => {
    expect(() => lower({ editProgram: program(positionOperation({ x: 320, y: 180 })) })).toThrowError(/must change/);
    expect(() => lower({ editProgram: program(positionOperation({ x: 320 + 1e-12, y: 180 })) })).toThrowError(
      /must change/,
    );
    expect(() => lower({ editProgram: program(positionOperation({ x: 1e12, y: 180 })) })).toThrowError(
      /bounded coordinate range/,
    );
  });

  it("rejects a second Program, a nonzero anchor, and incomplete or aliased bindings", () => {
    const editProgram = program();
    expect(() =>
      lower({
        request: {
          programs: [editProgram, { ...editProgram, transactionId: "second-position" }],
        },
      }),
    ).toThrowError(/exactly one correlated position Program/);
    expect(() =>
      lower({
        editProgram: {
          ...editProgram,
          anchor: {
            ...editProgram.anchor,
            capturedPlayhead: 1,
            resolvedSeconds: 1,
            source: { kind: "absolute", seconds: 1 },
          },
        },
        sourceAnchor: 1,
      }),
    ).toThrowError(/source time zero/);
    expect(() =>
      lower({ request: { sourceBindings: [{ entityId: squareEntityId, sourceVariable: "square" }] } }),
    ).toThrowError(/exact imported `circle` and `square`/);
    expect(() =>
      lower({
        request: {
          sourceBindings: [
            { entityId: circleEntityId, sourceVariable: "square" },
            { entityId: squareEntityId, sourceVariable: "circle" },
          ],
        },
      }),
    ).toThrowError(/exact imported `circle` and `square`/);
  });

  it("does not widen the exact profile to copied paths or altered Transform dependencies", () => {
    expect(() => lower({ request: { sourcePath: "copied/basic.py" } })).toThrowError(/No # poietra:anchor/);
    const changedDependency = source.replace("Transform(square, circle)", "Transform(circle, square)");
    expect(() => lower({ source: changedDependency })).toThrowError(/current source bytes are not the pinned official/);
  });
});
