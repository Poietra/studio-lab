import { describe, expect, it } from "vitest";

import { lowerVerifiedFastManimRuntimeTraceV2 } from "./fast-manim-runtime-trace-v2-lowering";
import { digestFastManimRuntimeTracePathV2 } from "./fast-manim-runtime-trace-v2-result-contract";
import { fastManimRuntimeTraceV2Fixture } from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";

const fixture = fastManimRuntimeTraceV2Fixture;

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
  it("maps captured presentation frames to existing retained Scene IR channels", { timeout: 15_000 }, async () => {
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(fixture());

    expect(bundle.scene.source).toMatchObject({ kind: "imported-manim-runtime-trace", traceVersion: 2 });
    expect(bundle.scene.entities).toHaveLength(117);
    expect(bundle.scene.entities.filter((entity) => entity.geometry.kind === "group")).toHaveLength(5);
    expect(bundle.scene.animationChannels).toHaveLength(197);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(9_343);
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

    const paths = bundle.scene.entities.filter(({ geometry }) => geometry.kind === "cubic-path");
    expect(paths).toHaveLength(112);
    expect(paths.every(({ lifetimes }) => lifetimes.length === 1)).toBe(true);
    expect(
      [0, 3, 5, 13].map((at) => ({
        at,
        count: paths.filter(({ lifetimes }) => lifetimes[0]?.start === at).length,
      })),
    ).toEqual([
      { at: 0, count: 44 },
      { at: 3, count: 2 },
      { at: 5, count: 35 },
      { at: 13, count: 31 },
    ]);
    expect(
      [4, 8, 15].map((at) => ({
        at,
        count: paths.filter(({ lifetimes }) => lifetimes[0]?.end === at).length,
      })),
    ).toEqual([
      { at: 4, count: 14 },
      { at: 8, count: 32 },
      { at: 15, count: 66 },
    ]);
    expect({
      affine: bundle.scene.animationChannels.filter(({ kind }) => kind === "affine-transform").length,
      morph: bundle.scene.animationChannels.filter(({ kind }) => kind === "path-morph").length,
      opacity: bundle.scene.animationChannels.filter(({ kind }) => kind === "opacity").length,
      trim: bundle.scene.animationChannels.filter(({ kind }) => kind === "path-trim").length,
      vectorAppearance: bundle.scene.animationChannels.filter(({ kind }) => kind === "vector-appearance").length,
    }).toEqual({ affine: 14, morph: 43, opacity: 57, trim: 39, vectorAppearance: 44 });

    const baselMotion = bundle.scene.animationChannels.find(
      (candidate) =>
        candidate.kind === "affine-transform" && candidate.entityId.endsWith("/runtime-root:basel/runtime-draw:0"),
    );
    const titleTrim = bundle.scene.animationChannels.find(
      (candidate) =>
        candidate.kind === "path-trim" &&
        candidate.entityId.endsWith("/runtime-root:title/runtime-draw:0/paint:stroke"),
    );
    const gridTitleOpacity = bundle.scene.animationChannels.find(
      (candidate) =>
        candidate.kind === "opacity" && candidate.entityId.endsWith("/runtime-root:grid-title/runtime-draw:0"),
    );
    if (
      baselMotion?.kind !== "affine-transform" ||
      titleTrim?.kind !== "path-trim" ||
      gridTitleOpacity?.kind !== "opacity"
    ) {
      throw new Error("Expected representative retained channels.");
    }
    expect(
      baselMotion.keyframes
        .filter(({ at }) => at === 0 || at === 0.5 || at === 1 || at === 3)
        .map(({ at, value }) => ({ at, tx: value.tx, ty: value.ty })),
    ).toEqual([
      { at: 0, tx: 0, ty: 0 },
      { at: 0.5, tx: 0.5, ty: 0 },
      { at: 1, tx: 1, ty: 0 },
      { at: 3, tx: 1, ty: 0 },
    ]);
    expect(
      titleTrim.keyframes
        .filter(({ at }) => at === 0 || at === 1 || at === 479 / 60)
        .map(({ at, value }) => ({ at, value })),
    ).toEqual([
      { at: 0, value: 0 },
      { at: 1, value: 1 },
      { at: 479 / 60, value: 1 },
    ]);
    expect(
      gridTitleOpacity.keyframes
        .filter(({ at }) => at === 5 || at === 6 || at === 899 / 60)
        .map(({ at, value }) => ({ at, value })),
    ).toEqual([
      { at: 5, value: 0 },
      { at: 6, value: 1 },
      { at: 899 / 60, value: 1 },
    ]);
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

  it("compresses only world paths that reproduce a sealed smooth Transform", { timeout: 15_000 }, async () => {
    const trace = fixture();
    const bundle = await lowerVerifiedFastManimRuntimeTraceV2(trace);
    const channel = bundle.scene.animationChannels.find(
      (candidate) =>
        candidate.kind === "path-morph" && candidate.entityId.endsWith("/runtime-root:title/runtime-draw:0/paint:fill"),
    );
    if (!channel || channel.kind !== "path-morph") throw new Error("Expected a title world-path channel.");
    const entityId = channel.entityId;
    expect(channel.keyframes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ at: 3, easingToNext: { kind: "manim-smooth" } }),
        expect.objectContaining({ at: 4 }),
      ]),
    );
    expect(
      bundle.scene.animationChannels.some(
        (candidate) => candidate.kind === "affine-transform" && candidate.entityId === entityId,
      ),
    ).toBe(false);

    trace.frames[210]!.draws[0]!.translation.x += 0.001;
    await expect(lowerVerifiedFastManimRuntimeTraceV2(trace)).rejects.toThrow(/sealed smooth endpoint interpolation/);
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

  it("splits only a draw whose captured cubic topology changes", { timeout: 15_000 }, async () => {
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

  it("lowers same-topology path changes through one compact path-morph channel", { timeout: 15_000 }, async () => {
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
