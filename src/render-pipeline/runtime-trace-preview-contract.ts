import { z } from "zod";

import { opaqueIdV1Schema, sha256V1Schema, sourceIdentityV1Schema } from "../engine/contracts";
import { sourceBindingV1Schema } from "../engine/source-runtime-identity";
import { manimProjectIdSchema, manimSceneNameSchema, manimSourcePathSchema } from "./manim-identity-contract";

export const FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1 = "poietra.fast-manim-runtime-trace-run" as const;

/** Browser-to-server request for the one bounded Runtime Trace preview profile. */
export const fastManimRuntimeTraceRunRequestV1Schema = z
  .object({
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    sceneName: manimSceneNameSchema,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
  })
  .strict();

export const fastManimRuntimeTraceRunFailureCodeV1Schema = z.enum([
  "producer-exit",
  "producer-output-overflow",
  "producer-spawn-failed",
  "producer-timeout",
  "result-rejected",
  "runtime-config-changed",
  "sandbox-attestation-rejected",
  "sandbox-execution-failed",
  "sandbox-result-rejected",
  "sandbox-unavailable",
  "source-changed",
  "source-correlation-stale",
  "unsupported-profile",
]);

const runtimeTraceRunBaseShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  runtimeConfigHash: sha256V1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: manimSceneNameSchema,
  schema: z.literal(FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1),
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
  version: z.literal(1),
};

/** Unpublished, request-scoped response consumed directly by Studio preview. */
export const fastManimRuntimeTraceRunViewV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      ...runtimeTraceRunBaseShape,
      bundle: z.unknown(),
      roots: z
        .array(
          z
            .object({
              binding: sourceBindingV1Schema,
              entityId: sourceIdentityV1Schema,
            })
            .strict(),
        )
        .length(2),
      status: z.literal("verified"),
      traceDigest: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      ...runtimeTraceRunBaseShape,
      failure: z
        .object({
          code: fastManimRuntimeTraceRunFailureCodeV1Schema,
          message: z.string().min(1).max(500),
        })
        .strict(),
      status: z.literal("failed"),
    })
    .strict(),
]);

export type FastManimRuntimeTraceRunFailureCodeV1 = z.infer<typeof fastManimRuntimeTraceRunFailureCodeV1Schema>;
export type FastManimRuntimeTraceRunRequestV1 = z.infer<typeof fastManimRuntimeTraceRunRequestV1Schema>;
export type FastManimRuntimeTraceRunViewV1 = z.infer<typeof fastManimRuntimeTraceRunViewV1Schema>;
