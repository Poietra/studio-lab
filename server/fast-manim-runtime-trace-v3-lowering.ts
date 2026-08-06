import { createHash } from "node:crypto";

import {
  type AnimationChannelV1,
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
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  type FastManimRuntimeTraceProducerRequestV3,
} from "./fast-manim-runtime-trace-v3-contract";
import {
  type FastManimRuntimeTraceV3,
  parseFastManimRuntimeTraceProducerJsonV3,
  type TrustedFastManimRuntimeTraceProducerV3,
} from "./fast-manim-runtime-trace-v3-result-contract";

const ZERO_SHA256 = "0".repeat(64);
const IDENTITY = { m11: 1, m12: 0, m21: 0, m22: 1, tx: 0, ty: 0 } as const;
const MAX_NORMALIZED_RUNTIME_TRACE_V3_BYTES = 88 * 1024 * 1024;

type StateV3 = FastManimRuntimeTraceV3["frames"][number]["states"][number];
type PathV3 = FastManimRuntimeTraceV3["resources"]["paths"][number]["path"];
type AppearanceV3 = Omit<FastManimRuntimeTraceV3["resources"]["appearances"][number], "id">;
type EntityChannelV3 = Exclude<AnimationChannelV1, { kind: "camera" }>;

export class FastManimRuntimeTraceV3LoweringError extends Error {
  readonly code = "semantic-mismatch" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimRuntimeTraceV3LoweringError";
  }
}

function fail(message: string): never {
  throw new FastManimRuntimeTraceV3LoweringError(message);
}

function sameValue(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function pathTopology(path: PathV3) {
  return path.subpaths.map((subpath) => `${subpath.closed ? 1 : 0}:${subpath.segments.length}`).join("|");
}

function seconds(frame: number) {
  return frame / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3;
}

function lifetimes(runs: readonly Readonly<{ endFrame: number; startFrame: number }>[]) {
  return runs.map(({ endFrame, startFrame }) => ({ end: seconds(endFrame), start: seconds(startFrame) }));
}

function derivedId(trace: FastManimRuntimeTraceV3, kind: string, value: unknown) {
  const digest = createHash("sha256").update(canonicalJsonV1({ kind, value })).digest("hex");
  return `${trace.sceneId}/runtime-v3-${kind}:${digest}`;
}

function valuesChange<T>(values: readonly T[]) {
  const first = values[0];
  return first !== undefined && values.slice(1).some((value) => !sameValue(first, value));
}

function compactSamples<T>(values: readonly T[], frameIndexes: readonly number[]) {
  if (values.length !== frameIndexes.length || values.length === 0)
    fail("Runtime Trace V3 samples lost frame identity.");
  const keep = values.map((value, index) => {
    if (index === 0 || index === values.length - 1) return true;
    if (frameIndexes[index] !== frameIndexes[index - 1]! + 1 || frameIndexes[index + 1] !== frameIndexes[index]! + 1) {
      return true;
    }
    return !sameValue(value, values[index - 1]) || !sameValue(value, values[index + 1]);
  });
  return {
    frameIndexes: frameIndexes.filter((_, index) => keep[index]),
    values: values.filter((_, index) => keep[index]),
  };
}

function keyframes<T>(values: readonly T[], frameIndexes: readonly number[]) {
  const compacted = compactSamples(values, frameIndexes);
  return compacted.values.map((value, index) => ({
    at: seconds(compacted.frameIndexes[index]!),
    easingToNext: index === compacted.values.length - 1 ? null : ({ kind: "linear" } as const),
    value,
  }));
}

function transparentFill(fill: NonNullable<AppearanceV3["fill"]>) {
  return { ...fill, color: { ...fill.color, alpha: 0 } };
}

function transparentStroke(stroke: NonNullable<AppearanceV3["stroke"]>) {
  return { ...stroke, color: { ...stroke.color, alpha: 0 } };
}

function normalizedAppearances(values: readonly AppearanceV3[], part: "both" | "fill" | "stroke") {
  const fillFallback = values.find(({ fill }) => fill !== null)?.fill ?? null;
  const strokeFallback = values.find(({ stroke }) => stroke !== null)?.stroke ?? null;
  return values.map((appearance) => ({
    fill: part === "stroke" || fillFallback === null ? null : (appearance.fill ?? transparentFill(fillFallback)),
    stroke:
      part === "fill" || strokeFallback === null ? null : (appearance.stroke ?? transparentStroke(strokeFallback)),
  }));
}

function transform(state: StateV3) {
  return {
    m11: state.transform.a,
    m12: state.transform.b,
    m21: state.transform.c,
    m22: state.transform.d,
    tx: state.transform.tx,
    ty: state.transform.ty,
  };
}

function stateTimelines(trace: FastManimRuntimeTraceV3) {
  const timelines = new Map<string, { frameIndexes: number[]; states: StateV3[] }>(
    trace.draws.map((draw) => [draw.id, { frameIndexes: [], states: [] }]),
  );
  trace.frames.forEach((frame) => {
    for (const state of frame.states) {
      const timeline = timelines.get(state.drawId);
      if (!timeline) fail(`Runtime Trace V3 state references missing draw ${state.drawId}.`);
      timeline.frameIndexes.push(frame.frameIndex);
      timeline.states.push(state);
    }
  });
  return timelines;
}

function stableDrawOrder(trace: FastManimRuntimeTraceV3) {
  const index = new Map(trace.draws.map((draw, drawIndex) => [draw.id, drawIndex]));
  const outgoing = new Map(trace.draws.map((draw) => [draw.id, new Set<string>()]));
  const indegree = new Map(trace.draws.map((draw) => [draw.id, 0]));
  for (const frame of trace.frames) {
    for (let order = 1; order < frame.states.length; order += 1) {
      const before = frame.states[order - 1]!.drawId;
      const after = frame.states[order]!.drawId;
      if (before === after || outgoing.get(before)!.has(after)) continue;
      outgoing.get(before)!.add(after);
      indegree.set(after, indegree.get(after)! + 1);
    }
  }
  const ready = trace.draws.filter((draw) => indegree.get(draw.id) === 0).map((draw) => draw.id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => index.get(left)! - index.get(right)!);
    const id = ready.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id)!) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (ordered.length !== trace.draws.length) fail("Runtime Trace V3 paint order changes across frames.");
  return new Map(ordered.map((id, order) => [id, order]));
}

function familyGroups(trace: FastManimRuntimeTraceV3) {
  const framesByKey = new Map<string, Set<number>>();
  const metadata = new Map<string, { path: readonly number[]; rootId: string }>();
  for (const draw of trace.draws) {
    for (let length = 1; length <= draw.familyPath.length; length += 1) {
      const path = draw.familyPath.slice(0, length);
      const key = `${draw.rootId}\0${path.join(".")}`;
      metadata.set(key, { path, rootId: draw.rootId });
      const frames = framesByKey.get(key) ?? new Set<number>();
      for (const run of draw.lifetimes) {
        for (let frame = run.startFrame; frame < run.endFrame; frame += 1) frames.add(frame);
      }
      framesByKey.set(key, frames);
    }
  }
  const rootOrder = new Map(trace.roots.map((root) => [root.id, root.sceneOrder]));
  const entries = [...metadata.entries()].sort(([, left], [, right]) => {
    const root = rootOrder.get(left.rootId)! - rootOrder.get(right.rootId)!;
    if (root !== 0) return root;
    const length = Math.min(left.path.length, right.path.length);
    for (let index = 0; index < length; index += 1) {
      const difference = left.path[index]! - right.path[index]!;
      if (difference !== 0) return difference;
    }
    return left.path.length - right.path.length;
  });
  const idByKey = new Map(entries.map(([key, value]) => [key, derivedId(trace, "family", value)]));
  return entries.map(([key, value]) => {
    const parentPath = value.path.slice(0, -1);
    const parentKey = `${value.rootId}\0${parentPath.join(".")}`;
    const frames = [...framesByKey.get(key)!].sort((left, right) => left - right);
    const runs: Array<{ endFrame: number; startFrame: number }> = [];
    for (const frame of frames) {
      const previous = runs.at(-1);
      if (previous && previous.endFrame === frame) previous.endFrame += 1;
      else runs.push({ endFrame: frame + 1, startFrame: frame });
    }
    return {
      id: idByKey.get(key)!,
      lifetimes: lifetimes(runs),
      parentId: value.path.length === 1 ? value.rootId : idByKey.get(parentKey)!,
      path: value.path,
      rootId: value.rootId,
    };
  });
}

function requiredCapabilities(channels: readonly AnimationChannelV1[]) {
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

async function emptyManifest(trace: FastManimRuntimeTraceV3) {
  const draft = assetManifestV1Schema.parse({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId: `${trace.sceneId}/runtime-v3:manifest`,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
}

export async function lowerVerifiedFastManimRuntimeTraceV3(trace: FastManimRuntimeTraceV3) {
  const paths = new Map(trace.resources.paths.map((resource) => [resource.id, resource.path]));
  const appearances = new Map(
    trace.resources.appearances.map(({ fill, id, stroke }) => [id, { fill, stroke }] as const),
  );
  const timelines = stateTimelines(trace);
  const drawOrder = stableDrawOrder(trace);
  const provenanceId = `${trace.sceneId}/provenance:runtime-v3`;
  const rootEntities: SceneEntityV1[] = trace.roots.map((root) => ({
    appearance: { kind: "group", opacity: 1 },
    geometry: { kind: "group" },
    id: root.id,
    lifetimes: lifetimes(root.lifetimes),
    parentId: null,
    provenanceId,
    sceneOrder: root.sceneOrder,
    sourceZIndex: 0,
    transform: IDENTITY,
  }));
  const groups = familyGroups(trace);
  const groupEntities: SceneEntityV1[] = groups.map((group, index) => ({
    appearance: { kind: "group", opacity: 1 },
    geometry: { kind: "group" },
    id: group.id,
    lifetimes: group.lifetimes,
    parentId: group.parentId,
    provenanceId,
    sceneOrder: rootEntities.length + index,
    sourceZIndex: 0,
    transform: IDENTITY,
  }));
  const familyIds = new Map(groups.map((group) => [`${group.rootId}\0${group.path.join(".")}`, group.id]));
  const entities: SceneEntityV1[] = [];
  const channels: EntityChannelV3[] = [];
  const orderedDraws = [...trace.draws].sort((left, right) => drawOrder.get(left.id)! - drawOrder.get(right.id)!);
  for (const draw of orderedDraws) {
    const timeline = timelines.get(draw.id)!;
    const first = timeline.states[0];
    if (!first) fail(`Runtime Trace V3 draw ${draw.id} has no presentation state.`);
    const timelinePaths = timeline.states.map(
      (state) => paths.get(state.pathId) ?? fail(`Missing path ${state.pathId}.`),
    );
    const topology = pathTopology(timelinePaths[0]!);
    if (timelinePaths.some((path) => pathTopology(path) !== topology)) {
      fail(`Runtime Trace V3 draw ${draw.id} changed topology without opening a new draw epoch.`);
    }
    const timelineAppearances = timeline.states.map(
      (state) => appearances.get(state.appearanceId) ?? fail(`Missing appearance ${state.appearanceId}.`),
    );
    const trimValues = timeline.states.map((state) => state.pathTrim.end);
    if (timeline.states.some((state) => state.pathTrim.start !== 0)) {
      fail(`Runtime Trace V3 draw ${draw.id} uses unsupported non-zero trim starts.`);
    }
    const trimChanges = valuesChange(trimValues);
    if (!trimChanges && trimValues[0] !== 1) {
      fail(`Runtime Trace V3 draw ${draw.id} has an unrepresentable static partial path.`);
    }
    if (
      trimChanges &&
      timeline.states.some((state, index) => {
        const fill = timelineAppearances[index]?.fill;
        return (
          state.pathTrim.end !== 1 &&
          state.opacity !== 0 &&
          fill !== null &&
          fill !== undefined &&
          fill.color.alpha !== 0
        );
      })
    ) {
      fail(`Runtime Trace V3 draw ${draw.id} has a visible partial fill.`);
    }
    const hasFill = timelineAppearances.some(({ fill }) => fill !== null);
    const hasStroke = timelineAppearances.some(({ stroke }) => stroke !== null);
    const parts: Array<{ kind: "both" | "fill" | "stroke"; trim: boolean }> = trimChanges
      ? [
          ...(hasFill ? [{ kind: "fill" as const, trim: false }] : []),
          ...(hasStroke ? [{ kind: "stroke" as const, trim: true }] : []),
        ]
      : [{ kind: "both", trim: false }];
    if (parts.length === 0) fail(`Runtime Trace V3 draw ${draw.id} has no lowerable paint.`);
    const sourceZIndexes = timeline.states.map(({ sourceZIndex }) => sourceZIndex);
    if (valuesChange(sourceZIndexes)) fail(`Runtime Trace V3 draw ${draw.id} changes source z-index.`);
    const parentKey = `${draw.rootId}\0${draw.familyPath.join(".")}`;
    const parentId = draw.familyPath.length === 0 ? draw.rootId : familyIds.get(parentKey)!;
    for (const part of parts) {
      const entityId = parts.length === 1 ? draw.id : derivedId(trace, `paint-${part.kind}`, draw.id);
      const paint = normalizedAppearances(timelineAppearances, part.kind);
      const basePaint = paint[0];
      if (!basePaint || (basePaint.fill === null && basePaint.stroke === null)) {
        fail(`Runtime Trace V3 draw ${draw.id} lost its base paint.`);
      }
      entities.push({
        appearance: { ...basePaint, kind: "vector", opacity: first.opacity },
        geometry: { kind: "cubic-path", path: timelinePaths[0]! },
        id: entityId,
        lifetimes: lifetimes(draw.lifetimes),
        parentId,
        provenanceId,
        sceneOrder: rootEntities.length + groupEntities.length + entities.length,
        sourceZIndex: sourceZIndexes[0]!,
        transform: transform(first),
      });
      const addChannel = <T extends EntityChannelV3>(channel: T) => channels.push(channel);
      const transforms = timeline.states.map(transform);
      if (valuesChange(transforms)) {
        addChannel({
          entityId,
          id: derivedId(trace, "channel-affine", entityId),
          keyframes: keyframes(transforms, timeline.frameIndexes),
          kind: "affine-transform",
          provenanceId,
        });
      }
      const opacities = timeline.states.map(({ opacity }) => opacity);
      if (valuesChange(opacities)) {
        addChannel({
          entityId,
          id: derivedId(trace, "channel-opacity", entityId),
          keyframes: keyframes(opacities, timeline.frameIndexes),
          kind: "opacity",
          provenanceId,
        });
      }
      if (valuesChange(timelinePaths)) {
        addChannel({
          entityId,
          id: derivedId(trace, "channel-path", entityId),
          keyframes: keyframes(timelinePaths, timeline.frameIndexes),
          kind: "path-morph",
          provenanceId,
        });
      }
      if (valuesChange(paint)) {
        addChannel({
          entityId,
          id: derivedId(trace, "channel-appearance", entityId),
          keyframes: keyframes(paint, timeline.frameIndexes),
          kind: "vector-appearance",
          provenanceId,
        });
      }
      if (part.trim) {
        addChannel({
          entityId,
          id: derivedId(trace, "channel-trim", entityId),
          keyframes: keyframes(trimValues, timeline.frameIndexes),
          kind: "path-trim",
          parameterization: "uniform-cubic-parameter-v1",
          provenanceId,
        });
      }
    }
  }

  const assets = await emptyManifest(trace);
  const traceDigest = digestFastManimRuntimeTraceV3(trace);
  let scene: SceneIrV1;
  try {
    scene = sceneIrV1Schema.parse({
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
      duration: trace.sampleSchedule.frameCount / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
      entities: [...rootEntities, ...groupEntities, ...entities],
      fidelity: { kind: "exact" },
      provenance: [
        {
          evidence: [
            "fast-manim generic Runtime Trace V3, preview authority only",
            `post-evaluation 60 fps evidence from ${trace.producer.fastManimCommit}`,
            `source ${trace.sourcePath}#${trace.sceneName} at ${trace.sourceHash}`,
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
        traceDigest,
        traceVersion: 3,
      },
      version: 1,
    });
  } catch (cause) {
    throw new FastManimRuntimeTraceV3LoweringError("Runtime Trace V3 cannot be represented by bounded Scene IR.", {
      cause,
    });
  }
  const bundle = await parseVerifiedSceneIrBundleV1({ assets, scene } satisfies SceneIrBundleV1);
  if (Buffer.byteLength(canonicalJsonV1(bundle), "utf8") > MAX_NORMALIZED_RUNTIME_TRACE_V3_BYTES) {
    fail("Runtime Trace V3 normalized Scene IR exceeds its byte budget.");
  }
  return bundle;
}

export function digestFastManimRuntimeTraceV3(trace: FastManimRuntimeTraceV3) {
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        runtimeConfigHash: trace.runtimeConfigHash,
        sceneId: trace.sceneId,
        semanticsSha256: trace.producer.semanticsSha256,
        sourceHash: trace.sourceHash,
      }),
    )
    .digest("hex");
}

export async function lowerFastManimRuntimeTraceProducerJsonV3(
  value: string | Uint8Array,
  request: FastManimRuntimeTraceProducerRequestV3,
  trusted: TrustedFastManimRuntimeTraceProducerV3,
) {
  return lowerVerifiedFastManimRuntimeTraceV3(parseFastManimRuntimeTraceProducerJsonV3(value, request, trusted));
}
