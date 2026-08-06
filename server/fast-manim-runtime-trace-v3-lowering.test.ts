import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { createFastManimRuntimeTraceProducerRequestV3 } from "./fast-manim-runtime-trace-v3-contract";
import { lowerFastManimRuntimeTraceProducerJsonV3 } from "./fast-manim-runtime-trace-v3-lowering";

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
});
