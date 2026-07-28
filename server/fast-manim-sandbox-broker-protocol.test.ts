import { describe, expect, it } from "vitest";

import {
  decodeFastManimSandboxBrokerRequestBytesV1,
  encodeFastManimSandboxBrokerClientFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  encodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerServerFrameV1,
  FastManimSandboxBrokerClientFrameDecoderV1,
  FastManimSandboxBrokerProtocolErrorV1,
  FastManimSandboxBrokerServerFrameDecoderV1,
  MAX_FAST_MANIM_SANDBOX_BROKER_STATUS_FRAME_BYTES_V1,
} from "./fast-manim-sandbox-broker-protocol";
import { SANDBOX_TEST_SHA_A } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const identity = { projectId: "default", requestId: "request-1", tenantId: "tenant-1" };

function decodeChunks<T extends { push: (chunk: Uint8Array) => unknown; finish: () => void }>(
  decoder: T,
  frame: Uint8Array,
) {
  let decoded: unknown;
  for (let offset = 0; offset < frame.byteLength; ) {
    const next = Math.min(frame.byteLength, offset + ((offset % 7) + 1));
    decoded = decoder.push(frame.subarray(offset, next)) ?? decoded;
    offset = next;
  }
  decoder.finish();
  return decoded;
}

function rawFrame(operationCode: number, bodyLength: number) {
  const value = Buffer.alloc(bodyLength + 2, 0x61);
  value[0] = operationCode;
  value[value.byteLength - 1] = 0x0a;
  return value;
}

function errorCode(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (error instanceof FastManimSandboxBrokerProtocolErrorV1) return error.code;
    throw error;
  }
  throw new Error("Expected a protocol error.");
}

describe("fast-manim single-operation broker wire", () => {
  it("round-trips each request and response across arbitrary chunks", () => {
    const startRequest = {
      attestationDigest: SANDBOX_TEST_SHA_A,
      deadlineEpochMs: 1_800_000_000_000,
      identity,
      kind: "start" as const,
      requestBytesBase64: encodeFastManimSandboxBrokerRequestBytesV1(Uint8Array.of(1, 2, 3)),
      requestDigest: SANDBOX_TEST_SHA_A,
    };
    const startResponse = {
      kind: "job-result" as const,
      result: {
        attestationDigest: SANDBOX_TEST_SHA_A,
        kind: "ok" as const,
        requestDigest: SANDBOX_TEST_SHA_A,
        resultBytesBase64: encodeFastManimSandboxBrokerResultBytesV1(Uint8Array.of(4, 5, 6)),
      },
    };

    expect(
      decodeChunks(
        new FastManimSandboxBrokerClientFrameDecoderV1(),
        encodeFastManimSandboxBrokerClientFrameV1(startRequest),
      ),
    ).toEqual(startRequest);
    expect(
      decodeChunks(
        new FastManimSandboxBrokerServerFrameDecoderV1("start"),
        encodeFastManimSandboxBrokerServerFrameV1("start", startResponse),
      ),
    ).toEqual(startResponse);
    expect([...decodeFastManimSandboxBrokerRequestBytesV1(startRequest.requestBytesBase64)]).toEqual([1, 2, 3]);
  });

  it("selects the operation-specific cap before allocating or parsing a body", () => {
    const statusFrame = encodeFastManimSandboxBrokerClientFrameV1({
      deadlineEpochMs: 1,
      identity,
      kind: "status",
    });
    const startFrame = encodeFastManimSandboxBrokerClientFrameV1({
      attestationDigest: SANDBOX_TEST_SHA_A,
      deadlineEpochMs: 1,
      identity,
      kind: "start",
      requestBytesBase64: "",
      requestDigest: SANDBOX_TEST_SHA_A,
    });
    const oversizedForStatus = MAX_FAST_MANIM_SANDBOX_BROKER_STATUS_FRAME_BYTES_V1 + 1;

    expect(
      errorCode(() =>
        new FastManimSandboxBrokerClientFrameDecoderV1().push(rawFrame(statusFrame[0]!, oversizedForStatus)),
      ),
    ).toBe("oversized");
    expect(
      errorCode(() =>
        new FastManimSandboxBrokerClientFrameDecoderV1().push(rawFrame(startFrame[0]!, oversizedForStatus)),
      ),
    ).toBe("malformed");
    expect(
      errorCode(() => new FastManimSandboxBrokerServerFrameDecoderV1("status").push(rawFrame(startFrame[0]!, 1))),
    ).toBe("malformed");
  });

  it("rejects non-canonical, duplicated, and truncated input terminally", () => {
    expect(() => decodeFastManimSandboxBrokerRequestBytesV1("AQ")).toThrow(/canonical base64/i);
    const frame = encodeFastManimSandboxBrokerClientFrameV1({
      deadlineEpochMs: 1,
      identity,
      kind: "status",
    });
    const duplicated = Buffer.concat([Buffer.from(frame), Buffer.from(frame)]);
    expect(errorCode(() => new FastManimSandboxBrokerClientFrameDecoderV1().push(duplicated))).toBe("malformed");

    const partial = new FastManimSandboxBrokerClientFrameDecoderV1();
    partial.push(frame.subarray(0, -1));
    expect(errorCode(() => partial.finish())).toBe("truncated");
    expect(errorCode(() => partial.push(new Uint8Array()))).toBe("closed");
  });
});
