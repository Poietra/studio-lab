import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import { samplePropertyValue } from "../studio/property-sampling";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import { lowerCanonicalProgramBatchSource, ProgramLoweringError } from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "WarpSquare";
const frame = { height: 8, width: 14.222222222222221 } as const;
const viewport = { height: 360, width: 640 } as const;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const sourceHash = createHash("sha256").update(source).digest("hex");
const imported = importManimScene(source, sourcePath, sceneName, frame)!;
const squareEntityId = Object.entries(imported.sourceVariables).find(([, variable]) => variable === "square")![0];

function operationBase(id: string, start = 0, end = start) {
  return {
    dependsOn: [],
    id,
    interval: { end, start },
    provenance: { evidence: ["WarpSquare V9 initial edit"], origin: "direct-manipulation" as const },
  };
}

function positionOperation(
  value: Readonly<{ x: number; y: number }> = { x: 410, y: 135 },
  id = "warp-square-position",
): CanonicalEditOperation {
  return {
    ...operationBase(id),
    entityId: squareEntityId,
    key: "position",
    kind: "SetProperty",
    value,
  };
}

function scaleOperation(factor = 1.5, id = "warp-square-scale"): CanonicalEditOperation {
  return {
    ...operationBase(id),
    easing: "smooth",
    entityId: squareEntityId,
    from: 1,
    key: "scale",
    kind: "AnimateProperty",
    relativeFactor: factor,
    to: factor,
  };
}

function program(
  operations: readonly CanonicalEditOperation[],
  overrides: Partial<CanonicalEditProgram> = {},
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: ["verified WarpSquare V9 source-time zero"],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations,
    provenance: { evidence: ["WarpSquare V9 initial edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: operations.map(({ id }) => id) },
    transactionId: "warp-square-v9-initial-transform",
    version: 1,
    ...overrides,
  };
}

function request(editProgram: CanonicalEditProgram): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program: editProgram,
    projectId: "demo",
    sceneName,
    sourceBindings: [{ entityId: squareEntityId, sourceVariable: "square" }],
    sourceHash,
    sourcePath,
    viewport,
  };
}

function lower(
  operations: readonly CanonicalEditOperation[],
  input: Readonly<{
    editProgram?: CanonicalEditProgram;
    request?: Partial<ProgramRenderRequest>;
    source?: string;
    sourceAnchor?: number;
  }> = {},
) {
  const defaultPrograms = input.editProgram
    ? [input.editProgram]
    : operations.map((operation, index) =>
        program([operation], { transactionId: `warp-square-v9-initial-transform-${index + 1}` }),
      );
  const editProgram = defaultPrograms[0]!;
  const renderRequest = {
    ...request(editProgram),
    ...(defaultPrograms.length > 1 ? { programs: defaultPrograms } : {}),
    ...input.request,
  };
  const requestPrograms = renderRequest.programs ?? [renderRequest.program];
  return lowerCanonicalProgramBatchSource(
    input.source ?? source,
    renderRequest,
    requestPrograms.map((program) => ({ program, sourceAnchor: input.sourceAnchor ?? 0 })),
    frame,
    null,
  );
}

describe("WarpSquare V9 initial transform source lowering", () => {
  it("inserts canonical move_to then scale calls and reimports the edited initial state", () => {
    const lowered = lower([positionOperation(), scaleOperation()]);

    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-warp-square-v9",
    });
    expect(lowered.anchorLine).toBe(87);
    expect(lowered.insertedCode).toBe("        square.move_to((2, 1, 0))\n        square.scale(1.5)");
    expect(lowered.source.match(/square\.move_to/g)).toHaveLength(1);
    expect(lowered.source.match(/square\.scale/g)).toHaveLength(1);
    expect(lowered.source.indexOf("square = Square()")).toBeLessThan(
      lowered.source.indexOf("square.move_to((2, 1, 0))"),
    );
    expect(lowered.source.indexOf("square.move_to((2, 1, 0))")).toBeLessThan(
      lowered.source.indexOf("square.scale(1.5)"),
    );
    expect(lowered.source.indexOf("square.scale(1.5)")).toBeLessThan(
      lowered.source.indexOf("self.play(", lowered.source.indexOf("class WarpSquare")),
    );

    const reimported = importManimScene(lowered.source, sourcePath, sceneName, frame)!;
    const entity = Object.values(reimported.runtimeSceneState.objectGraph.entities).find(
      ({ sourceIdentity }) => sourceIdentity.kind === "known" && sourceIdentity.value === "square",
    )!;
    expect(
      samplePropertyValue(reimported.runtimeSceneState.propertyChannels[`${entity.id}/position`]!.samples, 0),
    ).toEqual({
      x: 410,
      y: 135,
    });
    expect(samplePropertyValue(reimported.runtimeSceneState.propertyChannels[`${entity.id}/scale`]!.samples, 0)).toBe(
      1.5,
    );
  });

  it.each([
    ["position only", [positionOperation()], "square.move_to((2, 1, 0))", "square.scale("],
    ["scale only", [scaleOperation()], "square.scale(1.5)", "square.move_to("],
  ] as const)("lowers %s without synthesizing the other transform", (_label, operations, present, absent) => {
    const lowered = lower(operations);
    expect(lowered.source).toContain(present);
    expect(lowered.source).not.toContain(absent);
  });

  it("aggregates separate move and scale Programs into one canonical source patch", () => {
    const move = program([positionOperation()], { transactionId: "warp-square-v9-move" });
    const scale = program([scaleOperation()], { transactionId: "warp-square-v9-scale" });
    const renderRequest: ProgramRenderRequest = { ...request(move), programs: [move, scale] };
    const lowered = lowerCanonicalProgramBatchSource(
      source,
      renderRequest,
      [
        { program: move, sourceAnchor: 0 },
        { program: scale, sourceAnchor: 0 },
      ],
      frame,
      null,
    );

    expect(lowered.insertedCode).toBe("        square.move_to((2, 1, 0))\n        square.scale(1.5)");
  });

  it("rejects replay after the official source generation has been edited", () => {
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
  });

  it.each([
    ["a repeated position", [positionOperation(), positionOperation({ x: 420, y: 145 }, "position-2")]],
    [
      "a dynamic scale",
      [{ ...scaleOperation(), from: undefined, relativeFactor: undefined } as CanonicalEditOperation],
    ],
    ["a negative scale", [{ ...scaleOperation(), relativeFactor: -1, to: -1 } as CanonicalEditOperation]],
    [
      "rotation",
      [
        {
          ...operationBase("rotation"),
          entityId: squareEntityId,
          key: "rotation",
          kind: "SetProperty",
          value: 0.5,
        } satisfies CanonicalEditOperation,
      ],
    ],
    ["a timed transform", [{ ...positionOperation(), interval: { end: 1, start: 0 } } as CanonicalEditOperation]],
  ] as const)("fails closed for %s", (_label, operations) => {
    expect(() => lower(operations)).toThrow(ProgramLoweringError);
  });

  it("rejects a post-play anchor, ambiguous binding, and more than two Programs", () => {
    const editProgram = program([positionOperation()]);
    expect(() =>
      lower(editProgram.operations, {
        editProgram: {
          ...editProgram,
          anchor: { ...editProgram.anchor, capturedPlayhead: 3, resolvedSeconds: 3 },
        },
        sourceAnchor: 3,
      }),
    ).toThrowError(/source time zero/);
    expect(() => lower(editProgram.operations, { request: { sourceBindings: [] } })).toThrowError(
      /exactly one imported `square` source binding/,
    );
    expect(() =>
      lower(editProgram.operations, {
        request: {
          programs: [
            editProgram,
            program([scaleOperation()], { transactionId: "second-program" }),
            program([scaleOperation(2)], { transactionId: "third-program" }),
          ],
        },
      }),
    ).toThrowError(/one or two correlated initial-transform Programs/);
  });

  it("rejects hidden operations and non-direct execution metadata before bypassing the generic evaluator", () => {
    const hidden = program([positionOperation(), scaleOperation()]);
    expect(() => lower(hidden.operations, { editProgram: hidden })).toThrowError(
      /one exact direct-manipulation Program/,
    );

    const sequenced = program([positionOperation()], {
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: ["warp-square-position"] },
    });
    expect(() => lower(sequenced.operations, { editProgram: sequenced })).toThrowError(
      /one exact direct-manipulation Program/,
    );
  });

  it("does not widen the marker-based generic lowerer outside the exact V9 identity", () => {
    expect(() => lower([positionOperation()], { request: { sourcePath: "copied/basic.py" } })).toThrowError(
      /No # poietra:anchor/,
    );
  });
});
