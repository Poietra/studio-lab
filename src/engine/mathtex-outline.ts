import { z } from "zod";
import {
  coordinateV1Schema,
  countCubicPathSegments,
  cubicPathV1Schema,
  finiteNumberV1Schema,
  rgbaColorV1Schema,
  sha256V1Schema,
} from "./primitives";

export const POIETRA_MATHTEX_OUTLINE_ABI_VERSION = 1 as const;
export const POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION = 1 as const;
export const POIETRA_TEXT_OUTLINE_ABI_VERSION = 9 as const;
const MAX_MATHTEX_PARTS = 16;
const MAX_MATHTEX_CONTENT_LENGTH = 2_000;
const MAX_MATHTEX_REQUEST_JSON_BYTES = 16 * 1024;
const MAX_MATHTEX_RESPONSE_JSON_BYTES = 1024 * 1024;
const MAX_MATHTEX_OUTLINE_SEGMENTS = 2_048;
const MATHTEX_NORMALIZATION_TOLERANCE = 0.000_002;
const MAX_SEGMENTED_TEX_SOURCE_BYTES = 256;
const MAX_SEGMENTED_TEX_PAINT_MATCHES = 4;
const MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES = 64;
const MAX_SEGMENTED_TEX_FRAGMENTS = 128;
const MAX_SEGMENTED_TEX_CUBIC_SEGMENTS = 2_048;
const MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES = 512;
const MAX_U32 = 0xffff_ffff;
export const MAX_TEXT_OUTLINE_SCALARS = 256;
export const MAX_TEXT_OUTLINE_LINES = 8;
export const MAX_TEXT_OUTLINE_LINE_SCALARS = 128;
export const MAX_TEXT_OUTLINE_SEGMENTS = 2_048;

const mathTexOutlineRequestV1Schema = z
  .object({
    schema: z.literal("poietra.mathtex-outline-request"),
    texParts: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_MATHTEX_CONTENT_LENGTH)
          .refine((part) => part.trim().length > 0, "MathTex parts cannot be blank."),
      )
      .min(1)
      .max(MAX_MATHTEX_PARTS)
      .refine(
        (parts) => parts.reduce((length, part) => length + part.length, 0) <= MAX_MATHTEX_CONTENT_LENGTH,
        `MathTex content accepts at most ${MAX_MATHTEX_CONTENT_LENGTH} characters.`,
      ),
    version: z.literal(1),
  })
  .strict();

export const mathTexOutlineArtifactV1Schema = z
  .object({
    bounds: z
      .object({
        bottom: coordinateV1Schema,
        left: coordinateV1Schema,
        right: coordinateV1Schema,
        top: coordinateV1Schema,
      })
      .strict()
      .refine(({ bottom, left, right, top }) => right > left && top > bottom, "MathTex ink bounds must be positive."),
    contentDigest: sha256V1Schema,
    fillRule: z.literal("nonzero"),
    fontDigest: sha256V1Schema,
    kind: z.literal("compiled"),
    path: cubicPathV1Schema,
    toolchainDigest: sha256V1Schema,
  })
  .strict()
  .superRefine(({ bounds, path }, context) => {
    if (countCubicPathSegments(path) > MAX_MATHTEX_OUTLINE_SEGMENTS) {
      context.addIssue({ code: "custom", message: "MathTex outlines accept at most 2,048 cubic segments." });
    }
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "MathTex outline contours must be closed." });
    }
    if (
      Math.abs(bounds.top - bounds.bottom - 1) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.left + bounds.right) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.bottom + bounds.top) > MATHTEX_NORMALIZATION_TOLERANCE
    ) {
      context.addIssue({ code: "custom", message: "MathTex outline bounds must use canonical centered unit height." });
    }
  });

const mathTexOutlineUnsupportedV1Schema = z
  .object({
    code: z.enum([
      "conversion-failed",
      "frame-item-unsupported",
      "internal-failure",
      "invalid-request",
      "layout-failed",
      "outline-invalid",
      "outline-limit-exceeded",
      "request-too-large",
      "response-too-large",
      "syntax-unsupported",
    ]),
    kind: z.literal("unsupported"),
    message: z.string().min(1).max(512),
  })
  .strict();

export const mathTexOutlineResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [mathTexOutlineArtifactV1Schema, mathTexOutlineUnsupportedV1Schema]),
    schema: z.literal("poietra.mathtex-outline-response"),
    version: z.literal(1),
  })
  .strict();

export type MathTexOutlineArtifactV1 = z.infer<typeof mathTexOutlineArtifactV1Schema>;
export type MathTexOutlineResponseV1 = z.infer<typeof mathTexOutlineResponseV1Schema>;
export type MathTexOutlineCompilerV1 = (texParts: readonly string[]) => Promise<MathTexOutlineResponseV1>;

function hasBoundedUtf8Length(value: string, maximum: number) {
  return new TextEncoder().encode(value).byteLength <= maximum;
}

const segmentedTexSourceV1Schema = z
  .string()
  .min(1)
  .refine(
    (source) => hasBoundedUtf8Length(source, MAX_SEGMENTED_TEX_SOURCE_BYTES),
    `Segmented Tex source accepts at most ${MAX_SEGMENTED_TEX_SOURCE_BYTES} UTF-8 bytes.`,
  );

const opaqueRgbaColorV1Schema = rgbaColorV1Schema.extend({ alpha: z.literal(1) });

const segmentedTexPaintMatchV1Schema = z
  .object({
    literal: z
      .string()
      .min(1)
      .refine(
        (literal) => hasBoundedUtf8Length(literal, MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES),
        `Segmented Tex paint literals accept at most ${MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES} UTF-8 bytes.`,
      ),
    paint: opaqueRgbaColorV1Schema,
  })
  .strict();

const segmentedTexOutlineRequestBodyV1Schema = z
  .object({
    mode: z.enum(["tex-text", "mathtex-math"]),
    paintMatches: z.array(segmentedTexPaintMatchV1Schema).max(MAX_SEGMENTED_TEX_PAINT_MATCHES),
    source: segmentedTexSourceV1Schema,
    sourceKind: z.enum(["literal", "dynamic"]),
  })
  .strict();

/** Input body accepted by the browser wrapper; the fixed schema and version are added at the WASM boundary. */
export const segmentedTexOutlineInputV1Schema = segmentedTexOutlineRequestBodyV1Schema;

export const segmentedTexOutlineRequestV1Schema = z
  .object({
    mode: z.enum(["tex-text", "mathtex-math"]),
    paintMatches: z.array(segmentedTexPaintMatchV1Schema).max(MAX_SEGMENTED_TEX_PAINT_MATCHES),
    schema: z.literal("poietra.segmented-tex-outline-request"),
    source: segmentedTexSourceV1Schema,
    sourceKind: z.enum(["literal", "dynamic"]),
    version: z.literal(1),
  })
  .strict();

const segmentedTexByteRangeV1Schema = z
  .object({
    sourceEndByte: z.number().int().positive().max(MAX_U32),
    sourceStartByte: z.number().int().nonnegative().max(MAX_U32),
  })
  .strict()
  .refine(
    ({ sourceEndByte, sourceStartByte }) => sourceStartByte < sourceEndByte,
    "Segmented Tex source byte ranges must be non-empty.",
  );

const segmentedTexSourceCorrelationV1Schema = z.discriminatedUnion("kind", [
  segmentedTexByteRangeV1Schema.safeExtend({ kind: z.literal("exact-byte-range") }),
  segmentedTexByteRangeV1Schema.safeExtend({ kind: z.literal("expression-byte-range") }),
]);

const segmentedTexPaintSpanV1Schema = segmentedTexByteRangeV1Schema.safeExtend({
  paint: opaqueRgbaColorV1Schema,
});

const segmentedTexOutlineBoundsV1Schema = z
  .object({
    bottom: coordinateV1Schema,
    left: coordinateV1Schema,
    right: coordinateV1Schema,
    top: coordinateV1Schema,
  })
  .strict()
  .refine(({ bottom, left, right, top }) => right > left && top > bottom, "Segmented Tex ink bounds must be positive.");

const segmentedTexOutlineFragmentV1Schema = z
  .object({
    bounds: segmentedTexOutlineBoundsV1Schema,
    fillEntityId: z.string(),
    fillRule: z.literal("nonzero"),
    id: z.string(),
    kind: z.enum(["glyph", "rule", "shape", "path"]),
    order: z.number().int().nonnegative().max(MAX_U32),
    outlineEntityId: z.string(),
    paint: opaqueRgbaColorV1Schema,
    path: cubicPathV1Schema,
    sourceCorrelation: segmentedTexSourceCorrelationV1Schema,
  })
  .strict()
  .superRefine(({ path }, context) => {
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "Segmented Tex outline contours must be closed." });
    }
  });

const segmentedTexWritePlanV1Schema = z
  .object({
    fragmentLagRatio: finiteNumberV1Schema.positive().max(0.2),
    outlineStrokeWidth: z.literal(2),
    phaseBoundary: z.literal(0.5),
    representation: z.literal("separate-outline-and-fill-entities"),
  })
  .strict();

function isUtf8Boundary(source: string, byteOffset: number) {
  const bytes = new TextEncoder().encode(source);
  if (byteOffset === 0 || byteOffset === bytes.byteLength) return true;
  return byteOffset > 0 && byteOffset < bytes.byteLength && (bytes[byteOffset] & 0xc0) !== 0x80;
}

export const segmentedTexOutlineArtifactV1Schema = z
  .object({
    bounds: segmentedTexOutlineBoundsV1Schema,
    contentDigest: sha256V1Schema,
    fontDigest: sha256V1Schema,
    fragments: z.array(segmentedTexOutlineFragmentV1Schema).min(1).max(MAX_SEGMENTED_TEX_FRAGMENTS),
    mode: z.enum(["tex-text", "mathtex-math"]),
    paintSpans: z.array(segmentedTexPaintSpanV1Schema).max(MAX_SEGMENTED_TEX_PAINT_MATCHES),
    source: segmentedTexSourceV1Schema,
    toolchainDigest: sha256V1Schema,
    writePlan: segmentedTexWritePlanV1Schema,
  })
  .strict()
  .superRefine(({ bounds, fragments, mode, paintSpans, source }, context) => {
    if (
      Math.abs(bounds.top - bounds.bottom - 1) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.left + bounds.right) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.bottom + bounds.top) > MATHTEX_NORMALIZATION_TOLERANCE
    ) {
      context.addIssue({ code: "custom", message: "Segmented Tex bounds must use canonical centered unit height." });
    }

    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    let segmentCount = 0;
    fragments.forEach((fragment, index) => {
      segmentCount += countCubicPathSegments(fragment.path);
      const expectedId = `fragment-${index.toString().padStart(4, "0")}`;
      if (
        fragment.order !== index ||
        fragment.id !== expectedId ||
        fragment.outlineEntityId !== `${expectedId}:outline` ||
        fragment.fillEntityId !== `${expectedId}:fill`
      ) {
        context.addIssue({
          code: "custom",
          message: "Segmented Tex fragments must preserve canonical order and entity IDs.",
          path: ["fragments", index],
        });
      }
      const { kind, sourceEndByte, sourceStartByte } = fragment.sourceCorrelation;
      if (
        sourceEndByte > sourceByteLength ||
        !isUtf8Boundary(source, sourceStartByte) ||
        !isUtf8Boundary(source, sourceEndByte)
      ) {
        context.addIssue({
          code: "custom",
          message: "Segmented Tex fragment correlation must reference source UTF-8 boundaries.",
          path: ["fragments", index, "sourceCorrelation"],
        });
      }
      if (
        (mode === "tex-text" && kind !== "exact-byte-range") ||
        (mode === "mathtex-math" &&
          (kind !== "expression-byte-range" || sourceStartByte !== 0 || sourceEndByte !== sourceByteLength))
      ) {
        context.addIssue({
          code: "custom",
          message: "Segmented Tex fragment correlation must match the compilation mode.",
          path: ["fragments", index, "sourceCorrelation"],
        });
      }
    });
    if (segmentCount > MAX_SEGMENTED_TEX_CUBIC_SEGMENTS) {
      context.addIssue({ code: "custom", message: "Segmented Tex outlines accept at most 2,048 cubic segments." });
    }

    paintSpans.forEach(({ sourceEndByte, sourceStartByte }, index) => {
      const previous = paintSpans[index - 1];
      if (
        sourceEndByte > sourceByteLength ||
        !isUtf8Boundary(source, sourceStartByte) ||
        !isUtf8Boundary(source, sourceEndByte) ||
        (previous !== undefined && previous.sourceEndByte > sourceStartByte)
      ) {
        context.addIssue({
          code: "custom",
          message: "Segmented Tex paint spans must be ordered, disjoint source UTF-8 ranges.",
          path: ["paintSpans", index],
        });
      }
    });
  });

const segmentedTexOutlineUnsupportedV1Schema = z
  .object({
    code: z.enum([
      "invalid-request",
      "request-too-large",
      "dynamic-source-unsupported",
      "syntax-unsupported",
      "option-unsupported",
      "paint-partition-ambiguous",
      "source-correlation-unsupported",
      "frame-item-unsupported",
      "outline-invalid",
      "outline-limit-exceeded",
      "response-too-large",
      "internal-failure",
    ]),
    kind: z.literal("unsupported"),
    message: z
      .string()
      .min(1)
      .refine(
        (message) => hasBoundedUtf8Length(message, MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES),
        `Segmented Tex unsupported messages accept at most ${MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES} UTF-8 bytes.`,
      ),
  })
  .strict();

const segmentedTexOutlineCompiledV1Schema = segmentedTexOutlineArtifactV1Schema.safeExtend({
  kind: z.literal("compiled"),
});

export const segmentedTexOutlineResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [segmentedTexOutlineCompiledV1Schema, segmentedTexOutlineUnsupportedV1Schema]),
    schema: z.literal("poietra.segmented-tex-outline-response"),
    version: z.literal(1),
  })
  .strict();

export type SegmentedTexOutlineInputV1 = z.infer<typeof segmentedTexOutlineInputV1Schema>;
export type SegmentedTexOutlineRequestV1 = z.infer<typeof segmentedTexOutlineRequestV1Schema>;
export type SegmentedTexOutlineArtifactV1 = z.infer<typeof segmentedTexOutlineArtifactV1Schema>;
export type SegmentedTexOutlineResponseV1 = z.infer<typeof segmentedTexOutlineResponseV1Schema>;
export type SegmentedTexOutlineCompilerV1 = (
  input: SegmentedTexOutlineInputV1,
) => Promise<SegmentedTexOutlineResponseV1>;

function hasUnpairedUtf16Surrogate(text: string) {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const canonicalTextOutlineContentV1Schema = z
  .string()
  .transform((text) => text.replaceAll("\r\n", "\n").normalize("NFC"))
  .superRefine((text, context) => {
    const scalars = [...text];
    if (text.length === 0 || text.trim().length === 0) {
      context.addIssue({ code: "custom", message: "Text must contain visible content." });
    }
    if (hasUnpairedUtf16Surrogate(text)) {
      context.addIssue({ code: "custom", message: "Text must contain valid Unicode scalar values." });
    }
    if (scalars.length > MAX_TEXT_OUTLINE_SCALARS) {
      context.addIssue({ code: "custom", message: "Text accepts at most 256 Unicode scalars." });
    }
    if (scalars.some((scalar) => scalar !== "\n" && /[\u0000-\u001f\u007f-\u009f]/u.test(scalar))) {
      context.addIssue({ code: "custom", message: "Text rejects control characters other than LF." });
    }
  });

const textOutlineContentV1Schema = canonicalTextOutlineContentV1Schema.superRefine((text, context) => {
  const lines = text.split("\n");
  if (lines.length > MAX_TEXT_OUTLINE_LINES) {
    context.addIssue({ code: "custom", message: "Text accepts at most 8 lines." });
  }
  if (lines.some((line) => [...line].length > MAX_TEXT_OUTLINE_LINE_SCALARS)) {
    context.addIssue({ code: "custom", message: "Each Text line accepts at most 128 Unicode scalars." });
  }
});

export const textOutlineLayoutV1Schema = z
  .object({
    alignment: z.enum(["center", "left", "right"]),
    fontFamily: z.enum(["mono", "sans"]).default("sans"),
    fontWeight: z.enum(["bold", "regular"]).default("regular"),
    lineHeight: z.number().finite().positive(),
    wrapWidthEm: z.number().finite().positive().optional(),
  })
  .strict();

/** Returns the LF- and NFC-normalized bounded text accepted by the Rust outline request. */
export function canonicalTextOutlineInputV1(text: unknown): string | null {
  const parsed = textOutlineContentV1Schema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

export const textOutlineRequestV1Schema = z
  .object({
    layout: textOutlineLayoutV1Schema.default({
      alignment: "left",
      fontFamily: "sans",
      fontWeight: "regular",
      lineHeight: 1.2,
    }),
    schema: z.literal("poietra.text-outline-request"),
    text: canonicalTextOutlineContentV1Schema,
    version: z.literal(1),
  })
  .strict()
  .superRefine(({ layout, text }, context) => {
    const lines = text.split("\n");
    if (lines.length > MAX_TEXT_OUTLINE_LINES) {
      context.addIssue({ code: "custom", message: "Text accepts at most 8 explicit lines.", path: ["text"] });
    }
    if (layout.wrapWidthEm === undefined && lines.some((line) => [...line].length > MAX_TEXT_OUTLINE_LINE_SCALARS)) {
      context.addIssue({
        code: "custom",
        message: "Unwrapped Text accepts at most 128 Unicode scalars per line.",
        path: ["text"],
      });
    }
  });

export const textOutlineGlyphFragmentV1Schema = z
  .object({
    order: z.number().int().nonnegative().max(MAX_U32),
    path: cubicPathV1Schema,
    sourceCorrelation: z
      .object({
        key: z
          .string()
          .refine(
            (key) =>
              !hasUnpairedUtf16Surrogate(key) &&
              [...key].length === 1 &&
              key === key.normalize("NFC") &&
              !/^\s$/u.test(key),
            "Text glyph source keys must be one visible NFC Unicode scalar.",
          ),
        kind: z.literal("nfc-scalar"),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ path }, context) => {
    if (path.subpaths.length === 0) {
      context.addIssue({ code: "custom", message: "Text glyph fragments must contain visible contours." });
    }
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "Text glyph fragment contours must be closed." });
    }
  });

export const textOutlineArtifactV1Schema = z
  .object({
    bounds: z
      .object({
        bottom: coordinateV1Schema,
        left: coordinateV1Schema,
        right: coordinateV1Schema,
        top: coordinateV1Schema,
      })
      .strict()
      .refine(({ bottom, left, right, top }) => right > left && top > bottom, "Text ink bounds must be positive."),
    fillRule: z.literal("nonzero"),
    fragments: z.array(textOutlineGlyphFragmentV1Schema).min(1).max(MAX_TEXT_OUTLINE_SCALARS),
    kind: z.literal("compiled"),
    path: cubicPathV1Schema,
  })
  .strict()
  .superRefine(({ bounds, fragments, path }, context) => {
    if (countCubicPathSegments(path) > MAX_TEXT_OUTLINE_SEGMENTS) {
      context.addIssue({ code: "custom", message: "Text outlines accept at most 2,048 cubic segments." });
    }
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "Text outline contours must be closed." });
    }
    if (
      Math.abs(bounds.left + bounds.right) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.bottom + bounds.top) > MATHTEX_NORMALIZATION_TOLERANCE
    ) {
      context.addIssue({ code: "custom", message: "Text outline bounds must use canonical centered coordinates." });
    }
    fragments.forEach((fragment, index) => {
      if (fragment.order !== index) {
        context.addIssue({
          code: "custom",
          message: "Text glyph fragments must preserve canonical reading order.",
          path: ["fragments", index, "order"],
        });
      }
    });
    const fragmentSubpaths = fragments.flatMap((fragment) => fragment.path.subpaths);
    if (JSON.stringify(fragmentSubpaths) !== JSON.stringify(path.subpaths)) {
      context.addIssue({
        code: "custom",
        message: "Text glyph fragments must exactly partition the aggregate outline.",
        path: ["fragments"],
      });
    }
  });

const textOutlineUnsupportedV1Schema = z
  .object({
    code: z.enum([
      "character-unsupported",
      "glyph-missing",
      "internal-failure",
      "invalid-request",
      "outline-invalid",
      "outline-limit-exceeded",
      "request-too-large",
      "response-too-large",
    ]),
    kind: z.literal("unsupported"),
    message: z.string().min(1).max(512),
  })
  .strict();

export const textOutlineResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [textOutlineArtifactV1Schema, textOutlineUnsupportedV1Schema]),
    schema: z.literal("poietra.text-outline-response"),
    version: z.literal(1),
  })
  .strict();

export type TextOutlineArtifactV1 = z.infer<typeof textOutlineArtifactV1Schema>;
export type TextOutlineGlyphFragmentV1 = z.infer<typeof textOutlineGlyphFragmentV1Schema>;
export type TextOutlineResponseV1 = z.infer<typeof textOutlineResponseV1Schema>;
export type TextOutlineInputV1 = Readonly<{
  layout: z.infer<typeof textOutlineLayoutV1Schema>;
  text: string;
}>;
export type TextOutlineCompilerV1 = (input: TextOutlineInputV1) => Promise<TextOutlineResponseV1>;

type PoietraMathTexOutlineWasmModuleV1 = Readonly<{
  compileMathTexOutlineV1: (requestJson: Uint8Array) => Uint8Array;
  compileSegmentedTexOutlineV1?: (requestJson: Uint8Array) => Uint8Array;
  compileTextOutlineV1?: (requestJson: Uint8Array) => Uint8Array;
  default: (input?: unknown) => Promise<unknown>;
  poietraMathTexOutlineAbiVersion: () => number;
  poietraSegmentedTexOutlineAbiVersion?: () => number;
  poietraTextOutlineAbiVersion?: () => number;
}>;

export type SegmentedTexOutlineWasmBindingsV1 = Readonly<{
  compileSegmentedTexOutlineV1?: (requestJson: Uint8Array) => Uint8Array;
  poietraSegmentedTexOutlineAbiVersion?: () => number;
}>;

function browserModuleUrl() {
  if (typeof document === "undefined") return null;
  return new URL("./engine-wasm/mathtex-outline/poietra_mathtex_wasm.js", document.baseURI);
}

async function nodeAssetUrl(fileName: string) {
  const currentUrl = import.meta.url;
  const serverMarker = "/dist-server/";
  const electronMarker = "/dist-electron/";
  const serverIndex = currentUrl.lastIndexOf(serverMarker);
  if (serverIndex >= 0) {
    return new URL(`engine-wasm/mathtex-outline/${fileName}`, currentUrl.slice(0, serverIndex + serverMarker.length));
  }
  const electronIndex = currentUrl.lastIndexOf(electronMarker);
  if (electronIndex >= 0) {
    return new URL(`dist/engine-wasm/mathtex-outline/${fileName}`, currentUrl.slice(0, electronIndex + 1));
  }

  const pathSpecifier = "node:path";
  const urlSpecifier = "node:url";
  const [{ resolve }, { pathToFileURL }] = await Promise.all([
    import(/* @vite-ignore */ pathSpecifier) as Promise<typeof import("node:path")>,
    import(/* @vite-ignore */ urlSpecifier) as Promise<typeof import("node:url")>,
  ]);
  return pathToFileURL(resolve(process.cwd(), "public", "engine-wasm", "mathtex-outline", fileName));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export async function initializePoietraMathTexOutlineBindingsV1(
  candidate: unknown,
  initInput?: unknown,
): Promise<PoietraMathTexOutlineWasmModuleV1> {
  if (!isRecord(candidate) || typeof candidate.default !== "function") {
    throw new Error("The MathTex outline module has no WASM initializer.");
  }
  if (initInput === undefined) await candidate.default();
  else await candidate.default(initInput);
  if (
    typeof candidate.poietraMathTexOutlineAbiVersion !== "function" ||
    candidate.poietraMathTexOutlineAbiVersion() !== POIETRA_MATHTEX_OUTLINE_ABI_VERSION ||
    typeof candidate.compileMathTexOutlineV1 !== "function"
  ) {
    throw new Error(
      `The MathTex outline module does not implement ABI version ${POIETRA_MATHTEX_OUTLINE_ABI_VERSION}.`,
    );
  }
  return candidate as PoietraMathTexOutlineWasmModuleV1;
}

let bindingsPromise: Promise<PoietraMathTexOutlineWasmModuleV1> | null = null;

async function loadPoietraMathTexOutlineBindingsV1() {
  bindingsPromise ??= (async () => {
    const browserUrl = browserModuleUrl();
    const moduleUrl = browserUrl ?? (await nodeAssetUrl("poietra_mathtex_wasm.js"));
    const candidate: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (browserUrl) return initializePoietraMathTexOutlineBindingsV1(candidate);
    const fsSpecifier = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import("node:fs/promises");
    const wasmBytes = await readFile(await nodeAssetUrl("poietra_mathtex_wasm_bg.wasm"));
    return initializePoietraMathTexOutlineBindingsV1(candidate, { module_or_path: wasmBytes });
  })();
  return bindingsPromise;
}

function parseBoundedResponse(responseJson: Uint8Array): MathTexOutlineResponseV1 {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_MATHTEX_RESPONSE_JSON_BYTES
  ) {
    throw new Error("The MathTex outline module returned an invalid or oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
  } catch (cause) {
    throw new Error("The MathTex outline module returned malformed UTF-8 JSON.", { cause });
  }
  const parsed = mathTexOutlineResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The MathTex outline module violated the v1 response contract.", { cause: parsed.error });
  }
  return parsed.data;
}

function parseBoundedTextResponse(responseJson: Uint8Array): TextOutlineResponseV1 {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_MATHTEX_RESPONSE_JSON_BYTES
  ) {
    throw new Error("The Text outline module returned an invalid or oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
  } catch (cause) {
    throw new Error("The Text outline module returned malformed UTF-8 JSON.", { cause });
  }
  const parsed = textOutlineResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The Text outline module violated the v1 response contract.", { cause: parsed.error });
  }
  return parsed.data;
}

function parseBoundedSegmentedResponse(
  responseJson: Uint8Array,
  request: SegmentedTexOutlineRequestV1,
): SegmentedTexOutlineResponseV1 {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_MATHTEX_RESPONSE_JSON_BYTES
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
  if (
    parsed.data.result.kind === "compiled" &&
    (parsed.data.result.mode !== request.mode || parsed.data.result.source !== request.source)
  ) {
    throw new Error("The segmented Tex outline module returned an artifact for a different request.");
  }
  return parsed.data;
}

export const compileMathTexOutlineV1: MathTexOutlineCompilerV1 = async (texParts) => {
  const request = mathTexOutlineRequestV1Schema.parse({
    schema: "poietra.mathtex-outline-request",
    texParts: [...texParts],
    version: 1,
  });
  const requestJson = new TextEncoder().encode(JSON.stringify(request));
  if (requestJson.byteLength > MAX_MATHTEX_REQUEST_JSON_BYTES) {
    throw new Error("The MathTex outline request is oversized.");
  }
  const bindings = await loadPoietraMathTexOutlineBindingsV1();
  return parseBoundedResponse(bindings.compileMathTexOutlineV1(requestJson));
};

/** Creates a bounded browser adapter for the generated segmented Tex/MathTex WASM binding. */
export function createSegmentedTexOutlineCompilerV1(
  getBindings: () => Promise<SegmentedTexOutlineWasmBindingsV1>,
): SegmentedTexOutlineCompilerV1 {
  return async (input) => {
    const request = segmentedTexOutlineRequestV1Schema.parse({
      ...input,
      schema: "poietra.segmented-tex-outline-request",
      version: 1,
    });
    const requestJson = new TextEncoder().encode(JSON.stringify(request));
    if (requestJson.byteLength > MAX_MATHTEX_REQUEST_JSON_BYTES) {
      throw new Error("The segmented Tex outline request is oversized.");
    }
    const bindings = await getBindings();
    if (
      typeof bindings.poietraSegmentedTexOutlineAbiVersion !== "function" ||
      bindings.poietraSegmentedTexOutlineAbiVersion() !== POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION ||
      typeof bindings.compileSegmentedTexOutlineV1 !== "function"
    ) {
      throw new Error(
        `The segmented Tex outline module does not implement ABI version ${POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION}.`,
      );
    }
    return parseBoundedSegmentedResponse(bindings.compileSegmentedTexOutlineV1(requestJson), request);
  };
}

export const compileSegmentedTexOutlineV1 = createSegmentedTexOutlineCompilerV1(loadPoietraMathTexOutlineBindingsV1);

export const compileTextOutlineV1: TextOutlineCompilerV1 = async ({ layout, text }) => {
  const request = textOutlineRequestV1Schema.parse({
    layout,
    schema: "poietra.text-outline-request",
    text,
    version: 1,
  });
  const requestJson = new TextEncoder().encode(JSON.stringify(request));
  if (requestJson.byteLength > MAX_MATHTEX_REQUEST_JSON_BYTES) {
    throw new Error("The Text outline request is oversized.");
  }
  const bindings = await loadPoietraMathTexOutlineBindingsV1();
  if (
    typeof bindings.poietraTextOutlineAbiVersion !== "function" ||
    bindings.poietraTextOutlineAbiVersion() !== POIETRA_TEXT_OUTLINE_ABI_VERSION ||
    typeof bindings.compileTextOutlineV1 !== "function"
  ) {
    throw new Error(`The Text outline module does not implement ABI version ${POIETRA_TEXT_OUTLINE_ABI_VERSION}.`);
  }
  return parseBoundedTextResponse(bindings.compileTextOutlineV1(requestJson));
};
