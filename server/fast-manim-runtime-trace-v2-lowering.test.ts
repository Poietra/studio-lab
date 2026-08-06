import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { lowerVerifiedFastManimRuntimeTraceV2 } from "./fast-manim-runtime-trace-v2-lowering";
import { fastManimRuntimeTraceV2Fixture } from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

const fixture = fastManimRuntimeTraceV2Fixture;

async function frameAt(bundle: Awaited<ReturnType<typeof lowerVerifiedFastManimRuntimeTraceV2>>, sampleTime: number) {
  const result = await compileEngineFrameV1({
    assets: bundle.assets,
    packetId: `opening-v2:${sampleTime}`,
    sampleTime,
    scene: bundle.scene,
    viewport: { heightPx: 720, widthPx: 1_280 },
  });
  if (result.kind !== "ready") throw new Error(result.message);
  return result.frame;
}

describe("OpeningManim Runtime Trace V2 lowering", () => {
  it("maps captured presentation frames to existing retained Scene IR channels", async () => {
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(fixture());

    expect(bundle.scene.source).toMatchObject({ kind: "imported-manim-runtime-trace", traceVersion: 2 });
    expect(bundle.scene.entities).toHaveLength(47);
    expect(bundle.scene.entities.filter((entity) => entity.geometry.kind === "group")).toHaveLength(3);
    expect(bundle.scene.animationChannels).toHaveLength(73);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(13_140);
    expect(bundle.scene.entities.slice(3, 5).map(({ id }) => id)).toEqual([
      expect.stringMatching(/runtime-draw:0\/paint:fill$/),
      expect.stringMatching(/runtime-draw:0\/paint:stroke$/),
    ]);
    expect(bundle.scene.requiredCapabilities).toEqual([
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
      "path-trim-animation",
      "vector-appearance-animation",
    ]);

    const initial = await frameAt(bundle, 0);
    expect(initial.packet.draws).toHaveLength(44);
    expect(initial.packet.draws[1].kind).toBe("empty");
    expect(initial.packet.draws[30].opacity).toBe(1);
    expect(initial.packet.draws[30].transform.tx).toBe(0);

    const midpoint = await frameAt(bundle, 0.5);
    expect(midpoint.packet.draws[1].kind).toBe("path");
    expect(midpoint.packet.draws[30].opacity).toBe(1);
    expect(midpoint.packet.draws[30].transform.tx).toBe(0.5);

    const hold = await frameAt(bundle, 3);
    expect(hold.packet.draws).toHaveLength(44);
    expect(hold.packet.draws[1]).toMatchObject({
      kind: "path",
      stroke: { color: { alpha: 0 } },
    });
    expect(hold.packet.draws[30].opacity).toBe(1);
    expect(hold.packet.draws[30].transform.tx).toBe(1);

    expect(await frameAt(bundle, 0.5)).toEqual(midpoint);
  });

  it("fails closed when one frame changes stable draw identity", async () => {
    const original = fixture();
    const trace = {
      ...original,
      frames: original.frames.map((frame, frameIndex) =>
        frameIndex === 1
          ? {
              ...frame,
              draws: frame.draws.map((draw, drawIndex) =>
                drawIndex === 0 ? { ...draw, pathId: `path:${"9".repeat(64)}` } : draw,
              ),
            }
          : frame,
      ),
    };
    await expect(lowerVerifiedFastManimRuntimeTraceV2(trace)).rejects.toMatchObject({
      code: "semantic-mismatch",
    });
  });

  it("rejects a visible partial fill that the stroke-only trim channel cannot represent", async () => {
    const original = fixture();
    const finalAppearanceId = original.resources.appearances[1]!.id;
    const trace = {
      ...original,
      frames: original.frames.map((frame, frameIndex) =>
        frameIndex === 1
          ? {
              ...frame,
              draws: frame.draws.map((draw, drawIndex) =>
                drawIndex === 0 ? { ...draw, appearanceId: finalAppearanceId } : draw,
              ),
            }
          : frame,
      ),
    };
    await expect(lowerVerifiedFastManimRuntimeTraceV2(trace)).rejects.toThrow(/visible partial fill/);
  });
});
