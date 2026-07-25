import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assetManifestV1Schema } from "./asset-manifest";
import { compileEngineFrameV1 } from "./reference-evaluator";
import { sceneIrV1Schema } from "./scene-ir";

type SharedGoldenFixture = Readonly<{
  assets: unknown;
  expected: Readonly<{
    camera: Readonly<{ bottom: number; left: number; right: number; top: number }>;
    drawEntityIds: readonly string[];
    drawKinds: readonly string[];
    opacities: readonly number[];
    pathSegmentCounts: readonly number[];
    requiredCapabilities: readonly string[];
    tolerance: number;
  }>;
  id: string;
  sample: Readonly<{
    evidence: readonly string[];
    packetId: string;
    sampleTime: number;
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>;
  scene: unknown;
}>;

async function loadFixture(): Promise<SharedGoldenFixture> {
  const url = new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as SharedGoldenFixture;
}

function segmentCount(draw: { kind: string; path?: { subpaths: readonly { segments: readonly unknown[] }[] } }) {
  if (draw.kind !== "path" || !draw.path) return 0;
  return draw.path.subpaths.reduce((total, subpath) => total + subpath.segments.length, 0);
}

function expectClose(actual: number, expected: number, tolerance: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)));
}

describe("shared Poietra Engine v1 golden fixture", () => {
  it("parses and evaluates to the shared semantic expectation", async () => {
    const fixture = await loadFixture();
    const assets = assetManifestV1Schema.parse(fixture.assets);
    const scene = sceneIrV1Schema.parse(fixture.scene);
    const result = await compileEngineFrameV1({ assets, scene, ...fixture.sample });

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(`${fixture.id}: ${result.message}`);

    const { packet } = result.frame;
    expect(packet.draws.map((draw) => draw.entityId)).toEqual(fixture.expected.drawEntityIds);
    expect(packet.draws.map((draw) => draw.kind)).toEqual(fixture.expected.drawKinds);
    expect(packet.draws.map(segmentCount)).toEqual(fixture.expected.pathSegmentCounts);
    expect(packet.requiredCapabilities).toEqual(fixture.expected.requiredCapabilities);
    packet.draws.forEach((draw, index) => {
      expectClose(draw.opacity, fixture.expected.opacities[index], fixture.expected.tolerance);
    });
    for (const [key, expected] of Object.entries(fixture.expected.camera)) {
      expectClose(packet.camera[key as keyof typeof fixture.expected.camera], expected, fixture.expected.tolerance);
    }
  });
});
