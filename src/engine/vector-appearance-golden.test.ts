import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assetManifestV1Schema } from "./asset-manifest";
import { compileEngineFrameV1 } from "./reference-evaluator";
import { sceneIrV1Schema, vectorAppearanceValueV1Schema } from "./scene-ir";

type Fixture = Readonly<{
  assets: unknown;
  id: string;
  samples: readonly Readonly<{ expected: unknown; id: string; sampleTime: number }>[];
  scene: unknown;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

async function loadFixture(): Promise<Fixture> {
  const url = new URL("../../fixtures/engine-v1/vector-appearance-square-circle.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Fixture;
}

function expectColorClose(
  actual: Readonly<{ alpha: number; blue: number; green: number; red: number }>,
  expected: Readonly<{ alpha: number; blue: number; green: number; red: number }>,
) {
  expect(actual.alpha).toBeCloseTo(expected.alpha, 14);
  expect(actual.blue).toBeCloseTo(expected.blue, 14);
  expect(actual.green).toBeCloseTo(expected.green, 14);
  expect(actual.red).toBeCloseTo(expected.red, 14);
}

describe("vector-appearance Scene IR channel", () => {
  it("matches measured SquareToCircle appearance at boundaries and unordered retained-style seeks", async () => {
    const fixture = await loadFixture();
    const assets = assetManifestV1Schema.parse(fixture.assets);
    const scene = sceneIrV1Schema.parse(fixture.scene);
    const appearances = new Map<string, unknown>();

    expect(fixture.samples.map(({ sampleTime }) => sampleTime)).toEqual([1.5, 1, 1.25, 2, 1.5]);
    expect(scene.entities[0]?.lifetimes).toEqual([{ end: 3, start: 0 }]);
    expect(
      scene.animationChannels.map((channel) => ({
        entityId: channel.kind === "camera" ? null : channel.entityId,
        kind: channel.kind,
      })),
    ).toEqual([
      { entityId: "shape", kind: "path-morph" },
      { entityId: "shape", kind: "vector-appearance" },
    ]);

    for (const sample of fixture.samples) {
      const expected = vectorAppearanceValueV1Schema.parse(sample.expected);
      const result = await compileEngineFrameV1({
        assets,
        evidence: [fixture.id, sample.id],
        packetId: `appearance:${sample.id}`,
        sampleTime: sample.sampleTime,
        scene,
        viewport: fixture.viewport,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error(result.message);
      const draw = result.frame.packet.draws[0];
      if (draw?.kind !== "path" || draw.fill === null || draw.stroke === null) {
        throw new Error(`${sample.id}: expected one fill-and-stroke path draw`);
      }
      if (expected.fill === null || expected.stroke === null)
        throw new Error("Fixture appearance must be materialized.");
      expectColorClose(draw.fill.color, expected.fill.color);
      expect(draw.fill.rule).toBe(expected.fill.rule);
      expectColorClose(draw.stroke.color, expected.stroke.color);
      expect(draw.stroke).toMatchObject({
        cap: expected.stroke.cap,
        join: expected.stroke.join,
        miterLimit: expected.stroke.miterLimit,
      });
      expect(draw.stroke.widthWorld).toBeCloseTo(expected.stroke.widthWorld, 14);
      appearances.set(sample.id, { fill: draw.fill, stroke: draw.stroke });
    }

    expect(appearances.get("midpoint-repeat")).toEqual(appearances.get("midpoint-first"));

    const before = await compileEngineFrameV1({
      assets,
      packetId: "appearance:before",
      sampleTime: 0.5,
      scene,
      viewport: fixture.viewport,
    });
    if (before.kind !== "ready") throw new Error(before.message);
    const beforeDraw = before.frame.packet.draws[0];
    expect(beforeDraw?.kind === "path" ? beforeDraw.fill : undefined).toBeNull();
  });

  it("interpolates stroke width through the same Manim easing", async () => {
    const fixture = await loadFixture();
    const scene = sceneIrV1Schema.parse(fixture.scene);
    const channel = scene.animationChannels.find((candidate) => candidate.kind === "vector-appearance");
    if (channel?.kind !== "vector-appearance" || channel.keyframes[1]?.value.stroke === null) {
      throw new Error("Fixture must contain a vector-appearance stroke channel.");
    }
    channel.keyframes[1].value.stroke.widthWorld = 0.08;
    scene.requiredCapabilities = ["cubic-path-geometry", "path-morph-animation", "vector-appearance-animation"];
    const result = await compileEngineFrameV1({
      assets: assetManifestV1Schema.parse(fixture.assets),
      packetId: "appearance:width",
      sampleTime: 1.25,
      scene,
      viewport: fixture.viewport,
    });
    if (result.kind !== "ready") throw new Error(result.message);
    const draw = result.frame.packet.draws[0];
    if (draw?.kind !== "path" || draw.stroke === null) throw new Error("Expected a stroked path draw.");
    expect(draw.stroke.widthWorld).toBeCloseTo(0.04280414866180433, 14);
  });

  it("fails closed for implicit paint cross-fades and unsupported style transitions", async () => {
    const fixture = await loadFixture();
    const candidateScene = () => sceneIrV1Schema.parse(fixture.scene);
    const channel = (scene: ReturnType<typeof candidateScene>) => {
      const candidate = scene.animationChannels.find((entry) => entry.kind === "vector-appearance");
      if (candidate?.kind !== "vector-appearance") throw new Error("Fixture channel is missing.");
      return candidate;
    };

    const absentTransition = candidateScene();
    channel(absentTransition).keyframes[1]!.value.fill = null;
    expect(sceneIrV1Schema.safeParse(absentTransition).success).toBe(false);

    const opaqueMaterialization = candidateScene();
    channel(opaqueMaterialization).keyframes[0]!.value.fill!.color.alpha = 1;
    expect(sceneIrV1Schema.safeParse(opaqueMaterialization).success).toBe(false);

    const fillRuleTransition = candidateScene();
    channel(fillRuleTransition).keyframes[1]!.value.fill!.rule = "evenodd";
    expect(sceneIrV1Schema.safeParse(fillRuleTransition).success).toBe(false);

    const strokeStyleTransition = candidateScene();
    channel(strokeStyleTransition).keyframes[1]!.value.stroke!.cap = "round";
    expect(sceneIrV1Schema.safeParse(strokeStyleTransition).success).toBe(false);

    const unknownPaint = candidateScene();
    Object.assign(channel(unknownPaint).keyframes[1]!.value.fill!, { gradient: "unsupported" });
    expect(sceneIrV1Schema.safeParse(unknownPaint).success).toBe(false);
  });
});
