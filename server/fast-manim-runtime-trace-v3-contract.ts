import { createHash } from "node:crypto";

import { z } from "zod";

import {
  enginePointV1Schema,
  MAX_COORDINATE,
  opaqueIdV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../src/engine/contracts";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";
import {
  canonicalRuntimeTraceDomainJsonV3,
  canonicalRuntimeTraceF64HexV3,
} from "../src/render-pipeline/runtime-trace-v3-digest";
import {
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  fastManimRuntimeTraceSourceBindingV3Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3,
} from "../src/render-pipeline/runtime-trace-v3-shared-contract";
import type { StudioSourceAnalysisV1 } from "../src/render-pipeline/source-analysis";
import { fastManimSourceBindingIdentifierV1 } from "../src/render-pipeline/source-runtime-identity-digest";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";

export const FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3 =
  "poietra.fast-manim-runtime-trace-producer-request" as const;
export const FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3 = "poietra.fast-manim-runtime-trace-config" as const;
export const FAST_MANIM_RUNTIME_TRACE_VERSION_V3 = 3 as const;
export const FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3 = 3 as const;
export {
  FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
  FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
  fastManimRuntimeTraceSourceBindingV3Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3,
} from "../src/render-pipeline/runtime-trace-v3-shared-contract";
export const FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3 = "post-updater-pre-cairo-paint" as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3 = 2 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V3 =
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3 * 6 + 64 * 1024;

const canonicalCameraV3 = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 128 / 9,
} as const;

function sameNumber(actual: number, expected: number) {
  return canonicalRuntimeTraceF64HexV3(actual) === canonicalRuntimeTraceF64HexV3(expected);
}

const runtimeTraceCameraV3Schema = z
  .object({
    background: rgbaColorV1Schema,
    center: enginePointV1Schema,
    frameHeight: z.number().finite().positive().max(MAX_COORDINATE),
    frameWidth: z.number().finite().positive().max(MAX_COORDINATE),
  })
  .strict()
  .refine(
    (camera) =>
      sameNumber(camera.background.alpha, canonicalCameraV3.background.alpha) &&
      sameNumber(camera.background.blue, canonicalCameraV3.background.blue) &&
      sameNumber(camera.background.green, canonicalCameraV3.background.green) &&
      sameNumber(camera.background.red, canonicalCameraV3.background.red) &&
      sameNumber(camera.center.x, canonicalCameraV3.center.x) &&
      sameNumber(camera.center.y, canonicalCameraV3.center.y) &&
      sameNumber(camera.frameHeight, canonicalCameraV3.frameHeight) &&
      sameNumber(camera.frameWidth, canonicalCameraV3.frameWidth),
    "Runtime Trace V3 requires the exact default Cairo camera.",
  );

export const fastManimRuntimeTraceConfigV3Schema = z
  .object({
    camera: runtimeTraceCameraV3Schema,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3),
    maxFrameCount: z.literal(FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3),
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3),
    randomSeed: z.literal(0),
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V3),
  })
  .strict();

export type FastManimRuntimeTraceConfigV3 = z.infer<typeof fastManimRuntimeTraceConfigV3Schema>;

export function digestFastManimRuntimeTraceDomainV3(domain: string, value: unknown) {
  return createHash("sha256").update(canonicalRuntimeTraceDomainJsonV3(domain, value)).digest("hex");
}

export function digestFastManimRuntimeTraceConfigV3(value: FastManimRuntimeTraceConfigV3) {
  return digestFastManimRuntimeTraceDomainV3(
    "poietra.fast-manim-runtime-trace-config.v3",
    fastManimRuntimeTraceConfigV3Schema.parse(value),
  );
}

function isUnicodeScalarSequence(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type FastManimRuntimeTraceSourceBindingV3 = z.infer<typeof fastManimRuntimeTraceSourceBindingV3Schema>;

/**
 * Project versioned SourceAnalysis evidence onto the closed producer request.
 * Runtime correlation remains preview-only: this helper does not grant an
 * edit capability and deliberately excludes ambiguous or dynamic bindings.
 */
export function fastManimRuntimeTraceSourceBindingsFromAnalysisV3(analysis: StudioSourceAnalysisV1, sceneId: string) {
  if (sceneId !== fastManimRuntimeTraceSceneIdV1(analysis.sourcePath, analysis.scene.name)) {
    throw new TypeError("Runtime Trace V3 source binding analysis is for another Scene.");
  }
  const candidates = analysis.bindings
    .filter(
      (binding) =>
        binding.kind === "assignment" &&
        binding.scopeId === analysis.scene.construct.scopeId &&
        binding.controlPath.length === 0 &&
        binding.ordinal !== null &&
        !binding.ambiguous &&
        binding.capabilities.move.status === "source-eligible" &&
        binding.capabilities.uniformResize.status === "source-eligible",
    )
    .sort((left, right) => left.ordinal! - right.ordinal!);
  const projected: FastManimRuntimeTraceSourceBindingV3[] = [];
  for (const binding of candidates) {
    // Python normalizes identifiers to NFKC while parsing. Sending a spelling
    // that changes under that normalization would make the source token and
    // runtime local disagree, so omit only that candidate from correlation.
    if (binding.name.normalize("NFKC") !== binding.name) continue;
    const candidate = {
      id: "",
      name: binding.name,
      ordinal: binding.ordinal!,
      span: {
        endColumn: binding.span.endColumn,
        endLine: binding.span.endLine,
        startColumn: binding.span.startColumn,
        startLine: binding.span.startLine,
      },
    };
    candidate.id = fastManimSourceBindingIdentifierV1(analysis.sourceHash, sceneId, candidate);
    const parsed = fastManimRuntimeTraceSourceBindingV3Schema.safeParse(candidate);
    if (!parsed.success) continue;
    projected.push(parsed.data);
    if (projected.length === MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3) break;
  }
  return projected;
}

const runtimeTraceSourceBindingsV3Schema = z
  .array(fastManimRuntimeTraceSourceBindingV3Schema)
  .max(MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3);

export const fastManimRuntimeTraceProducerRequestV3Schema = z
  .object({
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3),
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    runtimeConfig: fastManimRuntimeTraceConfigV3Schema,
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    sceneName: manimSceneNameSchema,
    sceneOccurrence: z
      .object({
        constructStartLine: z.number().int().positive().max(10_000),
        definitionOrdinal: z.number().int().positive().max(10_000),
      })
      .strict(),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3),
    sourceHash: sha256V1Schema,
    sourceBindings: runtimeTraceSourceBindingsV3Schema,
    sourcePath: manimSourcePathSchema,
    sourceText: z.string().refine(isUnicodeScalarSequence, "Runtime Trace V3 sourceText must contain Unicode scalars."),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V3),
  })
  .strict()
  .superRefine((request, context) => {
    if (Buffer.byteLength(request.sourceText, "utf8") > MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V3 source accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V3} UTF-8 bytes.`,
        path: ["sourceText"],
      });
    }
    if (request.sourceHash !== createHash("sha256").update(request.sourceText, "utf8").digest("hex")) {
      context.addIssue({ code: "custom", message: "Runtime Trace V3 sourceHash is stale.", path: ["sourceHash"] });
    }
    if (request.sceneId !== fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName)) {
      context.addIssue({ code: "custom", message: "Runtime Trace V3 sceneId is stale.", path: ["sceneId"] });
    }
    if (request.runtimeConfigHash !== digestFastManimRuntimeTraceConfigV3(request.runtimeConfig)) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V3 runtimeConfigHash is stale.",
        path: ["runtimeConfigHash"],
      });
    }
    const bindingIds = new Set<string>();
    const bindingNames = new Set<string>();
    request.sourceBindings.forEach((binding, index) => {
      if (binding.id !== fastManimSourceBindingIdentifierV1(request.sourceHash, request.sceneId, binding)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V3 source binding identity is stale.",
          path: ["sourceBindings", index, "id"],
        });
      }
      if (bindingIds.has(binding.id) || bindingNames.has(binding.name)) {
        context.addIssue({
          code: "custom",
          message: "Runtime Trace V3 source bindings must be unique by identity and name.",
          path: ["sourceBindings", index],
        });
      }
      bindingIds.add(binding.id);
      bindingNames.add(binding.name);
    });
  });

export type FastManimRuntimeTraceProducerRequestV3 = z.infer<typeof fastManimRuntimeTraceProducerRequestV3Schema>;

export function createFastManimRuntimeTraceConfigV3(frame: Readonly<{ height: number; width: number }>) {
  return fastManimRuntimeTraceConfigV3Schema.parse({
    camera: {
      background: canonicalCameraV3.background,
      center: canonicalCameraV3.center,
      frameHeight: frame.height,
      frameWidth: frame.width,
    },
    compositing: "manim-cairo-srgb",
    coordinatePrecisionDigits: FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V3,
    frameRate: FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
    maxFrameCount: FAST_MANIM_RUNTIME_TRACE_MAX_FRAME_COUNT_V3,
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3,
    randomSeed: 0,
    samplePhase: FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V3,
    schema: FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V3,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V3,
  });
}

export function createFastManimRuntimeTraceProducerRequestV3(
  run: Readonly<{
    projectId: string;
    requestId: string;
    sceneName: string;
    sourceHash: string;
    sourcePath: string;
  }>,
  sourceText: string,
  sceneOccurrence: Readonly<{ constructStartLine: number; definitionOrdinal: number }>,
  frame: Readonly<{ height: number; width: number }>,
  sourceBindings: readonly FastManimRuntimeTraceSourceBindingV3[] = [],
) {
  const runtimeConfig = createFastManimRuntimeTraceConfigV3(frame);
  return fastManimRuntimeTraceProducerRequestV3Schema.parse({
    profileVersion: FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V3,
    projectId: run.projectId,
    requestId: run.requestId,
    runtimeConfig,
    runtimeConfigHash: digestFastManimRuntimeTraceConfigV3(runtimeConfig),
    sceneId: fastManimRuntimeTraceSceneIdV1(run.sourcePath, run.sceneName),
    sceneName: run.sceneName,
    sceneOccurrence,
    schema: FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V3,
    sourceHash: run.sourceHash,
    sourceBindings,
    sourcePath: run.sourcePath,
    sourceText,
    version: FAST_MANIM_RUNTIME_TRACE_VERSION_V3,
  });
}
