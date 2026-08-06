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
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import { canonicalF64HexV1 } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V2 =
  "poietra.fast-manim-runtime-trace-producer-request" as const;
export const FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V2 = "poietra.fast-manim-runtime-trace-config" as const;
export const FAST_MANIM_RUNTIME_TRACE_VERSION_V2 = 2 as const;
export const FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2 = 2 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2 = 60 as const;
export const FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2 = 5 as const;
export const FAST_MANIM_RUNTIME_TRACE_FRAME_COUNT_V2 = 300 as const;
export const FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2 = 13 as const;
export const FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2 = "post-updater-pre-cairo-paint" as const;
export const MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V2 = 2 * 1024 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2 =
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V2 * 6 + 64 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_DEPTH_V2 = 16;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_ENTRIES_V2 = 128;
export const MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_VALUES_V2 = 192;

const correlationShapeV2 = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: manimSceneNameSchema,
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
};

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

const canonicalRuntimeTraceCameraV2 = {
  background: { alpha: 1, blue: 0, green: 0, red: 0 },
  center: { x: 0, y: 0 },
  frameHeight: 8,
  frameWidth: 128 / 9,
} as const;

function isCanonicalRuntimeTraceCameraV2(
  camera: Readonly<{
    background: Readonly<{ alpha: number; blue: number; green: number; red: number }>;
    center: Readonly<{ x: number; y: number }>;
    frameHeight: number;
    frameWidth: number;
  }>,
) {
  const sameNumber = (actual: number, expected: number) => canonicalF64HexV1(actual) === canonicalF64HexV1(expected);
  return (
    sameNumber(camera.background.alpha, canonicalRuntimeTraceCameraV2.background.alpha) &&
    sameNumber(camera.background.blue, canonicalRuntimeTraceCameraV2.background.blue) &&
    sameNumber(camera.background.green, canonicalRuntimeTraceCameraV2.background.green) &&
    sameNumber(camera.background.red, canonicalRuntimeTraceCameraV2.background.red) &&
    sameNumber(camera.center.x, canonicalRuntimeTraceCameraV2.center.x) &&
    sameNumber(camera.center.y, canonicalRuntimeTraceCameraV2.center.y) &&
    sameNumber(camera.frameHeight, canonicalRuntimeTraceCameraV2.frameHeight) &&
    sameNumber(camera.frameWidth, canonicalRuntimeTraceCameraV2.frameWidth)
  );
}

const runtimeTraceCameraV2Schema = z
  .object({
    background: rgbaColorV1Schema,
    center: enginePointV1Schema,
    frameHeight: z.number().finite().positive().max(MAX_COORDINATE),
    frameWidth: z.number().finite().positive().max(MAX_COORDINATE),
  })
  .strict()
  .refine(isCanonicalRuntimeTraceCameraV2, "Runtime Trace V2 requires the exact default Cairo camera.");

export const fastManimRuntimeTraceConfigV2Schema = z
  .object({
    camera: runtimeTraceCameraV2Schema,
    compositing: z.literal("manim-cairo-srgb"),
    coordinatePrecisionDigits: z.literal(FAST_MANIM_RUNTIME_TRACE_COORDINATE_PRECISION_DIGITS_V2),
    durationSeconds: z.literal(FAST_MANIM_RUNTIME_TRACE_DURATION_SECONDS_V2),
    frameRate: z.literal(FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V2),
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2),
    randomSeed: z.literal(0),
    samplePhase: z.literal(FAST_MANIM_RUNTIME_TRACE_SAMPLE_PHASE_V2),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_CONFIG_SCHEMA_V2),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V2),
  })
  .strict();

export type FastManimRuntimeTraceConfigV2 = z.infer<typeof fastManimRuntimeTraceConfigV2Schema>;

export function digestFastManimRuntimeTraceConfigV2(value: FastManimRuntimeTraceConfigV2) {
  const config = fastManimRuntimeTraceConfigV2Schema.parse(value);
  const number = canonicalF64HexV1;
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        camera: {
          background: {
            alpha: number(config.camera.background.alpha),
            blue: number(config.camera.background.blue),
            green: number(config.camera.background.green),
            red: number(config.camera.background.red),
          },
          center: { x: number(config.camera.center.x), y: number(config.camera.center.y) },
          frameHeight: number(config.camera.frameHeight),
          frameWidth: number(config.camera.frameWidth),
        },
        compositing: config.compositing,
        coordinatePrecisionDigits: config.coordinatePrecisionDigits,
        durationSeconds: config.durationSeconds,
        frameRate: config.frameRate,
        profileVersion: config.profileVersion,
        randomSeed: config.randomSeed,
        samplePhase: config.samplePhase,
        schema: config.schema,
        version: config.version,
      }),
    )
    .digest("hex");
}

export const fastManimRuntimeTraceProducerRequestV2Schema = z
  .object({
    ...correlationShapeV2,
    profileVersion: z.literal(FAST_MANIM_RUNTIME_TRACE_PROFILE_VERSION_V2),
    runtimeConfig: fastManimRuntimeTraceConfigV2Schema,
    sceneOccurrence: z
      .object({
        constructStartLine: z.number().int().positive().max(10_000),
        definitionOrdinal: z.number().int().positive().max(10_000),
      })
      .strict(),
    schema: z.literal(FAST_MANIM_RUNTIME_TRACE_PRODUCER_REQUEST_SCHEMA_V2),
    sourceText: z.string().refine(isUnicodeScalarSequence, "Runtime Trace V2 sourceText must contain Unicode scalars."),
    version: z.literal(FAST_MANIM_RUNTIME_TRACE_VERSION_V2),
  })
  .strict()
  .superRefine((request, context) => {
    if (Buffer.byteLength(request.sourceText, "utf8") > MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V2) {
      context.addIssue({
        code: "custom",
        message: `Runtime Trace V2 source accepts at most ${MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BYTES_V2} UTF-8 bytes.`,
        path: ["sourceText"],
      });
    }
    const sourceHash = createHash("sha256").update(request.sourceText, "utf8").digest("hex");
    if (request.sourceHash !== sourceHash) {
      context.addIssue({ code: "custom", message: "Runtime Trace V2 sourceHash is stale.", path: ["sourceHash"] });
    }
    if (request.sceneId !== fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName)) {
      context.addIssue({ code: "custom", message: "Runtime Trace V2 sceneId is stale.", path: ["sceneId"] });
    }
    if (request.runtimeConfigHash !== digestFastManimRuntimeTraceConfigV2(request.runtimeConfig)) {
      context.addIssue({
        code: "custom",
        message: "Runtime Trace V2 runtimeConfigHash is stale.",
        path: ["runtimeConfigHash"],
      });
    }
  });

export type FastManimRuntimeTraceProducerRequestV2 = z.infer<typeof fastManimRuntimeTraceProducerRequestV2Schema>;

export type FastManimRuntimeTraceV2RequestContractErrorCode =
  | "request-invalid"
  | "request-malformed"
  | "request-too-complex"
  | "request-too-large";

export class FastManimRuntimeTraceV2RequestContractError extends Error {
  readonly code: FastManimRuntimeTraceV2RequestContractErrorCode;

  constructor(code: FastManimRuntimeTraceV2RequestContractErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FastManimRuntimeTraceV2RequestContractError";
    this.code = code;
  }
}

function assertBoundedRuntimeTraceV2RequestJson(value: unknown) {
  const stack: Array<Readonly<{ depth: number; value: unknown }>> = [{ depth: 0, value }];
  let entries = 0;
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    values += 1;
    if (
      values > MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_VALUES_V2 ||
      current.depth > MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_DEPTH_V2
    ) {
      throw new FastManimRuntimeTraceV2RequestContractError(
        "request-too-complex",
        "Runtime Trace V2 request exceeds its structural budget.",
      );
    }
    const entry = current.value;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue;
    }
    let children: unknown[];
    if (Array.isArray(entry)) {
      children = entry;
    } else if (typeof entry === "object") {
      children = Object.values(entry);
    } else {
      throw new FastManimRuntimeTraceV2RequestContractError(
        "request-too-complex",
        "Runtime Trace V2 request is not finite plain JSON.",
      );
    }
    entries += children.length;
    if (entries > MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_STRUCTURE_ENTRIES_V2) {
      throw new FastManimRuntimeTraceV2RequestContractError(
        "request-too-complex",
        "Runtime Trace V2 request exceeds its container-entry budget.",
      );
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: children[index] });
    }
  }
}

export function parseFastManimRuntimeTraceProducerRequestJsonV2(value: string | Uint8Array) {
  const byteLength = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (byteLength > MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2) {
    throw new FastManimRuntimeTraceV2RequestContractError(
      "request-too-large",
      `Runtime Trace V2 requests accept at most ${MAX_FAST_MANIM_RUNTIME_TRACE_REQUEST_JSON_BYTES_V2} encoded bytes.`,
    );
  }
  let json: string;
  try {
    json = typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new FastManimRuntimeTraceV2RequestContractError(
      "request-malformed",
      "Runtime Trace V2 request is not UTF-8 JSON.",
      { cause },
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new FastManimRuntimeTraceV2RequestContractError(
      "request-malformed",
      "Runtime Trace V2 request is malformed JSON.",
      { cause },
    );
  }
  assertBoundedRuntimeTraceV2RequestJson(document);
  if (canonicalJsonV1(document) !== json) {
    throw new FastManimRuntimeTraceV2RequestContractError(
      "request-malformed",
      "Runtime Trace V2 request must use duplicate-free canonical JSON.",
    );
  }
  const parsed = fastManimRuntimeTraceProducerRequestV2Schema.safeParse(document);
  if (!parsed.success) {
    throw new FastManimRuntimeTraceV2RequestContractError(
      "request-invalid",
      "Runtime Trace V2 request violates its closed contract.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
