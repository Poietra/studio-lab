import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { digestAssetManifestV1, type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  deriveHermeticMathTexMorphV5Plan,
  deriveHermeticMathTexV3TransformPlan,
  deriveHermeticPngV4TransformPlan,
  deriveMixedDynamicMathTexV7TransformPlan,
  digestFastManimSnapshotBundleV1,
  type ExpectedFastManimSnapshotCorrelationV1,
  expectedFastManimSnapshotCorrelationV1Schema,
  FAST_MANIM_SNAPSHOT_MATHTEX_PROVENANCE_EVIDENCE_V7,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V3,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V4,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V5,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V6,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V7,
  FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1,
  fastManimSnapshotAffineTransformChannelIdV2,
  fastManimSnapshotAffineTransformChannelProvenanceIdV2,
  fastManimSnapshotEntityIdV1,
  fastManimSnapshotMotionPathChannelIdV2,
  fastManimSnapshotMotionPathChannelProvenanceIdV2,
  fastManimSnapshotOpacityChannelIdV2,
  fastManimSnapshotOpacityChannelProvenanceIdV2,
  fastManimSnapshotPathMorphChannelIdV2,
  fastManimSnapshotPathMorphChannelProvenanceIdV2,
  fastManimSnapshotPathTrimChannelIdV2,
  fastManimSnapshotPathTrimChannelProvenanceIdV2,
  fastManimSnapshotPngAssetIdV4,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  isCanonicalFastManimLineSegmentV1,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import {
  mixedDynamic2dSnapshotBundleFixtureV7,
  pngSnapshotBundleFixture,
  staticSnapshotBundleFixture,
} from "./test-fixtures/fast-manim-snapshot-bundle-fixture";

const expected = {
  frame: { height: 8, width: 14.222222222222221 },
  projectId: "workspace-a",
  requestId: "snapshot-request-a",
  runtimeConfigHash: "b".repeat(64),
  snapshotVersion: 1,
  sceneId: fastManimSnapshotSceneIdV1("examples/scene.py", "ExampleScene"),
  sceneName: "ExampleScene",
  sourceHash: "a".repeat(64),
  sourcePath: "examples/scene.py",
} satisfies ExpectedFastManimSnapshotCorrelationV1;

// The wire correlation fields a producer result envelope carries: the frame
// is server-side expected state only and never appears on the wire.
const { frame: _serverOnlyFrame, snapshotVersion: _serverOnlySnapshotVersion, ...wireCorrelation } = expected;

async function importedBundle(): Promise<SceneIrBundleV1> {
  return staticSnapshotBundleFixture(expected);
}

type FixturePoint = Readonly<{ x: number; y: number }>;

function lineCubicSubpath(points: readonly FixturePoint[], closed: boolean) {
  if (points.length < 2) throw new Error("A fixture subpath requires at least two anchors.");
  const [start, ...rest] = points;
  const ends = closed ? [...rest, start!] : rest;
  let current = start!;
  return {
    closed,
    segments: ends.map((end) => {
      const segment = { control1: current, control2: end, end };
      current = end;
      return segment;
    }),
    start: start!,
  };
}

async function genericVmobjectBundleV6(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const [nonconvex, fillAndStroke, curvedStroke] = base.scene.entities;
  if (!nonconvex || !fillAndStroke || !curvedStroke) throw new Error("Expected three static fixture entities.");
  const stroke = {
    cap: "butt" as const,
    color: { alpha: 0.8, blue: 0.2, green: 0.4, red: 0.9 },
    join: "miter" as const,
    miterLimit: 10,
    widthWorld: 0.075,
  };
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      entities: [
        {
          ...nonconvex,
          geometry: {
            kind: "cubic-path",
            path: {
              subpaths: [
                lineCubicSubpath(
                  [
                    { x: -4, y: -1 },
                    { x: -1, y: -1 },
                    { x: -2.5, y: 0 },
                    { x: -1, y: 1 },
                    { x: -4, y: 1 },
                  ],
                  true,
                ),
                lineCubicSubpath(
                  [
                    { x: -3.5, y: -0.25 },
                    { x: -3, y: 0.25 },
                    { x: -2.5, y: -0.25 },
                  ],
                  true,
                ),
              ],
            },
          },
        },
        {
          ...fillAndStroke,
          appearance: { ...fillAndStroke.appearance, stroke },
        },
        {
          ...curvedStroke,
          appearance: { fill: null, kind: "vector", opacity: 1, stroke },
          geometry: {
            kind: "cubic-path",
            path: {
              subpaths: [
                {
                  closed: false,
                  segments: [
                    {
                      control1: { x: 1.5, y: 2 },
                      control2: { x: 3.5, y: -2 },
                      end: { x: 4, y: 0 },
                    },
                  ],
                  start: { x: 1, y: 0 },
                },
              ],
            },
          },
        },
      ],
      source: { ...base.scene.source, snapshotVersion: 6 },
    },
  });
}

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

async function hermeticMathTexBundle(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const entity = base.scene.entities[0]!;
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      entities: [
        {
          ...entity,
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
                // Opposite winding preserves a glyph counter under nonzero fill.
                closedFixtureSubpath([
                  { x: -0.5, y: -0.5 },
                  { x: -0.5, y: 0.5 },
                  { x: 0.5, y: 0.5 },
                  { x: 0.5, y: -0.5 },
                ]),
              ],
            },
          },
        },
      ],
      provenance: [
        base.scene.provenance[0],
        {
          ...base.scene.provenance[1],
          evidence: [
            `MathTex content digest ${"3".repeat(64)}`,
            "MathTex toolchain digest 40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430",
            "MathTex font digest e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa",
          ],
        },
      ],
      source: { ...base.scene.source, snapshotVersion: 3 },
    },
  });
}

const HERMETIC_MATHTEX_MORPH_SOURCE_V5 = String.raw`from manim import MathTex, Scene, TransformMatchingTex, smoothstep

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        self.wait(1, frozen_frame=True)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}")
        maxwell.move_to(equation.get_center())
        self.play(
            TransformMatchingTex(equation, maxwell, transform_mismatches=True),
            run_time=1,
            rate_func=smoothstep,
        )
        equation = maxwell
        self.wait(0.5, frozen_frame=True)
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(
            TransformMatchingTex(maxwell, restored, transform_mismatches=True),
            run_time=2,
            rate_func=smoothstep,
        )
        maxwell = restored
        equation = restored
        self.wait(1, frozen_frame=True)
`;

async function hermeticMathTexMorphBundleV5(
  plan = deriveHermeticMathTexMorphV5Plan(HERMETIC_MATHTEX_MORPH_SOURCE_V5, expected.sceneName),
): Promise<SceneIrBundleV1> {
  const base = await hermeticMathTexBundle();
  const entity = base.scene.entities[0]!;
  if (entity.geometry.kind !== "cubic-path") throw new Error("Expected cubic MathTex fixture geometry.");
  const initial = entity.geometry.path;
  const middle = structuredClone(initial);
  middle.subpaths[0]!.segments[0]!.control1.x += 0.25;
  const channelProvenanceId = fastManimSnapshotPathMorphChannelProvenanceIdV2(expected.sceneId, 0);
  const [initialDigest, middleDigest] = plan.contentDigests;
  const keyframes =
    plan.keyframeTimes.length === 3
      ? [
          { at: plan.keyframeTimes[0], easingToNext: { kind: "smooth" as const }, value: initial },
          { at: plan.keyframeTimes[1], easingToNext: { kind: "smooth" as const }, value: middle },
          { at: plan.keyframeTimes[2], easingToNext: null, value: initial },
        ]
      : [
          { at: plan.keyframeTimes[0], easingToNext: { kind: "smooth" as const }, value: initial },
          { at: plan.keyframeTimes[1], easingToNext: { kind: "smooth" as const }, value: middle },
          { at: plan.keyframeTimes[2], easingToNext: { kind: "smooth" as const }, value: middle },
          { at: plan.keyframeTimes[3], easingToNext: null, value: initial },
        ];
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotPathMorphChannelIdV2(expected.sceneId, 0),
          keyframes,
          kind: "path-morph",
          provenanceId: channelProvenanceId,
        },
      ],
      duration: plan.duration,
      entities: [{ ...entity, lifetimes: [{ end: plan.duration, start: 0 }] }],
      fidelity: {
        evidence: [
          "TransformMatchingTex is represented as a bounded aggregate cubic-path alignment; provider v1 exposes aggregate outlines without glyph identity",
        ],
        kind: "approximate",
      },
      provenance: [
        { ...base.scene.provenance[0], evidence: ["fast-manim hermetic MathTex morph Scene snapshot profile v5"] },
        {
          ...base.scene.provenance[1],
          evidence: [
            `MathTex content digest ${initialDigest}`,
            "MathTex toolchain digest 40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430",
            "MathTex font digest e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa",
          ],
        },
        {
          evidence: [
            `MathTex morph stage 0 content digests ${initialDigest} -> ${middleDigest}`,
            `MathTex morph stage 1 content digests ${middleDigest} -> ${initialDigest}`,
          ],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
      source: { ...base.scene.source, snapshotVersion: 5 },
    },
  });
}

async function hermeticPngBundle(sampler: "linear" | "nearest" = "nearest"): Promise<SceneIrBundleV1> {
  return pngSnapshotBundleFixture({ ...expected, snapshotVersion: 4 }, { sampler });
}

async function dynamicOpacityBundle(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 6;
  const entity = { ...base.scene.entities[0]!, lifetimes: [{ end: duration, start: 1 }] };
  const channelProvenanceId = fastManimSnapshotOpacityChannelProvenanceIdV2(expected.sceneId, 0);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotOpacityChannelIdV2(expected.sceneId, 0),
          keyframes: [
            { at: 1, easingToNext: { kind: "linear" }, value: 0 },
            { at: 3, easingToNext: { kind: "linear" }, value: 1 },
            { at: 4, easingToNext: { kind: "linear" }, value: 1 },
            { at: 6, easingToNext: null, value: 0 },
          ],
          kind: "opacity",
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: [entity],
      provenance: [
        base.scene.provenance[0],
        base.scene.provenance[1],
        {
          evidence: ["producer-authored opacity evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

async function dynamicAffineBundle(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 6;
  const channelProvenanceId = fastManimSnapshotAffineTransformChannelProvenanceIdV2(expected.sceneId, 0);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: base.scene.entities[0]!.id,
          id: fastManimSnapshotAffineTransformChannelIdV2(expected.sceneId, 0),
          keyframes: [
            {
              at: 1,
              easingToNext: { kind: "linear" },
              value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
            },
            {
              at: 2,
              easingToNext: { kind: "linear" },
              value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 2, ty: -1 },
            },
            {
              at: 3,
              easingToNext: { kind: "linear" },
              value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 2, ty: -1 },
            },
            {
              at: 5,
              easingToNext: null,
              value: { m11: -1, m12: 0.5, m21: 0, m22: 2, tx: 4, ty: -3 },
            },
          ],
          kind: "affine-transform",
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: base.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ end: duration, start: 0 }] })),
      provenance: [
        ...base.scene.provenance,
        {
          evidence: ["producer-authored affine evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

async function dynamicPathTrimBundle(values: readonly number[] = [0, 1, 1, 0]): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 6;
  const times =
    values.length === 2 ? (values[0] === 0 ? [0, 2] : [1, 6]) : values.length === 3 ? [0, 2, 6] : [0, 2, 4, 6];
  const sourceEntity = base.scene.entities[0]!;
  const entity = {
    ...sourceEntity,
    appearance: {
      ...sourceEntity.appearance,
      fill: null,
      stroke: {
        cap: "butt" as const,
        color: { alpha: 1, blue: 1, green: 1, red: 1 },
        join: "miter" as const,
        miterLimit: 10,
        widthWorld: 0.05,
      },
    },
    lifetimes: [{ end: duration, start: 0 }],
  };
  const channelProvenanceId = fastManimSnapshotPathTrimChannelProvenanceIdV2(expected.sceneId, 0);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotPathTrimChannelIdV2(expected.sceneId, 0),
          keyframes: values.map((value, index) => ({
            at: times[index],
            easingToNext: index === values.length - 1 ? null : { kind: "linear" as const },
            value,
          })),
          kind: "path-trim",
          parameterization: "uniform-cubic-parameter-v1",
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: [entity],
      provenance: [
        base.scene.provenance[0],
        base.scene.provenance[1],
        {
          evidence: ["producer-authored path-trim evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "path-trim-animation"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

type TestCubicPath = Extract<SceneIrBundleV1["scene"]["entities"][number]["geometry"], { kind: "cubic-path" }>["path"];

function mapCubicPath(
  path: TestCubicPath,
  mapPoint: (point: Readonly<{ x: number; y: number }>) => { x: number; y: number },
) {
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
  } satisfies TestCubicPath;
}

async function dynamicPathMorphBundle(
  shape: "one-transform" | "two-adjacent-transforms" | "two-transforms-with-hold" = "two-transforms-with-hold",
  entityIndex = 0,
): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 6;
  const sourceEntity = base.scene.entities[entityIndex]!;
  if (sourceEntity.geometry.kind !== "cubic-path") throw new Error("Expected the fixture's cubic geometry.");
  const entity = { ...sourceEntity, lifetimes: [{ end: duration, start: 0 }] };
  const basePath = structuredClone(sourceEntity.geometry.path);
  const stretched = mapCubicPath(basePath, ({ x, y }) => ({ x: -1 + (x + 1) * 1.25, y: y * 0.75 }));
  const sheared = mapCubicPath(basePath, ({ x, y }) => ({ x: x + y * 0.35, y: y * 1.1 }));
  const values =
    shape === "one-transform"
      ? [basePath, stretched]
      : shape === "two-adjacent-transforms"
        ? [basePath, stretched, sheared]
        : [basePath, stretched, stretched, sheared];
  const times = shape === "one-transform" ? [1, 2] : shape === "two-adjacent-transforms" ? [1, 2, 5] : [1, 2, 3, 5];
  const channelProvenanceId = fastManimSnapshotPathMorphChannelProvenanceIdV2(expected.sceneId, entityIndex);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotPathMorphChannelIdV2(expected.sceneId, entityIndex),
          keyframes: values.map((value, index) => ({
            at: times[index],
            easingToNext: index === values.length - 1 ? null : { kind: "linear" as const },
            value,
          })),
          kind: "path-morph",
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: base.scene.entities.map((candidate, index) =>
        index === entityIndex ? entity : { ...candidate, lifetimes: [{ end: duration, start: 0 }] },
      ),
      provenance: [
        ...base.scene.provenance,
        {
          evidence: ["producer-authored path-morph evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

async function dynamicMotionPathBundle(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 4;
  const sourceEntity = base.scene.entities[0]!;
  if (sourceEntity.geometry.kind !== "cubic-path") throw new Error("Expected the fixture's cubic geometry.");
  const sourceSubpath = sourceEntity.geometry.path.subpaths[0]!;
  const anchors = [sourceSubpath.start, ...sourceSubpath.segments.map((segment) => segment.end)];
  const center = {
    x: (Math.min(...anchors.map((point) => point.x)) + Math.max(...anchors.map((point) => point.x))) / 2,
    y: (Math.min(...anchors.map((point) => point.y)) + Math.max(...anchors.map((point) => point.y))) / 2,
  };
  const entity = {
    ...sourceEntity,
    geometry: {
      kind: "cubic-path" as const,
      path: mapCubicPath(sourceEntity.geometry.path, ({ x, y }) => ({ x: x - center.x, y: y - center.y })),
    },
    lifetimes: [{ end: duration, start: 0 }],
  };
  const channelProvenanceId = fastManimSnapshotMotionPathChannelProvenanceIdV2(expected.sceneId, 0);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotMotionPathChannelIdV2(expected.sceneId, 0),
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 2, easingToNext: null, value: 1 },
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
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: [entity],
      provenance: [
        base.scene.provenance[0],
        base.scene.provenance[1],
        {
          evidence: ["producer-authored MoveAlongPath evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "motion-path-animation"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

/** Golden mixed slice shared with the V7 producer contract: one static
 * hermetic MathTex leaf, one Create ring, and one particle moving along one
 * bounded cubic path. */
async function mixedDynamic2dBundleV7(): Promise<SceneIrBundleV1> {
  return mixedDynamic2dSnapshotBundleFixtureV7({ ...expected, snapshotVersion: 7 });
}

function compiled(bundle: SceneIrBundleV1, expectedValue: ExpectedFastManimSnapshotCorrelationV1 = expected) {
  if (bundle.scene.source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported source.");
  const {
    frame: _serverFrame,
    hermeticMathTexV3Plan: _serverHermeticMathTexV3Plan,
    hermeticMathTexMorphV5Plan: _serverHermeticMathTexMorphV5Plan,
    hermeticPngV4Plan: _serverHermeticPngV4Plan,
    snapshotVersion: _serverSnapshotVersion,
    ...resultCorrelation
  } = expectedValue;
  return {
    ...resultCorrelation,
    bundle,
    kind: "compiled" as const,
    schema: "poietra.fast-manim-snapshot-result" as const,
    snapshotHash: bundle.scene.source.snapshotHash,
    version: 1 as const,
  };
}

function parseProducer(
  value: unknown,
  expectedValue: ExpectedFastManimSnapshotCorrelationV1 = expected,
  sourceText?: string,
) {
  return parseAndSealFastManimSnapshotProducerJsonV1(JSON.stringify(value), expectedValue, sourceText);
}

describe("canonical fast-manim Line cubic", () => {
  const start = { x: -4, y: 2 };
  const end = { x: 4, y: 2 };
  const canonical = {
    control1: { x: start.x + (end.x - start.x) / 3, y: 2 },
    control2: { x: start.x + ((end.x - start.x) * 2) / 3, y: 2 },
    end,
  };

  it("accepts bounded producer roundoff beyond one ordered-f64 ULP", () => {
    expect(
      isCanonicalFastManimLineSegmentV1(start, {
        ...canonical,
        control1: { x: -1.3333333333333337, y: 2 },
        control2: { x: 1.333333333333333, y: 2 },
      }),
    ).toBe(true);
    expect(
      isCanonicalFastManimLineSegmentV1(
        { x: -2.1, y: 0.7 },
        {
          control1: { x: -0.9333333333333336, y: 0.36666666666666664 },
          control2: { x: 0.23333333333333317, y: 0.033333333333333354 },
          end: { x: 1.4, y: -0.3 },
        },
      ),
    ).toBe(true);
  });

  it("uses the motion world origin as a roundoff floor after local rebasing", () => {
    const worldStart = { x: 1_000_000, y: 0 };
    const worldEnd = { x: 1_000_001, y: 0.25 };
    const worldCenter = { x: 1_000_000.5, y: 0.125 };
    const local = (point: { x: number; y: number }) => ({
      x: point.x - worldCenter.x,
      y: point.y - worldCenter.y,
    });
    const control = (factor: number) => ({
      x: worldStart.x + (worldEnd.x - worldStart.x) * factor,
      y: worldStart.y + (worldEnd.y - worldStart.y) * factor,
    });
    const start = local(worldStart);
    const segment = {
      control1: local(control(1 / 3)),
      control2: local(control(2 / 3)),
      end: local(worldEnd),
    };

    expect(isCanonicalFastManimLineSegmentV1(start, segment)).toBe(false);
    expect(isCanonicalFastManimLineSegmentV1(start, segment, 1_000_000)).toBe(true);
  });

  it("rejects drift outside the numeric bound and arbitrary collinear controls", () => {
    expect(
      isCanonicalFastManimLineSegmentV1(start, {
        ...canonical,
        control1: { ...canonical.control1, x: canonical.control1.x + 1e-10 },
      }),
    ).toBe(false);
    expect(isCanonicalFastManimLineSegmentV1(start, { control1: start, control2: end, end })).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite control at the helper boundary (%s)",
    (value) => {
      expect(
        isCanonicalFastManimLineSegmentV1(start, {
          ...canonical,
          control2: { ...canonical.control2, y: value },
        }),
      ).toBe(false);
    },
  );
});

describe("fast-manim snapshot result v1", () => {
  it("verifies a compiled Scene bundle and accepts a closed unsupported result", async () => {
    const bundle = await importedBundle();
    const sealed = await parseProducer(compiled(bundle), expected);
    expect(sealed).toMatchObject({ kind: "compiled" });
    if (sealed.kind !== "compiled" || sealed.bundle.scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("Expected a compiled imported snapshot.");
    }
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene.source.snapshotHash).toBe(sealed.snapshotHash);
    expect(digestFastManimSnapshotBundleV1(sealed.bundle)).toBe(sealed.snapshotHash);
    expect(sealed.bundle.scene.provenance[0]?.evidence).toEqual([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1]);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);
    await expect(parseProducer(sealed, expected)).rejects.toMatchObject({
      code: "snapshot-not-unsealed",
    });
    await expect(
      parseProducer(
        {
          ...wireCorrelation,
          issues: [
            {
              code: "geometry-evidence-incomplete",
              evidence: ["RenderTrace v0 exposes only a bounding box and hash"],
              message: "Complete cubic geometry is unavailable.",
            },
          ],
          kind: "unsupported",
          schema: "poietra.fast-manim-snapshot-result",
          version: 1,
        },
        expected,
      ),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("seals bounded generic V6 leaves with nonconvex, multi-subpath, curved, and fill+stroke geometry", async () => {
    const expectedV6 = { ...expected, snapshotVersion: 6 } as const;
    const bundle = await genericVmobjectBundleV6();
    const sealed = await parseProducer(compiled(bundle, expectedV6), expectedV6);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled generic VMobject snapshot.");

    expect(sealed.bundle.scene.entities).toHaveLength(3);
    expect(sealed.bundle.scene.entities[0]?.geometry).toMatchObject({
      kind: "cubic-path",
      path: { subpaths: [{ closed: true }, { closed: true }] },
    });
    expect(sealed.bundle.scene.entities[1]?.appearance).toMatchObject({
      fill: { rule: "nonzero" },
      kind: "vector",
      stroke: { cap: "butt", join: "miter", miterLimit: 10 },
    });
    expect(sealed.bundle.scene.entities[2]?.geometry).toMatchObject({
      kind: "cubic-path",
      path: { subpaths: [{ closed: false }] },
    });
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => evidence.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V6,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV6)).resolves.toEqual(sealed);
  });

  it("keeps generic V6 paint and topology admission fail-closed without relaxing V1", async () => {
    const expectedV6 = { ...expected, snapshotVersion: 6 } as const;
    const bundle = await genericVmobjectBundleV6();
    const mutateEntity = (index: number, mutation: Record<string, unknown>) => ({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: bundle.scene.entities.map((entity, entityIndex) =>
          entityIndex === index ? { ...entity, ...mutation } : entity,
        ),
      },
    });
    const openEntity = bundle.scene.entities[2]!;
    const filledEntity = bundle.scene.entities[0]!;
    const combinedEntity = bundle.scene.entities[1]!;
    if (
      openEntity.appearance.kind !== "vector" ||
      filledEntity.appearance.kind !== "vector" ||
      combinedEntity.appearance.kind !== "vector" ||
      combinedEntity.appearance.stroke === null
    ) {
      throw new Error("Expected vector V6 fixture paint.");
    }
    const rejected = [
      mutateEntity(2, {
        appearance: {
          ...openEntity.appearance,
          fill: { color: { alpha: 1, blue: 1, green: 1, red: 1 }, rule: "nonzero" },
        },
      }),
      mutateEntity(0, {
        appearance: { ...filledEntity.appearance, fill: { ...filledEntity.appearance.fill!, rule: "evenodd" } },
      }),
      mutateEntity(1, {
        appearance: {
          ...combinedEntity.appearance,
          stroke: { ...combinedEntity.appearance.stroke, cap: "round" },
        },
      }),
      mutateEntity(1, { appearance: { ...combinedEntity.appearance, opacity: 0.5 } }),
    ];
    for (const invalid of rejected) {
      await expect(parseProducer(compiled(invalid as SceneIrBundleV1, expectedV6), expectedV6)).rejects.toMatchObject({
        code: "profile-violation",
      });
    }

    const v1 = {
      ...bundle,
      scene: { ...bundle.scene, source: { ...bundle.scene.source, snapshotVersion: 1 as const } },
    };
    await expect(parseProducer(compiled(v1, expected), expected)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it("seals the golden V7 mixed dynamic 2D bundle without weakening its V2 or MathTex leaves", async () => {
    const expectedV7 = { ...expected, snapshotVersion: 7 } as const;
    const bundle = await mixedDynamic2dBundleV7();
    const sealed = await parseProducer(compiled(bundle, expectedV7), expectedV7);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled mixed dynamic V7 snapshot.");

    expect(sealed.bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: ["cubic-path-geometry", "motion-path-animation", "path-trim-animation"],
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 7 },
    });
    expect(sealed.bundle.scene.entities.map(({ lifetimes }) => lifetimes)).toEqual([
      [{ end: 4, start: 0 }],
      [{ end: 4, start: 0 }],
      [{ end: 4, start: 1 }],
    ]);
    expect(
      sealed.bundle.scene.animationChannels.map((channel) => ({
        entityId: "entityId" in channel ? channel.entityId : null,
        kind: channel.kind,
      })),
    ).toEqual([
      { entityId: fastManimSnapshotEntityIdV1(expected.sceneId, 1), kind: "path-trim" },
      { entityId: fastManimSnapshotEntityIdV1(expected.sceneId, 2), kind: "motion-path" },
    ]);
    expect(sealed.bundle.scene.provenance[1]?.evidence).toEqual([FAST_MANIM_SNAPSHOT_MATHTEX_PROVENANCE_EVIDENCE_V7]);
    expect(
      sealed.bundle.scene.provenance
        .filter((_, index) => index !== 1)
        .every(({ evidence }) => evidence.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V7),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV7)).resolves.toEqual(sealed);
  });

  it("seals and revalidates only the source-proven V7 MathTex base transform using VMobject anchors", async () => {
    const source = `from manim import Circle, Create, CubicBezier, MathTex, MoveAlongPath, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        ring = Circle()
        particle = Circle()
        path = CubicBezier((0, 0, 0), (1, 1, 0), (2, 1, 0), (3, 0, 0))
        equation.move_to((1.25, -0.75, 0))
        equation.scale(1.5)
        self.add(equation)
        self.play(Create(ring), run_time=1)
        self.play(MoveAlongPath(particle, path), run_time=2)
        self.wait(1)
`;
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const hermeticMathTexV3Plan = deriveMixedDynamicMathTexV7TransformPlan(source, expected.sceneName);
    expect(hermeticMathTexV3Plan).toEqual({
      terminalWait: null,
      transforms: [
        { kind: "move-to", x: 1.25, y: -0.75 },
        { factor: 1.5, kind: "scale" },
      ],
    });
    const excessiveTransforms = source.replace(
      "        equation.move_to((1.25, -0.75, 0))\n        equation.scale(1.5)",
      Array.from({ length: 65 }, () => "        equation.scale(1)").join("\n"),
    );
    expect(() => deriveMixedDynamicMathTexV7TransformPlan(excessiveTransforms, expected.sceneName)).toThrow(
      /too many static transforms/i,
    );
    const expectedV7 = { ...expected, hermeticMathTexV3Plan, snapshotVersion: 7, sourceHash } as const;
    const base = await mixedDynamic2dSnapshotBundleFixtureV7(expectedV7);
    const transformed = structuredClone(base);
    const mathTex = transformed.scene.entities[0]!;
    if (mathTex.geometry.kind !== "cubic-path") throw new Error("Expected V7 MathTex cubic geometry.");
    // Real glyph handles may exceed the boundary anchors. Manim's center uses
    // only anchors, so these extrema must not alter the source transform.
    mathTex.geometry.path.subpaths[0]!.segments[0]!.control1 = { x: 8, y: -1 };
    mathTex.geometry.path.subpaths[0]!.segments[0]!.control2 = { x: 7, y: -1 };
    mathTex.transform = { m11: 1.5, m12: 0, m21: 0, m22: 1.5, tx: 1.25, ty: -0.75 };

    const sealed = await parseProducer(compiled(transformed, expectedV7), expectedV7, source);
    if (sealed.kind !== "compiled") throw new Error("Expected one transformed V7 snapshot.");
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV7)).resolves.toEqual(sealed);

    const wrongPlan = {
      ...expectedV7,
      hermeticMathTexV3Plan: {
        ...hermeticMathTexV3Plan,
        transforms: [
          { kind: "move-to" as const, x: 2, y: -0.75 },
          { factor: 1.5, kind: "scale" as const },
        ],
      },
    };
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, wrongPlan)).rejects.toMatchObject({
      code: "profile-violation",
    });

    const transformedRing = structuredClone(transformed);
    transformedRing.scene.entities[1]!.transform.tx = 0.25;
    await expect(parseProducer(compiled(transformedRing, expectedV7), expectedV7, source)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it("keeps V7 fail-closed when MathTex is dynamic, duplicated, or not accompanied by mixed dynamic evidence", async () => {
    const expectedV7 = { ...expected, snapshotVersion: 7 } as const;
    const bundle = await mixedDynamic2dBundleV7();
    const mathTexEntity = bundle.scene.entities[0]!;
    const pathTrim = bundle.scene.animationChannels[0];
    if (pathTrim?.kind !== "path-trim") throw new Error("Expected the golden Create channel.");

    const animatedMathTex = structuredClone(bundle);
    const animatedMathTexChannel = animatedMathTex.scene.animationChannels[0];
    if (animatedMathTexChannel?.kind !== "path-trim") throw new Error("Expected the cloned Create channel.");
    animatedMathTexChannel.entityId = mathTexEntity.id;
    animatedMathTexChannel.id = fastManimSnapshotPathTrimChannelIdV2(expected.sceneId, 0);
    animatedMathTexChannel.provenanceId = fastManimSnapshotPathTrimChannelProvenanceIdV2(expected.sceneId, 0);
    animatedMathTex.scene.provenance[4] = {
      ...animatedMathTex.scene.provenance[4]!,
      id: animatedMathTexChannel.provenanceId,
    };

    const duplicateMathTex = structuredClone(bundle);
    duplicateMathTex.scene.provenance[2] = {
      ...duplicateMathTex.scene.provenance[2]!,
      evidence: [...bundle.scene.provenance[1]!.evidence],
    };

    const noDynamicEvidence = structuredClone(bundle);
    noDynamicEvidence.scene.animationChannels = [];
    noDynamicEvidence.scene.provenance = noDynamicEvidence.scene.provenance.slice(0, 4);
    noDynamicEvidence.scene.requiredCapabilities = ["cubic-path-geometry"];

    const unsupportedV2Kind = structuredClone(bundle);
    const ringId = unsupportedV2Kind.scene.entities[1]!.id;
    const opacityProvenanceId = fastManimSnapshotOpacityChannelProvenanceIdV2(expected.sceneId, 1);
    unsupportedV2Kind.scene.animationChannels[0] = {
      entityId: ringId,
      id: fastManimSnapshotOpacityChannelIdV2(expected.sceneId, 1),
      keyframes: [
        { at: 0, easingToNext: { kind: "linear" }, value: 0 },
        { at: 1, easingToNext: null, value: 1 },
      ],
      kind: "opacity",
      provenanceId: opacityProvenanceId,
    };
    unsupportedV2Kind.scene.provenance[4] = {
      ...unsupportedV2Kind.scene.provenance[4]!,
      id: opacityProvenanceId,
    };
    unsupportedV2Kind.scene.requiredCapabilities = [
      "cubic-path-geometry",
      "motion-path-animation",
      "opacity-animation",
    ];

    const uncreate = structuredClone(bundle);
    const uncreateChannel = uncreate.scene.animationChannels[0];
    if (uncreateChannel?.kind !== "path-trim") throw new Error("Expected the cloned Create channel.");
    uncreateChannel.keyframes = [
      { at: 0, easingToNext: { kind: "linear" }, value: 1 },
      { at: 1, easingToNext: null, value: 0 },
    ];

    for (const candidate of [animatedMathTex, duplicateMathTex, noDynamicEvidence, unsupportedV2Kind, uncreate]) {
      await expect(parseProducer(compiled(candidate, expectedV7), expectedV7)).rejects.toThrow();
    }
  });

  it("seals one bounded hermetic MathTex outline with multiple subpaths and a counter", async () => {
    const expectedV3 = { ...expected, snapshotVersion: 3 } as const;
    const bundle = await hermeticMathTexBundle();
    const sealed = await parseProducer(compiled(bundle), expectedV3);
    expect(sealed).toMatchObject({ kind: "compiled" });
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled MathTex snapshot.");
    expect(sealed.bundle.scene.entities[0]?.geometry).toMatchObject({
      kind: "cubic-path",
      path: { subpaths: [{ closed: true }, { closed: true }] },
    });
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => evidence.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V3,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV3)).resolves.toEqual(sealed);
  });

  it("re-derives static MathTex transforms while preserving the canonical outline", async () => {
    const source = `from manim import MathTex, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        equation.move_to((1.25, -0.75, 0_0))
        equation.scale(1.5)
        equation.move_to((-0.25, 0.75, 0))
        equation.scale(0.5)
        self.wait(2)
`;
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const hermeticMathTexV3Plan = deriveHermeticMathTexV3TransformPlan(source, expected.sceneName);
    expect(hermeticMathTexV3Plan).toEqual({
      terminalWait: 2,
      transforms: [
        { kind: "move-to", x: 1.25, y: -0.75 },
        { factor: 1.5, kind: "scale" },
        { kind: "move-to", x: -0.25, y: 0.75 },
        { factor: 0.5, kind: "scale" },
      ],
    });
    const expectedV3 = { ...expected, hermeticMathTexV3Plan, snapshotVersion: 3, sourceHash } as const;
    const base = await hermeticMathTexBundle();
    const entity = base.scene.entities[0]!;
    const transformed = sceneIrBundleV1Schema.parse({
      ...base,
      scene: {
        ...base.scene,
        duration: 2,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            transform: { m11: 0.75, m12: 0, m21: 0, m22: 0.75, tx: -0.25, ty: 0.75 },
          },
        ],
        source: { ...base.scene.source, sourceHash },
      },
    });

    const sealed = await parseProducer(compiled(transformed, expectedV3), expectedV3, source);
    expect(sealed).toMatchObject({ kind: "compiled", bundle: { scene: { duration: 2 } } });
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV3)).resolves.toEqual(sealed);

    const wrongDuration = sceneIrBundleV1Schema.parse({
      ...transformed,
      scene: {
        ...transformed.scene,
        duration: 1,
        entities: transformed.scene.entities.map((candidate) => ({
          ...candidate,
          lifetimes: [{ end: 1, start: 0 }],
        })),
      },
    });
    await expect(parseProducer(compiled(wrongDuration, expectedV3), expectedV3, source)).rejects.toMatchObject({
      code: "profile-violation",
    });

    const machineRounded = sceneIrBundleV1Schema.parse({
      ...transformed,
      scene: {
        ...transformed.scene,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            transform: {
              m11: 0.75 + Number.EPSILON,
              m12: 0,
              m21: 0,
              m22: 0.75 - Number.EPSILON,
              tx: -0.25 + Number.EPSILON,
              ty: 0.75 - Number.EPSILON,
            },
          },
        ],
      },
    });
    await expect(parseProducer(compiled(machineRounded, expectedV3), expectedV3, source)).resolves.toMatchObject({
      kind: "compiled",
    });

    const wrongPlan = {
      ...expectedV3,
      hermeticMathTexV3Plan: {
        ...hermeticMathTexV3Plan,
        transforms: [{ factor: 2, kind: "scale" as const }, ...hermeticMathTexV3Plan.transforms.slice(1)],
      },
    };
    await expect(parseProducer(compiled(transformed, wrongPlan), wrongPlan, source)).rejects.toMatchObject({
      code: "profile-violation",
    });

    const drifted = sceneIrBundleV1Schema.parse({
      ...transformed,
      scene: {
        ...transformed.scene,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            transform: { ...entity.transform, m11: 0.750_001, m22: 0.75, tx: -0.25, ty: 0.75 },
          },
        ],
      },
    });
    await expect(parseProducer(compiled(drifted, expectedV3), expectedV3, source)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it("rejects a hermetic static transform plan whose cumulative scale underflows", () => {
    const source = `from manim import MathTex, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        equation.scale(1e-300)
        equation.scale(1e-300)
`;

    expect(() => deriveHermeticMathTexV3TransformPlan(source, expected.sceneName)).toThrow(
      /out-of-range cumulative scale/,
    );
  });

  it("fails closed when profile V3 contains an open contour or more than one entity", async () => {
    const expectedV3 = { ...expected, snapshotVersion: 3 } as const;
    const bundle = await hermeticMathTexBundle();
    const geometry = bundle.scene.entities[0]!.geometry;
    if (geometry.kind !== "cubic-path") throw new Error("Expected cubic MathTex fixture geometry.");
    const openContour = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: [
          {
            ...bundle.scene.entities[0],
            geometry: {
              ...geometry,
              path: {
                subpaths: geometry.path.subpaths.map((subpath, index) =>
                  index === 1 ? { ...subpath, closed: false } : subpath,
                ),
              },
            },
          },
        ],
      },
    });
    const extraEntity = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: [
          bundle.scene.entities[0],
          {
            ...bundle.scene.entities[0],
            id: `${expected.sceneId}/entity:1`,
            provenanceId: `${expected.sceneId}/provenance:entity:1`,
            sceneOrder: 1,
          },
        ],
        provenance: [
          ...bundle.scene.provenance,
          {
            evidence: ["producer-authored evidence must be normalized"],
            id: `${expected.sceneId}/provenance:entity:1`,
            origin: "fast-manim-server-snapshot",
          },
        ],
      },
    });
    await expect(parseProducer(compiled(openContour), expectedV3)).rejects.toMatchObject({ code: "profile-violation" });
    await expect(parseProducer(compiled(extraEntity), expectedV3)).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("fails closed when profile V3 loses canonical paint, coordinate quantum, or artifact attestation", async () => {
    const expectedV3 = { ...expected, snapshotVersion: 3 } as const;
    const bundle = await hermeticMathTexBundle();
    const entity = bundle.scene.entities[0]!;
    if (entity.appearance.kind !== "vector" || entity.geometry.kind !== "cubic-path") {
      throw new Error("Expected vector cubic MathTex fixture geometry.");
    }
    const wrongPaint = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: [
          {
            ...entity,
            appearance: {
              ...entity.appearance,
              fill: { ...entity.appearance.fill, color: { alpha: 1, blue: 1, green: 1, red: 0.5 } },
            },
          },
        ],
      },
    });
    const firstSubpath = entity.geometry.path.subpaths[0]!;
    const wrongQuantum = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: [
          {
            ...entity,
            geometry: {
              ...entity.geometry,
              path: {
                subpaths: [
                  { ...firstSubpath, start: { ...firstSubpath.start, x: firstSubpath.start.x + 0.000_000_4 } },
                  ...entity.geometry.path.subpaths.slice(1),
                ],
              },
            },
          },
        ],
      },
    });
    const wrongAttestation = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: bundle.scene.provenance.map((record, index) =>
          index === 1
            ? { ...record, evidence: [...record.evidence.slice(0, -1), `MathTex font digest ${"0".repeat(64)}`] }
            : record,
        ),
      },
    });
    for (const rejected of [wrongPaint, wrongQuantum, wrongAttestation]) {
      await expect(parseProducer(compiled(rejected), expectedV3)).rejects.toMatchObject({ code: "profile-violation" });
    }
  });

  it("seals one source-derived two-stage MathTex A/B/A morph as profile V5", async () => {
    const sourceHash = createHash("sha256").update(HERMETIC_MATHTEX_MORPH_SOURCE_V5, "utf8").digest("hex");
    const hermeticMathTexMorphV5Plan = deriveHermeticMathTexMorphV5Plan(
      HERMETIC_MATHTEX_MORPH_SOURCE_V5,
      expected.sceneName,
    );
    expect(hermeticMathTexMorphV5Plan).toMatchObject({
      duration: 5.5,
      keyframeTimes: [1, 2, 2.5, 4.5],
    });
    expect(hermeticMathTexMorphV5Plan.contentDigests[0]).toBe(hermeticMathTexMorphV5Plan.contentDigests[2]);
    expect(hermeticMathTexMorphV5Plan.contentDigests[0]).not.toBe(hermeticMathTexMorphV5Plan.contentDigests[1]);
    const expectedV5 = {
      ...expected,
      hermeticMathTexMorphV5Plan,
      snapshotVersion: 5,
      sourceHash,
    } as const;
    const bundle = await hermeticMathTexMorphBundleV5(hermeticMathTexMorphV5Plan);
    const correlated = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: { ...bundle.scene, source: { ...bundle.scene.source, sourceHash } },
    });
    const sealed = await parseProducer(compiled(correlated, expectedV5), expectedV5, HERMETIC_MATHTEX_MORPH_SOURCE_V5);
    expect(sealed).toMatchObject({
      kind: "compiled",
      bundle: {
        scene: {
          duration: 5.5,
          fidelity: { kind: "approximate" },
          requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
          source: { snapshotVersion: 5 },
        },
      },
    });
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled MathTex morph snapshot.");
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => evidence.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V5,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV5)).resolves.toEqual(sealed);
  });

  it("matches the producer's three-keyframe normalization for adjacent V5 morphs", async () => {
    const source = HERMETIC_MATHTEX_MORPH_SOURCE_V5.replace("        self.wait(0.5, frozen_frame=True)\n", "");
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const hermeticMathTexMorphV5Plan = deriveHermeticMathTexMorphV5Plan(source, expected.sceneName);
    expect(hermeticMathTexMorphV5Plan).toMatchObject({ duration: 5, keyframeTimes: [1, 2, 4] });
    const expectedV5 = {
      ...expected,
      hermeticMathTexMorphV5Plan,
      snapshotVersion: 5,
      sourceHash,
    } as const;
    const bundle = await hermeticMathTexMorphBundleV5(hermeticMathTexMorphV5Plan);
    const correlated = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: { ...bundle.scene, source: { ...bundle.scene.source, sourceHash } },
    });
    const sealed = await parseProducer(compiled(correlated, expectedV5), expectedV5, source);
    expect(sealed).toMatchObject({
      kind: "compiled",
      bundle: { scene: { animationChannels: [{ keyframes: [{ at: 1 }, { at: 2 }, { at: 4 }] }] } },
    });
  });

  it("fails closed on every V5 A/B/B/A trust boundary", async () => {
    const sourceHash = createHash("sha256").update(HERMETIC_MATHTEX_MORPH_SOURCE_V5, "utf8").digest("hex");
    const hermeticMathTexMorphV5Plan = deriveHermeticMathTexMorphV5Plan(
      HERMETIC_MATHTEX_MORPH_SOURCE_V5,
      expected.sceneName,
    );
    const expectedV5 = {
      ...expected,
      hermeticMathTexMorphV5Plan,
      snapshotVersion: 5,
      sourceHash,
    } as const;
    const base = await hermeticMathTexMorphBundleV5(hermeticMathTexMorphV5Plan);
    const correlated = sceneIrBundleV1Schema.parse({
      ...base,
      scene: { ...base.scene, source: { ...base.scene.source, sourceHash } },
    });
    const channel = correlated.scene.animationChannels[0]!;
    if (channel.kind !== "path-morph") throw new Error("Expected V5 path-morph fixture.");
    const entity = correlated.scene.entities[0]!;
    if (entity.geometry.kind !== "cubic-path") throw new Error("Expected V5 cubic fixture.");
    const wrongTopologyPath = structuredClone(channel.keyframes[1]!.value);
    wrongTopologyPath.subpaths[0]!.segments.pop();
    const wrongTopology = {
      ...correlated,
      scene: {
        ...correlated.scene,
        animationChannels: [
          {
            ...channel,
            keyframes: channel.keyframes.map((keyframe, index) =>
              index === 1 ? { ...keyframe, value: wrongTopologyPath } : keyframe,
            ),
          },
        ],
      },
    } as SceneIrBundleV1;
    const wrongTime = sceneIrBundleV1Schema.parse({
      ...correlated,
      scene: {
        ...correlated.scene,
        animationChannels: [
          {
            ...channel,
            keyframes: channel.keyframes.map((keyframe, index) =>
              index === 2 ? { ...keyframe, at: keyframe.at + 1 / 60 } : keyframe,
            ),
          },
        ],
      },
    });
    const wrongEasing = sceneIrBundleV1Schema.parse({
      ...correlated,
      scene: {
        ...correlated.scene,
        animationChannels: [
          {
            ...channel,
            keyframes: channel.keyframes.map((keyframe, index) =>
              index === 0 ? { ...keyframe, easingToNext: { kind: "linear" } } : keyframe,
            ),
          },
        ],
      },
    });
    const wrongFidelity = sceneIrBundleV1Schema.parse({
      ...correlated,
      scene: { ...correlated.scene, fidelity: { kind: "exact" } },
    });
    const wrongToolchain = sceneIrBundleV1Schema.parse({
      ...correlated,
      scene: {
        ...correlated.scene,
        provenance: correlated.scene.provenance.map((record, index) =>
          index === 1
            ? {
                ...record,
                evidence: record.evidence.map((entry) =>
                  entry.startsWith("MathTex toolchain digest") ? `MathTex toolchain digest ${"0".repeat(64)}` : entry,
                ),
              }
            : record,
        ),
      },
    });
    const wrongRestored = sceneIrBundleV1Schema.parse({
      ...correlated,
      scene: {
        ...correlated.scene,
        animationChannels: [
          {
            ...channel,
            keyframes: channel.keyframes.map((keyframe, index) =>
              index === 3 ? { ...keyframe, value: channel.keyframes[1]!.value } : keyframe,
            ),
          },
        ],
      },
    });
    expect(entity.geometry.path).toEqual(channel.keyframes[0]!.value);
    await expect(
      parseProducer(compiled(wrongTopology, expectedV5), expectedV5, HERMETIC_MATHTEX_MORPH_SOURCE_V5),
    ).rejects.toThrow(/matching cubic topology/i);
    for (const rejected of [wrongTime, wrongEasing, wrongFidelity, wrongToolchain, wrongRestored]) {
      await expect(
        parseProducer(compiled(rejected, expectedV5), expectedV5, HERMETIC_MATHTEX_MORPH_SOURCE_V5),
      ).rejects.toMatchObject({ code: "profile-violation" });
    }
    await expect(parseProducer(compiled(correlated, expectedV5), expectedV5)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it.each(["nearest", "linear"] as const)("seals one bounded hermetic PNG with the %s sampler", async (sampler) => {
    const expectedV4 = { ...expected, snapshotVersion: 4 } as const;
    const bundle = await hermeticPngBundle(sampler);
    const sealed = await parseProducer(compiled(bundle), expectedV4);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled PNG snapshot.");
    expect(sealed.bundle.assets.assets).toEqual([
      expect.objectContaining({
        id: fastManimSnapshotPngAssetIdV4(expected.sceneId),
        kind: "png-image",
        pixelHeight: 1,
        pixelWidth: 2,
      }),
    ]);
    expect(sealed.bundle.scene.entities[0]?.geometry).toMatchObject({ kind: "image", sampler });
    expect(
      sealed.bundle.scene.provenance.every(
        ({ evidence }) => evidence.length === 1 && evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V4,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV4)).resolves.toEqual(sealed);
  });

  it("re-derives ordered PNG transforms from exact source and retains the plan for sealed revalidation", async () => {
    const source = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ExampleScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        # image.move_to((999, 999, 0)) must remain a comment.
        image.scale(1.5)
        image.move_to((1, -2, 0))
        # image.scale(999) must remain a comment too.
        self.wait(2)
`;
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const hermeticPngV4Plan = deriveHermeticPngV4TransformPlan(source, expected.sceneName);
    expect(hermeticPngV4Plan).toEqual({
      terminalWait: 2,
      transforms: [
        { factor: 1.5, kind: "scale" },
        { kind: "move-to", x: 1, y: -2 },
      ],
    });
    const expectedV4 = { ...expected, hermeticPngV4Plan, snapshotVersion: 4, sourceHash } as const;
    const base = await hermeticPngBundle();
    const entity = base.scene.entities[0]!;
    if (entity.geometry.kind !== "image") throw new Error("Expected image fixture geometry.");
    const baseHeight = (base.assets.assets[0]!.pixelHeight / 1_080) * expected.frame.height;
    const baseWidth = (baseHeight * base.assets.assets[0]!.pixelWidth) / base.assets.assets[0]!.pixelHeight;
    const transformed = sceneIrBundleV1Schema.parse({
      ...base,
      scene: {
        ...base.scene,
        duration: 2,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            geometry: {
              ...entity.geometry,
              localRect: {
                bottom: -2 - (baseHeight * 1.5) / 2,
                left: 1 - (baseWidth * 1.5) / 2,
                right: 1 + (baseWidth * 1.5) / 2,
                top: -2 + (baseHeight * 1.5) / 2,
              },
            },
          },
        ],
        source: { ...base.scene.source, sourceHash },
      },
    });

    const sealed = await parseProducer(compiled(transformed, expectedV4), expectedV4, source);
    expect(sealed).toMatchObject({ kind: "compiled", bundle: { scene: { duration: 2 } } });
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV4)).resolves.toEqual(sealed);

    const transformedGeometry = transformed.scene.entities[0]!.geometry;
    if (transformedGeometry.kind !== "image") throw new Error("Expected transformed image geometry.");
    const machineRounded = sceneIrBundleV1Schema.parse({
      ...transformed,
      scene: {
        ...transformed.scene,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            geometry: {
              ...entity.geometry,
              localRect: {
                bottom: transformedGeometry.localRect.bottom - Number.EPSILON * 4,
                left: transformedGeometry.localRect.left + Number.EPSILON * 4,
                right: transformedGeometry.localRect.right - Number.EPSILON * 4,
                top: transformedGeometry.localRect.top + Number.EPSILON * 4,
              },
            },
          },
        ],
      },
    });
    await expect(parseProducer(compiled(machineRounded, expectedV4), expectedV4, source)).resolves.toMatchObject({
      kind: "compiled",
    });

    const wrongPlan = {
      ...expectedV4,
      hermeticPngV4Plan: {
        ...hermeticPngV4Plan,
        transforms: [{ factor: 2, kind: "scale" as const }, hermeticPngV4Plan.transforms[1]!],
      },
    };
    await expect(parseProducer(compiled(transformed, wrongPlan), wrongPlan, source)).rejects.toMatchObject({
      code: "profile-violation",
    });

    const drifted = sceneIrBundleV1Schema.parse({
      ...transformed,
      scene: {
        ...transformed.scene,
        entities: [
          {
            ...entity,
            lifetimes: [{ end: 2, start: 0 }],
            geometry: {
              ...entity.geometry,
              localRect: {
                ...transformedGeometry.localRect,
                right: transformedGeometry.localRect.right + 0.000_001,
              },
            },
          },
        ],
      },
    });
    await expect(parseProducer(compiled(drifted, expectedV4), expectedV4, source)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it("preserves producer unsupported results when V4 source is outside the transform grammar", async () => {
    const expectedV4 = { ...expected, snapshotVersion: 4 } as const;
    await expect(
      parseProducer(
        {
          ...wireCorrelation,
          issues: [
            {
              code: "runtime-semantics-unsupported",
              evidence: [],
              message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["runtime-semantics-unsupported"],
            },
          ],
          kind: "unsupported",
          schema: "poietra.fast-manim-snapshot-result",
          version: 1,
        },
        expectedV4,
        "this is not valid Python and must not mask producer unsupported",
      ),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("fails closed when profile V4 image metadata, geometry, capability, or provenance drifts", async () => {
    const expectedV4 = { ...expected, snapshotVersion: 4 } as const;
    const bundle = await hermeticPngBundle();
    const entity = bundle.scene.entities[0]!;
    if (entity.geometry.kind !== "image") throw new Error("Expected image fixture geometry.");

    const mutateScene = (patch: Partial<typeof bundle.scene>) => ({
      ...bundle,
      scene: { ...bundle.scene, ...patch },
    });
    const rejected = [
      mutateScene({
        entities: [
          {
            ...entity,
            geometry: {
              ...entity.geometry,
              localRect: { ...entity.geometry.localRect, right: entity.geometry.localRect.right + 0.000_001 },
            },
          },
        ],
      }),
      mutateScene({
        provenance: bundle.scene.provenance.map((record, index) =>
          index === 0 ? { ...record, evidence: ["fast-manim hermetic PNG Scene snapshot profile v5"] } : record,
        ),
      }),
      mutateScene({
        provenance: bundle.scene.provenance.map((record, index) =>
          index === 1
            ? { ...record, evidence: [...record.evidence.slice(0, -3), `PNG encoded digest ${"5".repeat(64)}`] }
            : record,
        ),
      }),
      mutateScene({
        provenance: bundle.scene.provenance.map((record, index) =>
          index === 1
            ? {
                ...record,
                evidence: [...record.evidence.slice(0, -2), "PNG dimensions 1 x 2", record.evidence.at(-1)!],
              }
            : record,
        ),
      }),
      mutateScene({
        provenance: bundle.scene.provenance.map((record, index) =>
          index === 1 ? { ...record, evidence: [...record.evidence.slice(0, -1), "PNG sampler linear"] } : record,
        ),
      }),
    ];
    await expect(
      parseProducer(
        compiled(mutateScene({ requiredCapabilities: ["cubic-path-geometry"] }) as SceneIrBundleV1),
        expectedV4,
      ),
    ).rejects.toThrow(/requiredCapabilities must exactly equal: png-image/i);
    for (const candidate of rejected) {
      await expect(parseProducer(compiled(candidate as SceneIrBundleV1), expectedV4)).rejects.toMatchObject({
        code: "profile-violation",
      });
    }

    const secondAsset = { ...bundle.assets.assets[0]!, id: `${expected.sceneId}/asset:image:1` };
    const assets = [...bundle.assets.assets, secondAsset];
    const manifestDigest = await digestAssetManifestV1({ ...bundle.assets, assets, manifestDigest: ZERO_SHA256 });
    const extraAsset = {
      assets: { ...bundle.assets, assets, manifestDigest },
      scene: { ...bundle.scene, assetManifest: { ...bundle.scene.assetManifest, manifestDigest } },
    };
    await expect(parseProducer(compiled(extraAsset as SceneIrBundleV1), expectedV4)).rejects.toMatchObject({
      code: "profile-violation",
    });
  });

  it("seals a bounded variable-duration V2 still while keeping versions correlated", async () => {
    const v1 = await importedBundle();
    const duration = 2.5;
    const v2 = sceneIrBundleV1Schema.parse({
      ...v1,
      scene: {
        ...v1.scene,
        duration,
        entities: v1.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ start: 0, end: duration }] })),
        source: { ...v1.scene.source, snapshotVersion: 2 },
      },
    });
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(v2), expectedV2);
    if (sealed.kind !== "compiled" || sealed.bundle.scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("Expected a compiled V2 snapshot.");
    }
    expect(sealed.bundle.scene.duration).toBe(duration);
    expect(sealed.bundle.scene.entities.every((entity) => entity.lifetimes[0]?.end === duration)).toBe(true);
    expect(sealed.bundle.scene.source.snapshotVersion).toBe(2);
    expect(sealed.bundle.scene.provenance[0]?.evidence).toEqual([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2]);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
    const floatLexeme = JSON.stringify(compiled(v2)).replace('"snapshotVersion":2', '"snapshotVersion":2.0');
    await expect(parseAndSealFastManimSnapshotProducerJsonV1(floatLexeme, expectedV2)).resolves.toMatchObject({
      kind: "compiled",
    });
    await expect(parseProducer(compiled(v2), expected)).rejects.toMatchObject({ code: "snapshot-source-mismatch" });
    await expect(parseProducer(compiled(v1), expectedV2)).rejects.toMatchObject({ code: "snapshot-source-mismatch" });

    const legacyDuration = 0.51;
    const legacyFrozenWait = sceneIrBundleV1Schema.parse({
      ...v2,
      scene: {
        ...v2.scene,
        duration: legacyDuration,
        entities: v2.scene.entities.map((entity) => ({
          ...entity,
          lifetimes: [{ end: legacyDuration, start: 0 }],
        })),
      },
    });
    await expect(parseProducer(compiled(legacyFrozenWait), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const tooLong = {
      ...v2,
      scene: {
        ...v2.scene,
        duration: 3_600.001,
        entities: v2.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ start: 0, end: 3_600.001 }] })),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(tooLong), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("seals producer-shaped V2 membership and linear opacity evidence", async () => {
    const bundle = await dynamicOpacityBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(bundle), expectedV2);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled dynamic V2 snapshot.");

    expect(sealed.bundle.scene.duration).toBe(6);
    expect(sealed.bundle.scene.entities[0]?.lifetimes).toEqual([{ end: 6, start: 1 }]);
    expect(sealed.bundle.scene.animationChannels).toEqual(bundle.scene.animationChannels);
    expect(sealed.bundle.scene.provenance.every((record) => record.evidence.length === 1)).toBe(true);
    expect(
      sealed.bundle.scene.provenance.every(
        (record) => record.evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);

    const membershipOnly = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: [],
        duration: 3,
        entities: bundle.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ end: 3, start: 1 }] })),
        provenance: bundle.scene.provenance.slice(0, 2),
        requiredCapabilities: ["cubic-path-geometry"],
      },
    });
    await expect(parseProducer(compiled(membershipOnly), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const cumulativeDuration = 23 / 60;
    const cumulativeGrid = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: bundle.scene.animationChannels.map((channel) => ({
          ...channel,
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 22 / 60, easingToNext: null, value: 1 },
          ],
        })),
        duration: cumulativeDuration,
        entities: bundle.scene.entities.map((entity) => ({
          ...entity,
          lifetimes: [{ end: cumulativeDuration, start: 0 }],
        })),
      },
    });
    await expect(parseProducer(compiled(cumulativeGrid), expectedV2)).resolves.toMatchObject({ kind: "compiled" });
  });

  it("seals bounded absolute affine keyframes, including reflection, while keeping the base static", async () => {
    const bundle = await dynamicAffineBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(bundle), expectedV2);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled affine V2 snapshot.");

    expect(sealed.bundle.scene.requiredCapabilities).toEqual(["affine-transform-animation", "cubic-path-geometry"]);
    expect(sealed.bundle.scene.entities[0]?.geometry).toEqual(bundle.scene.entities[0]?.geometry);
    expect(sealed.bundle.scene.entities[0]?.transform).toEqual({ m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 });
    expect(sealed.bundle.scene.animationChannels).toEqual(bundle.scene.animationChannels);
    const sealedChannel = sealed.bundle.scene.animationChannels[0]!;
    if (sealedChannel.kind !== "affine-transform") throw new Error("Expected the sealed affine channel.");
    const reflected = sealedChannel.keyframes.at(-1)!.value;
    expect(reflected.m11 * reflected.m22 - reflected.m12 * reflected.m21).toBeLessThan(0);
    expect(
      sealed.bundle.scene.provenance.every(
        (record) => record.evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
  });

  it("accepts affine then opacity for one entity and rejects reversed channel identity order", async () => {
    const opacity = await dynamicOpacityBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const entity = opacity.scene.entities[0]!;
    const affineProvenanceId = fastManimSnapshotAffineTransformChannelProvenanceIdV2(expected.sceneId, 0);
    const affine = {
      entityId: entity.id,
      id: fastManimSnapshotAffineTransformChannelIdV2(expected.sceneId, 0),
      keyframes: [
        {
          at: 1,
          easingToNext: { kind: "linear" as const },
          value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
        },
        {
          at: 2,
          easingToNext: null,
          value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 2, ty: 0 },
        },
      ],
      kind: "affine-transform" as const,
      provenanceId: affineProvenanceId,
    };
    const combined = sceneIrBundleV1Schema.parse({
      ...opacity,
      scene: {
        ...opacity.scene,
        animationChannels: [affine, ...opacity.scene.animationChannels],
        provenance: [
          ...opacity.scene.provenance.slice(0, 2),
          {
            evidence: ["producer-authored affine evidence must be normalized"],
            id: affineProvenanceId,
            origin: "fast-manim-server-snapshot",
          },
          opacity.scene.provenance[2],
        ],
        requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "opacity-animation"],
      },
    });
    await expect(parseProducer(compiled(combined), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const reversed = {
      ...combined,
      scene: { ...combined.scene, animationChannels: [...combined.scene.animationChannels].reverse() },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(reversed), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects schema-valid affine evidence outside the exact producer profile", async () => {
    const bundle = await dynamicAffineBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const scene = bundle.scene;
    const channel = scene.animationChannels[0]!;
    if (channel.kind !== "affine-transform") throw new Error("Expected the affine fixture channel.");
    const mutate = (patch: Partial<typeof scene>) => ({ ...bundle, scene: { ...scene, ...patch } }) as SceneIrBundleV1;
    const mutateChannel = (patch: Partial<typeof channel>) =>
      mutate({ animationChannels: [{ ...channel, ...patch }] } as Partial<typeof scene>);
    const identity = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 };

    const profileViolations = [
      mutateChannel({ id: fastManimSnapshotAffineTransformChannelIdV2(expected.sceneId, 1) }),
      mutateChannel({ provenanceId: scene.provenance[1]!.id }),
      mutateChannel({ entityId: scene.entities[1]!.id }),
      mutateChannel({ keyframes: channel.keyframes.map((keyframe) => ({ ...keyframe, value: identity })) }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 0 ? { ...keyframe, value: { ...keyframe.value, tx: 1 } } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 0 ? { ...keyframe, easingToNext: { kind: "smooth" as const } } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) => (index === 1 ? { ...keyframe, at: 2.01 } : keyframe)),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 1 ? { ...keyframe, value: { ...keyframe.value, m11: 1_000_000_001 } } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 1 ? { ...keyframe, value: { ...keyframe.value, m11: 1_000_000_000 } } : keyframe,
        ),
      }),
      mutate({
        entities: scene.entities.map((entity, index) =>
          index === 0 ? { ...entity, transform: { ...entity.transform, tx: 1 } } : entity,
        ),
      } as Partial<typeof scene>),
    ];
    for (const invalid of profileViolations) {
      await expect(parseProducer(compiled(invalid), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
    }
  });

  it("rejects omitted, unknown, and non-finite affine matrix fields at the Scene IR boundary", async () => {
    const bundle = await dynamicAffineBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const missing = structuredClone(bundle) as unknown as {
      scene: { animationChannels: Array<{ keyframes: Array<{ value: Record<string, unknown> }> }> };
    };
    delete missing.scene.animationChannels[0]!.keyframes[1]!.value.m11;
    const unknown = structuredClone(bundle) as unknown as {
      scene: { animationChannels: Array<{ keyframes: Array<{ value: Record<string, unknown> }> }> };
    };
    unknown.scene.animationChannels[0]!.keyframes[1]!.value.future = 1;
    const nonFinite = structuredClone(bundle) as unknown as {
      scene: { animationChannels: Array<{ keyframes: Array<{ value: Record<string, unknown> }> }> };
    };
    nonFinite.scene.animationChannels[0]!.keyframes[1]!.value.m11 = Number.NaN;
    const wrongCapabilities = {
      ...bundle,
      scene: { ...bundle.scene, requiredCapabilities: ["cubic-path-geometry"] },
    };

    for (const invalid of [missing, unknown, nonFinite, wrongCapabilities]) {
      await expect(parseProducer(compiled(invalid as unknown as SceneIrBundleV1), expectedV2)).rejects.toThrow();
    }
  });

  it("seals one locally rebased direct MoveAlongPath channel without rewriting its path", async () => {
    const bundle = await dynamicMotionPathBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(bundle), expectedV2);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled motion-path V2 snapshot.");

    expect(sealed.bundle.scene.requiredCapabilities).toEqual(["cubic-path-geometry", "motion-path-animation"]);
    expect(sealed.bundle.scene.entities).toEqual(bundle.scene.entities);
    expect(sealed.bundle.scene.animationChannels).toEqual(bundle.scene.animationChannels);
    expect(sealed.bundle.scene.animationChannels[0]).toMatchObject({
      id: fastManimSnapshotMotionPathChannelIdV2(expected.sceneId, 0),
      kind: "motion-path",
      orientToPath: false,
      parameterization: "manim-point-from-proportion-v1",
      provenanceId: fastManimSnapshotMotionPathChannelProvenanceIdV2(expected.sceneId, 0),
    });
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
  });

  it("rejects motion-path evidence outside the direct canonical MoveAlongPath profile", async () => {
    const bundle = await dynamicMotionPathBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    type MotionPathChannel = Extract<SceneIrBundleV1["scene"]["animationChannels"][number], { kind: "motion-path" }>;
    const mutateChannel = (mutate: (channel: MotionPathChannel) => void) => {
      const candidate = structuredClone(bundle);
      const channel = candidate.scene.animationChannels[0];
      if (channel?.kind !== "motion-path") throw new Error("Expected the motion-path fixture channel.");
      mutate(channel);
      return candidate;
    };
    const invalid = [
      mutateChannel((channel) => {
        channel.id = fastManimSnapshotMotionPathChannelIdV2(expected.sceneId, 1);
      }),
      mutateChannel((channel) => {
        channel.parameterization = "arc-length-v1";
      }),
      mutateChannel((channel) => {
        channel.orientToPath = true;
      }),
      mutateChannel((channel) => {
        channel.keyframes[0]!.at = 1;
      }),
      mutateChannel((channel) => {
        channel.keyframes[1]!.value = 0.5;
      }),
      mutateChannel((channel) => {
        channel.path.subpaths[0]!.closed = true;
      }),
      mutateChannel((channel) => {
        channel.path = mapCubicPath(channel.path, ({ y }) => ({ x: 1_000_000_000, y }));
      }),
      (() => {
        const candidate = structuredClone(bundle);
        const entity = candidate.scene.entities[0]!;
        if (entity.geometry.kind !== "cubic-path") throw new Error("Expected cubic path geometry.");
        entity.geometry.path = mapCubicPath(entity.geometry.path, ({ x, y }) => ({ x: x + 0.25, y }));
        return candidate;
      })(),
    ];
    for (const candidate of invalid) {
      await expect(parseProducer(compiled(candidate), expectedV2)).rejects.toThrow();
    }
  });

  it("seals one or two compatible direct path morphs without rewriting base geometry or style", async () => {
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    for (const [shape, entityIndex] of [
      ["one-transform", 0],
      ["two-adjacent-transforms", 0],
      ["two-transforms-with-hold", 0],
      ["one-transform", 2],
    ] as const) {
      const bundle = await dynamicPathMorphBundle(shape, entityIndex);
      const baseEntity = structuredClone(bundle.scene.entities[entityIndex]!);
      const sealed = await parseProducer(compiled(bundle), expectedV2);
      if (sealed.kind !== "compiled") throw new Error("Expected a compiled path-morph V2 snapshot.");

      expect(sealed.bundle.scene.requiredCapabilities).toEqual(["cubic-path-geometry", "path-morph-animation"]);
      expect(sealed.bundle.scene.entities[entityIndex]).toEqual(baseEntity);
      expect(sealed.bundle.scene.animationChannels).toEqual(bundle.scene.animationChannels);
      expect(sealed.bundle.scene.animationChannels[0]).toMatchObject({
        id: fastManimSnapshotPathMorphChannelIdV2(expected.sceneId, entityIndex),
        kind: "path-morph",
        provenanceId: fastManimSnapshotPathMorphChannelProvenanceIdV2(expected.sceneId, entityIndex),
      });
      expect(
        sealed.bundle.scene.provenance.every(
          (record) => record.evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
        ),
      ).toBe(true);
      await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
    }
  });

  it("rejects schema-valid path morph evidence outside the direct Transform profile", async () => {
    const bundle = await dynamicPathMorphBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    type PathMorphChannel = Extract<SceneIrBundleV1["scene"]["animationChannels"][number], { kind: "path-morph" }>;
    const mutateChannel = (mutate: (channel: PathMorphChannel) => void) => {
      const candidate = structuredClone(bundle);
      const channel = candidate.scene.animationChannels[0];
      if (channel?.kind !== "path-morph") throw new Error("Expected the path-morph fixture channel.");
      mutate(channel);
      return candidate;
    };
    const thirdShape = (() => {
      const entity = bundle.scene.entities[0]!;
      if (entity.geometry.kind !== "cubic-path") throw new Error("Expected cubic path geometry.");
      return mapCubicPath(entity.geometry.path, ({ x, y }) => ({ x: x * 0.9 - y * 0.2, y: x * 0.1 + y }));
    })();
    const invalid = [
      mutateChannel((channel) => {
        channel.id = fastManimSnapshotPathMorphChannelIdV2(expected.sceneId, 1);
      }),
      mutateChannel((channel) => {
        channel.provenanceId = bundle.scene.provenance[1]!.id;
      }),
      mutateChannel((channel) => {
        channel.keyframes[0]!.value.subpaths[0]!.start.x += 0.125;
      }),
      mutateChannel((channel) => {
        channel.keyframes[0]!.easingToNext = { kind: "smooth" };
      }),
      mutateChannel((channel) => {
        channel.keyframes[1]!.at = 2.01;
      }),
      mutateChannel((channel) => {
        channel.keyframes[2]!.value = thirdShape;
      }),
      mutateChannel((channel) => {
        channel.keyframes = [
          channel.keyframes[0]!,
          { ...channel.keyframes[0]!, at: 2 },
          { ...channel.keyframes[1]!, at: 3, easingToNext: null },
        ];
      }),
      mutateChannel((channel) => {
        channel.keyframes = [
          channel.keyframes[0]!,
          channel.keyframes[1]!,
          { ...channel.keyframes[2]!, easingToNext: null },
        ];
      }),
    ];
    for (const candidate of invalid) {
      await expect(parseProducer(compiled(candidate), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
    }
  });

  it("rejects incompatible cubic topology and another channel on the morph entity", async () => {
    const bundle = await dynamicPathMorphBundle("one-transform");
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const topologyMismatch = structuredClone(bundle);
    const morph = topologyMismatch.scene.animationChannels[0];
    if (morph?.kind !== "path-morph") throw new Error("Expected the path-morph fixture channel.");
    const targetSegments = morph.keyframes[1]!.value.subpaths[0]!.segments;
    // Models the producer-visible Circle/Rectangle mismatch: eight serialized
    // cubics cannot silently remesh to the base entity's four cubics.
    morph.keyframes[1]!.value.subpaths[0]!.segments = targetSegments.flatMap((segment) => [segment, segment]);
    await expect(parseProducer(compiled(topologyMismatch), expectedV2)).rejects.toThrow(/matching cubic topology/i);

    const affineProvenanceId = fastManimSnapshotAffineTransformChannelProvenanceIdV2(expected.sceneId, 0);
    const combined = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: [
          {
            entityId: bundle.scene.entities[0]!.id,
            id: fastManimSnapshotAffineTransformChannelIdV2(expected.sceneId, 0),
            keyframes: [
              {
                at: 0,
                easingToNext: { kind: "linear" },
                value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
              },
              {
                at: 1,
                easingToNext: null,
                value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 1, ty: 0 },
              },
            ],
            kind: "affine-transform",
            provenanceId: affineProvenanceId,
          },
          bundle.scene.animationChannels[0],
        ],
        provenance: [
          ...bundle.scene.provenance.slice(0, -1),
          {
            evidence: ["producer-authored affine evidence must be normalized"],
            id: affineProvenanceId,
            origin: "fast-manim-server-snapshot",
          },
          bundle.scene.provenance.at(-1),
        ],
        requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "path-morph-animation"],
      },
    });
    await expect(parseProducer(compiled(combined), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects path morphs that collapse between otherwise valid endpoints", async () => {
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    for (const entityIndex of [0, 2]) {
      const bundle = await dynamicPathMorphBundle("one-transform", entityIndex);
      const morph = bundle.scene.animationChannels[0];
      if (morph?.kind !== "path-morph") throw new Error("Expected the path-morph fixture channel.");
      morph.keyframes[1]!.value = mapCubicPath(morph.keyframes[0]!.value, ({ x, y }) => ({ x: -x, y: -y }));
      await expect(parseProducer(compiled(bundle), expectedV2)).rejects.toThrow(/non-degenerate/i);
    }
  });

  it("rejects path morphs that become concave while retaining positive area", async () => {
    type ControlPoint = Readonly<{ x: number; y: number }>;
    const pathFromControlPolygon = (points: readonly [ControlPoint, ControlPoint, ControlPoint, ControlPoint]) => ({
      subpaths: [
        {
          closed: true,
          segments: [{ control1: points[1], control2: points[2], end: points[3] }],
          start: points[0],
        },
      ],
    });
    const bundle = await dynamicPathMorphBundle("one-transform");
    const entity = bundle.scene.entities[0]!;
    const morph = bundle.scene.animationChannels[0];
    if (entity.geometry.kind !== "cubic-path" || morph?.kind !== "path-morph") {
      throw new Error("Expected the path-morph fixture geometry and channel.");
    }
    const start = pathFromControlPolygon([
      { x: -5, y: -2 },
      { x: -4, y: -3 },
      { x: 5, y: -5 },
      { x: 3, y: 4 },
    ]);
    const end = pathFromControlPolygon([
      { x: -5, y: -1 },
      { x: 3, y: 0 },
      { x: 4, y: 1 },
      { x: -4, y: 4 },
    ]);
    entity.geometry.path = start;
    morph.keyframes[0]!.value = start;
    morph.keyframes[1]!.value = end;
    await expect(parseProducer(compiled(bundle), { ...expected, snapshotVersion: 2 })).rejects.toThrow(/convex/i);
  });

  it("seals the four exact producer path-trim shapes without rewriting canonical geometry", async () => {
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    for (const values of [
      [0, 1],
      [1, 0],
      [0, 1, 0],
      [0, 1, 1, 0],
    ] as const) {
      const bundle = await dynamicPathTrimBundle(values);
      const geometry = structuredClone(bundle.scene.entities[0]!.geometry);
      const sealed = await parseProducer(compiled(bundle), expectedV2);
      if (sealed.kind !== "compiled") throw new Error("Expected a compiled path-trim V2 snapshot.");
      expect(sealed.bundle.scene.entities[0]!.geometry).toEqual(geometry);
      expect(sealed.bundle.scene.animationChannels[0]).toMatchObject({
        id: fastManimSnapshotPathTrimChannelIdV2(expected.sceneId, 0),
        kind: "path-trim",
        parameterization: "uniform-cubic-parameter-v1",
        provenanceId: fastManimSnapshotPathTrimChannelProvenanceIdV2(expected.sceneId, 0),
      });
      expect(sealed.bundle.scene.animationChannels[0]!.keyframes.map((keyframe) => keyframe.value)).toEqual(values);
      await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
    }
  });

  it("rejects malformed path-trim evidence and does not globally admit closed stroke-only geometry", async () => {
    const bundle = await dynamicPathTrimBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    type MutablePathTrimCandidate = {
      scene: {
        animationChannels: Array<{
          id: string;
          keyframes: Array<{ at: number; easingToNext: { kind: string } | null; value: number }>;
          parameterization?: string;
        }>;
        entities: Array<{ appearance: { stroke: { cap: string } | null } }>;
        provenance: unknown[];
        requiredCapabilities: string[];
      };
    };
    const mutate = (change: (candidate: MutablePathTrimCandidate) => void) => {
      const candidate = structuredClone(bundle) as unknown as MutablePathTrimCandidate;
      change(candidate);
      return compiled(candidate as unknown as SceneIrBundleV1);
    };
    const invalid = [
      mutate((candidate) => {
        candidate.scene.animationChannels[0].parameterization = "arc-length-v1";
      }),
      mutate((candidate) => {
        delete candidate.scene.animationChannels[0].parameterization;
      }),
      mutate((candidate) => {
        candidate.scene.animationChannels[0].id = fastManimSnapshotPathTrimChannelIdV2(expected.sceneId, 1);
      }),
      mutate((candidate) => {
        candidate.scene.animationChannels[0].keyframes[1].value = 0.5;
      }),
      mutate((candidate) => {
        candidate.scene.animationChannels[0].keyframes[1].at = 2.01;
      }),
      mutate((candidate) => {
        candidate.scene.animationChannels[0].keyframes[0].easingToNext = { kind: "smooth" };
      }),
      mutate((candidate) => {
        candidate.scene.entities[0]!.appearance.stroke!.cap = "round";
      }),
      mutate((candidate) => {
        candidate.scene.requiredCapabilities = ["cubic-path-geometry"];
      }),
      mutate((candidate) => {
        candidate.scene.animationChannels = [];
        candidate.scene.provenance = candidate.scene.provenance.slice(0, 2);
        candidate.scene.requiredCapabilities = ["cubic-path-geometry"];
      }),
    ];
    for (const candidate of invalid) {
      await expect(parseProducer(candidate, expectedV2)).rejects.toThrow();
    }
  });

  it("accepts only producer-reachable opacity/path-trim pairs and orders the next entity's affine", async () => {
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const path = await dynamicPathTrimBundle([0, 1]);
    const pathChannel = path.scene.animationChannels[0]!;
    const pathProvenance = path.scene.provenance[2]!;
    const opacityProvenanceId = fastManimSnapshotOpacityChannelProvenanceIdV2(expected.sceneId, 0);
    const opacityChannel = {
      entityId: path.scene.entities[0]!.id,
      id: fastManimSnapshotOpacityChannelIdV2(expected.sceneId, 0),
      keyframes: [
        { at: 4, easingToNext: { kind: "linear" as const }, value: 1 },
        { at: 6, easingToNext: null, value: 0 },
      ],
      kind: "opacity" as const,
      provenanceId: opacityProvenanceId,
    };
    const opacityAndTrim = sceneIrBundleV1Schema.parse({
      ...path,
      scene: {
        ...path.scene,
        animationChannels: [opacityChannel, pathChannel],
        provenance: [
          ...path.scene.provenance.slice(0, 2),
          {
            evidence: ["producer-authored opacity evidence must be normalized"],
            id: opacityProvenanceId,
            origin: "fast-manim-server-snapshot",
          },
          pathProvenance,
        ],
        requiredCapabilities: ["cubic-path-geometry", "opacity-animation", "path-trim-animation"],
      },
    });
    await expect(parseProducer(compiled(opacityAndTrim), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const pairedCandidate = (
      mutate: (
        opacity: Extract<(typeof opacityAndTrim.scene.animationChannels)[number], { kind: "opacity" }>,
        pathTrim: Extract<(typeof opacityAndTrim.scene.animationChannels)[number], { kind: "path-trim" }>,
      ) => void,
    ) => {
      const candidate = structuredClone(opacityAndTrim);
      const [opacity, pathTrim] = candidate.scene.animationChannels;
      if (opacity?.kind !== "opacity" || pathTrim?.kind !== "path-trim") throw new Error("Expected scalar channels.");
      mutate(opacity, pathTrim);
      return compiled(candidate);
    };
    const fadeInThenUncreate = pairedCandidate((opacity, pathTrim) => {
      opacity.keyframes = [
        { at: 0, easingToNext: { kind: "linear" }, value: 0 },
        { at: 2, easingToNext: null, value: 1 },
      ];
      pathTrim.keyframes = [
        { at: 4, easingToNext: { kind: "linear" }, value: 1 },
        { at: 6, easingToNext: null, value: 0 },
      ];
    });
    await expect(parseProducer(fadeInThenUncreate, expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const unreachablePairs = [
      pairedCandidate((opacity) => {
        opacity.keyframes = [
          { at: 0, easingToNext: { kind: "linear" }, value: 0 },
          { at: 2, easingToNext: null, value: 1 },
        ];
      }),
      pairedCandidate((_, pathTrim) => {
        pathTrim.keyframes = [
          { at: 4, easingToNext: { kind: "linear" }, value: 1 },
          { at: 6, easingToNext: null, value: 0 },
        ];
      }),
      pairedCandidate((opacity) => {
        opacity.keyframes[0]!.at = 1;
      }),
    ];
    for (const unreachable of unreachablePairs) {
      await expect(parseProducer(unreachable, expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
    }

    const base = await importedBundle();
    const secondEntity = { ...base.scene.entities[1]!, lifetimes: [{ end: 6, start: 0 }] };
    const affineProvenanceId = fastManimSnapshotAffineTransformChannelProvenanceIdV2(expected.sceneId, 1);
    const affineChannel = {
      entityId: secondEntity.id,
      id: fastManimSnapshotAffineTransformChannelIdV2(expected.sceneId, 1),
      keyframes: [
        {
          at: 0,
          easingToNext: { kind: "linear" as const },
          value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 },
        },
        {
          at: 1,
          easingToNext: null,
          value: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 1, ty: 0 },
        },
      ],
      kind: "affine-transform" as const,
      provenanceId: affineProvenanceId,
    };
    const trimThenNextEntityAffine = sceneIrBundleV1Schema.parse({
      ...path,
      scene: {
        ...path.scene,
        animationChannels: [pathChannel, affineChannel],
        entities: [path.scene.entities[0], secondEntity],
        provenance: [
          path.scene.provenance[0],
          path.scene.provenance[1],
          base.scene.provenance[2],
          pathProvenance,
          {
            evidence: ["producer-authored affine evidence must be normalized"],
            id: affineProvenanceId,
            origin: "fast-manim-server-snapshot",
          },
        ],
        requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "path-trim-animation"],
      },
    });
    await expect(parseProducer(compiled(trimThenNextEntityAffine), expectedV2)).resolves.toMatchObject({
      kind: "compiled",
    });
  });

  it("rejects schema-valid opacity/lifetime evidence outside the exact producer profile", async () => {
    const bundle = await dynamicOpacityBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const scene = bundle.scene;
    const channel = scene.animationChannels[0]!;
    if (channel.kind !== "opacity") throw new Error("Expected the opacity fixture channel.");
    const mutate = (patch: Partial<typeof scene>) => ({ ...bundle, scene: { ...scene, ...patch } }) as SceneIrBundleV1;
    const mutateChannel = (patch: Partial<typeof channel>) =>
      mutate({ animationChannels: [{ ...channel, ...patch }] } as Partial<typeof scene>);

    await expect(
      parseProducer(
        compiled(mutate({ provenance: [scene.provenance[0]!, scene.provenance[2]!, scene.provenance[1]!] })),
        expectedV2,
      ),
    ).rejects.toMatchObject({
      code: "profile-violation",
      message:
        "Dynamic profile V2 provenance must be exactly the derived scene, per-entity, and per-animation-channel records in order.",
    });

    const profileViolations = [
      mutate({ duration: 6.01 } as Partial<typeof scene>),
      mutate({
        entities: scene.entities.map((entity) => ({ ...entity, lifetimes: [{ end: 6, start: 1.01 }] })),
      } as Partial<typeof scene>),
      mutateChannel({ id: `${expected.sceneId}/channel:opacity:999` }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) => (index === 1 ? { ...keyframe, value: 0.5 } : keyframe)),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 0 ? { ...keyframe, easingToNext: { kind: "smooth" as const } } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) => (index === 1 ? { ...keyframe, at: 3.01 } : keyframe)),
      }),
      mutateChannel({
        keyframes: [
          { at: 1, easingToNext: { kind: "linear" }, value: 0 },
          { at: 2, easingToNext: { kind: "linear" }, value: 1 },
          { at: 3, easingToNext: { kind: "linear" }, value: 0 },
          { at: 4, easingToNext: { kind: "linear" }, value: 1 },
          { at: 6, easingToNext: null, value: 0 },
        ],
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === channel.keyframes.length - 1 ? { ...keyframe, at: 5 } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: [
          { at: 1, easingToNext: { kind: "linear" }, value: 0 },
          { at: 83 / 60, easingToNext: { kind: "linear" }, value: 1 },
          { at: 4, easingToNext: { kind: "linear" }, value: 1 },
          { at: 6, easingToNext: null, value: 0 },
        ],
      }),
    ];
    for (const invalid of profileViolations) {
      await expect(parseProducer(compiled(invalid), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
    }
  });

  it("defaults legacy persisted correlation metadata to profile V1 only", () => {
    const { snapshotVersion: _snapshotVersion, ...legacy } = expected;
    const hermeticMathTexV3Plan = { terminalWait: 2, transforms: [{ factor: 1.5, kind: "scale" as const }] };
    const hermeticMathTexMorphV5Plan = deriveHermeticMathTexMorphV5Plan(
      HERMETIC_MATHTEX_MORPH_SOURCE_V5,
      expected.sceneName,
    );
    const hermeticPngV4Plan = { terminalWait: null, transforms: [] } as const;
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse(legacy).snapshotVersion).toBe(1);
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 3 }).snapshotVersion).toBe(
      3,
    );
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 4 }).snapshotVersion).toBe(
      4,
    );
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 5 }).snapshotVersion).toBe(
      5,
    );
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 6 }).snapshotVersion).toBe(
      6,
    );
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 7 }).snapshotVersion).toBe(
      7,
    );
    expect(
      expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, hermeticPngV4Plan, snapshotVersion: 4 })
        .hermeticPngV4Plan,
    ).toEqual(hermeticPngV4Plan);
    expect(
      expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, hermeticMathTexV3Plan, snapshotVersion: 3 })
        .hermeticMathTexV3Plan,
    ).toEqual(hermeticMathTexV3Plan);
    expect(
      expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, hermeticMathTexV3Plan, snapshotVersion: 7 })
        .hermeticMathTexV3Plan,
    ).toEqual(hermeticMathTexV3Plan);
    expect(
      expectedFastManimSnapshotCorrelationV1Schema.parse({
        ...legacy,
        hermeticMathTexMorphV5Plan,
        snapshotVersion: 5,
      }).hermeticMathTexMorphV5Plan,
    ).toEqual(hermeticMathTexMorphV5Plan);
    for (const snapshotVersion of [1, 2, 3, 5, 6, 7] as const) {
      expect(() =>
        expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, hermeticPngV4Plan, snapshotVersion }),
      ).toThrow(/only for snapshot profile V4/i);
    }
    for (const snapshotVersion of [1, 2, 4, 5, 6] as const) {
      expect(() =>
        expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, hermeticMathTexV3Plan, snapshotVersion }),
      ).toThrow(/only for snapshot profiles V3 and V7/i);
    }
    for (const snapshotVersion of [1, 2, 3, 4, 6, 7] as const) {
      expect(() =>
        expectedFastManimSnapshotCorrelationV1Schema.parse({
          ...legacy,
          hermeticMathTexMorphV5Plan,
          snapshotVersion,
        }),
      ).toThrow(/only for snapshot profile V5/i);
    }
  });

  it("rejects unknown fields and newer envelope versions", async () => {
    const value = compiled(await importedBundle());
    await expect(parseProducer({ ...value, unexpected: true }, expected)).rejects.toThrow();
    await expect(parseProducer({ ...value, version: 2 }, expected)).rejects.toThrow();
    await expect(
      parseProducer({ ...value, sceneName: `S${"x".repeat(240)}` }, { ...expected, sceneName: `S${"x".repeat(240)}` }),
    ).rejects.toThrow();
    await expect(
      parseProducer(
        { ...value, bundle: { ...value.bundle, scene: { ...value.bundle.scene, unexpected: true } } },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      parseProducer(
        {
          ...value,
          bundle: {
            ...value.bundle,
            scene: { ...value.bundle.scene, source: { ...value.bundle.scene.source, snapshotVersion: 5 } },
          },
        },
        expected,
      ),
    ).rejects.toThrow();
  });

  it("rejects bundles above the initial snapshot budget before structural parsing", async () => {
    const value = compiled(await importedBundle());
    await expect(
      parseProducer({ ...value, bundle: "x".repeat(MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES) }, expected),
    ).rejects.toThrow(/encoded bytes/i);
  });

  it("bounds raw producer bytes and structural complexity before Zod parsing", async () => {
    expect(() =>
      parseAndSealFastManimSnapshotProducerJsonV1(" ".repeat(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 1), expected),
    ).toThrowError(expect.objectContaining({ code: "result-too-large" }));
    expect(() => parseAndSealFastManimSnapshotProducerJsonV1(new Uint8Array([0xff]), expected)).toThrowError(
      expect.objectContaining({ code: "result-malformed" }),
    );

    const value = compiled(await importedBundle());
    const amplified = {
      ...value,
      bundle: {
        ...value.bundle,
        scene: {
          ...value.bundle.scene,
          entities: Array<null>(MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS + 1).fill(null),
        },
      },
    };
    await expect(parseProducer(amplified)).rejects.toMatchObject({ code: "result-too-complex" });

    const wideObject = {
      ...value,
      bundle: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field-${index}`, index])),
    };
    await expect(parseProducer(wideObject)).rejects.toMatchObject({ code: "result-too-complex" });
  });

  it("validates the exact JSON wire representation used for byte limits", async () => {
    const wireBundle = await importedBundle();
    const disguisedBundle = structuredClone(wireBundle);
    disguisedBundle.scene.camera.background.red = 0.75;
    Object.defineProperty(disguisedBundle, "toJSON", {
      enumerable: false,
      value: () => wireBundle,
    });

    const sealed = await parseProducer(compiled(disguisedBundle), expected);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    expect(sealed.bundle.scene.camera.background.red).toBe(wireBundle.scene.camera.background.red);
  });

  it("bounds the total encoded unsupported evidence", async () => {
    const issue = {
      code: "geometry-evidence-incomplete",
      evidence: Array<string>(64).fill("x".repeat(500)),
      message: "Complete geometry is unavailable.",
    };
    await expect(
      parseProducer(
        {
          ...wireCorrelation,
          issues: Array<typeof issue>(9).fill(issue),
          kind: "unsupported",
          schema: "poietra.fast-manim-snapshot-result",
          version: 1,
        },
        expected,
      ),
    ).rejects.toThrow(/encoded bytes/i);
  });

  it("rejects stale outer request and source correlation", async () => {
    const value = compiled(await importedBundle());
    for (const stale of [
      { requestId: "snapshot-request-b" },
      { sceneId: fastManimSnapshotSceneIdV1("examples/scene.py", "OtherScene") },
      { sourceHash: "c".repeat(64) },
      { runtimeConfigHash: "d".repeat(64) },
    ]) {
      await expect(parseProducer({ ...value, ...stale }, expected)).rejects.toMatchObject({
        code: "correlation-mismatch",
      });
    }

    await expect(
      parseProducer({ ...value, sourceHash: "c".repeat(64) }, { ...expected, sourceHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "snapshot-source-mismatch" });
  });

  it("rejects non-imported source evidence and missing fast-manim provenance", async () => {
    const bundle = await importedBundle();
    const studioSource = {
      ...bundle,
      scene: {
        ...bundle.scene,
        source: { editProgramVersion: 1 as const, kind: "studio-edit-program" as const, revisionHash: "e".repeat(64) },
      },
    };
    await expect(parseProducer({ ...compiled(bundle), bundle: studioSource }, expected)).rejects.toMatchObject({
      code: "source-kind-mismatch",
    });

    const withoutProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: bundle.scene.provenance.map((record) => ({ ...record, origin: "fixture" as const })),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(withoutProvenance), expected)).rejects.toMatchObject({
      code: "provenance-missing",
    });

    const unreferencedFastProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: [
          ...bundle.scene.provenance.map((record) => ({ ...record, origin: "fixture" as const })),
          { evidence: ["unreferenced"], id: "dummy", origin: "fast-manim-server-snapshot" as const },
        ],
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(unreferencedFastProvenance))).rejects.toMatchObject({
      code: "provenance-missing",
    });
  });

  it("rejects canonical snapshot tampering, malformed bundles, and invalid manifest digests", async () => {
    const bundle = await importedBundle();
    const value = compiled(bundle);
    const sealed = await parseProducer(value);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    const tampered = {
      ...sealed,
      bundle: {
        ...sealed.bundle,
        scene: {
          ...sealed.bundle.scene,
          camera: {
            ...sealed.bundle.scene.camera,
            background: { ...sealed.bundle.scene.camera.background, red: 0.5 },
          },
        },
      },
    };
    await expect(parseVerifiedFastManimSnapshotResultV1(tampered, expected)).rejects.toMatchObject({
      code: "snapshot-digest-mismatch",
    });

    const downgraded = {
      ...tampered,
      bundle: {
        ...tampered.bundle,
        scene: {
          ...tampered.bundle.scene,
          source: { ...tampered.bundle.scene.source, snapshotHash: ZERO_SHA256 },
        },
      },
      snapshotHash: ZERO_SHA256,
    };
    await expect(parseVerifiedFastManimSnapshotResultV1(downgraded, expected)).rejects.toMatchObject({
      code: "snapshot-not-sealed",
    });
    await expect(parseProducer({ ...value, bundle: null }, expected)).rejects.toThrow();

    const manifestDigest = "f".repeat(64);
    const invalidManifest = {
      ...bundle,
      assets: { ...bundle.assets, manifestDigest },
      scene: { ...bundle.scene, assetManifest: { ...bundle.scene.assetManifest, manifestDigest } },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(invalidManifest), expected)).rejects.toThrow(/manifest digest/i);
  });

  it("rejects producer-chosen ID suffixes and unreferenced provenance records", async () => {
    const bundle = await importedBundle();
    // The `stroke` entity (sceneOrder 2) is not referenced by any channel, so
    // its ID is exactly the kind of free string an exfiltrating producer
    // would abuse; the profile requires the exact derived identifier.
    const exfilEntity = {
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: bundle.scene.entities.map((entity) =>
          entity.sceneOrder === 2 ? { ...entity, id: `${expected.sceneId}/ghp_EXFILTRATED_SECRET` } : entity,
        ),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(exfilEntity))).rejects.toMatchObject({ code: "profile-violation" });

    const exfilProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: [
          ...bundle.scene.provenance,
          {
            evidence: ["unreferenced"],
            id: `${expected.sceneId}/ghp_EXFILTRATED_SECRET`,
            origin: "fast-manim-server-snapshot" as const,
          },
        ],
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(exfilProvenance))).rejects.toMatchObject({ code: "profile-violation" });

    const wrongEntityOrder = {
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: bundle.scene.entities.map((entity) =>
          entity.sceneOrder === 2 ? { ...entity, id: `${expected.sceneId}/entity:99` } : entity,
        ),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(wrongEntityOrder))).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects every deviation from the exporter's static v1 Scene shape", async () => {
    const bundle = await importedBundle();
    const scene = bundle.scene;
    const mutate = (patch: Partial<typeof scene>) => ({ ...bundle, scene: { ...scene, ...patch } }) as SceneIrBundleV1;
    const mutateEntity = (index: number, patch: Record<string, unknown>) =>
      mutate({
        entities: scene.entities.map((entity, at) => (at === index ? { ...entity, ...patch } : entity)),
      } as Partial<typeof scene>);
    const line = scene.entities[2]!;
    if (line.geometry.kind !== "cubic-path") throw new Error("Expected the Line cubic fixture.");
    const lineSubpath = line.geometry.path.subpaths[0]!;
    const lineSegment = lineSubpath.segments[0]!;
    const mutateLineSegment = (patch: Partial<typeof lineSegment>) =>
      mutateEntity(2, {
        geometry: {
          ...line.geometry,
          path: {
            subpaths: [{ ...lineSubpath, segments: [{ ...lineSegment, ...patch }] }],
          },
        },
      });

    const profileViolations: SceneIrBundleV1[] = [
      // Not the canonical 1-second static duration.
      mutate({ duration: 2 } as Partial<typeof scene>),
      // Entity lifetime shorter than the full static duration.
      mutateEntity(0, { lifetimes: [{ end: 0.5, start: 0 }] }),
      // Parent references are outside the static profile.
      mutateEntity(1, { parentId: scene.entities[0]!.id }),
      // Non-identity transform.
      mutateEntity(0, { transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 1, ty: 0 } }),
      // Non-unit appearance opacity.
      mutateEntity(0, { appearance: { ...scene.entities[0]!.appearance, opacity: 0.5 } }),
      // Raw primitive geometry instead of the canonical cubic-path lowering.
      mutate({
        entities: scene.entities.map((entity, at) =>
          at === 0 ? { ...entity, geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 1 } } : entity,
        ),
        requiredCapabilities: ["cubic-path-geometry", "shape-primitives"],
      } as Partial<typeof scene>),
      // Any animation channel, even schema-valid with matching capabilities.
      mutate({
        animationChannels: [
          {
            entityId: scene.entities[0]!.id,
            id: `${expected.sceneId}/channel:opacity:0`,
            keyframes: [
              { at: 0, easingToNext: { kind: "linear" }, value: 0 },
              { at: 1, easingToNext: null, value: 1 },
            ],
            kind: "opacity",
            provenanceId: scene.provenance[1]!.id,
          },
        ],
        requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
      } as Partial<typeof scene>),
      // Camera not centered at the origin.
      mutate({
        camera: { ...scene.camera, view: { ...scene.camera.view, center: { x: 1, y: 0 } } },
      } as Partial<typeof scene>),
      // Camera frame differing from the request's runtimeConfig frame.
      mutate({
        camera: { ...scene.camera, view: { ...scene.camera.view, frameWidth: 16 } },
      } as Partial<typeof scene>),
      // Non-canonical fill winding rule.
      mutateEntity(0, {
        appearance: {
          ...scene.entities[0]!.appearance,
          fill: { ...(scene.entities[0]!.appearance as { fill: object }).fill, rule: "evenodd" },
        },
      }),
      // Non-canonical stroke shape on the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, cap: "round" },
        },
      }),
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, miterLimit: 5 },
        },
      }),
      // Only join='miter' is producer-exact for the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, join: "bevel" },
        },
      }),
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, join: "round" },
        },
      }),
      // Collinearity alone is insufficient: the verifier accepts only the
      // exporter's canonical 1/3 and 2/3 Line controls within bounded roundoff.
      mutateLineSegment({ control1: lineSubpath.start, control2: lineSegment.end }),
      // Fully transparent fill: the exporter never emits invisible paint.
      mutateEntity(0, {
        appearance: {
          ...scene.entities[0]!.appearance,
          fill: {
            ...(scene.entities[0]!.appearance as { fill: { color: object } }).fill,
            color: { ...(scene.entities[0]!.appearance as { fill: { color: object } }).fill.color, alpha: 0 },
          },
        },
      }),
      // Fully transparent stroke on the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: {
            ...(scene.entities[2]!.appearance as { stroke: { color: object } }).stroke,
            color: { ...(scene.entities[2]!.appearance as { stroke: { color: object } }).stroke.color, alpha: 0 },
          },
        },
      }),
      // Reordered entities: sceneOrder no longer equals the array index.
      mutate({ entities: [scene.entities[1]!, scene.entities[0]!, scene.entities[2]!] } as Partial<typeof scene>),
      // A gap in the enumerate order (0, 2) with matching derived IDs.
      mutate({
        entities: [
          scene.entities[0]!,
          {
            ...scene.entities[1]!,
            id: `${expected.sceneId}/entity:2`,
            provenanceId: `${expected.sceneId}/provenance:entity:2`,
            sceneOrder: 2,
          },
        ],
        provenance: [
          scene.provenance[0]!,
          scene.provenance[1]!,
          { ...scene.provenance[2]!, id: `${expected.sceneId}/provenance:entity:2` },
        ],
      } as Partial<typeof scene>),
    ];
    for (const [index, deviated] of profileViolations.entries()) {
      await expect(parseProducer(compiled(deviated)), `deviation ${index}`).rejects.toMatchObject({
        code: "profile-violation",
      });
    }

    // Duplicate sceneOrder is rejected before the profile even runs.
    const duplicated = mutate({
      entities: [scene.entities[0]!, { ...scene.entities[1]!, sceneOrder: 0 }],
      provenance: scene.provenance.slice(0, 3),
    } as Partial<typeof scene>);
    await expect(parseProducer(compiled(duplicated))).rejects.toThrow();

    // A non-canonical coordinate space never even reaches the profile: the
    // scene-ir schema pins every coordinateSpace field to a single literal.
    const driftedSpace = {
      ...bundle,
      scene: { ...scene, coordinateSpace: { ...scene.coordinateSpace, cpuPrecision: "f32" } },
    } as unknown as SceneIrBundleV1;
    await expect(parseProducer(compiled(driftedSpace))).rejects.toThrow();
  });

  it("locks the verified run-view arm to compiled snapshots", async () => {
    const sealed = await parseProducer(compiled(await importedBundle()));
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    const runViewBase = {
      projectId: expected.projectId,
      requestId: expected.requestId,
      runtimeConfigHash: expected.runtimeConfigHash,
      sceneName: expected.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: expected.sourcePath,
      version: 1,
    };
    const verifiedView = {
      ...runViewBase,
      publishedAt: new Date().toISOString(),
      revision: 1,
      snapshot: sealed,
      status: "verified",
    };
    expect(fastManimSnapshotRunViewV1Schema.parse(verifiedView)).toMatchObject({ status: "verified" });
    // An unsupported result must never ride a "verified" status, even when it
    // is otherwise well-formed: the wire schema itself refuses it.
    const unsupportedResult = {
      ...wireCorrelation,
      issues: [
        {
          code: "runtime-semantics-unsupported",
          evidence: [],
          message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["runtime-semantics-unsupported"],
        },
      ],
      kind: "unsupported",
      schema: "poietra.fast-manim-snapshot-result",
      version: 1,
    };
    expect(() => fastManimSnapshotRunViewV1Schema.parse({ ...verifiedView, snapshot: unsupportedResult })).toThrow();
  });

  it("rejects hostile producer diagnostics in the unsupported run-view wire schema", () => {
    const runViewBase = {
      fallback: { kind: "server-authoritative-render" },
      projectId: expected.projectId,
      requestId: expected.requestId,
      runtimeConfigHash: expected.runtimeConfigHash,
      sceneName: expected.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: expected.sourcePath,
      status: "unsupported",
      version: 1,
    };
    const normalizedIssue = {
      code: "runtime-semantics-unsupported" as const,
      evidence: [] as string[],
      message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["runtime-semantics-unsupported"],
    };
    expect(fastManimSnapshotRunViewV1Schema.parse({ ...runViewBase, issues: [normalizedIssue] })).toMatchObject({
      status: "unsupported",
    });
    // The wire schema itself — not just runtime normalization — refuses
    // producer strings: free evidence, host paths, runtime object identities,
    // non-owned messages, and unsorted or duplicated codes.
    const hostile = [
      [{ ...normalizedIssue, evidence: ["/home/builder/private.py"] }],
      [{ ...normalizedIssue, runtimeObjectId: "leaked-runtime-object" }],
      [{ ...normalizedIssue, message: "Traceback from /home/builder/private.py with secret-9f8e" }],
      [normalizedIssue, normalizedIssue],
      [
        normalizedIssue,
        {
          code: "geometry-evidence-incomplete" as const,
          evidence: [] as string[],
          message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["geometry-evidence-incomplete"],
        },
      ],
    ];
    for (const issues of hostile) {
      expect(() => fastManimSnapshotRunViewV1Schema.parse({ ...runViewBase, issues })).toThrow();
    }
  });
});
