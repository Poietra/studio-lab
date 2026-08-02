import { readFile } from "node:fs/promises";

import { digestAssetManifestV1, type SceneIrBundleV1, sceneIrBundleV1Schema } from "../../src/engine/contracts";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  fastManimSnapshotManifestIdV1,
  fastManimSnapshotPngAssetIdV4,
  type HermeticPngV4TransformPlan,
  ZERO_SHA256,
} from "../fast-manim-snapshot-contract";

type FixtureEntity = Record<string, unknown> & { id: string };

export async function staticSnapshotBundleFixture(
  expected: ExpectedFastManimSnapshotCorrelationV1,
): Promise<SceneIrBundleV1> {
  const fixtureUrl = new URL("./fast-manim-static-bundle.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    scene: Record<string, unknown> & { entities: FixtureEntity[] };
  };
  const namespace = (suffix: string) => `${expected.sceneId}/${suffix}`;
  const manifestId = namespace("manifest");
  const manifestDigest = await digestAssetManifestV1({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return sceneIrBundleV1Schema.parse({
    assets: { assets: [], manifestDigest, manifestId, schema: "poietra.asset-manifest", version: 1 },
    scene: {
      ...fixture.scene,
      animationChannels: [],
      assetManifest: { manifestDigest, manifestId },
      entities: fixture.scene.entities.map((entity, index) => ({
        ...entity,
        id: namespace(`entity:${index}`),
        parentId: null,
        provenanceId: namespace(`provenance:entity:${index}`),
      })),
      provenance: [
        {
          evidence: ["fast-manim static snapshot"],
          id: namespace("provenance:scene"),
          origin: "fast-manim-server-snapshot",
        },
        ...fixture.scene.entities.map((_, index) => ({
          evidence: ["fast-manim static snapshot"],
          id: namespace(`provenance:entity:${index}`),
          origin: "fast-manim-server-snapshot",
        })),
      ],
      sceneId: expected.sceneId,
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: expected.runtimeConfigHash,
        snapshotHash: ZERO_SHA256,
        snapshotVersion: expected.snapshotVersion,
        sourceHash: expected.sourceHash,
      },
    },
  });
}

export async function pngSnapshotBundleFixture(
  expected: ExpectedFastManimSnapshotCorrelationV1,
  options: Readonly<{ plan?: HermeticPngV4TransformPlan; sampler?: "linear" | "nearest" }> = {},
): Promise<SceneIrBundleV1> {
  const base = await staticSnapshotBundleFixture(expected);
  const entity = base.scene.entities[0];
  if (!entity) throw new Error("Expected one base entity for the PNG fixture.");
  const plan = options.plan ?? { terminalWait: null, transforms: [] };
  const sampler = options.sampler ?? "nearest";
  const pixelHeight = 1;
  const pixelWidth = 2;
  const sha256 = "4".repeat(64);
  const assetId = fastManimSnapshotPngAssetIdV4(expected.sceneId);
  const manifestId = fastManimSnapshotManifestIdV1(expected.sceneId);
  const asset = {
    alphaMode: "straight" as const,
    byteLength: 74,
    colorSpace: "srgb" as const,
    id: assetId,
    kind: "png-image" as const,
    mediaType: "image/png" as const,
    pixelHeight,
    pixelWidth,
    sha256,
  };
  const manifestDigest = await digestAssetManifestV1({
    assets: [asset],
    manifestDigest: ZERO_SHA256,
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  const cumulativeScale = plan.transforms.reduce(
    (scale, transform) => (transform.kind === "scale" ? scale * transform.factor : scale),
    1,
  );
  const center = plan.transforms.reduce(
    (point, transform) => (transform.kind === "move-to" ? { x: transform.x, y: transform.y } : point),
    { x: 0, y: 0 },
  );
  const duration = plan.terminalWait ?? 1;
  const height = (pixelHeight / 1_080) * expected.frame.height * cumulativeScale;
  const width = (height * pixelWidth) / pixelHeight;
  return sceneIrBundleV1Schema.parse({
    assets: { assets: [asset], manifestDigest, manifestId, schema: "poietra.asset-manifest", version: 1 },
    scene: {
      ...base.scene,
      assetManifest: { manifestDigest, manifestId },
      duration,
      entities: [
        {
          ...entity,
          appearance: { kind: "image", opacity: 1 },
          geometry: {
            asset: { assetId, sha256 },
            kind: "image",
            localRect: {
              bottom: center.y - height / 2,
              left: center.x - width / 2,
              right: center.x + width / 2,
              top: center.y + height / 2,
            },
            sampler,
          },
          lifetimes: [{ end: duration, start: 0 }],
          sourceZIndex: 0,
        },
      ],
      provenance: [
        { ...base.scene.provenance[0], evidence: ["fast-manim hermetic PNG Scene snapshot profile v4"] },
        {
          ...base.scene.provenance[1],
          evidence: [
            "capability png-image: one verified PNG-backed rectangle",
            `PNG encoded digest ${sha256}`,
            `PNG dimensions ${pixelWidth} x ${pixelHeight}`,
            `PNG sampler ${sampler}`,
          ],
        },
      ],
      requiredCapabilities: ["png-image"],
      source: { ...base.scene.source, snapshotVersion: 4 },
    },
  });
}
