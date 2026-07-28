import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema } from "../src/engine/primitives";
import {
  manimRenderSandboxStatusV1Schema,
  manimRenderSandboxTerminalV1Schema,
  MAX_MANIM_RENDER_SANDBOX_FRAME_BYTES_V1,
  MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1,
} from "./manim-render-sandbox-contract";

const OPERATION = { cancel: 3, status: 1, submit: 2 } as const;
export type ManimRenderSandboxBrokerOperationV1 = keyof typeof OPERATION;
const deadlineSchema = z.number().int().safe().positive();
const canonicalRequestBase64Schema = z
  .string()
  .max(4 * Math.ceil(MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1 / 3))
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.byteLength <= MAX_MANIM_RENDER_SANDBOX_REQUEST_BYTES_V1 && bytes.toString("base64") === value;
  });

export const manimRenderSandboxBrokerClientMessageV1Schema = z.discriminatedUnion("kind", [
  z.object({ deadlineEpochMs: deadlineSchema, kind: z.literal("status") }).strict(),
  z
    .object({
      deadlineEpochMs: deadlineSchema,
      kind: z.literal("submit"),
      requestBytesBase64: canonicalRequestBase64Schema,
      requestDigest: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      deadlineEpochMs: deadlineSchema,
      jobId: opaqueIdV1Schema,
      kind: z.literal("cancel"),
    })
    .strict(),
]);
export type ManimRenderSandboxBrokerClientMessageV1 = z.infer<typeof manimRenderSandboxBrokerClientMessageV1Schema>;

const brokerErrorSchema = z
  .object({ code: z.enum(["capacity", "cleanup", "internal", "unavailable"]), kind: z.literal("error") })
  .strict();
export const manimRenderSandboxBrokerServerMessageV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status-result"), status: manimRenderSandboxStatusV1Schema }).strict(),
  z.object({ kind: z.literal("job-result"), result: manimRenderSandboxTerminalV1Schema }).strict(),
  z.object({ cancelled: z.literal(true), kind: z.literal("cancel-result") }).strict(),
  brokerErrorSchema,
]);
export type ManimRenderSandboxBrokerServerMessageV1 = z.infer<typeof manimRenderSandboxBrokerServerMessageV1Schema>;

export class ManimRenderSandboxBrokerProtocolErrorV1 extends Error {
  constructor(readonly code: "closed" | "malformed" | "oversized" | "truncated") {
    super(`The render sandbox broker frame is ${code}.`);
    this.name = "ManimRenderSandboxBrokerProtocolErrorV1";
  }
}

function operationForCode(code: number): ManimRenderSandboxBrokerOperationV1 | undefined {
  return (Object.entries(OPERATION) as [ManimRenderSandboxBrokerOperationV1, number][]).find(
    (entry) => entry[1] === code,
  )?.[0];
}

function encode(
  operation: ManimRenderSandboxBrokerOperationV1,
  value: ManimRenderSandboxBrokerClientMessageV1 | ManimRenderSandboxBrokerServerMessageV1,
  schema: z.ZodType<ManimRenderSandboxBrokerClientMessageV1 | ManimRenderSandboxBrokerServerMessageV1>,
) {
  const body = Buffer.from(canonicalJsonV1(schema.parse(value)), "utf8");
  if (body.byteLength < 1 || body.byteLength > MAX_MANIM_RENDER_SANDBOX_FRAME_BYTES_V1) {
    throw new ManimRenderSandboxBrokerProtocolErrorV1("oversized");
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 2);
  frame[0] = OPERATION[operation];
  body.copy(frame, 1);
  frame[frame.byteLength - 1] = 0x0a;
  return frame;
}

export function encodeManimRenderSandboxBrokerClientFrameV1(value: ManimRenderSandboxBrokerClientMessageV1) {
  const parsed = manimRenderSandboxBrokerClientMessageV1Schema.parse(value);
  return encode(parsed.kind, parsed, manimRenderSandboxBrokerClientMessageV1Schema);
}

export function encodeManimRenderSandboxBrokerServerFrameV1(
  operation: ManimRenderSandboxBrokerOperationV1,
  value: ManimRenderSandboxBrokerServerMessageV1,
) {
  return encode(operation, value, manimRenderSandboxBrokerServerMessageV1Schema);
}

class Decoder<T> {
  #body: Buffer[] = [];
  #bytes = 0;
  #closed = false;
  readonly #expectedOperation: ManimRenderSandboxBrokerOperationV1 | undefined;
  #operation: ManimRenderSandboxBrokerOperationV1 | undefined;
  #seen = false;
  readonly #schema: z.ZodType<T>;

  constructor(schema: z.ZodType<T>, expectedOperation?: ManimRenderSandboxBrokerOperationV1) {
    this.#schema = schema;
    this.#expectedOperation = expectedOperation;
  }

  get operation() {
    return this.#operation;
  }

  push(chunk: Uint8Array): T | undefined {
    if (this.#closed) throw new ManimRenderSandboxBrokerProtocolErrorV1("closed");
    if (this.#seen && chunk.byteLength > 0) throw new ManimRenderSandboxBrokerProtocolErrorV1("malformed");
    let bytes = Buffer.from(chunk);
    if (!this.#operation) {
      if (bytes.byteLength === 0) return undefined;
      this.#operation = operationForCode(bytes[0]!);
      if (!this.#operation || (this.#expectedOperation && this.#operation !== this.#expectedOperation)) {
        throw new ManimRenderSandboxBrokerProtocolErrorV1("malformed");
      }
      bytes = bytes.subarray(1);
    }
    const newline = bytes.indexOf(0x0a);
    if (newline !== -1 && newline !== bytes.byteLength - 1) {
      throw new ManimRenderSandboxBrokerProtocolErrorV1("malformed");
    }
    const content = newline === -1 ? bytes : bytes.subarray(0, -1);
    this.#bytes += content.byteLength;
    if (this.#bytes > MAX_MANIM_RENDER_SANDBOX_FRAME_BYTES_V1) {
      throw new ManimRenderSandboxBrokerProtocolErrorV1("oversized");
    }
    if (content.byteLength > 0) this.#body.push(Buffer.from(content));
    if (newline === -1) return undefined;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.#body, this.#bytes));
      const parsed = this.#schema.parse(JSON.parse(text));
      if (canonicalJsonV1(parsed) !== text) throw new Error();
      this.#seen = true;
      return parsed;
    } catch {
      throw new ManimRenderSandboxBrokerProtocolErrorV1("malformed");
    }
  }

  finish() {
    if (this.#closed) throw new ManimRenderSandboxBrokerProtocolErrorV1("closed");
    this.#closed = true;
    if (!this.#seen) throw new ManimRenderSandboxBrokerProtocolErrorV1("truncated");
  }
}

export class ManimRenderSandboxBrokerClientFrameDecoderV1 extends Decoder<ManimRenderSandboxBrokerClientMessageV1> {
  constructor() {
    super(manimRenderSandboxBrokerClientMessageV1Schema);
  }
}

export class ManimRenderSandboxBrokerServerFrameDecoderV1 extends Decoder<ManimRenderSandboxBrokerServerMessageV1> {
  constructor(operation: ManimRenderSandboxBrokerOperationV1) {
    super(manimRenderSandboxBrokerServerMessageV1Schema, operation);
  }
}
