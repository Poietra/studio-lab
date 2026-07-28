import {
  type AnimationChannelV1,
  type CubicPathV1,
  type EngineAffineTransformV1,
  type SceneEntityV1,
  type SceneIrBundleV1,
  sceneIrBundleV1Schema,
} from "../src/engine/contracts";
import { MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES } from "../src/engine/canvas-worker-protocol";

/**
 * Shared 1920x1080 stress workload generators.
 *
 * The stress benchmark and the stage-telemetry benchmark must measure the
 * exact same 100/1,000 shape-primitive and animated-cubic workloads so their
 * evidence stays comparable across runs and commits.
 */
export const STRESS_VIEWPORT = { heightPx: 1_080, widthPx: 1_920 } as const;

export const STAGE_TELEMETRY_PHASE_NAMES = [
  "browserComposite",
  "bufferCreateAndStage",
  "commandEncodeTotal",
  "drawRecord",
  "evaluate",
  "gpuErrorScopeResolution",
  "gpuExecution",
  "gpuQueueSubmittedWorkDone",
  "postPresentReconfigure",
  "prepare",
  "present",
  "submit",
  "surfaceAcquire",
  "tessellate",
  "vertexIndexEncode",
] as const;

export const STAGE_TELEMETRY_COUNT_NAMES = [
  "bufferCreations",
  "drawCalls",
  "evaluatedDraws",
  "evaluatedEntities",
  "surfaceConfigurations",
  "tessellationCalls",
  "tessellatedIndices",
  "tessellatedVertices",
  "uploadBytes",
] as const;

export type StressDefinition = Readonly<{
  entityCount: 100 | 1_000;
  id: string;
  profile: "animated-cubic-paths" | "shape-primitives";
  revision: string;
}>;

export const STRESS_DEFINITIONS: readonly StressDefinition[] = [
  { entityCount: 100, id: "shape-primitives-100", profile: "shape-primitives", revision: "1".repeat(64) },
  { entityCount: 1_000, id: "shape-primitives-1000", profile: "shape-primitives", revision: "2".repeat(64) },
  { entityCount: 100, id: "animated-cubic-paths-100", profile: "animated-cubic-paths", revision: "3".repeat(64) },
  {
    entityCount: 1_000,
    id: "animated-cubic-paths-1000",
    profile: "animated-cubic-paths",
    revision: "4".repeat(64),
  },
];

export type TimingSummary = Readonly<{
  maximumMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  samplesMs: readonly number[];
}>;

export type ByteLengthSummary = Readonly<{
  maximumBytes: number;
  minimumBytes: number;
  p50Bytes: number;
  p95Bytes: number;
  p99Bytes: number;
  samplesBytes: readonly number[];
}>;

type TimingSignPolicy = "nonnegative" | "signed";

function summarizeTimingWithPolicy(
  samples: readonly number[],
  expectedCount: number,
  signPolicy: TimingSignPolicy,
): TimingSummary {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`expectedCount must be a positive integer, received ${expectedCount}`);
  }
  const signed = signPolicy === "signed";
  if (samples.length !== expectedCount) {
    throw new Error(
      `expected exactly ${expectedCount} ${signed ? "signed" : "timing"} samples, received ${samples.length}`,
    );
  }
  for (const [index, sample] of samples.entries()) {
    if (!Number.isFinite(sample) || (!signed && sample < 0)) {
      throw new Error(`${signed ? "signed" : "timing"} sample ${index} is invalid: ${sample}`);
    }
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    maximumMs: sorted.at(-1)!,
    p50Ms: nearestRank(0.5),
    p95Ms: nearestRank(0.95),
    p99Ms: nearestRank(0.99),
    samplesMs: [...samples],
  };
}

/**
 * Nearest-rank percentiles recomputed from the raw samples.
 *
 * Fails closed instead of summarizing: a missing sample (299 of 300), an
 * empty array, or any negative/NaN/Infinity sample rejects the whole series,
 * so a broken clock or dropped frame can never look like a healthy summary.
 */
export function summarizeTiming(samples: readonly number[], expectedCount: number): TimingSummary {
  return summarizeTimingWithPolicy(samples, expectedCount, "nonnegative");
}

/**
 * Nearest-rank summary for signed series (per-frame attribution residuals may
 * be slightly negative within the clock-quantization tolerance). Finite-ness
 * and exact sample count are still enforced; sign is not clamped.
 */
export function summarizeSignedTiming(samples: readonly number[], expectedCount: number): TimingSummary {
  return summarizeTimingWithPolicy(samples, expectedCount, "signed");
}

/** Exact-count, nearest-rank summary for bounded logical response sizes. */
export function summarizeByteLengths(samples: readonly number[], expectedCount: number): ByteLengthSummary {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error(`expectedCount must be a positive integer, received ${expectedCount}`);
  }
  if (samples.length !== expectedCount) {
    throw new Error(`expected exactly ${expectedCount} byte-length samples, received ${samples.length}`);
  }
  for (const [index, sample] of samples.entries()) {
    if (!Number.isSafeInteger(sample) || sample < 1 || sample > MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES) {
      throw new Error(`logical response byte-length sample ${index} is outside the canvas response budget: ${sample}`);
    }
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    maximumBytes: sorted.at(-1)!,
    minimumBytes: sorted[0]!,
    p50Bytes: nearestRank(0.5),
    p95Bytes: nearestRank(0.95),
    p99Bytes: nearestRank(0.99),
    samplesBytes: [...samples],
  };
}

const IDENTITY: EngineAffineTransformV1 = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 };

function gridPosition(index: number, count: number) {
  const columns = Math.ceil(Math.sqrt((count * 16) / 9));
  const rows = Math.ceil(count / columns);
  const cellWidth = 14.4 / columns;
  const cellHeight = 7.6 / rows;
  return {
    cellHeight,
    cellWidth,
    x: -7.2 + ((index % columns) + 0.5) * cellWidth,
    y: 3.8 - (Math.floor(index / columns) + 0.5) * cellHeight,
  };
}

function color(index: number) {
  return {
    alpha: 1,
    blue: 0.25 + ((index * 17) % 60) / 100,
    green: 0.25 + ((index * 29) % 60) / 100,
    red: 0.25 + ((index * 43) % 60) / 100,
  };
}

function ellipsePath(center: Readonly<{ x: number; y: number }>, radiusX: number, radiusY: number): CubicPathV1 {
  const kappa = 0.552_284_749_830_793_6;
  return {
    subpaths: [
      {
        closed: true,
        segments: [
          {
            control1: { x: center.x + radiusX, y: center.y + kappa * radiusY },
            control2: { x: center.x + kappa * radiusX, y: center.y + radiusY },
            end: { x: center.x, y: center.y + radiusY },
          },
          {
            control1: { x: center.x - kappa * radiusX, y: center.y + radiusY },
            control2: { x: center.x - radiusX, y: center.y + kappa * radiusY },
            end: { x: center.x - radiusX, y: center.y },
          },
          {
            control1: { x: center.x - radiusX, y: center.y - kappa * radiusY },
            control2: { x: center.x - kappa * radiusX, y: center.y - radiusY },
            end: { x: center.x, y: center.y - radiusY },
          },
          {
            control1: { x: center.x + kappa * radiusX, y: center.y - radiusY },
            control2: { x: center.x + radiusX, y: center.y - kappa * radiusY },
            end: { x: center.x + radiusX, y: center.y },
          },
        ],
        start: { x: center.x + radiusX, y: center.y },
      },
    ],
  };
}

function shapeEntity(index: number, count: number): SceneEntityV1 {
  const position = gridPosition(index, count);
  const size = Math.min(position.cellWidth, position.cellHeight);
  const id = `stress:shape:${index}`;
  const common = {
    id,
    lifetimes: [{ end: 4, start: 0 }],
    parentId: null,
    provenanceId: "stress-fixture",
    sceneOrder: index,
    sourceZIndex: index,
    transform: IDENTITY,
  } satisfies Partial<SceneEntityV1>;
  if (index % 3 === 2) {
    return {
      ...common,
      appearance: {
        fill: null,
        kind: "vector",
        opacity: 0.9,
        stroke: {
          cap: "round",
          color: color(index),
          join: "miter",
          miterLimit: 4,
          widthWorld: Math.max(0.01, size * 0.12),
        },
      },
      geometry: {
        end: { x: position.x + position.cellWidth * 0.3, y: position.y + position.cellHeight * 0.2 },
        kind: "line",
        start: { x: position.x - position.cellWidth * 0.3, y: position.y - position.cellHeight * 0.2 },
      },
    };
  }
  return {
    ...common,
    appearance: { fill: { color: color(index), rule: "nonzero" }, kind: "vector", opacity: 0.9, stroke: null },
    geometry:
      index % 3 === 0
        ? { center: { x: position.x, y: position.y }, kind: "circle", radius: size * 0.28 }
        : {
            center: { x: position.x, y: position.y },
            cornerRadius: size * 0.08,
            height: position.cellHeight * 0.55,
            kind: "rectangle",
            width: position.cellWidth * 0.55,
          },
  };
}

function animatedCubicEntity(index: number, count: number): SceneEntityV1 {
  const position = gridPosition(index, count);
  const radiusX = position.cellWidth * 0.28;
  const radiusY = position.cellHeight * 0.28;
  return {
    appearance: { fill: { color: color(index), rule: "nonzero" }, kind: "vector", opacity: 0.9, stroke: null },
    geometry: { kind: "cubic-path", path: ellipsePath(position, radiusX, radiusY) },
    id: `stress:cubic:${index}`,
    lifetimes: [{ end: 4, start: 0 }],
    parentId: null,
    provenanceId: "stress-fixture",
    sceneOrder: index,
    sourceZIndex: index,
    transform: IDENTITY,
  };
}

function animatedChannel(index: number, count: number): AnimationChannelV1 {
  const entityId = `stress:cubic:${index}`;
  const position = gridPosition(index, count);
  if (index % 2 === 0) {
    return {
      entityId,
      id: `stress:affine:${index}`,
      keyframes: [
        {
          at: 0,
          easingToNext: { kind: "cubic-bezier", x1: 0.42, x2: 0.58, y1: 0, y2: 1 },
          value: IDENTITY,
        },
        {
          at: 4,
          easingToNext: null,
          value: { ...IDENTITY, tx: (index % 4 === 0 ? 1 : -1) * position.cellWidth * 0.3 },
        },
      ],
      kind: "affine-transform",
      provenanceId: "stress-fixture",
    };
  }
  const radiusX = position.cellWidth * 0.28;
  const radiusY = position.cellHeight * 0.28;
  return {
    entityId,
    id: `stress:morph:${index}`,
    keyframes: [
      {
        at: 0,
        easingToNext: { kind: "cubic-bezier", x1: 0.25, x2: 0.75, y1: 0.1, y2: 1 },
        value: ellipsePath(position, radiusX, radiusY),
      },
      {
        at: 4,
        easingToNext: null,
        value: ellipsePath(position, radiusX * 0.72, radiusY * 1.18),
      },
    ],
    kind: "path-morph",
    provenanceId: "stress-fixture",
  };
}

export function stressBundle(base: SceneIrBundleV1, definition: StressDefinition) {
  const animated = definition.profile === "animated-cubic-paths";
  const entities = Array.from({ length: definition.entityCount }, (_, index) =>
    animated ? animatedCubicEntity(index, definition.entityCount) : shapeEntity(index, definition.entityCount),
  );
  const animationChannels: AnimationChannelV1[] = animated
    ? [
        ...Array.from({ length: definition.entityCount }, (_, index) => animatedChannel(index, definition.entityCount)),
        {
          id: "stress:camera",
          keyframes: [
            {
              at: 0,
              easingToNext: { kind: "smooth" },
              value: { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 },
            },
            {
              at: 4,
              easingToNext: null,
              value: { center: { x: 0.3, y: -0.2 }, frameHeight: 8.1, frameWidth: 14.4 },
            },
          ],
          kind: "camera",
          provenanceId: "stress-fixture",
        },
      ]
    : [];
  return sceneIrBundleV1Schema.parse({
    assets: base.assets,
    scene: {
      ...base.scene,
      animationChannels,
      duration: 4,
      entities,
      provenance: [
        {
          evidence: [`Generated ${definition.id} WebGPU stress workload`],
          id: "stress-fixture",
          origin: "fixture",
        },
      ],
      requiredCapabilities: animated
        ? ["affine-transform-animation", "camera-animation", "cubic-path-geometry", "path-morph-animation"]
        : ["shape-primitives"],
      sceneId: `stress:${definition.id}`,
      source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: definition.revision },
    },
  });
}

export type PageAdapterHint =
  | Readonly<{ architecture: string; description: string; device: string; kind: "available"; vendor: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * Runs IN THE PAGE via page.evaluate, exactly once, AFTER every measured
 * workload has completed: a page-level requestAdapter call creates its own
 * adapter, and issuing one mid-run would contaminate the later workloads.
 */
export async function collectPageAdapterHintOnce(): Promise<PageAdapterHint> {
  const gpu = (
    navigator as unknown as {
      gpu?: {
        requestAdapter: () => Promise<Readonly<{
          info: Readonly<{ architecture?: string; description?: string; device?: string; vendor?: string }>;
        }> | null>;
      };
    }
  ).gpu;
  if (!gpu) return { kind: "unavailable", reason: "navigator.gpu is undefined in this page" };
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? {
          architecture: adapter.info.architecture ?? "unreported",
          description: adapter.info.description ?? "unreported",
          device: adapter.info.device ?? "unreported",
          kind: "available",
          vendor: adapter.info.vendor ?? "unreported",
        }
      : { kind: "unavailable", reason: "navigator.gpu.requestAdapter() returned null" };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `navigator.gpu.requestAdapter() rejected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
