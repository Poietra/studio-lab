import { describe, expect, it } from "vitest";

import {
  decodeFastManimSandboxBrokerRequestBytesV1,
  decodeFastManimSandboxBrokerResultBytesV1,
  encodeFastManimSandboxBrokerFrameV1,
  encodeFastManimSandboxBrokerRequestBytesV1,
  encodeFastManimSandboxBrokerResultBytesV1,
  FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  FastManimSandboxBrokerFrameDecoderV1,
  type FastManimSandboxBrokerMessageV1,
  FastManimSandboxBrokerProtocolErrorV1,
  MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1,
} from "./fast-manim-sandbox-broker-protocol";
import { localSandboxReadyStatus, SANDBOX_TEST_SHA_A } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const common = {
  correlationId: "operation-1",
  protocol: FAST_MANIM_SANDBOX_BROKER_PROTOCOL_V1,
  version: 1 as const,
};
const identity = { projectId: "default", requestId: "request-1", tenantId: "tenant-1" };

function rawFrame(body: Uint8Array) {
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  Buffer.from(body).copy(frame, 4);
  return frame;
}

function protocolErrorCode(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (error instanceof FastManimSandboxBrokerProtocolErrorV1) return error.code;
    throw error;
  }
  throw new Error("Expected a broker protocol error.");
}

describe("fast-manim sandbox broker protocol", () => {
  it("round-trips every operation across arbitrary stream boundaries", () => {
    const requestBytesBase64 = encodeFastManimSandboxBrokerRequestBytesV1(Uint8Array.from([1, 2, 3]));
    const resultBytesBase64 = encodeFastManimSandboxBrokerResultBytesV1(Uint8Array.from([4, 5, 6]));
    const messages: FastManimSandboxBrokerMessageV1[] = [
      { ...common, deadlineEpochMs: 1_800_000_000_000, identity, kind: "status" },
      {
        ...common,
        attestationDigest: SANDBOX_TEST_SHA_A,
        correlationId: "operation-2",
        deadlineEpochMs: 1_800_000_000_000,
        identity,
        jobId: "job-1",
        kind: "start",
        requestBytesBase64,
        requestDigest: SANDBOX_TEST_SHA_A,
      },
      { ...common, correlationId: "operation-3", jobId: "job-1", kind: "abort" },
      { ...common, correlationId: "operation-4", kind: "close" },
      { ...common, kind: "status-result", status: localSandboxReadyStatus() },
      {
        ...common,
        correlationId: "operation-2",
        jobId: "job-1",
        kind: "job-result",
        result: {
          attestationDigest: SANDBOX_TEST_SHA_A,
          kind: "ok",
          requestDigest: SANDBOX_TEST_SHA_A,
          resultBytesBase64,
        },
      },
      { ...common, correlationId: "operation-3", jobId: "job-1", kind: "abort-ack" },
      { ...common, correlationId: "operation-4", kind: "close-ack" },
      { ...common, code: "capacity", kind: "error", operation: "start" },
    ];
    const wire = Buffer.concat(messages.map((message) => encodeFastManimSandboxBrokerFrameV1(message)));
    const decoder = new FastManimSandboxBrokerFrameDecoderV1();
    const decoded: FastManimSandboxBrokerMessageV1[] = [];
    for (let offset = 0; offset < wire.byteLength; ) {
      const next = Math.min(wire.byteLength, offset + ((offset % 11) + 1));
      decoded.push(...decoder.push(wire.subarray(offset, next)));
      offset = next;
    }
    decoder.finish();

    expect(decoded).toEqual(messages);
    expect([...decodeFastManimSandboxBrokerRequestBytesV1(requestBytesBase64)]).toEqual([1, 2, 3]);
    expect([...decodeFastManimSandboxBrokerResultBytesV1(resultBytesBase64)]).toEqual([4, 5, 6]);
  });

  it("rejects non-canonical bytes and unknown message fields", () => {
    expect(() => decodeFastManimSandboxBrokerRequestBytesV1("AQ")).toThrow(/canonical base64/i);
    expect(() => decodeFastManimSandboxBrokerResultBytesV1("AQ==\n")).toThrow(/canonical base64/i);
    expect(() =>
      encodeFastManimSandboxBrokerFrameV1({
        ...common,
        deadlineEpochMs: 1,
        identity,
        kind: "status",
        unexpected: true,
      } as FastManimSandboxBrokerMessageV1),
    ).toThrow();

    const valid = encodeFastManimSandboxBrokerFrameV1({
      ...common,
      deadlineEpochMs: 1,
      identity,
      kind: "status",
    });
    const nonCanonicalBody = Buffer.concat([Buffer.from(" "), Buffer.from(valid).subarray(4)]);
    const decoder = new FastManimSandboxBrokerFrameDecoderV1();
    expect(protocolErrorCode(() => decoder.push(rawFrame(nonCanonicalBody)))).toBe("malformed");
  });

  it("fails immediately for zero-length, oversized, malformed UTF-8, and malformed JSON frames", () => {
    const zeroLength = Buffer.alloc(4);
    expect(protocolErrorCode(() => new FastManimSandboxBrokerFrameDecoderV1().push(zeroLength))).toBe("malformed");

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_FAST_MANIM_SANDBOX_BROKER_FRAME_BYTES_V1 + 1, 0);
    expect(protocolErrorCode(() => new FastManimSandboxBrokerFrameDecoderV1().push(oversized))).toBe("oversized");
    expect(
      protocolErrorCode(() => new FastManimSandboxBrokerFrameDecoderV1().push(rawFrame(Uint8Array.of(0xff)))),
    ).toBe("malformed");
    expect(protocolErrorCode(() => new FastManimSandboxBrokerFrameDecoderV1().push(rawFrame(Buffer.from("{"))))).toBe(
      "malformed",
    );
  });

  it("distinguishes clean disconnect from truncated frames and remains terminal afterward", () => {
    const frame = encodeFastManimSandboxBrokerFrameV1({
      ...common,
      deadlineEpochMs: 1,
      identity,
      kind: "status",
    });
    const partialHeader = new FastManimSandboxBrokerFrameDecoderV1();
    partialHeader.push(frame.subarray(0, 2));
    expect(protocolErrorCode(() => partialHeader.finish())).toBe("truncated");
    expect(protocolErrorCode(() => partialHeader.push(new Uint8Array()))).toBe("closed");

    const partialBody = new FastManimSandboxBrokerFrameDecoderV1();
    partialBody.push(frame.subarray(0, frame.byteLength - 1));
    expect(protocolErrorCode(() => partialBody.finish())).toBe("truncated");

    const clean = new FastManimSandboxBrokerFrameDecoderV1();
    expect(clean.push(frame)).toHaveLength(1);
    clean.finish();
    expect(protocolErrorCode(() => clean.finish())).toBe("closed");
  });
});
