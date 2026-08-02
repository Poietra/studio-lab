import { readFile } from "node:fs/promises";

import { digestAssetManifestV1, type SceneIrBundleV1, sceneIrBundleV1Schema } from "../../src/engine/contracts";
import {
  type ExpectedFastManimSnapshotCorrelationV1,
  fastManimSnapshotEntityIdV1,
  fastManimSnapshotEntityProvenanceIdV1,
  fastManimSnapshotManifestIdV1,
  fastManimSnapshotMotionPathChannelIdV2,
  fastManimSnapshotMotionPathChannelProvenanceIdV2,
  fastManimSnapshotPathTrimChannelIdV2,
  fastManimSnapshotPathTrimChannelProvenanceIdV2,
  fastManimSnapshotPngAssetIdV4,
  fastManimSnapshotSceneProvenanceIdV1,
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

type FixturePoint = Readonly<{ x: number; y: number }>;
type FixtureCubicPath = Extract<
  SceneIrBundleV1["scene"]["entities"][number]["geometry"],
  { kind: "cubic-path" }
>["path"];

function closedFixtureSubpath(points: readonly [FixturePoint, FixturePoint, FixturePoint, FixturePoint]) {
  const [start, ...rest] = points;
  const ends = [...rest, start];
  let current = start;
  return {
    closed: true as const,
    segments: ends.map((end) => {
      const segment = { control1: current, control2: end, end };
      current = end;
      return segment;
    }),
    start,
  };
}

function mapFixtureCubicPath(path: FixtureCubicPath, mapPoint: (point: FixturePoint) => FixturePoint) {
  return {
    subpaths: path.subpaths.map((subpath) => ({
      ...subpath,
      segments: subpath.segments.map((segment) => ({
        control1: mapPoint(segment.control1),
        control2: mapPoint(segment.control2),
        end: mapPoint(segment.end),
      })),
      start: mapPoint(subpath.start),
    })),
  } satisfies FixtureCubicPath;
}

/** Canonical producer-side V7 vertical slice shared by contract and storage tests. */
export async function mixedDynamic2dSnapshotBundleFixtureV7(
  expected: ExpectedFastManimSnapshotCorrelationV1,
): Promise<SceneIrBundleV1> {
  if (expected.snapshotVersion !== 7) throw new Error("Expected a V7 fixture correlation.");
  const base = await staticSnapshotBundleFixture(expected);
  const sourceEntity = base.scene.entities[0];
  if (!sourceEntity || sourceEntity.geometry.kind !== "cubic-path") {
    throw new Error("Expected the static fixture's first cubic vector entity.");
  }
  const sourceSubpath = sourceEntity.geometry.path.subpaths[0];
  if (!sourceSubpath) throw new Error("Expected the static fixture's first cubic subpath.");
  const anchors = [sourceSubpath.start, ...sourceSubpath.segments.map((segment) => segment.end)];
  const center = {
    x: (Math.min(...anchors.map(({ x }) => x)) + Math.max(...anchors.map(({ x }) => x))) / 2,
    y: (Math.min(...anchors.map(({ y }) => y)) + Math.max(...anchors.map(({ y }) => y))) / 2,
  };
  const mathTexId = fastManimSnapshotEntityIdV1(expected.sceneId, 0);
  const mathTexProvenanceId = fastManimSnapshotEntityProvenanceIdV1(expected.sceneId, 0);
  const ringId = fastManimSnapshotEntityIdV1(expected.sceneId, 1);
  const ringProvenanceId = fastManimSnapshotEntityProvenanceIdV1(expected.sceneId, 1);
  const particleId = fastManimSnapshotEntityIdV1(expected.sceneId, 2);
  const particleProvenanceId = fastManimSnapshotEntityProvenanceIdV1(expected.sceneId, 2);
  const ringChannelProvenanceId = fastManimSnapshotPathTrimChannelProvenanceIdV2(expected.sceneId, 1);
  const particleChannelProvenanceId = fastManimSnapshotMotionPathChannelProvenanceIdV2(expected.sceneId, 2);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: ringId,
          id: fastManimSnapshotPathTrimChannelIdV2(expected.sceneId, 1),
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 1, easingToNext: null, value: 1 },
          ],
          kind: "path-trim",
          parameterization: "uniform-cubic-parameter-v1",
          provenanceId: ringChannelProvenanceId,
        },
        {
          entityId: particleId,
          id: fastManimSnapshotMotionPathChannelIdV2(expected.sceneId, 2),
          keyframes: [
            { at: 1, easingToNext: { kind: "linear" }, value: 0 },
            { at: 3, easingToNext: null, value: 1 },
          ],
          kind: "motion-path",
          orientToPath: false,
          parameterization: "manim-point-from-proportion-v1",
          path: {
            subpaths: [
              {
                closed: false,
                segments: [
                  {
                    control1: { x: center.x + 0.25, y: center.y + 2.5 },
                    control2: { x: center.x + 3.75, y: center.y - 1.5 },
                    end: { x: center.x + 4, y: center.y + 1 },
                  },
                ],
                start: center,
              },
            ],
          },
          provenanceId: particleChannelProvenanceId,
        },
      ],
      duration: 4,
      entities: [
        {
          ...sourceEntity,
          appearance: {
            fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" },
            kind: "vector",
            opacity: 1,
            stroke: null,
          },
          geometry: {
            kind: "cubic-path",
            path: {
              subpaths: [
                closedFixtureSubpath([
                  { x: -2, y: -1 },
                  { x: 2, y: -1 },
                  { x: 2, y: 1 },
                  { x: -2, y: 1 },
                ]),
                closedFixtureSubpath([
                  { x: -0.5, y: -0.5 },
                  { x: -0.5, y: 0.5 },
                  { x: 0.5, y: 0.5 },
                  { x: 0.5, y: -0.5 },
                ]),
              ],
            },
          },
          id: mathTexId,
          lifetimes: [{ end: 4, start: 0 }],
          provenanceId: mathTexProvenanceId,
          sceneOrder: 0,
          sourceZIndex: 0,
        },
        {
          ...sourceEntity,
          appearance: {
            fill: null,
            kind: "vector",
            opacity: 1,
            stroke: {
              cap: "butt",
              color: { alpha: 1, blue: 1, green: 1, red: 1 },
              join: "miter",
              miterLimit: 10,
              widthWorld: 0.05,
            },
          },
          id: ringId,
          lifetimes: [{ end: 4, start: 0 }],
          provenanceId: ringProvenanceId,
          sceneOrder: 1,
          sourceZIndex: 1,
        },
        {
          ...sourceEntity,
          geometry: {
            kind: "cubic-path",
            path: mapFixtureCubicPath(sourceEntity.geometry.path, ({ x, y }) => ({
              x: x - center.x,
              y: y - center.y,
            })),
          },
          id: particleId,
          lifetimes: [{ end: 4, start: 1 }],
          provenanceId: particleProvenanceId,
          sceneOrder: 2,
          sourceZIndex: 2,
        },
      ],
      provenance: [
        {
          evidence: ["producer-authored mixed Scene evidence must be normalized"],
          id: fastManimSnapshotSceneProvenanceIdV1(expected.sceneId),
          origin: "fast-manim-server-snapshot",
        },
        {
          evidence: [
            "MathTex content digest 4e86be799123233a78ef7e88c1a053a807d9c5de4f5db5dc4723bdfd1cda2eb4",
            "MathTex toolchain digest 40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430",
            "MathTex font digest e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa",
          ],
          id: mathTexProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
        {
          evidence: ["producer-authored Circle evidence must be normalized"],
          id: ringProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
        {
          evidence: ["producer-authored moving Circle evidence must be normalized"],
          id: particleProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
        {
          evidence: ["producer-authored Create evidence must be normalized"],
          id: ringChannelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
        {
          evidence: ["producer-authored MoveAlongPath evidence must be normalized"],
          id: particleChannelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "motion-path-animation", "path-trim-animation"],
      source: { ...base.scene.source, snapshotVersion: 7 },
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
