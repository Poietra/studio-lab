import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { createFastManimRuntimeTraceProducerRequestV3 } from "./fast-manim-runtime-trace-v3-contract";
import {
  lowerFastManimRuntimeTraceProducerJsonV3,
  lowerVerifiedFastManimRuntimeTraceV3,
} from "./fast-manim-runtime-trace-v3-lowering";
import { fastManimRuntimeTraceV3Schema } from "./fast-manim-runtime-trace-v3-result-contract";

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
    const trace = fastManimRuntimeTraceV3Schema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
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
});
