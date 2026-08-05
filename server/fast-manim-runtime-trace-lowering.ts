import { createHash } from "node:crypto";

import {
  assetManifestV1Schema,
  countCubicPathSegments,
  digestAssetManifestV1,
  parseVerifiedSceneIrBundleV1,
  type SceneEntityV1,
  type SceneIrBundleV1,
  sceneIrV1Schema,
} from "../src/engine/contracts";
import { applyEngineEasingV1 } from "../src/engine/easing";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceV1,
  expectedFastManimRuntimeTraceCorrelationFromRequestV1,
  FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  type FastManimRuntimeTraceProducerRequestV1,
  type FastManimRuntimeTraceV1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_LIFETIME_RUNS_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V1,
  parseFastManimRuntimeTraceProducerJsonV1,
  type TrustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-contract";

const ZERO_SHA256 = "0".repeat(64);
const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
const EXPECTED_CAMERA = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 14.222222222222221,
} as const;
const OFFICIAL_RUNTIME_CONFIG_HASH = "9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97";
const OFFICIAL_SCENE_ID = "scene:89e99799b8a4df781a0ee4dca3b92211b28cdfb690324a33df5917a457842128";
const OFFICIAL_SOURCE_HASH = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";

type RuntimeTraceDrawV1 = FastManimRuntimeTraceV1["frames"][number]["draws"][number];

export type FastManimRuntimeTraceLoweringErrorCodeV1 = "normalization-budget" | "semantic-mismatch";

export class FastManimRuntimeTraceLoweringError extends Error {
  readonly code: FastManimRuntimeTraceLoweringErrorCodeV1;

  constructor(code: FastManimRuntimeTraceLoweringErrorCodeV1, message: string) {
    super(message);
    this.name = "FastManimRuntimeTraceLoweringError";
    this.code = code;
  }
}

function failSemantic(message: string): never {
  throw new FastManimRuntimeTraceLoweringError("semantic-mismatch", message);
}

function expectedMotionY(frameIndex: number) {
  if (frameIndex > 300) return 2.5;
  const firstHalf = frameIndex <= 150;
  const progress = firstHalf ? frameIndex / 150 : (frameIndex - 150) / 150;
  const eased = applyEngineEasingV1({ kind: "manim-smooth" }, progress);
  return canonicalFastManimRuntimeTraceCoordinateV1(firstHalf ? 2.5 - 5 * eased : -2.5 + 5 * eased);
}

function assertExactOfficialMotion(trace: FastManimRuntimeTraceV1) {
  if (
    trace.sourcePath !== "example_scenes/basic.py" ||
    trace.sourceHash !== OFFICIAL_SOURCE_HASH ||
    trace.sceneName !== "UpdatersExample" ||
    trace.sceneId !== OFFICIAL_SCENE_ID ||
    trace.sceneOccurrence.constructStartLine !== 113 ||
    trace.sceneOccurrence.definitionOrdinal !== 5 ||
    trace.runtimeConfigHash !== OFFICIAL_RUNTIME_CONFIG_HASH
  ) {
    failSemantic("Runtime Trace lowering accepts only the exact official UpdatersExample source occurrence.");
  }
  if (canonicalJsonV1(trace.camera) !== canonicalJsonV1(EXPECTED_CAMERA)) {
    failSemantic("Runtime Trace lowering requires the official default Cairo camera.");
  }
  trace.frames.forEach((frame, frameIndex) => {
    if (frame.motionY !== expectedMotionY(frameIndex)) {
      failSemantic(`Runtime Trace frame ${frameIndex} does not follow the exact there_and_back Square motion.`);
    }
  });
}

function frameRuns(frameIndexes: readonly number[]) {
  const runs: Array<Readonly<{ endFrame: number; startFrame: number }>> = [];
  let startFrame = frameIndexes[0];
  let previousFrame = frameIndexes[0];
  if (startFrame === undefined || previousFrame === undefined) return runs;
  for (const frameIndex of frameIndexes.slice(1)) {
    if (frameIndex !== previousFrame + 1) {
      runs.push({ endFrame: previousFrame, startFrame });
      startFrame = frameIndex;
    }
    previousFrame = frameIndex;
  }
  runs.push({ endFrame: previousFrame, startFrame });
  return runs;
}

function lifetime(run: Readonly<{ endFrame: number; startFrame: number }>) {
  return {
    end: (run.endFrame + 1) / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
    start: run.startFrame / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  };
}

function groupEntity(
  id: string,
  parentId: string | null,
  sceneOrder: number,
  provenanceId: string,
  offset = { x: 0, y: 0 },
): SceneEntityV1 {
  return {
    appearance: { kind: "group", opacity: 1 },
    geometry: { kind: "group" },
    id,
    lifetimes: [{ end: 6, start: 0 }],
    parentId,
    provenanceId,
    sceneOrder,
    sourceZIndex: 0,
    transform: { ...IDENTITY, tx: offset.x, ty: offset.y },
  };
}

function stateIdentifier(trace: FastManimRuntimeTraceV1, drawIndex: number, stateKey: string, part: number) {
  const digest = createHash("sha256").update(stateKey, "utf8").digest("hex");
  return `${trace.sceneId}/runtime-trace:draw:${drawIndex}:state:${digest}:part:${part}`;
}

type RuntimeTraceStatePlanV1 = Readonly<{
  appearance: FastManimRuntimeTraceV1["resources"]["appearances"][number];
  draw: RuntimeTraceDrawV1;
  drawIndex: number;
  path: FastManimRuntimeTraceV1["resources"]["paths"][number]["path"];
  runs: readonly Readonly<{ endFrame: number; startFrame: number }>[];
  stateKey: string;
}>;

function collectStatePlans(trace: FastManimRuntimeTraceV1) {
  const paths = new Map(trace.resources.paths.map((resource) => [resource.id, resource.path]));
  const appearances = new Map(trace.resources.appearances.map((resource) => [resource.id, resource]));
  const states = Array.from(
    { length: FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1 },
    () => new Map<string, { draw: RuntimeTraceDrawV1; frames: number[] }>(),
  );
  trace.frames.forEach((frame) => {
    frame.draws.forEach((draw, drawIndex) => {
      const key = canonicalJsonV1(draw);
      const state = states[drawIndex].get(key);
      if (state) state.frames.push(frame.frameIndex);
      else states[drawIndex].set(key, { draw, frames: [frame.frameIndex] });
    });
  });

  const plans: RuntimeTraceStatePlanV1[] = [];
  states.forEach((drawStates, drawIndex) => {
    for (const [stateKey, state] of drawStates) {
      const path = paths.get(state.draw.pathId);
      const appearance = appearances.get(state.draw.appearanceId);
      if (!path || !appearance) failSemantic("Runtime Trace resources changed after contract verification.");
      plans.push({ appearance, draw: state.draw, drawIndex, path, runs: frameRuns(state.frames), stateKey });
    }
  });
  return plans;
}

function stateEntity(
  trace: FastManimRuntimeTraceV1,
  plan: RuntimeTraceStatePlanV1,
  part: number,
  provenanceId: string,
  sceneOrder: number,
): SceneEntityV1 {
  const offset = part * 64;
  return {
    appearance: {
      fill: plan.appearance.fill,
      kind: "vector",
      opacity: plan.draw.opacity,
      stroke: plan.appearance.stroke,
    },
    geometry: { kind: "cubic-path", path: plan.path },
    id: stateIdentifier(trace, plan.drawIndex, plan.stateKey, part),
    lifetimes: plan.runs.slice(offset, offset + 64).map(lifetime),
    parentId: plan.draw.rootId,
    provenanceId,
    sceneOrder,
    sourceZIndex: 0,
    transform: { ...IDENTITY, tx: plan.draw.localPosition.x, ty: plan.draw.localPosition.y },
  };
}

function collectStateEntities(
  trace: FastManimRuntimeTraceV1,
  plans: readonly RuntimeTraceStatePlanV1[],
  provenanceId: string,
  firstSceneOrder: number,
) {
  const entities: SceneEntityV1[] = [];
  let sceneOrder = firstSceneOrder;
  for (const plan of plans) {
    const parts = Math.ceil(plan.runs.length / 64);
    for (let part = 0; part < parts; part += 1) {
      entities.push(stateEntity(trace, plan, part, provenanceId, sceneOrder));
      sceneOrder += 1;
    }
  }
  return entities;
}

type RuntimeTraceNormalizationMetricsV1 = Readonly<{
  entities: number;
  jsonBytes: number;
  lifetimeRuns: number;
  pathSegments: number;
}>;

function failNormalizationBudget(metrics: RuntimeTraceNormalizationMetricsV1): never {
  throw new FastManimRuntimeTraceLoweringError(
    "normalization-budget",
    `Runtime Trace normalization exceeds its measured budget (${metrics.entities} entities, ${metrics.lifetimeRuns} runs, ${metrics.pathSegments} segments, ${metrics.jsonBytes} bytes).`,
  );
}

function normalizationIsOverBudget(metrics: RuntimeTraceNormalizationMetricsV1) {
  return (
    metrics.entities > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V1 ||
    metrics.lifetimeRuns > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_LIFETIME_RUNS_V1 ||
    metrics.pathSegments > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V1 ||
    metrics.jsonBytes > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1
  );
}

/**
 * Proves the expansion budget before Zod clones shared path geometry into the
 * normalized Scene. Entity/run/segment counts are checked before even the
 * streaming JSON-size pass, so a large path cannot be multiplied by thousands
 * of visual states in memory.
 */
function assertNormalizationPreflight(
  trace: FastManimRuntimeTraceV1,
  bundleWithoutEntities: unknown,
  groups: readonly SceneEntityV1[],
  plans: readonly RuntimeTraceStatePlanV1[],
  provenanceId: string,
) {
  const stateEntities = plans.reduce((total, plan) => total + Math.ceil(plan.runs.length / 64), 0);
  const metrics = {
    entities: groups.length + stateEntities,
    jsonBytes: 0,
    lifetimeRuns: groups.length + plans.reduce((total, plan) => total + plan.runs.length, 0),
    pathSegments: plans.reduce(
      (total, plan) => total + Math.ceil(plan.runs.length / 64) * countCubicPathSegments(plan.path),
      0,
    ),
  };
  if (normalizationIsOverBudget(metrics)) failNormalizationBudget(metrics);

  let jsonBytes = Buffer.byteLength(canonicalJsonV1(bundleWithoutEntities), "utf8");
  let sceneOrder = groups.length;
  let serializedEntities = 0;
  for (const entity of groups) {
    jsonBytes += Buffer.byteLength(canonicalJsonV1(entity), "utf8");
    serializedEntities += 1;
  }
  for (const plan of plans) {
    const parts = Math.ceil(plan.runs.length / 64);
    for (let part = 0; part < parts; part += 1) {
      jsonBytes += Buffer.byteLength(canonicalJsonV1(stateEntity(trace, plan, part, provenanceId, sceneOrder)), "utf8");
      serializedEntities += 1;
      sceneOrder += 1;
    }
  }
  // `bundleWithoutEntities` already contains `[]`; replacing it with a
  // populated array adds entity bytes and only the inter-entity commas.
  jsonBytes += Math.max(0, serializedEntities - 1);
  const completed = { ...metrics, jsonBytes };
  if (normalizationIsOverBudget(completed)) failNormalizationBudget(completed);
  return completed;
}

function normalizationMetrics(bundle: SceneIrBundleV1): RuntimeTraceNormalizationMetricsV1 {
  return {
    entities: bundle.scene.entities.length,
    lifetimeRuns: bundle.scene.entities.reduce((total, entity) => total + entity.lifetimes.length, 0),
    pathSegments: bundle.scene.entities.reduce(
      (total, entity) =>
        total + (entity.geometry.kind === "cubic-path" ? countCubicPathSegments(entity.geometry.path) : 0),
      0,
    ),
    jsonBytes: Buffer.byteLength(canonicalJsonV1(bundle), "utf8"),
  };
}

function assertNormalizationBudgets(bundle: SceneIrBundleV1) {
  const metrics = normalizationMetrics(bundle);
  if (normalizationIsOverBudget(metrics)) failNormalizationBudget(metrics);
  return metrics;
}

async function emptyRuntimeTraceManifest(trace: FastManimRuntimeTraceV1) {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId: `${trace.sceneId}/runtime-trace:manifest`,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

function runtimeTraceSceneDraft(
  trace: FastManimRuntimeTraceV1,
  assets: SceneIrBundleV1["assets"],
  traceDigest: string,
  provenanceId: string,
  motionRootId: string,
  entities: readonly SceneEntityV1[],
) {
  return {
    animationChannels: [
      {
        entityId: motionRootId,
        id: `${trace.sceneId}/channel:runtime-trace-motion-y`,
        keyframes: [
          { at: 0, easingToNext: { kind: "manim-smooth" as const }, value: { ...IDENTITY, ty: 2.5 } },
          { at: 2.5, easingToNext: { kind: "manim-smooth" as const }, value: { ...IDENTITY, ty: -2.5 } },
          { at: 5, easingToNext: null, value: { ...IDENTITY, ty: 2.5 } },
        ],
        kind: "affine-transform" as const,
        provenanceId,
      },
    ],
    assetManifest: { manifestDigest: assets.manifestDigest, manifestId: assets.manifestId },
    camera: {
      background: trace.camera.background,
      view: {
        center: trace.camera.center,
        frameHeight: trace.camera.frameHeight,
        frameWidth: trace.camera.frameWidth,
      },
    },
    coordinateSpace: {
      cpuPrecision: "f64" as const,
      kind: "cartesian-2d" as const,
      origin: "center" as const,
      unit: "scene-unit" as const,
      xAxis: "right" as const,
      yAxis: "up" as const,
    },
    duration: 6,
    entities,
    fidelity: { kind: "exact" as const },
    provenance: [
      {
        evidence: [
          "fast-manim Runtime Trace V1, preview authority only",
          `trace digest ${traceDigest}`,
          `post-updater 60 fps evidence from ${trace.producer.fastManimCommit}`,
          `source roots ${trace.roots.map((root) => root.binding.id).join(", ")}`,
        ],
        id: provenanceId,
        origin: "fast-manim-runtime-trace",
      },
    ],
    requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group"] as const,
    sceneId: trace.sceneId,
    schema: "poietra.scene-ir" as const,
    source: {
      kind: "imported-manim-runtime-trace" as const,
      runtimeConfigHash: trace.runtimeConfigHash,
      sourceHash: trace.sourceHash,
      traceDigest,
      traceVersion: 1 as const,
    },
    version: 1 as const,
  };
}

async function lowerParsedRuntimeTrace(trace: FastManimRuntimeTraceV1) {
  assertExactOfficialMotion(trace);
  const traceDigest = digestFastManimRuntimeTraceV1(trace);
  const provenanceId = `${trace.sceneId}/provenance:runtime-trace`;
  const motionRootId = `${trace.sceneId}/runtime-trace:motion-root`;
  const assets = await emptyRuntimeTraceManifest(trace);
  const groups = [
    groupEntity(motionRootId, null, 0, provenanceId),
    ...trace.roots.map((root, index) => groupEntity(root.id, motionRootId, index + 1, provenanceId, root.offset)),
  ];
  const plans = collectStatePlans(trace);
  const sceneWithoutEntities = runtimeTraceSceneDraft(trace, assets, traceDigest, provenanceId, motionRootId, []);
  const projectedMetrics = assertNormalizationPreflight(
    trace,
    { assets, scene: sceneWithoutEntities },
    groups,
    plans,
    provenanceId,
  );
  const entities = [...groups, ...collectStateEntities(trace, plans, provenanceId, groups.length)];
  const scene = sceneIrV1Schema.parse(
    runtimeTraceSceneDraft(trace, assets, traceDigest, provenanceId, motionRootId, entities),
  );
  const bundle = { assets, scene };
  const measuredMetrics = assertNormalizationBudgets(bundle);
  if (canonicalJsonV1(projectedMetrics) !== canonicalJsonV1(measuredMetrics)) {
    failSemantic("Runtime Trace normalization changed after its bounded preflight.");
  }
  return parseVerifiedSceneIrBundleV1(bundle);
}

/** Verifies producer bytes and correlation before creating display-only Scene IR. */
export async function lowerFastManimRuntimeTraceProducerJsonV1(
  value: string | Uint8Array,
  request: FastManimRuntimeTraceProducerRequestV1,
  trusted: TrustedFastManimRuntimeTraceProducerV1,
) {
  const expected = expectedFastManimRuntimeTraceCorrelationFromRequestV1(request, trusted);
  return lowerParsedRuntimeTrace(parseFastManimRuntimeTraceProducerJsonV1(value, expected));
}
