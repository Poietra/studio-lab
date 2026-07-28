import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import {
  fastManimSandboxBackendFailureCodeV1Schema,
  fastManimSandboxBackendStatusV1Schema,
  MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES,
  MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES,
} from "./fast-manim-sandbox-backend";
import { MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES } from "./fast-manim-snapshot-contract";

const FRAME_METADATA_BYTES = 16 * 1024;
const FRAME_TERMINATOR = 0x0a;
const OPERATION_CODE = { start: 2, status: 1 } as const;

export type FastManimSandboxBrokerOperationV1 = keyof typeof OPERATION_CODE;

export const MAX_FAST_MANIM_SANDBOX_BROKER_STATUS_FRAME_BYTES_V1 = MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES;
export const MAX_FAST_MANIM_SANDBOX_BROKER_START_REQUEST_FRAME_BYTES_V1 =
  4 * Math.ceil(MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES / 3) + FRAME_METADATA_BYTES;
export const MAX_FAST_MANIM_SANDBOX_BROKER_START_RESULT_FRAME_BYTES_V1 =
  4 * Math.ceil(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES / 3) + FRAME_METADATA_BYTES;

const canonicalBase64Within = (maximumDecodedBytes: number) =>
  z
    .string()
    .max(4 * Math.ceil(maximumDecodedBytes / 3))
    .refine((value) => {
      const decoded = Buffer.from(value, "base64");
      return decoded.byteLength <= maximumDecodedBytes && decoded.toString("base64") === value;
    }, "Expected canonical base64 within the decoded byte budget.");

const identityV1Schema = z
  .object({
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    tenantId: opaqueIdV1Schema,
  })
  .strict();
const deadlineEpochMsV1Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const brokerErrorCodeV1Schema = z.enum(["capacity", "cleanup", "internal", "unavailable"]);

export const fastManimSandboxBrokerStatusRequestV1Schema = z
  .object({
    deadlineEpochMs: deadlineEpochMsV1Schema,
    identity: identityV1Schema,
    kind: z.literal("status"),
  })
  .strict();

export const fastManimSandboxBrokerStartRequestV1Schema = z
  .object({
    attestationDigest: sha256V1Schema,
    deadlineEpochMs: deadlineEpochMsV1Schema,
    identity: identityV1Schema,
    kind: z.literal("start"),
    requestBytesBase64: canonicalBase64Within(MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES),
    requestDigest: sha256V1Schema,
  })
  .strict();

export const fastManimSandboxBrokerClientMessageV1Schema = z.discriminatedUnion("kind", [
  fastManimSandboxBrokerStatusRequestV1Schema,
  fastManimSandboxBrokerStartRequestV1Schema,
]);

const brokerErrorV1Schema = z
  .object({
    code: brokerErrorCodeV1Schema,
    kind: z.literal("error"),
  })
  .strict();

const statusResultV1Schema = z
  .object({
    kind: z.literal("status-result"),
    status: fastManimSandboxBackendStatusV1Schema,
  })
  .strict();

const wireBackendResultV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      attestationDigest: sha256V1Schema,
      kind: z.literal("ok"),
      requestDigest: sha256V1Schema,
      resultBytesBase64: canonicalBase64Within(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES),
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

const jobResultV1Schema = z.object({ kind: z.literal("job-result"), result: wireBackendResultV1Schema }).strict();
const fastManimSandboxBrokerServerMessageV1Schema = z.discriminatedUnion("kind", [
  statusResultV1Schema,
  jobResultV1Schema,
  brokerErrorV1Schema,
]);

export type FastManimSandboxBrokerClientMessageV1 = z.infer<typeof fastManimSandboxBrokerClientMessageV1Schema>;
export type FastManimSandboxBrokerServerMessageV1 = z.infer<typeof fastManimSandboxBrokerServerMessageV1Schema>;

export type FastManimSandboxBrokerProtocolErrorCodeV1 = "closed" | "malformed" | "oversized" | "truncated";

export class FastManimSandboxBrokerProtocolErrorV1 extends Error {
  readonly code: FastManimSandboxBrokerProtocolErrorCodeV1;

  constructor(code: FastManimSandboxBrokerProtocolErrorCodeV1) {
    super(`The sandbox broker frame is ${code}.`);
    this.name = "FastManimSandboxBrokerProtocolErrorV1";
    this.code = code;
  }
}

function decodeCanonicalBase64(value: string, maximumDecodedBytes: number) {
  return Uint8Array.from(Buffer.from(canonicalBase64Within(maximumDecodedBytes).parse(value), "base64"));
}

export function encodeFastManimSandboxBrokerRequestBytesV1(value: Uint8Array) {
  if (value.byteLength > MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES) throw new RangeError("Request bytes exceed the budget.");
  return Buffer.from(value).toString("base64");
}

export function decodeFastManimSandboxBrokerRequestBytesV1(value: string) {
  return decodeCanonicalBase64(value, MAX_FAST_MANIM_SANDBOX_REQUEST_BYTES);
}

export function encodeFastManimSandboxBrokerResultBytesV1(value: Uint8Array) {
  if (value.byteLength > MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES)
    throw new RangeError("Result bytes exceed the budget.");
  return Buffer.from(value).toString("base64");
}

export function decodeFastManimSandboxBrokerResultBytesV1(value: string) {
  return decodeCanonicalBase64(value, MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES);
}

type FrameDefinition<T> = readonly [maximumBytes: number, schema: z.ZodType<T>];

function clientDefinition(code: number): FrameDefinition<FastManimSandboxBrokerClientMessageV1> | undefined {
  if (code === OPERATION_CODE.status) {
    return [MAX_FAST_MANIM_SANDBOX_BROKER_STATUS_FRAME_BYTES_V1, fastManimSandboxBrokerStatusRequestV1Schema];
  }
  if (code === OPERATION_CODE.start) {
    return [MAX_FAST_MANIM_SANDBOX_BROKER_START_REQUEST_FRAME_BYTES_V1, fastManimSandboxBrokerStartRequestV1Schema];
  }
  return undefined;
}

function serverDefinition(
  operation: FastManimSandboxBrokerOperationV1,
): FrameDefinition<FastManimSandboxBrokerServerMessageV1> {
  return [
    operation === "status"
      ? MAX_FAST_MANIM_SANDBOX_BROKER_STATUS_FRAME_BYTES_V1
      : MAX_FAST_MANIM_SANDBOX_BROKER_START_RESULT_FRAME_BYTES_V1,
    fastManimSandboxBrokerServerMessageV1Schema,
  ];
}

function encodeFrame<T>(operation: FastManimSandboxBrokerOperationV1, value: T, definition: FrameDefinition<T>) {
  const [maximumBytes, schema] = definition;
  const body = Buffer.from(canonicalJsonV1(schema.parse(value)), "utf8");
  if (body.byteLength === 0 || body.byteLength > maximumBytes) {
    throw new FastManimSandboxBrokerProtocolErrorV1("oversized");
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 2);
  frame.writeUInt8(OPERATION_CODE[operation], 0);
  body.copy(frame, 1);
  frame[frame.byteLength - 1] = FRAME_TERMINATOR;
  return frame;
}

export function encodeFastManimSandboxBrokerClientFrameV1(value: FastManimSandboxBrokerClientMessageV1) {
  const parsed = fastManimSandboxBrokerClientMessageV1Schema.parse(value);
  return encodeFrame(parsed.kind, parsed, clientDefinition(OPERATION_CODE[parsed.kind])!);
}

export function encodeFastManimSandboxBrokerServerFrameV1(
  operation: FastManimSandboxBrokerOperationV1,
  value: FastManimSandboxBrokerServerMessageV1,
) {
  if (
    (operation === "status" && value.kind === "job-result") ||
    (operation === "start" && value.kind === "status-result")
  ) {
    throw new FastManimSandboxBrokerProtocolErrorV1("malformed");
  }
  return encodeFrame(operation, value, serverDefinition(operation));
}

function decodeBody<T>(body: Uint8Array, schema: z.ZodType<T>): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const message = schema.parse(JSON.parse(text));
    if (canonicalJsonV1(message) !== text) throw new Error();
    return message;
  } catch {
    throw new FastManimSandboxBrokerProtocolErrorV1("malformed");
  }
}

class SingleFrameDecoder<T> {
  readonly #definitionForCode: (code: number) => FrameDefinition<T> | undefined;
  #bodyBytes = 0;
  #chunks: Uint8Array[] = [];
  #definition: FrameDefinition<T> | undefined;
  #messageSeen = false;
  #state: "failed" | "finished" | "open" = "open";

  constructor(definitionForCode: (code: number) => FrameDefinition<T> | undefined) {
    this.#definitionForCode = definitionForCode;
  }

  push(chunk: Uint8Array): T | undefined {
    if (this.#state !== "open") throw new FastManimSandboxBrokerProtocolErrorV1("closed");
    if (this.#messageSeen && chunk.byteLength > 0) return this.#fail("malformed");
    try {
      let body = chunk;
      if (!this.#definition) {
        if (chunk.byteLength === 0) return undefined;
        this.#definition = this.#definitionForCode(chunk[0]!);
        if (!this.#definition) return this.#fail("malformed");
        body = chunk.subarray(1);
      }
      const terminator = body.indexOf(FRAME_TERMINATOR);
      if (terminator !== -1 && terminator !== body.byteLength - 1) return this.#fail("malformed");
      const content = terminator === -1 ? body : body.subarray(0, -1);
      if (this.#bodyBytes + content.byteLength > this.#definition[0]) return this.#fail("oversized");
      if (content.byteLength > 0) {
        this.#chunks.push(Uint8Array.from(content));
        this.#bodyBytes += content.byteLength;
      }
      if (terminator === -1) return undefined;
      if (this.#bodyBytes === 0) return this.#fail("malformed");
      const message = decodeBody(Buffer.concat(this.#chunks, this.#bodyBytes), this.#definition[1]);
      this.#messageSeen = true;
      this.#chunks = [];
      return message;
    } catch (error) {
      if (error instanceof FastManimSandboxBrokerProtocolErrorV1) throw this.#markFailed(error);
      throw this.#markFailed(new FastManimSandboxBrokerProtocolErrorV1("malformed"));
    }
  }

  finish() {
    if (this.#state !== "open") throw new FastManimSandboxBrokerProtocolErrorV1("closed");
    if (!this.#messageSeen) return this.#fail("truncated");
    this.#state = "finished";
  }

  #fail(code: FastManimSandboxBrokerProtocolErrorCodeV1): never {
    throw this.#markFailed(new FastManimSandboxBrokerProtocolErrorV1(code));
  }

  #markFailed(error: FastManimSandboxBrokerProtocolErrorV1) {
    this.#state = "failed";
    this.#chunks = [];
    this.#bodyBytes = 0;
    return error;
  }
}

export class FastManimSandboxBrokerClientFrameDecoderV1 extends SingleFrameDecoder<FastManimSandboxBrokerClientMessageV1> {
  constructor() {
    super(clientDefinition);
  }
}

export class FastManimSandboxBrokerServerFrameDecoderV1 extends SingleFrameDecoder<FastManimSandboxBrokerServerMessageV1> {
  constructor(operation: FastManimSandboxBrokerOperationV1) {
    const definition = serverDefinition(operation);
    super((code) => (code === OPERATION_CODE[operation] ? definition : undefined));
  }
}
