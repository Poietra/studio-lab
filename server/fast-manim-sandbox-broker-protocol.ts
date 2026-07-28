import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
  fastManimSandboxBackendFailureCodeV1Schema,
  fastManimSandboxBackendStatusV1Schema,
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
} from "./fast-manim-sandbox-backend";
import { MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES } from "./fast-manim-snapshot-contract";

export const FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1 = "poietra.fast-manim-sandbox-broker" as const;
export const FAST_MANIM_SANDBOX_BROKER_VERSION_V1 = 1 as const;

const FRAME_LENGTH_BYTES = 4;
const MAX_FRAME_METADATA_BYTES = 16 * 1024;
const MAX_FRAME_BINARY_BYTES = Math.max(
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
);

/** Maximum JSON payload size; the four-byte length prefix is not included. */
export const MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1 =
  4 * Math.ceil(MAX_FRAME_BINARY_BYTES / 3) + MAX_FRAME_METADATA_BYTES;

const canonicalBase64Within = (maximumDecodedBytes: number) =>
  z
    .string()
    .max(4 * Math.ceil(maximumDecodedBytes / 3))
    .refine((value) => {
      try {
        const decoded = Buffer.from(value, "base64");
        return decoded.byteLength <= maximumDecodedBytes && decoded.toString("base64") === value;
      } catch {
        return false;
      }
    }, "Expected canonical base64 within the decoded byte budget.");

const requestBytesBase64V1Schema = canonicalBase64Within(MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
const resultBytesBase64V1Schema = canonicalBase64Within(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES);
const deadlineEpochMsV1Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identityV1Schema = z
  .object({
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    tenantId: opaqueIdV1Schema,
  })
  .strict();

const messageBase = {
  correlationId: opaqueIdV1Schema,
  protocol: z.literal(FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1),
  version: z.literal(FAST_MANIM_SANDBOX_BROKER_VERSION_V1),
};

export const fastManimSandboxBrokerClientMessageV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...messageBase,
      deadlineEpochMs: deadlineEpochMsV1Schema,
      identity: identityV1Schema,
      kind: z.literal("status"),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      attestationDigest: sha256V1Schema,
      deadlineEpochMs: deadlineEpochMsV1Schema,
      identity: identityV1Schema,
      jobId: opaqueIdV1Schema,
      kind: z.literal("start"),
      requestBytesBase64: requestBytesBase64V1Schema,
      requestDigest: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      jobId: opaqueIdV1Schema,
      kind: z.literal("abort"),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      kind: z.literal("close"),
    })
    .strict(),
]);

const wireBackendResultV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      attestationDigest: sha256V1Schema,
      kind: z.literal("ok"),
      requestDigest: sha256V1Schema,
      resultBytesBase64: resultBytesBase64V1Schema,
    })
    .strict(),
  z
    .object({
      attestationDigest: sha256V1Schema,
      code: fastManimSandboxBackendFailureCodeV1Schema,
      kind: z.literal("failed"),
      requestDigest: sha256V1Schema,
    })
    .strict(),
]);

export const fastManimSandboxBrokerServerMessageV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...messageBase,
      kind: z.literal("status-result"),
      status: fastManimSandboxBackendStatusV1Schema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      jobId: opaqueIdV1Schema,
      kind: z.literal("job-result"),
      result: wireBackendResultV1Schema,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      jobId: opaqueIdV1Schema,
      kind: z.literal("abort-ack"),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      kind: z.literal("close-ack"),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      code: z.enum(["capacity", "cleanup", "internal", "unavailable"]),
      kind: z.literal("error"),
      operation: z.enum(["status", "start", "abort", "close"]),
    })
    .strict(),
]);

export const fastManimSandboxBrokerMessageV1Schema = z.union([
  fastManimSandboxBrokerClientMessageV1Schema,
  fastManimSandboxBrokerServerMessageV1Schema,
]);

export type FastManimSandboxBrokerClientMessageV1 = z.infer<typeof fastManimSandboxBrokerClientMessageV1Schema>;
export type FastManimSandboxBrokerServerMessageV1 = z.infer<typeof fastManimSandboxBrokerServerMessageV1Schema>;
export type FastManimSandboxBrokerMessageV1 = z.infer<typeof fastManimSandboxBrokerMessageV1Schema>;

export type FastManimSandboxBrokerProtocolErrorCodeV1 = "closed" | "malformed" | "oversized" | "truncated";

export class FastManimSandboxBrokerProtocolErrorV1 extends Error {
  readonly code: FastManimSandboxBrokerProtocolErrorCodeV1;

  constructor(code: FastManimSandboxBrokerProtocolErrorCodeV1) {
    const descriptions: Record<FastManimSandboxBrokerProtocolErrorCodeV1, string> = {
      closed: "The sandbox broker frame decoder is no longer open.",
      malformed: "The sandbox broker frame is malformed.",
      oversized: "The sandbox broker frame exceeds the byte budget.",
      truncated: "The sandbox broker stream ended in a partial frame.",
    };
    super(descriptions[code]);
    this.name = "FastManimSandboxBrokerProtocolErrorV1";
    this.code = code;
  }
}

function decodeCanonicalBase64(value: string, maximumDecodedBytes: number) {
  const parsed = canonicalBase64Within(maximumDecodedBytes).parse(value);
  return Uint8Array.from(Buffer.from(parsed, "base64"));
}

export function encodeFastManimSandboxBrokerRequestBytesV1(value: Uint8Array) {
  if (value.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES) {
    throw new RangeError("Sandbox broker request bytes exceed the byte budget.");
  }
  return Buffer.from(value).toString("base64");
}

export function decodeFastManimSandboxBrokerRequestBytesV1(value: string) {
  return decodeCanonicalBase64(value, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
}

export function encodeFastManimSandboxBrokerResultBytesV1(value: Uint8Array) {
  if (value.byteLength > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES) {
    throw new RangeError("Sandbox broker result bytes exceed the byte budget.");
  }
  return Buffer.from(value).toString("base64");
}

export function decodeFastManimSandboxBrokerResultBytesV1(value: string) {
  return decodeCanonicalBase64(value, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES);
}

export function encodeFastManimSandboxBrokerFrameV1(value: FastManimSandboxBrokerMessageV1): Uint8Array {
  const message = fastManimSandboxBrokerMessageV1Schema.parse(value);
  const body = Buffer.from(canonicalJsonV1(message), "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1) {
    throw new FastManimSandboxBrokerProtocolErrorV1("oversized");
  }
  const frame = Buffer.allocUnsafe(FRAME_LENGTH_BYTES + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, FRAME_LENGTH_BYTES);
  return frame;
}

function decodeFastManimSandboxBrokerFrameBodyV1(body: Uint8Array): FastManimSandboxBrokerMessageV1 {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const message = fastManimSandboxBrokerMessageV1Schema.parse(JSON.parse(text));
    if (canonicalJsonV1(message) !== text) throw new Error("Non-canonical JSON frame.");
    return message;
  } catch {
    throw new FastManimSandboxBrokerProtocolErrorV1("malformed");
  }
}

/**
 * Stateful length-prefixed decoder for arbitrary stream chunking. `finish`
 * represents transport disconnect: a clean boundary succeeds, while a partial
 * header or body fails closed. The connection owner must abort its jobs on
 * every disconnect, independently of whether framing was clean.
 */
export class FastManimSandboxBrokerFrameDecoderV1 {
  readonly #header = new Uint8Array(FRAME_LENGTH_BYTES);
  #headerBytes = 0;
  #body: Uint8Array | undefined;
  #bodyBytes = 0;
  #state: "failed" | "finished" | "open" = "open";

  push(chunk: Uint8Array): FastManimSandboxBrokerMessageV1[] {
    if (this.#state !== "open") throw new FastManimSandboxBrokerProtocolErrorV1("closed");
    const messages: FastManimSandboxBrokerMessageV1[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        if (this.#body === undefined) {
          const copied = Math.min(FRAME_LENGTH_BYTES - this.#headerBytes, chunk.byteLength - offset);
          this.#header.set(chunk.subarray(offset, offset + copied), this.#headerBytes);
          this.#headerBytes += copied;
          offset += copied;
          if (this.#headerBytes < FRAME_LENGTH_BYTES) continue;

          const bodyLength = new DataView(this.#header.buffer).getUint32(0, false);
          this.#headerBytes = 0;
          if (bodyLength === 0) throw new FastManimSandboxBrokerProtocolErrorV1("malformed");
          if (bodyLength > MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1) {
            throw new FastManimSandboxBrokerProtocolErrorV1("oversized");
          }
          this.#body = new Uint8Array(bodyLength);
          this.#bodyBytes = 0;
        }

        const copied = Math.min(this.#body.byteLength - this.#bodyBytes, chunk.byteLength - offset);
        this.#body.set(chunk.subarray(offset, offset + copied), this.#bodyBytes);
        this.#bodyBytes += copied;
        offset += copied;
        if (this.#bodyBytes !== this.#body.byteLength) continue;

        messages.push(decodeFastManimSandboxBrokerFrameBodyV1(this.#body));
        this.#body = undefined;
        this.#bodyBytes = 0;
      }
    } catch (error) {
      this.#state = "failed";
      this.#body = undefined;
      this.#bodyBytes = 0;
      if (error instanceof FastManimSandboxBrokerProtocolErrorV1) throw error;
      throw new FastManimSandboxBrokerProtocolErrorV1("malformed");
    }
    return messages;
  }

  finish() {
    if (this.#state !== "open") throw new FastManimSandboxBrokerProtocolErrorV1("closed");
    if (this.#headerBytes !== 0 || this.#body !== undefined) {
      this.#state = "failed";
      this.#body = undefined;
      this.#bodyBytes = 0;
      throw new FastManimSandboxBrokerProtocolErrorV1("truncated");
    }
    this.#state = "finished";
  }
}
