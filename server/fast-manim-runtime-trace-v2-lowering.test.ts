import { describe, expect, it } from "vitest";

import { compileEngineFrameV1 } from "../src/engine/reference-evaluator";
import { lowerVerifiedFastManimRuntimeTraceV2 } from "./fast-manim-runtime-trace-v2-lowering";
import { digestFastManimRuntimeTracePathV2 } from "./fast-manim-runtime-trace-v2-result-contract";
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

function expectCompactedPlateausToRemainExact(
  bundle: Awaited<ReturnType<typeof lowerVerifiedFastManimRuntimeTraceV2>>,
) {
  const channel = bundle.scene.animationChannels.find(
    (candidate) =>
      candidate.kind === "vector-appearance" &&
      candidate.entityId.endsWith("/runtime-root:title/runtime-draw:0/paint:fill"),
  );
  if (!channel) throw new Error("Expected the title fill appearance channel.");
  const plateauEdges = channel.keyframes.slice(1).flatMap((current, index) => {
    const previous = channel.keyframes[index]!;
    return current.at - previous.at > 1 / 60 + 1e-12 ? [{ current, previous }] : [];
  });
  expect(plateauEdges.length).toBeGreaterThanOrEqual(2);
  for (const { current, previous } of plateauEdges) {
    expect(current.value).toEqual(previous.value);
  }
}

describe("OpeningManim Runtime Trace V2 lowering", () => {
  it("maps captured presentation frames to existing retained Scene IR channels", async () => {
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(fixture());

    expect(bundle.scene.source).toMatchObject({ kind: "imported-manim-runtime-trace", traceVersion: 2 });
    expect(bundle.scene.entities).toHaveLength(86);
    expect(bundle.scene.entities.filter((entity) => entity.geometry.kind === "group")).toHaveLength(5);
    expect(bundle.scene.animationChannels).toHaveLength(197);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(9_345);
    expect(bundle.scene.entities.slice(5, 7).map(({ id }) => id)).toEqual([
      expect.stringMatching(/runtime-draw:0\/paint:fill$/),
      expect.stringMatching(/runtime-draw:0\/paint:stroke$/),
    ]);
    expect(bundle.scene.requiredCapabilities).toEqual([
      "affine-transform-animation",
      "cubic-path-geometry",
      "logical-group",
      "opacity-animation",
      "path-morph-animation",
      "path-trim-animation",
      "vector-appearance-animation",
    ]);
    expectCompactedPlateausToRemainExact(bundle);

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
    expect(hold.packet.draws).toHaveLength(46);
    expect(hold.packet.draws[1]).toMatchObject({
      kind: "path",
      stroke: { color: { alpha: 0 } },
    });
    expect(hold.packet.draws[32].opacity).toBe(1);
    expect(hold.packet.draws[32].transform.tx).toBe(1);

    const gridStart = await frameAt(bundle, 5);
    const gridMidpoint = await frameAt(bundle, 6.5);
    const gridComplete = await frameAt(bundle, 479 / 60);
    const finalHold = await frameAt(bundle, 539 / 60);
    expect([gridStart, gridMidpoint, gridComplete, finalHold].map(({ packet }) => packet.draws.length)).toEqual([
      67, 67, 67, 35,
    ]);
    expect(
      [gridStart, gridMidpoint, gridComplete, finalHold].map(
        ({ packet }) => packet.draws.filter((draw) => draw.kind === "path").length,
      ),
    ).toEqual([43, 66, 67, 35]);

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

  it("splits only a draw whose captured cubic topology changes", async () => {
    const trace = fixture();
    const source = structuredClone(trace.resources.paths[0]!.path);
    const prior = source.subpaths[0]!.segments[0]!;
    source.subpaths[0]!.segments.push({
      control1: { x: prior.end.x + 0.025, y: 0.05 },
      control2: { x: prior.end.x + 0.075, y: 0.05 },
      end: { x: prior.end.x + 0.1, y: 0 },
    });
    const pathId = `path:${digestFastManimRuntimeTracePathV2(source)}` as const;
    trace.resources.paths.push({ id: pathId, path: source });
    trace.frames.slice(1).forEach((frame) => {
      frame.draws[17]!.pathId = pathId;
    });

    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(trace);
    const drawId = `${trace.roots[1]!.id}/runtime-draw:0`;
    const split = bundle.scene.entities.filter((entity) => entity.id === drawId || entity.id.startsWith(`${drawId}/`));

    expect(split.map(({ id, lifetimes }) => ({ id, lifetimes }))).toEqual([
      { id: drawId, lifetimes: [{ end: 1 / 60, start: 0 }] },
      { id: `${drawId}/topology:1`, lifetimes: [{ end: 4, start: 1 / 60 }] },
    ]);
    expect(bundle.scene.entities.filter((entity) => entity.id.includes("/topology:"))).toHaveLength(1);
  });

  it("lowers same-topology path changes through one compact path-morph channel", async () => {
    const trace = fixture();
    const changed = structuredClone(trace.resources.paths[0]!.path);
    changed.subpaths[0]!.segments[0]!.control1.x += 0.01;
    const pathId = `path:${digestFastManimRuntimeTracePathV2(changed)}` as const;
    trace.resources.paths.push({ id: pathId, path: changed });
    trace.frames.slice(1, 61).forEach((frame) => {
      frame.draws[17]!.pathId = pathId;
    });

    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(trace);
    const drawId = `${trace.roots[1]!.id}/runtime-draw:0`;
    const channels = bundle.scene.animationChannels.filter(
      (channel) => channel.kind === "path-morph" && channel.entityId === drawId,
    );

    expect(bundle.scene.entities.filter((entity) => entity.id.includes("/topology:"))).toHaveLength(0);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.keyframes.map(({ at }) => at)).toEqual([0, 1 / 60, 1, 61 / 60, 239 / 60]);
    expect(bundle.scene.requiredCapabilities).toContain("path-morph-animation");
  });
});
