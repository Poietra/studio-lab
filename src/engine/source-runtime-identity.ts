import { z } from "zod";

import { sha256V1Schema, sourceIdentityV1Schema } from "./contracts";

export const FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1 =
  "poietra.fast-manim-source-runtime-identity" as const;
export const FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1 = 1 as const;
export const STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1 =
  "poietra.studio-verified-source-runtime-identity-map" as const;

export const sourceBindingSpanV1Schema = z
  .object({
    endColumn: z.number().int().nonnegative(),
    endLine: z.number().int().positive(),
    startColumn: z.number().int().nonnegative(),
    startLine: z.number().int().positive(),
  })
  .strict();

export const sourceBindingV1Schema = z
  .object({
    id: sourceIdentityV1Schema,
    name: z.string().min(1).max(240),
    ordinal: z.number().int().positive().max(10_000),
    span: sourceBindingSpanV1Schema,
  })
  .strict();

export const verifiedSourceRuntimeMappingV1Schema = z
  .object({
    binding: sourceBindingV1Schema,
    entityId: sourceIdentityV1Schema,
    familyPath: z.array(z.number().int().nonnegative().max(9_999)).max(64),
    provenanceId: sourceIdentityV1Schema,
  })
  .strict();

/**
 * Browser-safe output of the server identity verifier. Raw producer issues,
 * runtime type labels, lifecycle diagnostics, and non-mapped claims never
 * cross this boundary.
 */
export const verifiedSourceRuntimeIdentityMapV1Schema = z
  .object({
    mappings: z.array(verifiedSourceRuntimeMappingV1Schema).max(10_000),
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    schema: z.literal(STUDIO_VERIFIED_SOURCE_RUNTIME_IDENTITY_MAP_SCHEMA_V1),
    snapshotDigest: sha256V1Schema,
    snapshotHash: sha256V1Schema,
    sourceHash: sha256V1Schema,
    version: z.literal(1),
  })
  .strict();

export type SourceBindingSpanV1 = z.infer<typeof sourceBindingSpanV1Schema>;
export type SourceBindingV1 = z.infer<typeof sourceBindingV1Schema>;
export type VerifiedSourceRuntimeMappingV1 = z.infer<typeof verifiedSourceRuntimeMappingV1Schema>;
export type VerifiedSourceRuntimeIdentityMapV1 = z.infer<typeof verifiedSourceRuntimeIdentityMapV1Schema>;
