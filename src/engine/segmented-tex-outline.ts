import { z } from "zod";
import {
  coordinateV1Schema,
  countCubicPathSegments,
  cubicPathV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
} from "./primitives";

export const POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION = 1 as const;
const MAX_REQUEST_JSON_BYTES = 16 * 1024;
const MAX_RESPONSE_JSON_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 256;
const MAX_PAINT_MATCHES = 4;
const MAX_FRAGMENTS = 128;
const MAX_ENTITIES = 256;
const MAX_CUBIC_SEGMENTS = 2_048;
const NORMALIZATION_TOLERANCE = 0.000_002;
const encoder = new TextEncoder();

const boundsSchema = z
  .object({
    bottom: coordinateV1Schema,
    left: coordinateV1Schema,
    right: coordinateV1Schema,
    top: coordinateV1Schema,
  })
  .strict()
  .refine(({ bottom, left, right, top }) => right > left && top > bottom, "Tex ink bounds must be positive.");

const paintMatchSchema = z
  .object({
    literal: z.string(),
    paint: rgbaColorV1Schema,
  })
  .strict();

export const segmentedTexOutlineRequestV1Schema = z
  .object({
    mode: z.enum(["tex-text", "mathtex-math"]),
    paintMatches: z.array(paintMatchSchema),
    schema: z.literal("poietra.segmented-tex-outline-request"),
    source: z.string(),
    sourceKind: z.enum(["literal", "dynamic"]),
    version: z.literal(1),
  })
  .strict();

const sourceCorrelationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact-byte-range"),
      sourceEndByte: z.number().int().nonnegative(),
      sourceStartByte: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("expression-byte-range"),
      sourceEndByte: z.number().int().nonnegative(),
      sourceStartByte: z.number().int().nonnegative(),
    })
    .strict(),
]);

const paintSpanSchema = z
  .object({
    paint: rgbaColorV1Schema,
    sourceEndByte: z.number().int().nonnegative(),
    sourceStartByte: z.number().int().nonnegative(),
  })
  .strict();

const fragmentSchema = z
  .object({
    bounds: boundsSchema,
    fillEntityId: z.string().min(1).max(64),
    fillRule: z.literal("nonzero"),
    id: z.string().regex(/^fragment-\d{4}$/),
    kind: z.enum(["glyph", "rule", "shape", "path"]),
    order: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_FRAGMENTS - 1),
    outlineEntityId: z.string().min(1).max(64),
    paint: rgbaColorV1Schema,
    path: cubicPathV1Schema,
    sourceCorrelation: sourceCorrelationSchema,
  })
  .strict()
  .superRefine(({ path }, context) => {
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "Segmented Tex contours must be closed." });
    }
  });

const writePlanSchema = z
  .object({
    fragmentLagRatio: z.number().finite().positive().max(0.2),
    outlineStrokeWidth: z.literal(2),
    phaseBoundary: z.literal(0.5),
    representation: z.literal("separate-outline-and-fill-entities"),
  })
  .strict();

const compiledSchema = z
  .object({
    bounds: boundsSchema,
    contentDigest: sha256V1Schema,
    fontDigest: sha256V1Schema,
    fragments: z.array(fragmentSchema).min(1).max(MAX_FRAGMENTS),
    kind: z.literal("compiled"),
    mode: z.enum(["tex-text", "mathtex-math"]),
    paintSpans: z.array(paintSpanSchema).max(MAX_PAINT_MATCHES),
    source: z.string(),
    toolchainDigest: sha256V1Schema,
    writePlan: writePlanSchema,
  })
  .strict()
  .superRefine((artifact, context) => {
    validateCompiledArtifact(artifact, context);
  });

const unsupportedSchema = z
  .object({
    code: z.enum([
      "dynamic-source-unsupported",
      "frame-item-unsupported",
      "internal-failure",
      "invalid-request",
      "option-unsupported",
      "outline-invalid",
      "outline-limit-exceeded",
      "paint-partition-ambiguous",
      "request-too-large",
      "response-too-large",
      "source-correlation-unsupported",
      "syntax-unsupported",
    ]),
    kind: z.literal("unsupported"),
    message: z.string().min(1).max(512),
  })
  .strict();

export const segmentedTexOutlineResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [compiledSchema, unsupportedSchema]),
    schema: z.literal("poietra.segmented-tex-outline-response"),
    version: z.literal(1),
  })
  .strict();

export type SegmentedTexOutlineRequestV1 = z.infer<typeof segmentedTexOutlineRequestV1Schema>;
export type SegmentedTexOutlineArtifactV1 = z.infer<typeof compiledSchema>;
export type SegmentedTexOutlineResponseV1 = z.infer<typeof segmentedTexOutlineResponseV1Schema>;
export type SegmentedTexWriteSampleV1 = Readonly<{
  fragmentId: string;
  outline: SegmentedTexWriteEntityStateV1;
  fill: SegmentedTexWriteEntityStateV1;
}>;
export type SegmentedTexWriteEntityStateV1 = Readonly<{
  visible: boolean;
  fillOpacity: number;
  pathTrimEnd: number;
  strokeOpacity: number;
  strokeWidth: number;
}>;
export type SegmentedTexOutlineCompilerV1 = (
  request: Omit<SegmentedTexOutlineRequestV1, "schema" | "version">,
) => Promise<SegmentedTexOutlineResponseV1>;

type PoietraSegmentedTexOutlineWasmModuleV1 = Readonly<{
  compileSegmentedTexOutlineV1: (requestJson: Uint8Array) => Uint8Array;
  default: () => Promise<unknown>;
  poietraSegmentedTexOutlineAbiVersion: () => number;
}>;

function byteBoundaries(source: string) {
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const character of source) {
    offset += encoder.encode(character).byteLength;
    boundaries.add(offset);
  }
  return { boundaries, byteLength: offset };
}

function exactTexTextGlyphRanges(source: string) {
  const ranges: { sourceEndByte: number; sourceStartByte: number }[] = [];
  let byteOffset = 0;
  let sourceIsSupported = true;
  for (const character of source) {
    const sourceStartByte = byteOffset;
    byteOffset += encoder.encode(character).byteLength;
    if (!/^[\x20-\x7e]$/u.test(character) || /[\\{}%#$&^_~]/u.test(character)) {
      sourceIsSupported = false;
    }
    if (character !== " ") ranges.push({ sourceEndByte: byteOffset, sourceStartByte });
  }
  return { ranges, sourceIsSupported };
}

function equalPaint(
  left: Readonly<{ alpha: number; blue: number; green: number; red: number }>,
  right: Readonly<{ alpha: number; blue: number; green: number; red: number }>,
) {
  return left.alpha === right.alpha && left.blue === right.blue && left.green === right.green && left.red === right.red;
}

const WHITE = { alpha: 1, blue: 1, green: 1, red: 1 } as const;

function validateCompiledArtifact(artifact: z.infer<typeof compiledSchema>, context: z.RefinementCtx) {
  const { boundaries, byteLength } = byteBoundaries(artifact.source);
  const textGlyphs = exactTexTextGlyphRanges(artifact.source);
  if (byteLength > MAX_SOURCE_BYTES) {
    context.addIssue({ code: "custom", message: "Segmented Tex source exceeds 256 UTF-8 bytes." });
  }
  if (
    artifact.mode === "tex-text" &&
    (!textGlyphs.sourceIsSupported || textGlyphs.ranges.length !== artifact.fragments.length)
  ) {
    context.addIssue({
      code: "custom",
      message: "Tex text fragments must map one-to-one to the bounded literal source glyphs.",
    });
  }
  if (
    Math.abs(artifact.bounds.top - artifact.bounds.bottom - 1) > NORMALIZATION_TOLERANCE ||
    Math.abs(artifact.bounds.left + artifact.bounds.right) > NORMALIZATION_TOLERANCE ||
    Math.abs(artifact.bounds.bottom + artifact.bounds.top) > NORMALIZATION_TOLERANCE
  ) {
    context.addIssue({ code: "custom", message: "Segmented Tex bounds must use canonical centered unit height." });
  }
  const segmentCount = artifact.fragments.reduce((total, fragment) => total + countCubicPathSegments(fragment.path), 0);
  if (segmentCount > MAX_CUBIC_SEGMENTS) {
    context.addIssue({ code: "custom", message: "Segmented Tex accepts at most 2,048 cubic segments." });
  }
  if (artifact.fragments.length * 2 > MAX_ENTITIES) {
    context.addIssue({ code: "custom", message: "Segmented Tex accepts at most 256 derived entities." });
  }
  const expectedLag = Math.min(4 / artifact.fragments.length, 0.2);
  if (Math.abs(artifact.writePlan.fragmentLagRatio - expectedLag) > Number.EPSILON) {
    context.addIssue({ code: "custom", message: "Segmented Tex Write lag ratio does not match fragment order." });
  }

  let previousSpanEnd = 0;
  for (const [index, span] of artifact.paintSpans.entries()) {
    if (
      artifact.mode !== "tex-text" ||
      !boundaries.has(span.sourceStartByte) ||
      !boundaries.has(span.sourceEndByte) ||
      span.sourceStartByte >= span.sourceEndByte ||
      span.sourceEndByte > byteLength ||
      (index > 0 && span.sourceStartByte < previousSpanEnd)
    ) {
      context.addIssue({ code: "custom", message: "Segmented Tex paint spans must be ordered UTF-8 ranges." });
    }
    previousSpanEnd = span.sourceEndByte;
  }

  for (const [index, fragment] of artifact.fragments.entries()) {
    const expectedId = `fragment-${index.toString().padStart(4, "0")}`;
    if (
      fragment.id !== expectedId ||
      fragment.order !== index ||
      fragment.outlineEntityId !== `${expectedId}:outline` ||
      fragment.fillEntityId !== `${expectedId}:fill`
    ) {
      context.addIssue({ code: "custom", message: "Segmented Tex fragment identities must follow display order." });
    }
    if (
      fragment.bounds.left < artifact.bounds.left - NORMALIZATION_TOLERANCE ||
      fragment.bounds.right > artifact.bounds.right + NORMALIZATION_TOLERANCE ||
      fragment.bounds.bottom < artifact.bounds.bottom - NORMALIZATION_TOLERANCE ||
      fragment.bounds.top > artifact.bounds.top + NORMALIZATION_TOLERANCE
    ) {
      context.addIssue({ code: "custom", message: "Segmented Tex fragment bounds must stay within aggregate bounds." });
    }
    const correlation = fragment.sourceCorrelation;
    const expectedTextRange = textGlyphs.ranges[index];
    if (artifact.mode === "tex-text" && correlation.kind === "exact-byte-range" && expectedTextRange !== undefined) {
      if (
        !boundaries.has(correlation.sourceStartByte) ||
        !boundaries.has(correlation.sourceEndByte) ||
        correlation.sourceStartByte !== expectedTextRange.sourceStartByte ||
        correlation.sourceEndByte !== expectedTextRange.sourceEndByte
      ) {
        context.addIssue({
          code: "custom",
          message: "Tex glyph correlation must exactly match its non-whitespace source code point.",
        });
      }
      const span = artifact.paintSpans.find(
        ({ sourceEndByte, sourceStartByte }) =>
          sourceStartByte <= correlation.sourceStartByte && correlation.sourceEndByte <= sourceEndByte,
      );
      if (!equalPaint(fragment.paint, span?.paint ?? WHITE)) {
        context.addIssue({ code: "custom", message: "Tex fragment paint does not match its source partition." });
      }
    } else if (
      artifact.mode === "mathtex-math" &&
      correlation.kind === "expression-byte-range" &&
      correlation.sourceStartByte === 0 &&
      correlation.sourceEndByte === byteLength &&
      artifact.paintSpans.length === 0 &&
      equalPaint(fragment.paint, WHITE)
    ) {
      // Math macros deliberately retain expression-level, not fictitious glyph-level, correlation.
    } else {
      context.addIssue({ code: "custom", message: "Segmented Tex source correlation does not match its mode." });
    }
  }
  for (const span of artifact.paintSpans) {
    if (
      !artifact.fragments.some(
        ({ sourceCorrelation }) =>
          sourceCorrelation.kind === "exact-byte-range" &&
          span.sourceStartByte <= sourceCorrelation.sourceStartByte &&
          sourceCorrelation.sourceEndByte <= span.sourceEndByte,
      )
    ) {
      context.addIssue({ code: "custom", message: "Every Tex paint span must contain a correlated glyph." });
    }
  }
}

function browserBaseUrl() {
  if (typeof document !== "undefined") return document.baseURI;
  if (typeof location !== "undefined") return location.href;
  throw new Error("A browser base URL is unavailable for the segmented Tex outline module.");
}

function wasmModuleUrl() {
  const base = new URL(browserBaseUrl());
  const moduleUrl = new URL("./engine-wasm/mathtex-outline/poietra_mathtex_wasm.js", base);
  if (moduleUrl.origin !== base.origin)
    throw new Error("The segmented Tex outline module must use the application origin.");
  return moduleUrl;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export async function initializePoietraSegmentedTexOutlineBindingsV1(
  candidate: unknown,
): Promise<PoietraSegmentedTexOutlineWasmModuleV1> {
  if (!isRecord(candidate) || typeof candidate.default !== "function") {
    throw new Error("The segmented Tex outline module has no WASM initializer.");
  }
  await candidate.default();
  if (
    typeof candidate.poietraSegmentedTexOutlineAbiVersion !== "function" ||
    candidate.poietraSegmentedTexOutlineAbiVersion() !== POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION ||
    typeof candidate.compileSegmentedTexOutlineV1 !== "function"
  ) {
    throw new Error(
      `The segmented Tex outline module does not implement ABI version ${POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION}.`,
    );
  }
  return candidate as PoietraSegmentedTexOutlineWasmModuleV1;
}

let bindingsPromise: Promise<PoietraSegmentedTexOutlineWasmModuleV1> | null = null;

async function loadBindings() {
  bindingsPromise ??= import(/* @vite-ignore */ wasmModuleUrl().href).then(
    initializePoietraSegmentedTexOutlineBindingsV1,
  );
  return bindingsPromise;
}

export function parseSegmentedTexOutlineResponseV1(responseJson: Uint8Array): SegmentedTexOutlineResponseV1 {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_RESPONSE_JSON_BYTES
  ) {
    throw new Error("The segmented Tex outline module returned an invalid or oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
  } catch (cause) {
    throw new Error("The segmented Tex outline module returned malformed UTF-8 JSON.", { cause });
  }
  const parsed = segmentedTexOutlineResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The segmented Tex outline module violated the v1 response contract.", { cause: parsed.error });
  }
  return parsed.data;
}

export const compileSegmentedTexOutlineV1: SegmentedTexOutlineCompilerV1 = async (input) => {
  const request = segmentedTexOutlineRequestV1Schema.parse({
    ...input,
    schema: "poietra.segmented-tex-outline-request",
    version: 1,
  });
  const requestJson = encoder.encode(JSON.stringify(request));
  if (requestJson.byteLength > MAX_REQUEST_JSON_BYTES) {
    return {
      result: {
        code: "request-too-large",
        kind: "unsupported",
        message: "Segmented Tex outline request exceeds the transfer limit",
      },
      schema: "poietra.segmented-tex-outline-response",
      version: 1,
    };
  }
  const bindings = await loadBindings();
  return parseSegmentedTexOutlineResponseV1(bindings.compileSegmentedTexOutlineV1(requestJson));
};

export function evaluateSegmentedTexWriteV1(
  artifact: SegmentedTexOutlineArtifactV1,
  progress: number,
): readonly SegmentedTexWriteSampleV1[] {
  if (!Number.isFinite(progress) || artifact.fragments.length === 0) return [];
  const boundedProgress = Math.min(1, Math.max(0, progress));
  const lag = artifact.writePlan.fragmentLagRatio;
  const fullLength = (artifact.fragments.length - 1) * lag + 1;
  return artifact.fragments.map((fragment) => {
    const raw = boundedProgress * fullLength - fragment.order * lag;
    const local = Math.min(1, Math.max(0, raw));
    const started = raw >= 0;
    const outlineVisible = started && local < artifact.writePlan.phaseBoundary;
    const fillProgress = Math.min(
      1,
      Math.max(0, (local - artifact.writePlan.phaseBoundary) / (1 - artifact.writePlan.phaseBoundary)),
    );
    return {
      fill: {
        fillOpacity: fillProgress,
        pathTrimEnd: 1,
        strokeOpacity: 1,
        strokeWidth: artifact.writePlan.outlineStrokeWidth * (1 - fillProgress),
        visible: started && local >= artifact.writePlan.phaseBoundary,
      },
      fragmentId: fragment.id,
      outline: {
        fillOpacity: 0,
        pathTrimEnd: outlineVisible ? Math.min(1, Math.max(0, local / artifact.writePlan.phaseBoundary)) : 1,
        strokeOpacity: 1,
        strokeWidth: artifact.writePlan.outlineStrokeWidth,
        visible: outlineVisible,
      },
    };
  });
}
