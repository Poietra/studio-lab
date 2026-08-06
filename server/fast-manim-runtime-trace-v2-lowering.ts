import { createHash } from "node:crypto";

import {
  assetManifestV1Schema,
  digestAssetManifestV1,
  parseVerifiedSceneIrBundleV1,
  type SceneEntityV1,
  type SceneIrBundleV1,
  type SceneIrV1,
  sceneIrV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2,
  FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
  type FastManimRuntimeTraceProducerRequestV2,
} from "./fast-manim-runtime-trace-v2-contract";
import {
  expectedFastManimRuntimeTraceCorrelationFromRequestV2,
  FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2,
  FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2,
  type FastManimRuntimeTraceV2,
  MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2,
  MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2,
  parseFastManimRuntimeTraceProducerJsonV2,
  type TrustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-result-contract";

const ZERO_SHA256 = "0".repeat(64);
const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;

type CubicPathV2 = Extract<SceneEntityV1["geometry"], { kind: "cubic-path" }>["path"];
type VectorAppearanceV2 = Pick<Extract<SceneEntityV1["appearance"], { kind: "vector" }>, "fill" | "stroke">;
type AnimationChannelV2 = SceneIrV1["animationChannels"][number];

type RuntimeTraceDrawV2 = FastManimRuntimeTraceV2["frames"][number]["draws"][number];

export type VerifiedFastManimRuntimeTraceV2 = FastManimRuntimeTraceV2;

export type FastManimRuntimeTraceV2LoweringErrorCode = "semantic-mismatch";

export class FastManimRuntimeTraceV2LoweringError extends Error {
  readonly code: FastManimRuntimeTraceV2LoweringErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "FastManimRuntimeTraceV2LoweringError";
    this.code = "semantic-mismatch";
  }
}

function failSemantic(message: string): never {
  throw new FastManimRuntimeTraceV2LoweringError(message);
}

function sameValue(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
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

function lifetimes(frameIndexes: readonly number[]) {
  return frameRuns(frameIndexes).map((run) => ({
    end: (run.endFrame + 1) / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
    start: run.startFrame / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
  }));
}

function groupEntity(id: string, parentId: string | null, sceneOrder: number, provenanceId: string): SceneEntityV1 {
  return {
    appearance: { kind: "group", opacity: 1 },
    geometry: { kind: "group" },
    id,
    lifetimes: [{ end: FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2, start: 0 }],
    parentId,
    provenanceId,
    sceneOrder,
    sourceZIndex: 0,
    transform: IDENTITY,
  };
}

function keyframes<T>(values: readonly T[], frameIndexes: readonly number[]) {
  if (values.length !== frameIndexes.length)
    failSemantic("Runtime Trace V2 channel samples lost their frame identity.");
  return values.map((value, index) => ({
    at: frameIndexes[index]! / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2,
    easingToNext: index === values.length - 1 ? null : ({ kind: "linear" } as const),
    value,
  }));
}

function valuesChange<T>(values: readonly T[]) {
  const first = values[0];
  return first !== undefined && values.slice(1).some((value) => !sameValue(first, value));
}

function pathTopology(path: CubicPathV2) {
  return path.subpaths.map((subpath) => `${subpath.closed ? 1 : 0}:${subpath.segments.length}`).join("|");
}

type DrawTopologyRun = Readonly<{
  draws: readonly RuntimeTraceDrawV2[];
  frameIndexes: readonly number[];
  paths: readonly CubicPathV2[];
  topology: string;
}>;

function drawTopologyRuns(draws: readonly RuntimeTraceDrawV2[], paths: ReadonlyMap<string, CubicPathV2>) {
  const mutableRuns: Array<{
    draws: RuntimeTraceDrawV2[];
    frameIndexes: number[];
    paths: CubicPathV2[];
    topology: string;
  }> = [];
  draws.forEach((draw, frameIndex) => {
    if (!draw.present) return;
    const path = paths.get(draw.pathId);
    if (!path) failSemantic(`Runtime Trace V2 draw ${draw.drawId} references a missing path.`);
    const topology = pathTopology(path);
    let run = mutableRuns.at(-1);
    if (!run || run.topology !== topology || run.frameIndexes.at(-1) !== frameIndex - 1) {
      run = { draws: [], frameIndexes: [], paths: [], topology };
      mutableRuns.push(run);
    }
    run.draws.push(draw);
    run.frameIndexes.push(frameIndex);
    run.paths.push(path);
  });
  return mutableRuns as readonly DrawTopologyRun[];
}

function compactPathSamples(paths: readonly CubicPathV2[], frameIndexes: readonly number[]) {
  const keep = paths.map((path, index) => {
    if (index === 0 || index === paths.length - 1) return true;
    return !sameValue(path, paths[index - 1]) || !sameValue(path, paths[index + 1]);
  });
  return {
    frameIndexes: frameIndexes.filter((_, index) => keep[index]),
    paths: paths.filter((_, index) => keep[index]),
  };
}

function traceDigest(trace: VerifiedFastManimRuntimeTraceV2) {
  return createHash("sha256").update(canonicalJsonV1(trace), "utf8").digest("hex");
}

function assertStableDrawIdentity(trace: VerifiedFastManimRuntimeTraceV2) {
  if (
    trace.durationSeconds !== FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2 ||
    trace.frames.length !== FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2
  ) {
    failSemantic("Runtime Trace V2 lowering requires its complete five-second presentation grid.");
  }
  const roots = new Set(trace.roots.map((root) => root.id));
  if (trace.roots.length !== 2 || trace.roots[0]?.role !== "title" || trace.roots[1]?.role !== "basel") {
    failSemantic("Runtime Trace V2 lowering requires the exact title and basel source roots.");
  }
  const initial = trace.frames[0]?.draws;
  if (
    !initial ||
    initial.length !== FAST_MANIM_RUNTIME_TRACE_DRAWS_PER_FRAME_V2 ||
    trace.resources.paths.length < 1 ||
    trace.resources.paths.length > MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V2
  ) {
    failSemantic("Runtime Trace V2 lowering requires exactly 31 stable union draw slots.");
  }
  const drawIds = new Set(initial.map((draw) => draw.drawId));
  if (drawIds.size !== initial.length) failSemantic("Runtime Trace V2 draw identities must be unique.");
  const referencedPathIds = new Set(trace.frames.flatMap((frame) => frame.draws.map((draw) => draw.pathId)));
  const resourcePathIds = new Set(trace.resources.paths.map((path) => path.id));
  if (
    resourcePathIds.size !== trace.resources.paths.length ||
    referencedPathIds.size !== resourcePathIds.size ||
    [...referencedPathIds].some((pathId) => !resourcePathIds.has(pathId))
  ) {
    failSemantic("Runtime Trace V2 lowering requires exactly its referenced sealed path resources.");
  }

  trace.frames.forEach((frame, frameIndex) => {
    if (frame.frameIndex !== frameIndex || frame.draws.length !== initial.length) {
      failSemantic(`Runtime Trace V2 frame ${frameIndex} is missing its canonical draw family.`);
    }
    frame.draws.forEach((draw, drawIndex) => {
      const expected = initial[drawIndex];
      const title = drawIndex < FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2.length;
      const localOrder = title
        ? FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2[drawIndex]
        : drawIndex - FAST_MANIM_RUNTIME_TRACE_TITLE_UNION_IDENTITY_ORDERS_V2.length;
      const familyOrder = title ? drawIndex : localOrder;
      const expectedRoot = title ? trace.roots[0]?.id : trace.roots[1]?.id;
      if (
        !expected ||
        draw.drawId !== `${expectedRoot}/runtime-draw:${localOrder}` ||
        draw.rootId !== expectedRoot ||
        draw.paintOrder !== drawIndex ||
        draw.sourceZIndex !== 0 ||
        !sameValue(draw.familyPath, [0, familyOrder]) ||
        !roots.has(draw.rootId)
      ) {
        failSemantic(`Runtime Trace V2 frame ${frameIndex} changed draw identity at paint order ${drawIndex}.`);
      }
    });
    const holdStart = frameIndex >= 240 ? 240 : frameIndex >= 120 && frameIndex < 180 ? 120 : null;
    if (holdStart !== null && frameIndex > holdStart && !sameValue(frame.draws, trace.frames[holdStart]?.draws)) {
      failSemantic(`Runtime Trace V2 frame ${frameIndex} changed during a sealed Wait hold.`);
    }
  });
}

function collectDrawTimelines(trace: VerifiedFastManimRuntimeTraceV2) {
  assertStableDrawIdentity(trace);
  return trace.frames[0].draws.map((_, drawIndex) => trace.frames.map((frame) => frame.draws[drawIndex]));
}

function traceAppearances(draws: readonly RuntimeTraceDrawV2[], appearances: ReadonlyMap<string, VectorAppearanceV2>) {
  return draws.map((draw) => {
    const appearance = appearances.get(draw.appearanceId);
    if (!appearance) failSemantic(`Runtime Trace V2 draw ${draw.drawId} references a missing appearance.`);
    return appearance;
  });
}

function paintParts(draws: readonly RuntimeTraceDrawV2[], values: readonly VectorAppearanceV2[]) {
  const trimChangesGeometry = draws.some((draw) => draw.pathTrim.end !== 1);
  if (!trimChangesGeometry) return [{ appearances: values, suffix: "", trim: false }] as const;

  const fillPresence = values.map((appearance) => appearance.fill !== null);
  const strokePresence = values.map((appearance) => appearance.stroke !== null);
  const hasFill = fillPresence.some(Boolean);
  const hasStroke = strokePresence.some(Boolean);
  draws.forEach((draw, frameIndex) => {
    const fill = values[frameIndex]?.fill;
    if (draw.pathTrim.end !== 1 && draw.opacity !== 0 && fill !== null && fill.color.alpha !== 0) {
      failSemantic("Runtime Trace V2 cannot lower a visible partial fill through the stroke-only path-trim channel.");
    }
  });

  const parts: Array<Readonly<{ appearances: readonly VectorAppearanceV2[]; suffix: string; trim: boolean }>> = [];
  if (hasFill) {
    const fallback = values.find((appearance) => appearance.fill !== null)?.fill;
    if (!fallback) failSemantic("Runtime Trace V2 Write draw lost its fill paint template.");
    parts.push({
      appearances: values.map((appearance) => ({
        fill: appearance.fill ?? { ...fallback, color: { ...fallback.color, alpha: 0 } },
        stroke: null,
      })),
      suffix: "/paint:fill",
      trim: false,
    });
  }
  if (hasStroke) {
    const fallback = values.find((appearance) => appearance.stroke !== null)?.stroke;
    if (!fallback) failSemantic("Runtime Trace V2 Write draw lost its stroke paint template.");
    parts.push({
      appearances: values.map((appearance) => ({
        fill: null,
        stroke: appearance.stroke ?? { ...fallback, color: { ...fallback.color, alpha: 0 } },
      })),
      suffix: "/paint:stroke",
      trim: true,
    });
  }
  if (parts.length === 0) failSemantic("Runtime Trace V2 Write draw has no visible paint phase.");
  return parts;
}

function drawChannels(
  draws: readonly RuntimeTraceDrawV2[],
  appearanceValues: readonly VectorAppearanceV2[],
  paths: readonly CubicPathV2[],
  frameIndexes: readonly number[],
  entityId: string,
  trim: boolean,
  provenanceId: string,
) {
  const firstPresent = draws.find((draw) => draw.present);
  if (!firstPresent) return [];
  const channels: AnimationChannelV2[] = [];
  const base = { entityId, provenanceId } as const;
  const transforms = draws.map((draw) => ({ ...IDENTITY, tx: draw.translation.x, ty: draw.translation.y }));
  if (valuesChange(transforms)) {
    channels.push({
      ...base,
      id: `${entityId}/channel:runtime-trace-translation`,
      keyframes: keyframes(transforms, frameIndexes),
      kind: "affine-transform",
    });
  }
  const opacities = draws.map((draw) => draw.opacity);
  if (valuesChange(opacities)) {
    channels.push({
      ...base,
      id: `${entityId}/channel:runtime-trace-opacity`,
      keyframes: keyframes(opacities, frameIndexes),
      kind: "opacity",
    });
  }
  const trims = draws.map((draw) => draw.pathTrim.end);
  if (trim && trims.some((value) => value !== 1)) {
    channels.push({
      ...base,
      id: `${entityId}/channel:runtime-trace-path-trim`,
      keyframes: keyframes(trims, frameIndexes),
      kind: "path-trim",
      parameterization: "uniform-cubic-parameter-v1",
    });
  }
  if (valuesChange(appearanceValues)) {
    channels.push({
      ...base,
      id: `${entityId}/channel:runtime-trace-appearance`,
      keyframes: keyframes(appearanceValues, frameIndexes),
      kind: "vector-appearance",
    });
  }
  if (valuesChange(paths)) {
    const compacted = compactPathSamples(paths, frameIndexes);
    channels.push({
      ...base,
      id: `${entityId}/channel:runtime-trace-path-morph`,
      keyframes: keyframes(compacted.paths, compacted.frameIndexes),
      kind: "path-morph",
    });
  }
  return channels;
}

function lowerDrawTimeline(
  draws: readonly RuntimeTraceDrawV2[],
  paths: ReadonlyMap<string, CubicPathV2>,
  appearances: ReadonlyMap<string, VectorAppearanceV2>,
  provenanceId: string,
  firstSceneOrder: number,
) {
  const entities: SceneEntityV1[] = [];
  const channels: AnimationChannelV2[] = [];
  const topologyRuns = drawTopologyRuns(draws, paths);
  if (topologyRuns.length > 64) {
    const drawId = draws.find((draw) => draw.present)?.drawId ?? "unknown";
    failSemantic(`Runtime Trace V2 draw ${drawId} exceeds the topology-run budget.`);
  }
  topologyRuns.forEach((run, runIndex) => {
    const firstPresent = run.draws[0];
    const path = run.paths[0];
    if (!firstPresent || !path) return;
    const activeLifetimes = lifetimes(run.frameIndexes);
    if (activeLifetimes.length === 0 || activeLifetimes.length > 64) {
      failSemantic(`Runtime Trace V2 draw ${firstPresent.drawId} exceeds the Scene IR lifetime budget.`);
    }
    const values = traceAppearances(run.draws, appearances);
    const parts = paintParts(run.draws, values);
    parts.forEach((part) => {
      const topologySuffix = runIndex === 0 ? "" : `/topology:${runIndex}`;
      const entityId = `${firstPresent.drawId}${topologySuffix}${part.suffix}`;
      const baseAppearance = part.appearances[0];
      if (!baseAppearance) failSemantic(`Runtime Trace V2 draw ${firstPresent.drawId} has no base appearance.`);
      entities.push({
        appearance: { ...baseAppearance, kind: "vector", opacity: firstPresent.opacity },
        geometry: { kind: "cubic-path", path },
        id: entityId,
        lifetimes: activeLifetimes,
        parentId: firstPresent.rootId,
        provenanceId,
        sceneOrder: firstSceneOrder + entities.length,
        sourceZIndex: firstPresent.sourceZIndex,
        transform: { ...IDENTITY, tx: firstPresent.translation.x, ty: firstPresent.translation.y },
      });
      channels.push(
        ...drawChannels(run.draws, part.appearances, run.paths, run.frameIndexes, entityId, part.trim, provenanceId),
      );
    });
  });
  return { channels, entities };
}

function requiredCapabilities(channels: readonly AnimationChannelV2[]) {
  const capabilities = new Set<SceneIrV1["requiredCapabilities"][number]>(["cubic-path-geometry", "logical-group"]);
  for (const channel of channels) {
    if (channel.kind === "affine-transform") capabilities.add("affine-transform-animation");
    if (channel.kind === "opacity") capabilities.add("opacity-animation");
    if (channel.kind === "path-morph") capabilities.add("path-morph-animation");
    if (channel.kind === "path-trim") capabilities.add("path-trim-animation");
    if (channel.kind === "vector-appearance") capabilities.add("vector-appearance-animation");
  }
  return [...capabilities].sort();
}

async function emptyRuntimeTraceManifest(trace: VerifiedFastManimRuntimeTraceV2) {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId: `${trace.sceneId}/runtime-trace-v2:manifest`,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

/** Lowers one already verified OpeningManim Runtime Trace V2 into display-only retained Scene IR. */
export async function lowerVerifiedFastManimRuntimeTraceV2(trace: VerifiedFastManimRuntimeTraceV2) {
  const timelines = collectDrawTimelines(trace);
  const paths = new Map(trace.resources.paths.map((resource) => [resource.id, resource.path]));
  const appearances = new Map(
    trace.resources.appearances.map(({ fill, id, stroke }) => [id, { fill, stroke }] as const),
  );
  const provenanceId = `${trace.sceneId}/provenance:runtime-trace-v2`;
  const rootId = `${trace.sceneId}/runtime-trace-v2:root`;
  const groups = [
    groupEntity(rootId, null, 0, provenanceId),
    ...trace.roots.map((root, index) => groupEntity(root.id, rootId, index + 1, provenanceId)),
  ];
  const leaves: SceneEntityV1[] = [];
  const channels: AnimationChannelV2[] = [];
  for (const draws of timelines) {
    const lowered = lowerDrawTimeline(draws, paths, appearances, provenanceId, groups.length + leaves.length);
    leaves.push(...lowered.entities);
    channels.push(...lowered.channels);
  }
  const assets = await emptyRuntimeTraceManifest(trace);
  const digest = traceDigest(trace);
  const scene = sceneIrV1Schema.parse({
    animationChannels: channels,
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
    duration: trace.durationSeconds,
    entities: [...groups, ...leaves],
    fidelity: { kind: "exact" },
    provenance: [
      {
        evidence: [
          "fast-manim Runtime Trace V2, preview authority only",
          `trace digest ${digest}`,
          `post-evaluation 60 fps evidence from ${trace.producer.fastManimCommit}`,
          `real LaTeX/dvisvgm geometry ${trace.producer.geometryResourceSha256}`,
          `sealed TeX toolchain ${trace.producer.texToolchainSha256}`,
          `source roots ${trace.roots.map((root) => root.binding.id).join(", ")}`,
        ],
        id: provenanceId,
        origin: "fast-manim-runtime-trace",
      },
    ],
    requiredCapabilities: requiredCapabilities(channels),
    sceneId: trace.sceneId,
    schema: "poietra.scene-ir",
    source: {
      kind: "imported-manim-runtime-trace",
      runtimeConfigHash: trace.runtimeConfigHash,
      sourceHash: trace.sourceHash,
      traceDigest: digest,
      traceVersion: 2,
    },
    version: 1,
  });
  const bundle = await parseVerifiedSceneIrBundleV1({ assets, scene } satisfies SceneIrBundleV1);
  if (Buffer.byteLength(canonicalJsonV1(bundle), "utf8") > MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V2) {
    failSemantic("Runtime Trace V2 normalized Scene IR exceeds its measured eight-MiB budget.");
  }
  return bundle;
}

/** Verifies producer bytes and trusted request correlation before lowering OpeningManim. */
export async function lowerFastManimRuntimeTraceProducerJsonV2(
  value: string | Uint8Array,
  request: FastManimRuntimeTraceProducerRequestV2,
  trusted: TrustedFastManimRuntimeTraceProducerV2,
) {
  const expected = expectedFastManimRuntimeTraceCorrelationFromRequestV2(request, trusted);
  return lowerVerifiedFastManimRuntimeTraceV2(parseFastManimRuntimeTraceProducerJsonV2(value, expected));
}
