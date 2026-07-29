import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema, manimSourcePathSchema } from "../src/render-pipeline/contracts";
import { manimTenantIdSchema } from "./manim-request-principal";
import {
  MAX_PROJECT_PNG_BYTES_V1,
  MAX_PROJECT_PNG_DIMENSION_V1,
  MAX_PROJECT_PNG_PIXELS_V1,
  PROJECT_PNG_LOGICAL_PATH_V1,
} from "./storage/project-png-storage";

export const MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2 = "poietra.manim-render-sandbox-request" as const;
export const MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1 = "poietra.manim-render-sandbox-result" as const;
export const MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1 = "poietra.manim-render-sandbox-status" as const;
export const MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V2 = 2 * 1024 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_ASSET_BYTES_V2 = MAX_PROJECT_PNG_BYTES_V1;
const MAX_MANIM_RENDER_SANDBOX_ASSET_BASE64_BYTES_V2 = 4 * Math.ceil(MAX_MANIM_RENDER_SANDBOX_ASSET_BYTES_V2 / 3);
export const MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V2 =
  MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V2 + MAX_MANIM_RENDER_SANDBOX_ASSET_BASE64_BYTES_V2 + 64 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1 = 128 * 1024 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_LOG_BYTES_V1 = 4 * 1024;
export const MAX_MANIM_RENDER_SANDBOX_FRAME_BYTES_V2 =
  4 * Math.ceil(MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V2 / 3) + 32 * 1024;
export const MANIM_RENDER_CANONICAL_SCENE_FRAME_V1 = Object.freeze({
  height: 8 as const,
  width: 128 / 9,
});

export function digestManimRenderStagingRootV1(stagingRoot: string) {
  if (
    typeof stagingRoot !== "string" ||
    !isAbsolute(stagingRoot) ||
    resolve(stagingRoot) !== stagingRoot ||
    stagingRoot.includes("\0") ||
    Buffer.byteLength(stagingRoot, "utf8") > 4_096
  ) {
    throw new TypeError("Render staging root must be canonical and absolute.");
  }
  return createHash("sha256").update(`poietra.render-staging-root.v1\0${stagingRoot}`, "utf8").digest("hex");
}

const sceneNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(240);
const canonicalFenceTokenSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .max(40);
const deadlineEpochMsSchema = z.number().int().safe().positive();
const boundedSourceSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_MANIM_RENDER_SANDBOX_SOURCE_BYTES_V2,
    "Render source exceeds its UTF-8 byte budget.",
  );
const projectPngAssetSchema = z
  .object({
    byteLength: z.number().int().positive().max(MAX_MANIM_RENDER_SANDBOX_ASSET_BYTES_V2),
    bytesBase64: z.string().max(MAX_MANIM_RENDER_SANDBOX_ASSET_BASE64_BYTES_V2),
    digest: sha256V1Schema,
    height: z.number().int().positive().max(MAX_PROJECT_PNG_DIMENSION_V1),
    logicalPath: z.literal(PROJECT_PNG_LOGICAL_PATH_V1),
    mediaType: z.literal("image/png"),
    width: z.number().int().positive().max(MAX_PROJECT_PNG_DIMENSION_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64) {
      context.addIssue({ code: "custom", message: "Render asset bytes must use canonical base64." });
      return;
    }
    const signature = "89504e470d0a1a0a";
    if (
      bytes.byteLength !== value.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== value.digest ||
      bytes.byteLength < 24 ||
      bytes.subarray(0, 8).toString("hex") !== signature ||
      bytes.readUInt32BE(16) !== value.width ||
      bytes.readUInt32BE(20) !== value.height ||
      value.width * value.height > MAX_PROJECT_PNG_PIXELS_V1
    ) {
      context.addIssue({ code: "custom", message: "Render asset metadata does not match its PNG bytes." });
    }
  });
const stagingIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const boundedLogSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_MANIM_RENDER_SANDBOX_LOG_BYTES_V1,
    "Render diagnostics exceed their UTF-8 byte budget.",
  );

export const manimRenderSandboxDescriptorV2Schema = z
  .object({
    assets: z.array(projectPngAssetSchema).max(1).default([]),
    deadlineEpochMs: deadlineEpochMsSchema,
    fenceToken: canonicalFenceTokenSchema,
    jobId: opaqueIdV1Schema,
    output: z.discriminatedUnion("kind", [
      z
        .object({
          frameRate: z.literal(15),
          kind: z.literal("thumbnail"),
          mediaType: z.literal("image/png"),
          pixelHeight: z.literal(480),
          pixelWidth: z.literal(854),
        })
        .strict(),
      z
        .object({
          frameRate: z.literal(15),
          kind: z.literal("video"),
          mediaType: z.literal("video/mp4"),
          pixelHeight: z.literal(480),
          pixelWidth: z.literal(854),
        })
        .strict(),
    ]),
    profileDigest: sha256V1Schema,
    projectId: manimProjectIdSchema,
    runtimeDigest: sha256V1Schema,
    sceneFrame: z
      .object({
        height: z.literal(MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.height),
        width: z.literal(MANIM_RENDER_CANONICAL_SCENE_FRAME_V1.width),
      })
      .strict(),
    sceneName: sceneNameSchema,
    schema: z.literal(MANIM_RENDER_SANDBOX_REQUEST_SCHEMA_V2),
    sessionId: opaqueIdV1Schema,
    source: boundedSourceSchema,
    sourceDigest: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    tenantId: manimTenantIdSchema,
    version: z.literal(2),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.jobId !== `${value.tenantId}/${value.sessionId}`) {
      context.addIssue({
        code: "custom",
        message: "Render job identity does not match its tenant and session.",
      });
    }
    if (createHash("sha256").update(value.source, "utf8").digest("hex") !== value.sourceDigest) {
      context.addIssue({
        code: "custom",
        message: "Render source does not match its declared digest.",
      });
    }
  });

export type ManimRenderSandboxDescriptorV2 = Readonly<z.infer<typeof manimRenderSandboxDescriptorV2Schema>>;
export type ManimRenderSandboxDescriptorInputV2 = Readonly<z.input<typeof manimRenderSandboxDescriptorV2Schema>>;

export class SealedManimRenderSandboxRequestV2 {
  readonly byteLength: number;
  readonly requestDigest: string;
  readonly #bytes: Uint8Array;

  constructor(value: ManimRenderSandboxDescriptorInputV2) {
    const descriptor = manimRenderSandboxDescriptorV2Schema.parse(value);
    const bytes = Buffer.from(canonicalJsonV1(descriptor), "utf8");
    if (bytes.byteLength > MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V2) {
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

  parseDescriptor() {
    return manimRenderSandboxDescriptorV2Schema.parse(JSON.parse(Buffer.from(this.#bytes).toString("utf8")));
  }
}

export function verifySealedManimRenderSandboxRequestV2(request: SealedManimRenderSandboxRequestV2) {
  const bytes = request.copyBytes();
  return (
    bytes.byteLength === request.byteLength &&
    bytes.byteLength <= MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V2 &&
    createHash("sha256").update(bytes).digest("hex") === request.requestDigest &&
    canonicalJsonV1(request.parseDescriptor()) === Buffer.from(bytes).toString("utf8")
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
  deadlineEpochMs: deadlineEpochMsSchema,
  fenceToken: canonicalFenceTokenSchema,
  jobId: opaqueIdV1Schema,
  profileDigest: sha256V1Schema,
  requestDigest: sha256V1Schema,
  runtimeDigest: sha256V1Schema,
  schema: z.literal(MANIM_RENDER_SANDBOX_RESULT_SCHEMA_V1),
  sessionId: opaqueIdV1Schema,
  sourceDigest: sha256V1Schema,
  tenantId: manimTenantIdSchema,
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
    stagingRootDigest: sha256V1Schema,
    schema: z.literal(MANIM_RENDER_SANDBOX_STATUS_SCHEMA_V1),
    version: z.literal(1),
  })
  .strict();

export type ManimRenderSandboxStatusV1 = Readonly<z.infer<typeof manimRenderSandboxStatusV1Schema>>;

export function canonicalManimRenderFenceTokenV1(value: bigint) {
  if (value < 0n) throw new RangeError("Render fence token must be non-negative.");
  return canonicalFenceTokenSchema.parse(value.toString(10));
}

export function digestManimRenderSandboxExecutionV2(descriptor: ManimRenderSandboxDescriptorV2) {
  const { fenceToken: _fenceToken, ...stable } = manimRenderSandboxDescriptorV2Schema.parse(descriptor);
  return createHash("sha256").update(canonicalJsonV1(stable), "utf8").digest("hex");
}

export function manimRenderStagingIdV1(jobId: string, mediaKind: "thumbnail" | "video") {
  return createHash("sha256")
    .update(canonicalJsonV1({ jobId: opaqueIdV1Schema.parse(jobId), mediaKind }), "utf8")
    .digest("hex")
    .slice(0, 32);
}

const manimRenderStagingLocatorPayloadV1Schema = z
  .object({
    artifactDigest: sha256V1Schema,
    artifactSize: z.number().int().positive().max(MAX_MANIM_RENDER_SANDBOX_ARTIFACT_BYTES_V1),
    deadlineEpochMs: deadlineEpochMsSchema,
    fenceToken: canonicalFenceTokenSchema,
    jobId: opaqueIdV1Schema,
    mediaType: z.enum(["image/png", "video/mp4"]),
    profileDigest: sha256V1Schema,
    requestDigest: sha256V1Schema,
    runtimeDigest: sha256V1Schema,
    sessionId: opaqueIdV1Schema,
    sourceDigest: sha256V1Schema,
    stagingId: stagingIdSchema,
    tenantId: manimTenantIdSchema,
    version: z.literal(1),
  })
  .strict();

export function encodeManimRenderStagingLocatorV1(value: Extract<ManimRenderSandboxTerminalV1, { kind: "ready" }>) {
  const { kind: _kind, logTail: _logTail, schema: _schema, ...correlation } = value;
  return `render-staging:v1:${Buffer.from(
    canonicalJsonV1(manimRenderStagingLocatorPayloadV1Schema.parse(correlation)),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeManimRenderStagingLocatorV1(value: string) {
  if (!value.startsWith("render-staging:v1:") || Buffer.byteLength(value, "utf8") > 2_048) {
    throw new TypeError("The render staging locator is invalid.");
  }
  const encoded = value.slice("render-staging:v1:".length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new TypeError("The render staging locator is invalid.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = manimRenderStagingLocatorPayloadV1Schema.parse(JSON.parse(text));
  if (canonicalJsonV1(parsed) !== text) throw new TypeError("The render staging locator is invalid.");
  return parsed;
}
