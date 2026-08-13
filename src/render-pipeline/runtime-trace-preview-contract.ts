import { z } from "zod";

import { opaqueIdV1Schema, sha256V1Schema, sourceIdentityV1Schema } from "../engine/contracts";
import { sourceBindingV1Schema } from "../engine/source-runtime-identity";
import { manimProjectIdSchema, manimSceneNameSchema, manimSourcePathSchema } from "./manim-identity-contract";
import {
  fastManimRuntimeTraceSourceBindingEndpointV3Schema,
  fastManimRuntimeTraceSourceBindingV3Schema,
  MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3,
} from "./runtime-trace-v3-shared-contract";

export const FAST_MANIM_RUNTIME_TRACE_RUN_SCHEMA_V1 = "poietra.fast-manim-runtime-trace-run" as const;
export const FAST_MANIM_RUNTIME_TRACE_RUN_RESPONSE_ENVELOPE_BYTES_V2 = 256 * 1024;
export const MAX_FAST_MANIM_RUNTIME_TRACE_RUN_ROOTS_V2 = MAX_FAST_MANIM_RUNTIME_TRACE_SOURCE_BINDINGS_V3;

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

const runtimeTraceRunRootV1Schema = z
  .object({
    binding: sourceBindingV1Schema,
    entityId: sourceIdentityV1Schema,
  })
  .strict();
const runtimeTraceRunRootsV1Schema = z.union([
  z.array(runtimeTraceRunRootV1Schema).length(0),
  z.array(runtimeTraceRunRootV1Schema).length(2),
  z.array(runtimeTraceRunRootV1Schema).length(4),
]);

const runtimeTraceRunRootV2Schema = z
  .object({
    binding: fastManimRuntimeTraceSourceBindingV3Schema,
    entityId: sourceIdentityV1Schema,
    evidence: z
      .object({
        endpoints: z
          .object({
            initial: fastManimRuntimeTraceSourceBindingEndpointV3Schema,
            terminal: fastManimRuntimeTraceSourceBindingEndpointV3Schema,
          })
          .strict(),
        updaterStatus: z.enum(["conflict", "none"]),
      })
      .strict(),
  })
  .strict();

/** Internal legacy/failure response. Public HTTP rejects verified V1 views. */
export const fastManimRuntimeTraceRunViewV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      ...runtimeTraceRunBaseShape,
      bundle: z.unknown(),
      roots: runtimeTraceRunRootsV1Schema,
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

export const fastManimRuntimeTraceRunViewV2Schema = z
  .object({
    ...runtimeTraceRunBaseShape,
    bundle: z.unknown(),
    producerEvidence: z
      .object({
        correlationSha256: sha256V1Schema,
        semanticsSha256: sha256V1Schema,
      })
      .strict(),
    roots: z.array(runtimeTraceRunRootV2Schema).max(MAX_FAST_MANIM_RUNTIME_TRACE_RUN_ROOTS_V2),
    status: z.literal("verified"),
    traceDigest: sha256V1Schema,
    version: z.literal(2),
  })
  .strict();

/** Internal runner response union; the public HTTP boundary admits only failures and verified generic V2 views. */
export const fastManimRuntimeTraceRunViewSchema = z.union([
  fastManimRuntimeTraceRunViewV1Schema,
  fastManimRuntimeTraceRunViewV2Schema,
]);

export type FastManimRuntimeTraceRunFailureCodeV1 = z.infer<typeof fastManimRuntimeTraceRunFailureCodeV1Schema>;
export type FastManimRuntimeTraceRunRequestV1 = z.infer<typeof fastManimRuntimeTraceRunRequestV1Schema>;
export type FastManimRuntimeTraceRunViewV1 = z.infer<typeof fastManimRuntimeTraceRunViewV1Schema>;
export type FastManimRuntimeTraceRunViewV2 = z.infer<typeof fastManimRuntimeTraceRunViewV2Schema>;
export type FastManimRuntimeTraceRunView = z.infer<typeof fastManimRuntimeTraceRunViewSchema>;
