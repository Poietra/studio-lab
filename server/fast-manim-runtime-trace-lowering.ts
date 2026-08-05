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
  type ExpectedFastManimRuntimeTraceCorrelationV1,
  FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V1,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V1,
  type FastManimRuntimeTraceV1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_LIFETIME_RUNS_V1,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V1,
  parseFastManimRuntimeTraceProducerJsonV1,
} from "./fast-manim-runtime-trace-contract";

const ZERO_SHA256 = "0".repeat(64);
const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
const EXPECTED_CAMERA = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 14.222222222222221,
} as const;

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

function collectStateEntities(trace: FastManimRuntimeTraceV1, provenanceId: string, firstSceneOrder: number) {
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

  const entities: SceneEntityV1[] = [];
  let sceneOrder = firstSceneOrder;
  states.forEach((drawStates, drawIndex) => {
    for (const [stateKey, state] of drawStates) {
      const path = paths.get(state.draw.pathId);
      const appearance = appearances.get(state.draw.appearanceId);
      if (!path || !appearance) failSemantic("Runtime Trace resources changed after contract verification.");
      const runs = frameRuns(state.frames);
      for (let offset = 0; offset < runs.length; offset += 64) {
        const part = offset / 64;
        entities.push({
          appearance: {
            fill: appearance.fill,
            kind: "vector",
            opacity: state.draw.opacity,
            stroke: appearance.stroke,
          },
          geometry: { kind: "cubic-path", path },
          id: stateIdentifier(trace, drawIndex, stateKey, part),
          lifetimes: runs.slice(offset, offset + 64).map(lifetime),
          parentId: state.draw.rootId,
          provenanceId,
          sceneOrder,
          sourceZIndex: 0,
          transform: { ...IDENTITY, tx: state.draw.localPosition.x, ty: state.draw.localPosition.y },
        });
        sceneOrder += 1;
      }
    }
  });
  return entities;
}

function assertNormalizationBudgets(bundle: SceneIrBundleV1) {
  const entities = bundle.scene.entities.length;
  const lifetimeRuns = bundle.scene.entities.reduce((total, entity) => total + entity.lifetimes.length, 0);
  const pathSegments = bundle.scene.entities.reduce(
    (total, entity) =>
      total + (entity.geometry.kind === "cubic-path" ? countCubicPathSegments(entity.geometry.path) : 0),
    0,
  );
  const jsonBytes = Buffer.byteLength(canonicalJsonV1(bundle), "utf8");
  if (
    entities > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_ENTITIES_V1 ||
    lifetimeRuns > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_LIFETIME_RUNS_V1 ||
    pathSegments > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_PATH_SEGMENTS_V1 ||
    jsonBytes > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V1
  ) {
    throw new FastManimRuntimeTraceLoweringError(
      "normalization-budget",
      `Runtime Trace normalization exceeds its measured budget (${entities} entities, ${lifetimeRuns} runs, ${pathSegments} segments, ${jsonBytes} bytes).`,
    );
  }
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
  const entities = [...groups, ...collectStateEntities(trace, provenanceId, groups.length)];
  const scene = sceneIrV1Schema.parse({
    animationChannels: [
      {
        entityId: motionRootId,
        id: `${trace.sceneId}/channel:runtime-trace-motion-y`,
        keyframes: [
          { at: 0, easingToNext: { kind: "manim-smooth" }, value: { ...IDENTITY, ty: 2.5 } },
          { at: 2.5, easingToNext: { kind: "manim-smooth" }, value: { ...IDENTITY, ty: -2.5 } },
          { at: 5, easingToNext: null, value: { ...IDENTITY, ty: 2.5 } },
        ],
        kind: "affine-transform",
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
      cpuPrecision: "f64",
      kind: "cartesian-2d",
      origin: "center",
      unit: "scene-unit",
      xAxis: "right",
      yAxis: "up",
    },
    duration: 6,
    entities,
    fidelity: { kind: "exact" },
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
    requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group"],
    sceneId: trace.sceneId,
    schema: "poietra.scene-ir",
    source: {
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: trace.runtimeConfigHash,
      sourceHash: trace.sourceHash,
      traceDigest,
      traceVersion: 1,
    },
    version: 1,
  });
  const bundle = { assets, scene };
  assertNormalizationBudgets(bundle);
  return parseVerifiedSceneIrBundleV1(bundle);
}

/** Verifies producer bytes and correlation before creating display-only Scene IR. */
export async function lowerFastManimRuntimeTraceProducerJsonV1(
  value: string | Uint8Array,
  expected: ExpectedFastManimRuntimeTraceCorrelationV1,
) {
  return lowerParsedRuntimeTrace(parseFastManimRuntimeTraceProducerJsonV1(value, expected));
}
