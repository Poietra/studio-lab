import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema, manimSourcePathSchema } from "../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "./manim-request-principal";

export const MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1 = "poietra.manim-render-sandbox-request" as const;
export const MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1 = "poietra.manim-render-sandbox-result" as const;
export const MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1 = "poietra.manim-render-sandbox-status" as const;
export const MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V1 = 2 * 1024 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1 = MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V1 + 32 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1 = 128 * 1024 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_LOG_BYTES_V1 = 4 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_FRAME_BYTES_V1 = 3 * 1024 * 1024;

const sceneNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(240);
const canonicalFenceTokenSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .max(40);
const boundedSourceSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V1,
    "Render source exceeds its UTF-8 byte budget.",
  );
const stagingIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const boundedLogSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_MANIM_RENDER_SANDBOX_LOG_BYTES_V1,
    "Render diagnostics exceed their UTF-8 byte budget.",
  );

export const manimRenderSandboxDescriptorV1Schema = z
  .object({
    jobId: opaqueIdV1Schema,
    media: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("thumbnail"), mediaType: z.literal("image/png") }).strict(),
      z.object({ kind: z.literal("video"), mediaType: z.literal("video/mp4") }).strict(),
    ]),
    projectId: manimProjectIdSchema,
    sceneName: sceneNameSchema,
    schema: z.literal(MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V1),
    sessionId: opaqueIdV1Schema,
    source: boundedSourceSchema,
    sourceDigest: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    tenantId: manimTenantIdSchema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.jobId !== `${value.tenantId}/${value.sessionId}`) {
      context.addIssue({ code: "custom", message: "Render job identity does not match its tenant and session." });
    }
    if (createHash("sha256").update(value.source, "utf8").digest("hex") !== value.sourceDigest) {
      context.addIssue({ code: "custom", message: "Render source does not match its declared digest." });
    }
  });

export type ManimRenderSandboxDescriptorV1 = Readonly<z.infer<typeof manimRenderSandboxDescriptorV1Schema>>;

export class SealedManimRenderSandboxRequestV1 {
  readonly byteLength: number;
  readonly descriptor: ManimRenderSandboxDescriptorV1;
  readonly requestDigest: string;
  readonly #bytes: Uint8Array;

  constructor(value: ManimRenderSandboxDescriptorV1) {
    this.descriptor = Object.freeze(manimRenderSandboxDescriptorV1Schema.parse(value));
    const bytes = Buffer.from(canonicalJsonV1(this.descriptor), "utf8");
    if (bytes.byteLength > MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1) {
      throw new RangeError("Render sandbox request exceeds its byte budget.");
    }
    this.#bytes = Uint8Array.from(bytes);
    this.byteLength = bytes.byteLength;
    this.requestDigest = createHash("sha256").update(bytes).digest("hex");
    Object.freeze(this);
  }

  copyBytes() {
    return Uint8Array.from(this.#bytes);
  }
}

export function verifySealedManimRenderSandboxRequestV1(request: SealedManimRenderSandboxRequestV1) {
  const bytes = request.copyBytes();
  return (
    bytes.byteLength === request.byteLength &&
    bytes.byteLength <= MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1 &&
    createHash("sha256").update(bytes).digest("hex") === request.requestDigest &&
    canonicalJsonV1(request.descriptor) === Buffer.from(bytes).toString("utf8")
  );
}

export const manimRenderSandboxFailureCodeV1Schema = z.enum([
  "cancelled",
  "capacity",
  "cleanup-failed",
  "deadline-exceeded",
  "render-failed",
  "request-mismatch",
  "result-rejected",
  "sandbox-unavailable",
]);

const terminalCorrelation = {
  fenceToken: canonicalFenceTokenSchema,
  jobId: opaqueIdV1Schema,
  profileDigest: sha256V1Schema,
  requestDigest: sha256V1Schema,
  runtimeDigest: sha256V1Schema,
  schema: z.literal(MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1),
  version: z.literal(1),
};

export const manimRenderSandboxTerminalV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...terminalCorrelation,
      artifactDigest: sha256V1Schema,
      artifactSize: z.number().int().positive().max(MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1),
      kind: z.literal("ready"),
      logTail: boundedLogSchema,
      mediaType: z.enum(["image/png", "video/mp4"]),
      stagingId: stagingIdSchema,
    })
    .strict(),
  z
    .object({
      ...terminalCorrelation,
      code: manimRenderSandboxFailureCodeV1Schema,
      kind: z.literal("failed"),
      logTail: boundedLogSchema,
    })
    .strict(),
]);

export type ManimRenderSandboxTerminalV1 = Readonly<z.infer<typeof manimRenderSandboxTerminalV1Schema>>;

export const manimRenderSandboxStatusV1Schema = z
  .object({
    backendId: opaqueIdV1Schema,
    health: z.enum(["ready", "unavailable"]),
    profileDigest: sha256V1Schema,
    runtimeDigest: sha256V1Schema,
    schema: z.literal(MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1),
    version: z.literal(1),
  })
  .strict();

export type ManimRenderSandboxStatusV1 = Readonly<z.infer<typeof manimRenderSandboxStatusV1Schema>>;

export function canonicalManimRenderFenceTokenV1(value: bigint) {
  if (value < 0n) throw new RangeError("Render fence token must be non-negative.");
  return canonicalFenceTokenSchema.parse(value.toString(10));
}

export function manimRenderStagingIdV1(jobId: string) {
  return createHash("sha256").update(opaqueIdV1Schema.parse(jobId), "utf8").digest("hex").slice(0, 32);
}

export function encodeManimRenderStagingLocatorV1(
  value: Pick<
    Extract<ManimRenderSandboxTerminalV1, { kind: "ready" }>,
    "artifactDigest" | "artifactSize" | "mediaType" | "requestDigest" | "stagingId"
  >,
) {
  const media = value.mediaType === "video/mp4" ? "mp4" : "png";
  return `render-staging:v1:${value.stagingId}:${media}:${value.artifactSize}:${value.artifactDigest}:${value.requestDigest}`;
}
