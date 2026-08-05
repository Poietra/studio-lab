import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import { lowerCanonicalProgramBatchSource, ProgramLoweringError } from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "WriteStuff";
const frame = { height: 8, width: 14.222222222222221 } as const;
const viewport = { height: 360, width: 640 } as const;
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
const entityId = sourceBindings.find(({ sourceVariable }) => sourceVariable === "example_tex")!.entityId;

function operationBase(id: string) {
  return {
    dependsOn: [],
    id,
    interval: { end: 0, start: 0 },
    provenance: { evidence: ["WriteStuff V12 equation edit"], origin: "direct-manipulation" as const },
  };
}

function positionOperation(
  value: Readonly<{ x: number; y: number }> = { x: 376.25, y: 202.5 },
  targetEntityId = entityId,
): CanonicalEditOperation {
  return {
    ...operationBase("write-stuff-position"),
    entityId: targetEntityId,
    key: "position",
    kind: "SetProperty",
    value,
  };
}

function scaleOperation(factor = 0.5, targetEntityId = entityId): CanonicalEditOperation {
  return {
    ...operationBase("write-stuff-scale"),
    easing: "smooth",
    entityId: targetEntityId,
    from: 1,
    key: "scale",
    kind: "AnimateProperty",
    relativeFactor: factor,
    to: factor,
  };
}

function program(operation: CanonicalEditOperation, index = 0): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["verified WriteStuff V12 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["WriteStuff V12 equation edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: `write-stuff-v12-initial-transform-${index}`,
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
    programs.map((editProgram) => ({ program: editProgram, sourceAnchor: overrides.sourceAnchor ?? 0 })),
    frame,
    null,
  );
}

describe("WriteStuff V12 equation source lowering", () => {
  it("inserts the canonical move then scale after layout and before the first Write", () => {
    const lowered = lower([scaleOperation(), positionOperation()]);

    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-write-stuff-v12",
    });
    expect(lowered.insertedCode).toBe("        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)");
    const layoutIndex = lowered.source.indexOf('group.width = config["frame_width"] - 2 * LARGE_BUFF');
    const moveIndex = lowered.source.indexOf("example_tex.move_to((1.25, -0.5, 0))");
    const scaleIndex = lowered.source.indexOf("example_tex.scale(0.5)");
    const writeIndex = lowered.source.indexOf("self.play(Write(example_text))");
    expect(layoutIndex).toBeLessThan(moveIndex);
    expect(moveIndex).toBeLessThan(scaleIndex);
    expect(scaleIndex).toBeLessThan(writeIndex);

    const reimported = importManimScene(lowered.source, sourcePath, sceneName, frame)!;
    expect(reimported.sourceVariables).toEqual(imported.sourceVariables);
    const equation = reimported.runtimeSceneState.objectGraph.entities[entityId]!;
    expect(equation.sourceIdentity).toEqual({ kind: "known", value: "example_tex" });
  });

  it.each([
    ["move only", [positionOperation()], "example_tex.move_to((1.25, -0.5, 0))", "example_tex.scale("],
    ["scale only", [scaleOperation()], "example_tex.scale(0.5)", "example_tex.move_to("],
  ] as const)("supports %s", (_label, operations, present, absent) => {
    const lowered = lower(operations);
    expect(lowered.source).toContain(present);
    expect(lowered.source).not.toContain(absent);
  });

  it("rejects every source identity except the example_tex root", () => {
    for (const sourceVariable of ["group", "example_text"] as const) {
      const other = sourceBindings.find((binding) => binding.sourceVariable === sourceVariable)!;
      expect(() => lower([positionOperation(undefined, other.entityId)])).toThrowError(
        /one verified `example_tex` equation binding/,
      );
    }
    expect(() => lower([positionOperation()], { request: { sourceBindings: sourceBindings.slice(1) } })).toThrowError(
      /exact imported `group`, `example_text`, and `example_tex` source bindings/,
    );
  });

  it("rejects replay, nonzero anchors, and hidden Program operations", () => {
    const first = lower([positionOperation()]);
    expect(() => lower([scaleOperation()], { source: first.source })).toThrowError(
      /current source bytes are not the pinned official source generation/,
    );
    expect(() =>
      lower([positionOperation()], {
        request: { sourceHash: createHash("sha256").update(first.source).digest("hex") },
        source: first.source,
      }),
    ).toThrowError(/edit must be rebased from the pinned official source generation/);
    expect(() => lower([positionOperation()], { sourceAnchor: 0.01 })).toThrowError(/source time zero/);
    const hidden = {
      ...program(positionOperation()),
      operations: [positionOperation(), scaleOperation()],
    } satisfies CanonicalEditProgram;
    expect(() => lower(hidden.operations, { programs: [hidden] })).toThrowError(
      /one exact direct-manipulation Program/,
    );
  });

  it.each([
    ["negative scale", scaleOperation(-0.5)],
    ["duplicate move", positionOperation()],
    ["non-uniform geometry", { ...positionOperation(), key: "dimensions", value: { height: 2, width: 2 } }],
    ["rotation", { ...positionOperation(), key: "rotation", value: 0.5 }],
    ["timed move", { ...positionOperation(), interval: { end: 1, start: 0 } }],
    ["controlled scale", { ...scaleOperation(), control: { x: 1, y: 1 } }],
  ] as const)("fails closed for %s", (label, operation) => {
    const operations = label === "duplicate move" ? [operation, positionOperation({ x: 320, y: 180 })] : [operation];
    expect(() => lower(operations as readonly CanonicalEditOperation[])).toThrow(ProgramLoweringError);
  });

  it("does not widen the generic lowerer outside the exact profile identity", () => {
    expect(() => lower([positionOperation()], { request: { sceneName: "CopiedWriteStuff" } })).toThrowError(
      /not imported|No # poietra:anchor/,
    );
    expect(() => lower([positionOperation()], { request: { sourcePath: "copied/basic.py" } })).toThrowError(
      /No # poietra:anchor/,
    );
  });
});
