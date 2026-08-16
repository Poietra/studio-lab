import { expect, type Page, test } from "@playwright/test";

/**
 * WebCodecs H.264 export encoder binding proof (issue #719).
 *
 * The probe contract is asserted unconditionally: every environment must
 * produce a bounded closed-contract verdict and a fail-closed named refusal
 * for invalid session requests. The real ten-frame encode proof asserts chunk
 * count, keyframe-first ordering, and decoderConfig description evidence, and
 * is skipped honestly when the environment's Chromium build ships no H.264
 * encoder (the probe refuses with `unsupported-codec`).
 */

const EXPORT_ENCODER_REFUSAL_REASONS = [
  "api-unavailable",
  "capacity-exceeded",
  "encoder-error",
  "invalid-frame",
  "invalid-request",
  "no-chunk",
  "no-decoder-config",
  "no-key-frame",
  "response-too-large",
  "serialization-failed",
  "session-closed",
  "timeout",
  "unsupported-codec",
] as const;

const H264_CODEC_LADDER = ["avc1.640028", "avc1.42E01F"] as const;

const ENCODE_FRAME_COUNT = 10;
const ENCODE_WIDTH_PX = 320;
const ENCODE_HEIGHT_PX = 240;
const ENCODE_FRAMES_PER_SECOND = 30;
const ENCODE_BITRATE = 2_000_000;

type ExportEncoderResultV1 = Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;

type ExportEncoderResponseV1 = Readonly<{
  result: ExportEncoderResultV1;
  schema: string;
  version: number;
}>;

type ExportEncodeProofV1 = Readonly<{
  encode: Readonly<{
    chunkByteLengths?: readonly number[];
    chunkStatuses?: readonly ExportEncoderResultV1[];
    closedSessionRefusal?: ExportEncoderResultV1;
    descriptionByteLength?: number;
    descriptionFirstByte?: number | null;
    finish: ExportEncoderResultV1;
    pushResponses: readonly ExportEncoderResultV1[];
  }> | null;
  invalidCreateRejection: Readonly<{ message: string; name: string }> | null;
  kind: "export-encode-proof";
  probe: ExportEncoderResponseV1;
}>;

async function proveExportEncode(page: Page): Promise<ExportEncodeProofV1> {
  await page.goto("/");
  return page.evaluate(
    async ({ bitrate, frameCount, framesPerSecond, heightPx, widthPx }) => {
      const worker = new Worker("/e2e/engine-export-encoder.worker.ts", { type: "module" });
      const response = new Promise<ExportEncodeProofV1>((resolve, reject) => {
        worker.addEventListener(
          "error",
          (event) => reject(new Error(event.message || "The export encoder worker crashed.")),
          { once: true },
        );
        worker.addEventListener(
          "message",
          (event: MessageEvent<ExportEncodeProofV1 | Readonly<{ kind: "error"; message: string }>>) => {
            if (event.data.kind === "error") {
              reject(new Error(event.data.message));
              return;
            }
            resolve(event.data);
          },
          { once: true },
        );
      });
      worker.postMessage({
        bitrate,
        frameCount,
        framesPerSecond,
        heightPx,
        kind: "prove-export-encode",
        wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        widthPx,
      });
      try {
        return await response;
      } finally {
        worker.terminate();
      }
    },
    {
      bitrate: ENCODE_BITRATE,
      frameCount: ENCODE_FRAME_COUNT,
      framesPerSecond: ENCODE_FRAMES_PER_SECOND,
      heightPx: ENCODE_HEIGHT_PX,
      widthPx: ENCODE_WIDTH_PX,
    },
  );
}

test("export encoder probe returns a bounded closed-contract verdict and refuses invalid sessions by name", async ({
  page,
}) => {
  const proof = await proveExportEncode(page);

  expect(proof.probe.schema).toBe("poietra.export-encoder-response");
  expect(proof.probe.version).toBe(1);
  if (proof.probe.result.kind === "supported") {
    expect(H264_CODEC_LADDER).toContain(proof.probe.result.codec);
  } else {
    expect(proof.probe.result.kind).toBe("refused");
    expect(EXPORT_ENCODER_REFUSAL_REASONS).toContain(proof.probe.result.reason);
    expect(typeof proof.probe.result.message).toBe("string");
    expect((proof.probe.result.message as string).length).toBeGreaterThan(0);
  }

  // Invalid session requests must reject with the stable named error and the
  // machine-readable refusal prefix in every environment.
  expect(proof.invalidCreateRejection).not.toBeNull();
  expect(proof.invalidCreateRejection?.name).toBe("PoietraExportEncoderRefused");
  expect(proof.invalidCreateRejection?.message).toMatch(/^invalid-request: /);
});

test("a proven codec encodes ten gradient frames into keyframe-first chunks with decoderConfig evidence", async ({
  page,
}) => {
  const proof = await proveExportEncode(page);

  test.skip(
    proof.probe.result.kind !== "supported",
    `The fail-closed probe refused H.264 encoding here: ${JSON.stringify(proof.probe.result)}`,
  );
  expect(proof.encode).not.toBeNull();
  const encode = proof.encode;
  if (!encode) throw new Error("unreachable: the supported probe produced no encode proof");

  expect(encode.pushResponses).toHaveLength(ENCODE_FRAME_COUNT);
  for (const [frameIndex, pushResult] of encode.pushResponses.entries()) {
    expect(pushResult.kind).toBe("accepted");
    expect(pushResult.frameIndex).toBe(frameIndex);
    // Ten frames at 30 fps stay inside one 2-second cadence window, so only
    // the first frame is cadence-forced.
    expect(pushResult.keyFrame).toBe(frameIndex === 0);
  }

  expect(encode.finish.kind).toBe("finished");
  expect(encode.finish.chunkCount).toBe(ENCODE_FRAME_COUNT);
  expect(encode.finish.keyFrameCount).toBeGreaterThanOrEqual(1);

  const statuses = encode.chunkStatuses ?? [];
  const byteLengths = encode.chunkByteLengths ?? [];
  expect(statuses).toHaveLength(ENCODE_FRAME_COUNT);
  expect(byteLengths).toHaveLength(ENCODE_FRAME_COUNT);
  const pushedTimestamps = Array.from(
    { length: ENCODE_FRAME_COUNT },
    (_, frameIndex) => (frameIndex * 1_000_000) / ENCODE_FRAMES_PER_SECOND,
  );
  let totalBytes = 0;
  for (const [index, status] of statuses.entries()) {
    expect(status.kind).toBe("chunk");
    expect(status.index).toBe(index);
    expect(status.byteLength).toBe(byteLengths[index]);
    expect(byteLengths[index]).toBeGreaterThan(0);
    expect(pushedTimestamps).toContain(status.timestampMicroseconds);
    totalBytes += byteLengths[index] ?? 0;
  }
  expect(statuses[0]?.keyFrame).toBe(true);
  expect(statuses[0]?.timestampMicroseconds).toBe(0);
  expect(encode.finish.totalByteLength).toBe(totalBytes);

  // The avcC AVCDecoderConfigurationRecord always starts with version 0x01.
  expect(encode.descriptionByteLength).toBeGreaterThanOrEqual(8);
  expect(encode.descriptionFirstByte).toBe(1);
  const decoderConfig = encode.finish.decoderConfig as Readonly<{
    colorSpace: Readonly<Record<string, unknown>>;
    descriptionByteLength: number;
  }>;
  expect(decoderConfig.descriptionByteLength).toBe(encode.descriptionByteLength);
  expect(typeof decoderConfig.colorSpace).toBe("object");

  // A settled session accepts nothing further, by name.
  expect(encode.closedSessionRefusal?.kind).toBe("refused");
  expect(encode.closedSessionRefusal?.reason).toBe("session-closed");
});
