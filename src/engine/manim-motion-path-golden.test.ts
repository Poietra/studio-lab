import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assetManifestV1Schema } from "./asset-manifest";
import { compileEngineFrameV1 } from "./reference-evaluator";
import { sceneIrV1Schema } from "./scene-ir";

type Fixture = Readonly<{
  assets: unknown;
  reference: Readonly<{ commit: string; samplePointsPerCurve: number; symbol: string }>;
  samples: readonly Readonly<{ sampleTime: number; translation: readonly [number, number] }>[];
  scene: unknown;
}>;

describe("Manim point_from_proportion motion-path fixture", () => {
  it("matches real curved interior samples across non-monotonic seeks", async () => {
    const path = new URL("../../fixtures/engine-v1/manim-motion-path.json", import.meta.url);
    const fixture = JSON.parse(await readFile(path, "utf8")) as Fixture;
    const assets = assetManifestV1Schema.parse(fixture.assets);
    const scene = sceneIrV1Schema.parse(fixture.scene);

    expect(fixture.reference).toMatchObject({
      samplePointsPerCurve: 10,
      symbol: "manim.mobject.types.vectorized_mobject.VMobject.point_from_proportion",
    });
    expect(fixture.samples.map(({ sampleTime }) => sampleTime)).toEqual([0.75, 0, 0.5, 0.25, 0.75, 1, 0.125, 0.875]);
    expect(
      sceneIrV1Schema.safeParse({
        ...scene,
        animationChannels: scene.animationChannels.map((channel) =>
          channel.kind === "motion-path" ? { ...channel, orientToPath: true } : channel,
        ),
      }).success,
    ).toBe(false);

    const observed: Array<readonly [number, number]> = [];
    for (const [index, sample] of fixture.samples.entries()) {
      const result = await compileEngineFrameV1({
        assets,
        evidence: [fixture.reference.commit],
        packetId: `manim-motion:${index}`,
        sampleTime: sample.sampleTime,
        scene,
        viewport: { heightPx: 90, widthPx: 160 },
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error(result.message);
      const draw = result.frame.packet.draws[0];
      expect(draw?.kind).toBe("path");
      if (draw?.kind !== "path") throw new Error("Expected the retained motion-path draw.");
      expect(draw.transform.tx).toBeCloseTo(sample.translation[0], 12);
      expect(draw.transform.ty).toBeCloseTo(sample.translation[1], 12);
      observed.push([draw.transform.tx, draw.transform.ty]);
    }
    expect(observed[0]).toEqual(observed[4]);
  });
});
