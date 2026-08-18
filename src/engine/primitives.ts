import { z } from "zod";

export const POIETRA_ENGINE_CONTRACT_VERSION = 1 as const;
export const MAX_COORDINATE = 1_000_000_000;
export const MAX_FINITE_F32 = 3.402_823_466_385_288_6e38;
export const MAX_FRAGMENT_MATERIAL_PARAMETERS_V1 = 8;
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

export const fragmentMaterialV1Schema = z
  .object({
    parameters: z
      .array(finiteNumberV1Schema.min(-MAX_FINITE_F32).max(MAX_FINITE_F32))
      .max(MAX_FRAGMENT_MATERIAL_PARAMETERS_V1),
    revision: z.number().int().positive().max(0xffff_ffff),
    shaderId: opaqueIdV1Schema,
  })
  .strict();

export const fillStyleV1Schema = z
  .object({
    color: rgbaColorV1Schema,
    fragmentMaterial: fragmentMaterialV1Schema.optional(),
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
