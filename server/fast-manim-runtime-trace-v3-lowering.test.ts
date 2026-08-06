import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { createFastManimRuntimeTraceProducerRequestV3 } from "./fast-manim-runtime-trace-v3-contract";
import {
  lowerFastManimRuntimeTraceProducerJsonV3,
  lowerVerifiedFastManimRuntimeTraceV3,
} from "./fast-manim-runtime-trace-v3-lowering";
import {
  fastManimRuntimeTraceV3Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_CHANNELS_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_KEYFRAMES_V3,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V3,
} from "./fast-manim-runtime-trace-v3-result-contract";

const sourceText = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
const sourceHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
const fixturePath = new URL("./test-fixtures/fast-manim-runtime-trace-v3-generic.json", import.meta.url);
const trusted = {
  fastManimCommit: "0".repeat(40),
  fastManimTree: "1".repeat(40),
  manimVersion: "0.20.1",
} as const;

function request() {
  return createFastManimRuntimeTraceProducerRequestV3(
    {
      projectId: "generic-preview",
      requestId: "request-staticsquare-v3",
      sceneName: "StaticSquare",
      sourceHash,
      sourcePath: "scenes/staticsquare.py",
    },
    sourceText,
    { constructStartLine: 4, definitionOrdinal: 1 },
    { height: 8, width: 128 / 9 },
  );
}

async function traceFixture() {
  return fastManimRuntimeTraceV3Schema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
}

function pathWithSegmentCount(
  path: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>["resources"]["paths"][number]["path"],
  segmentCount: number,
) {
  const expanded = structuredClone(path);
  const subpath = expanded.subpaths[0]!;
  const segment = subpath.segments[0]!;
  expanded.subpaths = [
    {
      ...subpath,
      segments: Array.from({ length: segmentCount }, () => structuredClone(segment)),
    },
  ];
  return expanded;
}

function installSingleFrameDraws(
  trace: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>,
  drawCount: number,
  familyPath: (index: number) => number[],
) {
  const root = trace.roots[0]!;
  const seedDraw = trace.draws[0]!;
  const seedState = trace.frames[0]!.states[0]!;
  trace.draws = Array.from({ length: drawCount }, (_, index) => ({
    ...seedDraw,
    familyPath: familyPath(index),
    id: `${root.id}/draw:${index}`,
    rootId: root.id,
  }));
  trace.frames[0]!.states = trace.draws.map((draw, paintOrder) => ({
    ...seedState,
    drawId: draw.id,
    paintOrder,
  }));
}

describe("generic Runtime Trace V3 lowering", () => {
  it("compiles producer evidence into a preview-only retained path", async () => {
    const run = request();
    const bundle = await lowerFastManimRuntimeTraceProducerJsonV3(await readFile(fixturePath), run, trusted);

    expect(bundle.assets.assets).toEqual([]);
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: run.runtimeConfigHash,
      sourceHash,
      traceVersion: 3,
    });
    expect(bundle.scene.entities).toHaveLength(2);
    expect(bundle.scene.entities.map(({ geometry }) => geometry.kind)).toEqual(["group", "cubic-path"]);
    expect(bundle.scene.animationChannels).toEqual([]);

    const compiled = await compileEngineFrameV1({
      assets: bundle.assets,
      packetId: "runtime-v3:0",
      sampleTime: 0,
      scene: bundle.scene,
      viewport: { heightPx: 720, widthPx: 1_280 },
    });
    if (compiled.kind !== "ready") throw new Error(compiled.message);
    expect(compiled.frame.packet.draws).toHaveLength(1);
    expect(compiled.frame.packet.draws[0]).toMatchObject({
      fill: { color: { alpha: 0.6 } },
      kind: "path",
      opacity: 1,
      stroke: { color: { alpha: 1 }, widthWorld: 0.02 },
      transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
    });
  });

  it("seeks backward and forward across captured affine, opacity, and path samples deterministically", async () => {
    const trace = await traceFixture();
    const changedPath = structuredClone(trace.resources.paths[0]!.path);
    changedPath.subpaths[0]!.segments[0]!.control1.x += 0.25;
    const changedPathId = `path:${"2".repeat(64)}`;
    trace.resources.paths.push({ id: changedPathId, path: changedPath });
    trace.roots[0]!.lifetimes = [{ endFrame: 3, startFrame: 0 }];
    trace.draws[0]!.lifetimes = [{ endFrame: 3, startFrame: 0 }];
    const initialState = trace.frames[0]!.states[0]!;
    trace.frames = [
      trace.frames[0]!,
      {
        frameIndex: 1,
        sampleTime: 1 / 60,
        states: [
          { ...initialState, opacity: 0.5, pathId: changedPathId, transform: { ...initialState.transform, tx: 1 } },
        ],
      },
      {
        frameIndex: 2,
        sampleTime: 2 / 60,
        states: [{ ...initialState, transform: { ...initialState.transform, tx: 2 } }],
      },
    ];
    trace.sampleSchedule = { ...trace.sampleSchedule, durationSeconds: 0.05, frameCount: 3 };
    const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind).sort()).toEqual([
      "affine-transform",
      "opacity",
      "path-morph",
    ]);

    const compile = async (sampleTime: number) => {
      const result = await compileEngineFrameV1({
        assets: bundle.assets,
        packetId: `runtime-v3:${sampleTime}`,
        sampleTime,
        scene: bundle.scene,
        viewport: { heightPx: 720, widthPx: 1_280 },
      });
      if (result.kind !== "ready") throw new Error(result.message);
      return result.frame.packet.draws[0]!;
    };
    const forward = await compile(2 / 60);
    const backward = await compile(0);
    const middle = await compile(1 / 60);
    expect([forward.transform.tx, backward.transform.tx, middle.transform.tx]).toEqual([2, 0, 1]);
    expect(middle.opacity).toBe(0.5);
    expect(await compile(2 / 60)).toEqual(forward);
  });

  it("compacts content-addressed path IDs before materializing morph values", async () => {
    const trace = await traceFixture();
    const initialPath = trace.resources.paths[0]!;
    const changedPath = structuredClone(initialPath.path);
    changedPath.subpaths[0]!.segments[0]!.control1.x += 0.25;
    const changedPathId = `path:${"3".repeat(64)}`;
    trace.resources.paths.push({ id: changedPathId, path: changedPath });
    trace.roots[0]!.lifetimes = [{ endFrame: 6, startFrame: 0 }];
    trace.draws[0]!.lifetimes = [{ endFrame: 6, startFrame: 0 }];
    const state = trace.frames[0]!.states[0]!;
    const pathIds = [initialPath.id, initialPath.id, initialPath.id, changedPathId, changedPathId, changedPathId];
    trace.frames = pathIds.map((pathId, frameIndex) => ({
      frameIndex,
      sampleTime: Number((frameIndex / 60).toFixed(13)),
      states: [{ ...state, pathId }],
    }));
    trace.sampleSchedule = { ...trace.sampleSchedule, durationSeconds: 0.1, frameCount: 6 };

    const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
    const channel = bundle.scene.animationChannels.find(({ kind }) => kind === "path-morph");
    if (channel?.kind !== "path-morph") throw new Error("Expected a compacted path-morph channel.");
    expect(channel.keyframes.map(({ at }) => at)).toEqual([0, 2 / 60, 3 / 60, 5 / 60]);
    expect(channel.keyframes.map(({ value }) => value)).toEqual([
      initialPath.path,
      initialPath.path,
      changedPath,
      changedPath,
    ]);
  });

  it("reuses one large static path identity across the full 900-frame schedule", async () => {
    const trace = await traceFixture();
    trace.resources.paths[0]!.path = pathWithSegmentCount(trace.resources.paths[0]!.path, 400);
    trace.roots[0]!.lifetimes = [{ endFrame: 900, startFrame: 0 }];
    trace.draws[0]!.lifetimes = [{ endFrame: 900, startFrame: 0 }];
    const state = trace.frames[0]!.states[0]!;
    trace.frames = Array.from({ length: 900 }, (_, frameIndex) => ({
      frameIndex,
      sampleTime: Number((frameIndex / 60).toFixed(13)),
      states: [{ ...state }],
    }));
    trace.sampleSchedule = { ...trace.sampleSchedule, durationSeconds: 15, frameCount: 900 };

    const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
    expect(bundle.scene.duration).toBe(15);
    expect(bundle.scene.animationChannels.some(({ kind }) => kind === "path-morph")).toBe(false);
  });

  it("keeps provenance evidence bounded for a long source path", async () => {
    const trace = await traceFixture();
    trace.sourcePath = `${"nested/".repeat(61)}scene.py`;

    const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
    expect(bundle.scene.provenance[0]!.evidence.every((entry) => entry.length <= 500)).toBe(true);
  });

  it("rejects shared-path amplification beyond the normalized segment ceiling", async () => {
    const trace = await traceFixture();
    trace.resources.paths[0]!.path = pathWithSegmentCount(trace.resources.paths[0]!.path, 400);
    installSingleFrameDraws(trace, 256, (index) => [index]);

    await expect(lowerVerifiedFastManimRuntimeTraceV3(trace)).rejects.toThrow(
      `${MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V3} path-segment budget`,
    );
  });

  it("rejects family expansion beyond the normalized entity ceiling", async () => {
    const trace = await traceFixture();
    installSingleFrameDraws(trace, 157, (index) => [index, ...Array.from({ length: 63 }, () => 0)]);

    await expect(lowerVerifiedFastManimRuntimeTraceV3(trace)).rejects.toThrow(
      `${MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V3} entity budget`,
    );
  });

  it("rejects compacted animation evidence beyond the normalized keyframe ceiling", async () => {
    const trace = await traceFixture();
    installSingleFrameDraws(trace, 40, (index) => [index]);
    const changedAppearance = structuredClone(trace.resources.appearances[0]!);
    changedAppearance.id = `appearance:${"4".repeat(64)}`;
    if (changedAppearance.fill) changedAppearance.fill.color.red = changedAppearance.fill.color.red === 0 ? 0.25 : 0;
    else if (changedAppearance.stroke)
      changedAppearance.stroke.color.red = changedAppearance.stroke.color.red === 0 ? 0.25 : 0;
    else throw new Error("Expected one vector appearance.");
    trace.resources.appearances.push(changedAppearance);
    trace.roots[0]!.lifetimes = [{ endFrame: 900, startFrame: 0 }];
    trace.draws.forEach((draw) => {
      draw.lifetimes = [{ endFrame: 900, startFrame: 0 }];
    });
    const state = trace.frames[0]!.states[0]!;
    trace.frames = Array.from({ length: 900 }, (_, frameIndex) => ({
      frameIndex,
      sampleTime: Number((frameIndex / 60).toFixed(13)),
      states: trace.draws.map((draw, paintOrder) => ({
        ...state,
        appearanceId: frameIndex % 2 === 0 ? trace.resources.appearances[0]!.id : changedAppearance.id,
        drawId: draw.id,
        opacity: frameIndex % 2 === 0 ? 1 : 0.5,
        paintOrder,
        transform: { ...state.transform, tx: frameIndex % 2 },
      })),
    }));
    trace.sampleSchedule = { ...trace.sampleSchedule, durationSeconds: 15, frameCount: 900 };

    await expect(lowerVerifiedFastManimRuntimeTraceV3(trace)).rejects.toThrow(
      `${MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_KEYFRAMES_V3} keyframe budget`,
    );
    expect(MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_CHANNELS_V3).toBe(10_000);
  });
});
