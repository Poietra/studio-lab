import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../studio/operations";
import type { ProgramRenderRequest } from "./contracts";
import { importManimScene } from "./source-import";
import {
  deriveOpeningManimTerminalPositionSourceEditPlanV2,
  lowerOpeningManimTerminalPositionSourceV2,
  ProgramLoweringError,
  recoverOpeningManimOfficialSourceV2,
} from "./source-lowering";

const sourcePath = "example_scenes/basic.py";
const sceneName = "OpeningManim";
const sourceTime = 14;
const frame = { height: 8, width: 128 / 9 } as const;
const viewport = { height: 360, width: 640 } as const;
const source = readFileSync(
  new URL("../../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
  "utf8",
);
const sourceHash = createHash("sha256").update(source).digest("hex");
const imported = importManimScene(source, sourcePath, sceneName, frame)!;
const gridTitleBinding = Object.entries(imported.sourceVariables)
  .map(([entityId, sourceVariable]) => ({ entityId, sourceVariable }))
  .find(({ sourceVariable }) => sourceVariable === "grid_title")!;
const runtimeCenter = { x: -3, y: 2 } as const;

function viewportPosition(world: Readonly<{ x: number; y: number }>) {
  return {
    x: (world.x / frame.width + 0.5) * viewport.width,
    y: (0.5 - world.y / frame.height) * viewport.height,
  };
}

function positionOperation(world = { x: -1, y: 1 }, entityId = gridTitleBinding.entityId): CanonicalEditOperation {
  return {
    dependsOn: [],
    entityId,
    id: "opening-terminal-position",
    interval: { end: sourceTime, start: sourceTime },
    key: "position",
    kind: "SetProperty",
    provenance: { evidence: ["verified OpeningManim terminal root"], origin: "direct-manipulation" },
    value: viewportPosition(world),
  };
}

function program(operation = positionOperation()): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: sourceTime,
      evidence: ["verified final Transform play-end"],
      resolvedSeconds: sourceTime,
      source: { kind: "playhead", referenceSeconds: sourceTime },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: ["OpeningManim terminal edit"], origin: "direct-manipulation" },
    requestedExecution: "parallel",
    schedule: { edges: [], mode: "parallel", order: [operation.id] },
    transactionId: "opening-terminal-v2",
    version: 1,
  };
}

function request(editProgram = program()): ProgramRenderRequest {
  return {
    cameraCenter: { x: 0, y: 0 },
    destination: null,
    program: editProgram,
    projectId: "demo",
    sceneName,
    sourceBindings: [gridTitleBinding],
    sourceHash,
    sourcePath,
    viewport,
  };
}

function lower(
  overrides: Readonly<{
    center?: Readonly<{ x: number; y: number }> | null;
    editProgram?: CanonicalEditProgram;
    entries?: readonly Readonly<{ program: CanonicalEditProgram; sourceAnchor: number }>[];
    request?: Partial<ProgramRenderRequest>;
    source?: string;
  }> = {},
) {
  const editProgram = overrides.editProgram ?? program();
  return lowerOpeningManimTerminalPositionSourceV2(
    overrides.source ?? source,
    { ...request(editProgram), ...overrides.request },
    overrides.entries ?? [{ program: editProgram, sourceAnchor: sourceTime }],
    frame,
    null,
    overrides.center === undefined ? runtimeCenter : overrides.center,
  );
}

describe("OpeningManim terminal position V2 source authority", () => {
  it("proves the official grid_title occurrence and inserts one canonical translation at t=14", () => {
    expect(sourceHash).toBe("d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f");
    expect(deriveOpeningManimTerminalPositionSourceEditPlanV2(source, sceneName)).toEqual({
      anchorLine: 68,
      binding: { name: "grid_title", sourceLine: 38 },
      sourceTime,
      translation: null,
    });

    const lowered = lower()!;
    expect(lowered.preflight).toEqual({
      baseSourceHash: sourceHash,
      kind: "fast-manim-opening-terminal-v2",
    });
    expect(lowered.insertedCode).toBe("        grid_title.shift((2, -1, 0))");
    expect(lowered.source.indexOf("self.play(Transform(grid_title, grid_transform_title))")).toBeLessThan(
      lowered.source.indexOf(lowered.insertedCode),
    );
    expect(lowered.source.indexOf(lowered.insertedCode)).toBeLessThan(lowered.source.lastIndexOf("self.wait()"));
    expect(deriveOpeningManimTerminalPositionSourceEditPlanV2(lowered.source, sceneName).translation).toEqual({
      x: 2,
      y: -1,
      z: 0,
    });
    expect(recoverOpeningManimOfficialSourceV2(lowered.source, sceneName)).toBe(source);
    expect(lowered.source.replace(`${lowered.insertedCode}\n`, "")).toBe(source);
  });

  it("does not let Runtime Trace position evidence replace SourceAnalysis authority", () => {
    expect(() => lower({ request: { sourceBindings: [] } })).toThrowError(/SourceAnalysis grid_title binding/);
    expect(() =>
      lower({
        request: {
          sourceBindings: [{ entityId: "runtime-only:leaf", sourceVariable: "grid_title" }],
        },
      }),
    ).toThrowError(/SourceAnalysis grid_title binding/);
    expect(() => lower({ request: { sourceHash: "a".repeat(64) } })).toThrowError(/pinned official source generation/);
    expect(() => lower({ center: null })).toThrowError(/correlated Runtime Trace grid_title center/);
  });

  it("accepts only one exact position Program at the final Transform boundary", () => {
    const wrongTime = {
      ...program(),
      anchor: {
        ...program().anchor,
        capturedPlayhead: 13.99,
        resolvedSeconds: 13.99,
        source: { kind: "playhead" as const, referenceSeconds: 13.99 },
      },
    } satisfies CanonicalEditProgram;
    expect(() =>
      lower({ editProgram: wrongTime, entries: [{ program: wrongTime, sourceAnchor: 13.99 }] }),
    ).toThrowError(/source time fourteen/);
    expect(() => lower({ editProgram: program(positionOperation(undefined, "runtime-only:leaf")) })).toThrowError(
      /source time fourteen/,
    );
    expect(() =>
      lower({
        entries: [
          { program: program(), sourceAnchor: sourceTime },
          { program: program(), sourceAnchor: sourceTime },
        ],
      }),
    ).toThrowError(/source time fourteen/);
    expect(() => lower({ editProgram: program(), center: { x: -1, y: 1 } })).toThrowError(
      /nonzero bounded translation/,
    );
  });

  it("rejects missing, moved, ambiguous, and noncanonical source boundaries", () => {
    const boundary = "        self.play(Transform(grid_title, grid_transform_title))\n        self.wait()";
    for (const candidate of [
      source.replace('        grid_title = Tex("This is a grid", font_size=72)\n', ""),
      source.replace(
        boundary,
        "        self.play(Transform(grid_title, grid_transform_title))\n        grid_title.shift((2.0, -1, 0))\n        self.wait()",
      ),
      source.replace(
        boundary,
        "        self.play(Transform(grid_title, grid_transform_title))\n        if True:\n            grid_title.shift((2, -1, 0))\n        self.wait()",
      ),
      `${source}\nclass OpeningManim(Scene):\n    def construct(self):\n        self.wait()\n`,
    ]) {
      expect(() => deriveOpeningManimTerminalPositionSourceEditPlanV2(candidate, sceneName)).toThrow(
        ProgramLoweringError,
      );
    }
  });
});
