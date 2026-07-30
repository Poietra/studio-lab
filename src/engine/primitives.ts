import { z } from "zod";

export const POIETRA_ENGINE_CONTRACT_VERSION = 1 as const;
export const MAX_COORDINATE = 1_000_000_000;
export const MAX_TOTAL_PATH_SEGMENTS = 100_000;

export const finiteNumberV1Schema = z.number().finite();
export const coordinateV1Schema = finiteNumberV1Schema.min(-MAX_COORDINATE).max(MAX_COORDINATE);
export const normalizedNumberV1Schema = finiteNumberV1Schema.min(0).max(1);

function boundedUnpaddedString(maximum: number, label: string) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), `${label} must not have surrounding whitespace.`)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), `${label} must not contain control characters.`);
}

export const opaqueIdV1Schema = boundedUnpaddedString(240, "IDs").refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value),
  "IDs must use the portable ASCII identifier subset.",
);
export const sourceIdentityV1Schema = boundedUnpaddedString(240, "Source identities").refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:@/#-]*$/.test(value),
  "Source identities must use the portable ASCII identity subset.",
);
export const assetIdV1Schema = opaqueIdV1Schema;
export const evidenceV1Schema = boundedUnpaddedString(500, "Evidence");
export const sha256V1Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lower-case SHA-256 digest.");

export const enginePointV1Schema = z
  .object({
    x: coordinateV1Schema,
    y: coordinateV1Schema,
  })
  .strict();

export const engineAffineTransformV1Schema = z
  .object({
    m11: finiteNumberV1Schema,
    m12: finiteNumberV1Schema,
    m21: finiteNumberV1Schema,
    m22: finiteNumberV1Schema,
    tx: coordinateV1Schema,
    ty: coordinateV1Schema,
  })
  .strict();

/**
 * Smallest determinant magnitude an affine sample may carry and still be
 * prepared as f32 renderer geometry.
 *
 * The authoritative contract domain is f64, but the renderer converts geometry
 * to f32 before WGPU preparation, so the boundary that matters is the smallest
 * normal f32. Below it a determinant is a subnormal or zero in the renderer's
 * domain: preparation collapses and fails the *complete* frame, which is an
 * availability failure for input the snapshot profile sealed as verified
 * (`stretch(1e-50, 1)` is finite, bounded, and non-zero).
 *
 * Stable across WASM and native because it is not a tuned tolerance.
 * `f32::MIN_POSITIVE` is a fixed IEEE-754 binary32 quantity, and the predicate
 * reaches it only through operations IEEE-754 pins exactly in both targets:
 * round-to-nearest-even f64 -> f32 conversion (`Math.fround` here, `as f32` in
 * Rust) and one f64 multiply-subtract. No platform math library is involved,
 * so the same matrix classifies identically everywhere.
 *
 * Mirrored by `MIN_AFFINE_DETERMINANT_V1` in `poietra-scene-ir`.
 */
export const MIN_AFFINE_DETERMINANT = 1.1754943508222875e-38;

/**
 * Determinant of `transform` as the renderer will see it.
 *
 * Entries are rounded to f32 first: an entry can underflow on its own
 * (`m11 = 1e-50` with `m22 = 1e30` has an f64 determinant of `1e-20`, but
 * `m11` is zero once rounded), so an f64-only determinant would miss the
 * collapse this guard exists to catch.
 */
export function renderedAffineDeterminant(transform: { m11: number; m12: number; m21: number; m22: number }): number {
  return (
    Math.fround(transform.m11) * Math.fround(transform.m22) - Math.fround(transform.m12) * Math.fround(transform.m21)
  );
}

/**
 * Whether an affine sample is singular, or near enough that f32 preparation
 * would collapse it. An exactly singular transform — reflection's midpoint,
 * for instance — is the `determinant === 0` case and is unchanged.
 */
export function isSingularAffineTransform(transform: { m11: number; m12: number; m21: number; m22: number }): boolean {
  // Negated comparison so a NaN determinant classifies as singular rather than
  // reaching preparation.
  return !(Math.abs(renderedAffineDeterminant(transform)) >= MIN_AFFINE_DETERMINANT);
}

export const rgbaColorV1Schema = z
  .object({
    alpha: normalizedNumberV1Schema,
    blue: normalizedNumberV1Schema,
    green: normalizedNumberV1Schema,
    red: normalizedNumberV1Schema,
  })
  .strict();

const cubicSegmentV1Schema = z
  .object({
    control1: enginePointV1Schema,
    control2: enginePointV1Schema,
    end: enginePointV1Schema,
  })
  .strict();

const cubicSubpathV1Schema = z
  .object({
    closed: z.boolean(),
    segments: z.array(cubicSegmentV1Schema).min(1).max(MAX_TOTAL_PATH_SEGMENTS),
    start: enginePointV1Schema,
  })
  .strict();

export function countCubicPathSegments(
  path: Readonly<{ subpaths: readonly Readonly<{ segments: readonly unknown[] }>[] }>,
) {
  return path.subpaths.reduce((total, subpath) => total + subpath.segments.length, 0);
}

export const cubicPathV1Schema = z
  .object({
    subpaths: z.array(cubicSubpathV1Schema).min(1).max(MAX_TOTAL_PATH_SEGMENTS),
  })
  .strict()
  .superRefine((path, context) => {
    if (countCubicPathSegments(path) > MAX_TOTAL_PATH_SEGMENTS) {
      context.addIssue({
        code: "custom",
        message: `A cubic path accepts at most ${MAX_TOTAL_PATH_SEGMENTS} segments.`,
      });
    }
  });

export const assetReferenceV1Schema = z
  .object({
    assetId: assetIdV1Schema,
    sha256: sha256V1Schema,
  })
  .strict();

export const assetManifestReferenceV1Schema = z
  .object({
    manifestDigest: sha256V1Schema,
    manifestId: opaqueIdV1Schema,
  })
  .strict();

export const fillStyleV1Schema = z
  .object({
    color: rgbaColorV1Schema,
    rule: z.enum(["evenodd", "nonzero"]),
  })
  .strict();

export const strokeStyleV1Schema = z
  .object({
    cap: z.enum(["butt", "round", "square"]),
    color: rgbaColorV1Schema,
    join: z.enum(["bevel", "miter", "round"]),
    miterLimit: finiteNumberV1Schema.min(1).max(1_000),
    widthWorld: finiteNumberV1Schema.positive().max(MAX_COORDINATE),
  })
  .strict();

export function reportDuplicateIds(
  values: readonly Readonly<{ id: string }>[],
  path: string,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({ code: "custom", message: `Duplicate ID ${value.id}.`, path: [path, index, "id"] });
    }
    seen.add(value.id);
  });
}

export type CubicPathV1 = z.infer<typeof cubicPathV1Schema>;
export type EngineAffineTransformV1 = z.infer<typeof engineAffineTransformV1Schema>;
export type EnginePointV1 = z.infer<typeof enginePointV1Schema>;
