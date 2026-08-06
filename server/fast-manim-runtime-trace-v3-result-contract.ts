import { z } from "zod";

import {
  countCubicPathSegments,
  cubicPathV1Schema,
  fillStyleV1Schema,
  MAX_COORDINATE,
  normalizedNumberV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
  strokeStyleV1Schema,
} from "../src/engine/contracts";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  digestFastManimRuntimeTraceDomainV3,
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3,
  FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3,
  FAST_MANIM_RUNTIME_TRACE_VERSION_V3,
  type FastManimRuntimeTraceProducerRequestV3,
  fastManimRuntimeTraceProducerRequestV3Schema,
} from "./fast-manim-runtime-trace-v3-contract";
import { canonicalF64HexV1 } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_RUNTIME_TRACE_SCHEMA_V3 = "poietra.fast-manim-runtime-trace" as const;
export const FAST_MANIM_RUNTIME_TRACE_AUTHORITY_V3 = "preview-only" as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_ROOTS_V3 = 128;
export const MAX_FAST_MANIM_RUNTIME_TRACE_DRAWS_V3 = 256;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STATES_PER_FRAME_V3 = MAX_FAST_MANIM_RUNTIME_TRACE_DRAWS_V3;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STATES_V3 =
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 * MAX_FAST_MANIM_RUNTIME_TRACE_STATES_PER_FRAME_V3;
export const MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V3 = 384;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V3 = 6_566;
export const MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V3 = 100_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_FAMILY_PATH_DEPTH_V3 = 64;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SUBMOBJECTS_PER_PARENT_V3 = 10_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_LIFETIME_RUNS_V3 = 64;
export const MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3 = 88 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_NORMALIZED_JSON_BYTES_V3 = 88 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V3 = 16;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V3 = 5_000_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V3 = 5_000_000;
export const MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V3 = MAX_FAST_MANIM_RUNTIME_TRACE_STATES_V3;
export const MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V3 = 32;

const coordinateV3Schema = z
  .number()
  .finite()
  .min(-MAX_COORDINATE)
  .max(MAX_COORDINATE)
  .refine(
    (value) => value === Number(value.toFixed(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3)),
    "Runtime Trace V3 coordinates must use the canonical 13-digit precision.",
  );
const pathIdV3Schema = z.string().regex(/^path:[0-9a-f]{64}$/u);
const appearanceIdV3Schema = z.string().regex(/^appearance:[0-9a-f]{64}$/u);
const gitObjectIdV3Schema = z.string().regex(/^[0-9a-f]{40}$/u);

const lifetimeV3Schema = z
  .object({
    endFrame: z.number().int().positive().max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3),
    startFrame: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 - 1),
  })
  .strict()
  .refine(({ endFrame, startFrame }) => startFrame < endFrame, "Runtime Trace V3 lifetimes must be positive.");

const lifetimesV3Schema = z
  .array(lifetimeV3Schema)
  .min(1)
  .max(MAX_FAST_MANIM_RUNTIME_TRACE_LIFETIME_RUNS_V3)
  .refine(
    (lifetimes) =>
      lifetimes.every((lifetime, index) => index === 0 || lifetime.startFrame > lifetimes[index - 1]!.endFrame),
    "Runtime Trace V3 lifetimes must be ordered, separated frame ranges.",
  );

const rootV3Schema = z
  .object({
    id: sourceIdentityV1Schema,
    lifetimes: lifetimesV3Schema,
    sceneOrder: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FAST_MANIM_RUNTIME_TRACE_ROOTS_V3 - 1),
  })
  .strict();

const drawV3Schema = z
  .object({
    familyPath: z
      .array(
        z
          .number()
          .int()
          .nonnegative()
          .max(MAX_FAST_MANIM_RUNTIME_TRACE_SUBMOBJECTS_PER_PARENT_V3 - 1),
      )
      .max(MAX_FAST_MANIM_RUNTIME_TRACE_FAMILY_PATH_DEPTH_V3),
    id: sourceIdentityV1Schema,
    lifetimes: lifetimesV3Schema,
    rootId: sourceIdentityV1Schema,
  })
  .strict();

const appearanceV3Schema = z
  .object({
    fill: fillStyleV1Schema.nullable(),
    id: appearanceIdV3Schema,
    stroke: strokeStyleV1Schema.nullable(),
  })
  .strict()
  .refine(({ fill, stroke }) => fill !== null || stroke !== null, "Runtime Trace V3 appearances require paint.");

const pathResourceV3Schema = z.object({ id: pathIdV3Schema, path: cubicPathV1Schema }).strict();

const transformV3Schema = z
  .object({
    a: coordinateV3Schema,
    b: coordinateV3Schema,
    c: coordinateV3Schema,
    d: coordinateV3Schema,
    tx: coordinateV3Schema,
    ty: coordinateV3Schema,
  })
  .strict();

const stateV3Schema = z
  .object({
    appearanceId: appearanceIdV3Schema,
    drawId: sourceIdentityV1Schema,
    opacity: normalizedNumberV1Schema,
    paintOrder: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FAST_MANIM_RUNTIME_TRACE_STATES_PER_FRAME_V3 - 1),
    pathId: pathIdV3Schema,
    pathTrim: z
      .object({ end: normalizedNumberV1Schema, start: normalizedNumberV1Schema })
      .strict()
      .refine(({ end, start }) => start <= end, "Runtime Trace V3 path trim must be ordered."),
    sourceZIndex: coordinateV3Schema,
    transform: transformV3Schema,
  })
  .strict();

const frameV3Schema = z
  .object({
    frameIndex: z
      .number()
      .int()
      .nonnegative()
      .max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 - 1),
    sampleTime: coordinateV3Schema,
    states: z.array(stateV3Schema).max(MAX_FAST_MANIM_RUNTIME_TRACE_STATES_PER_FRAME_V3),
  })
  .strict();

export const fastManimRuntimeTraceV3Schema = z
  .object({
    authority: z.literal(FAST_MANIM_RUNTIME_TRACE_AUTHORITY_V3),
    camera: fastManimRuntimeTraceProducerRequestV3Schema.shape.runtimeConfig.shape.camera,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3),
    draws: z.array(drawV3Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_DRAWS_V3),
    frames: z.array(frameV3Schema).min(1).max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3),
    producer: z
      .object({
        fastManimCommit: gitObjectIdV3Schema,
        fastManimTree: gitObjectIdV3Schema,
        manimVersion: z.string().min(1).max(64),
        semanticsSha256: sha256V1Schema,
      })
      .strict(),
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3),
    projectId: fastManimRuntimeTraceProducerRequestV3Schema.shape.projectId,
    requestId: fastManimRuntimeTraceProducerRequestV3Schema.shape.requestId,
    resources: z
      .object({
        appearances: z.array(appearanceV3Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_APPEARANCE_RESOURCES_V3),
        paths: z.array(pathResourceV3Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_PATH_RESOURCES_V3),
      })
      .strict(),
    roots: z.array(rootV3Schema).min(1).max(MAX_FAST_MANIM_RUNTIME_TRACE_ROOTS_V3),
    runtimeConfigHash: sha256V1Schema,
    sampleSchedule: z
      .object({
        durationSeconds: coordinateV3Schema.positive().max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3 / 60),
        frameCount: z.number().int().positive().max(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3),
        frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3),
        samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3),
      })
      .strict(),
    sceneId: fastManimRuntimeTraceProducerRequestV3Schema.shape.sceneId,
    sceneName: fastManimRuntimeTraceProducerRequestV3Schema.shape.sceneName,
    sceneOccurrence: fastManimRuntimeTraceProducerRequestV3Schema.shape.sceneOccurrence,
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_SCHEMA_V3),
    sourceHash: fastManimRuntimeTraceProducerRequestV3Schema.shape.sourceHash,
    sourcePath: fastManimRuntimeTraceProducerRequestV3Schema.shape.sourcePath,
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V3),
  })
  .strict();

export type FastManimRuntimeTraceV3 = z.infer<typeof fastManimRuntimeTraceV3Schema>;
export type TrustedFastManimRuntimeTraceProducerV3 = Readonly<{
  fastManimCommit: string;
  fastManimTree: string;
  manimVersion: string;
}>;

function digestPathV3(path: z.infer<typeof cubicPathV1Schema>) {
  return digestFastManimRuntimeTraceDomainV3("poietra.runtime-trace-v3-path", path);
}

function digestAppearanceV3(appearance: z.infer<typeof appearanceV3Schema>) {
  return digestFastManimRuntimeTraceDomainV3("poietra.runtime-trace-v3-appearance", {
    fill: appearance.fill,
    stroke: appearance.stroke,
  });
}

function visualSemanticsDigestV3(trace: FastManimRuntimeTraceV3) {
  return digestFastManimRuntimeTraceDomainV3("poietra.fast-manim-runtime-trace-visual-semantics.v3", {
    camera: trace.camera,
    compositing: trace.compositing,
    coordinatePrecisionDigits: trace.coordinatePrecisionDigits,
    draws: trace.draws,
    frames: trace.frames,
    resources: trace.resources,
    roots: trace.roots,
    sampleSchedule: trace.sampleSchedule,
  });
}

function sameValue(left: unknown, right: unknown) {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function frameRuns(frames: readonly number[]) {
  const runs: Array<{ endFrame: number; startFrame: number }> = [];
  for (const frame of frames) {
    const previous = runs.at(-1);
    if (previous && previous.endFrame === frame) previous.endFrame += 1;
    else runs.push({ endFrame: frame + 1, startFrame: frame });
  }
  return runs;
}

function verifyCorrelationV3(trace: FastManimRuntimeTraceV3, request: FastManimRuntimeTraceProducerRequestV3) {
  for (const key of [
    "projectId",
    "requestId",
    "runtimeConfigHash",
    "sceneId",
    "sceneName",
    "sceneOccurrence",
    "sourceHash",
    "sourcePath",
  ] as const) {
    if (!sameValue(trace[key], request[key])) throw new TypeError(`Runtime Trace V3 has stale ${key} correlation.`);
  }
  if (!sameValue(trace.camera, request.runtimeConfig.camera)) {
    throw new TypeError("Runtime Trace V3 has stale camera correlation.");
  }
}

function verifySemanticsV3(trace: FastManimRuntimeTraceV3, trusted: TrustedFastManimRuntimeTraceProducerV3) {
  if (
    trace.producer.fastManimCommit !== trusted.fastManimCommit ||
    trace.producer.fastManimTree !== trusted.fastManimTree ||
    trace.producer.manimVersion !== trusted.manimVersion
  ) {
    throw new TypeError("Runtime Trace V3 producer identity is not trusted.");
  }
  const { frameCount } = trace.sampleSchedule;
  if (
    trace.frames.length !== frameCount ||
    canonicalF64HexV1(trace.sampleSchedule.durationSeconds) !==
      canonicalF64HexV1(Number((frameCount / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3).toFixed(13)))
  ) {
    throw new TypeError("Runtime Trace V3 sample schedule is inconsistent.");
  }

  const rootById = new Map<string, FastManimRuntimeTraceV3["roots"][number]>();
  const rootFrames = new Map<string, number[]>();
  trace.roots.forEach((root, index) => {
    if (root.sceneOrder !== index || rootById.has(root.id))
      throw new TypeError("Runtime Trace V3 root identity is invalid.");
    rootById.set(root.id, root);
    rootFrames.set(root.id, []);
  });
  const drawById = new Map<string, FastManimRuntimeTraceV3["draws"][number]>();
  const drawFrames = new Map<string, number[]>();
  for (const draw of trace.draws) {
    if (drawById.has(draw.id) || !rootById.has(draw.rootId)) {
      throw new TypeError("Runtime Trace V3 draw identity is invalid.");
    }
    drawById.set(draw.id, draw);
    drawFrames.set(draw.id, []);
  }

  const appearances = new Map<string, FastManimRuntimeTraceV3["resources"]["appearances"][number]>();
  for (const appearance of trace.resources.appearances) {
    if (appearances.has(appearance.id) || appearance.id !== `appearance:${digestAppearanceV3(appearance)}`) {
      throw new TypeError("Runtime Trace V3 appearance resources are not uniquely content-addressed.");
    }
    appearances.set(appearance.id, appearance);
  }
  const paths = new Map<string, FastManimRuntimeTraceV3["resources"]["paths"][number]>();
  let pathSegments = 0;
  for (const path of trace.resources.paths) {
    pathSegments += countCubicPathSegments(path.path);
    if (
      pathSegments > MAX_FAST_MANIM_RUNTIME_TRACE_PATH_SEGMENTS_V3 ||
      paths.has(path.id) ||
      path.id !== `path:${digestPathV3(path.path)}`
    ) {
      throw new TypeError("Runtime Trace V3 path resources are invalid.");
    }
    paths.set(path.id, path);
  }

  const referencedAppearances = new Set<string>();
  const referencedPaths = new Set<string>();
  let totalStates = 0;
  trace.frames.forEach((frame, frameIndex) => {
    if (
      frame.frameIndex !== frameIndex ||
      canonicalF64HexV1(frame.sampleTime) !==
        canonicalF64HexV1(Number((frameIndex / FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3).toFixed(13)))
    ) {
      throw new TypeError("Runtime Trace V3 frame sampling is not canonical.");
    }
    totalStates += frame.states.length;
    if (totalStates > MAX_FAST_MANIM_RUNTIME_TRACE_STATES_V3) {
      throw new TypeError("Runtime Trace V3 exceeds its state budget.");
    }
    const presented = new Set<string>();
    frame.states.forEach((state, paintOrder) => {
      const draw = drawById.get(state.drawId);
      if (
        state.paintOrder !== paintOrder ||
        !draw ||
        presented.has(state.drawId) ||
        !appearances.has(state.appearanceId) ||
        !paths.has(state.pathId)
      ) {
        throw new TypeError("Runtime Trace V3 frame state identity is invalid.");
      }
      presented.add(state.drawId);
      drawFrames.get(state.drawId)!.push(frameIndex);
      rootFrames.get(draw.rootId)!.push(frameIndex);
      referencedAppearances.add(state.appearanceId);
      referencedPaths.add(state.pathId);
    });
  });
  for (const [id, draw] of drawById) {
    if (!sameValue(frameRuns(drawFrames.get(id)!), draw.lifetimes)) {
      throw new TypeError("Runtime Trace V3 draw lifetimes do not match its frame states.");
    }
  }
  for (const [id, root] of rootById) {
    const frames = [...new Set(rootFrames.get(id)!)];
    if (!sameValue(frameRuns(frames), root.lifetimes)) {
      throw new TypeError("Runtime Trace V3 root lifetimes do not match its frame states.");
    }
  }
  if (
    referencedAppearances.size !== appearances.size ||
    referencedPaths.size !== paths.size ||
    [...appearances.keys()].some((id) => !referencedAppearances.has(id)) ||
    [...paths.keys()].some((id) => !referencedPaths.has(id))
  ) {
    throw new TypeError("Runtime Trace V3 resources must be referenced exactly.");
  }
  if (trace.producer.semanticsSha256 !== visualSemanticsDigestV3(trace)) {
    throw new TypeError("Runtime Trace V3 visual semantics digest is stale.");
  }
}

function assertBoundedStructureV3(value: unknown) {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  let entries = 0;
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    values += 1;
    if (
      values > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_VALUES_V3 ||
      current.depth > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_DEPTH_V3
    ) {
      throw new TypeError("Runtime Trace V3 result exceeds its structural budget.");
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    const children = Array.isArray(current.value)
      ? current.value
      : typeof current.value === "object"
        ? Object.values(current.value)
        : null;
    if (!children) throw new TypeError("Runtime Trace V3 result must be finite plain JSON.");
    const limit = Array.isArray(current.value)
      ? MAX_FAST_MANIM_RUNTIME_TRACE_ARRAY_ITEMS_V3
      : MAX_FAST_MANIM_RUNTIME_TRACE_OBJECT_FIELDS_V3;
    if (children.length > limit) throw new TypeError("Runtime Trace V3 result contains an oversized container.");
    entries += children.length;
    if (entries > MAX_FAST_MANIM_RUNTIME_TRACE_STRUCTURE_ENTRIES_V3) {
      throw new TypeError("Runtime Trace V3 result exceeds its structural budget.");
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: children[index] });
    }
  }
}

export function parseFastManimRuntimeTraceProducerJsonV3(
  value: string | Uint8Array,
  requestValue: FastManimRuntimeTraceProducerRequestV3,
  trusted: TrustedFastManimRuntimeTraceProducerV3,
) {
  const request = fastManimRuntimeTraceProducerRequestV3Schema.parse(requestValue);
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3) {
    throw new TypeError("Runtime Trace V3 result exceeds its byte budget.");
  }
  let json: string;
  try {
    json = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new TypeError("Runtime Trace V3 result is not UTF-8 JSON.", { cause });
  }
  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new TypeError("Runtime Trace V3 result is malformed JSON.", { cause });
  }
  assertBoundedStructureV3(document);
  const trace = fastManimRuntimeTraceV3Schema.parse(document);
  verifyCorrelationV3(trace, request);
  verifySemanticsV3(trace, trusted);
  return trace;
}
