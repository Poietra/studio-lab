import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import { lowerCanonicalProgramBatchSource, ProgramLoweringError } from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "LineJoints";
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
const entityId = sourceBindings.find(({ sourceVariable }) => sourceVariable === "t2")!.entityId;

function operationBase(id: string) {
  return {
    dependsOn: [],
    id,
    interval: { end: 0, start: 0 },
    provenance: { evidence: ["LineJoints V10 central-leaf edit"], origin: "direct-manipulation" as const },
  };
}

function positionOperation(
  value: Readonly<{ x: number; y: number }> = { x: 410, y: 135 },
  targetEntityId = entityId,
): CanonicalEditOperation {
  return {
    ...operationBase("line-joints-position"),
    entityId: targetEntityId,
    key: "position",
    kind: "SetProperty",
    value,
  };
}

function scaleOperation(factor = 1.5, targetEntityId = entityId): CanonicalEditOperation {
  return {
    ...operationBase("line-joints-scale"),
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
      evidence: ["verified LineJoints V10 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["LineJoints V10 central-leaf edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: `line-joints-v10-initial-transform-${index}`,
    version: 1,
  };
}

function request(program: CanonicalEditProgram): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program,
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
    programs.map((program) => ({ program, sourceAnchor: overrides.sourceAnchor ?? 0 })),
    frame,
    null,
  );
}

describe("LineJoints V10 central-leaf source lowering", () => {
  it("inserts move_to then scale after group layout and preserves source identity", () => {
    const lowered = lower([positionOperation(), scaleOperation()]);

    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-line-joints-v10",
    });
    expect(lowered.insertedCode).toBe("        t2.move_to((2, 1, 0))\n        t2.scale(1.5)");
    expect(lowered.source.indexOf("grp.set(width=config.frame_width - 1)")).toBeLessThan(
      lowered.source.indexOf("t2.move_to((2, 1, 0))"),
    );
    expect(lowered.source.indexOf("t2.move_to((2, 1, 0))")).toBeLessThan(lowered.source.indexOf("t2.scale(1.5)"));
    expect(lowered.source.indexOf("t2.scale(1.5)")).toBeLessThan(lowered.source.indexOf("self.add(grp)"));

    const reimported = importManimScene(lowered.source, sourcePath, sceneName, frame)!;
    expect(reimported.sourceVariables).toEqual(imported.sourceVariables);
    const t2 = reimported.runtimeSceneState.objectGraph.entities[entityId]!;
    if (!t2.geometry) throw new Error("The reimported t2 geometry is unavailable.");
    expect(t2.sourceIdentity).toEqual({ kind: "known", value: "t2" });
    expect(t2.geometry.position).toEqual({ kind: "known", value: { x: 410, y: 135 } });
  });

  it.each([
    ["move only", [positionOperation()], "t2.move_to((2, 1, 0))", "t2.scale("],
    ["scale only", [scaleOperation()], "t2.scale(1.5)", "t2.move_to("],
  ] as const)("supports %s", (_label, operations, present, absent) => {
    const lowered = lower(operations);
    expect(lowered.source).toContain(present);
    expect(lowered.source).not.toContain(absent);
  });

  it("rejects every source identity except the central t2 leaf", () => {
    for (const sourceVariable of ["grp", "t1", "t3"] as const) {
      const other = sourceBindings.find((binding) => binding.sourceVariable === sourceVariable)!;
      expect(() => lower([positionOperation(undefined, other.entityId)])).toThrowError(
        /one verified central `t2` binding/,
      );
    }
    expect(() => lower([positionOperation()], { request: { sourceBindings: sourceBindings.slice(1) } })).toThrowError(
      /exact imported `grp`, `t1`, `t2`, and `t3` source bindings/,
    );
  });

  it("rejects replay, nonzero anchors, and non-direct Program metadata", () => {
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
    expect(() => lower([positionOperation()], { sourceAnchor: 1 })).toThrowError(/source time zero/);
    const hidden = {
      ...program(positionOperation()),
      operations: [positionOperation(), scaleOperation()],
    } satisfies CanonicalEditProgram;
    expect(() => lower(hidden.operations, { programs: [hidden] })).toThrowError(
      /one exact direct-manipulation Program/,
    );
  });

  it.each([
    ["negative scale", scaleOperation(-1)],
    ["non-uniform geometry", { ...positionOperation(), key: "dimensions", value: { width: 2 } }],
    ["timed move", { ...positionOperation(), interval: { end: 1, start: 0 } }],
  ] as const)("fails closed for %s", (_label, operation) => {
    expect(() => lower([operation as CanonicalEditOperation])).toThrow(ProgramLoweringError);
  });

  it("does not widen the generic lowerer outside the exact profile identity", () => {
    expect(() => lower([positionOperation()], { request: { sceneName: "CopiedLineJoints" } })).toThrowError(
      /not imported|No # poietra:anchor/,
    );
    expect(() => lower([positionOperation()], { request: { sourcePath: "copied/basic.py" } })).toThrowError(
      /No # poietra:anchor/,
    );
  });
});
