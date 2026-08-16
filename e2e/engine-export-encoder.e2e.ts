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

const H264_CODEC_LADDER = ["avc1.64002A", "avc1.640028", "avc1.42E01F"] as const;

const ENCODE_FRAME_COUNT = 10;
const ENCODE_WIDTH_PX = 320;
const ENCODE_HEIGHT_PX = 240;
const ENCODE_FRAME_RATES = [30, 60] as const;
const ENCODE_BITRATE = 2_000_000;

const EXPECTED_TIMESTAMPS_BY_FRAME_RATE = {
  30: [0, 33_333, 66_666, 100_000, 133_333, 166_666, 200_000, 233_333, 266_666, 300_000],
  60: [0, 16_666, 33_333, 50_000, 66_666, 83_333, 100_000, 116_666, 133_333, 150_000],
} as const;

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
    fractionalTimestampRefusal?: ExportEncoderResultV1;
    pushResponses: readonly ExportEncoderResultV1[];
  }> | null;
  invalidCreateRejection: Readonly<{ message: string; name: string }> | null;
  kind: "export-encode-proof";
  probe: ExportEncoderResponseV1;
}>;

async function proveExportEncode(
  page: Page,
  framesPerSecond: (typeof ENCODE_FRAME_RATES)[number],
): Promise<ExportEncodeProofV1> {
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
      framesPerSecond,
      heightPx: ENCODE_HEIGHT_PX,
      widthPx: ENCODE_WIDTH_PX,
    },
  );
}

test("export encoder probe returns a bounded closed-contract verdict and refuses invalid sessions by name", {
  tag: "@ci-smoke",
}, async ({ page }) => {
  const proof = await proveExportEncode(page, 30);

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

for (const framesPerSecond of ENCODE_FRAME_RATES) {
  test(`a proven codec encodes ${ENCODE_FRAME_COUNT} frames at ${framesPerSecond} fps with ordered integer timestamps`, {
    tag: "@ci-smoke",
  }, async ({ page }) => {
    const proof = await proveExportEncode(page, framesPerSecond);

    test.skip(
      proof.probe.result.kind !== "supported",
      `The fail-closed probe refused H.264 encoding here: ${JSON.stringify(proof.probe.result)}`,
    );
    expect(proof.encode).not.toBeNull();
    const encode = proof.encode;
    if (!encode) throw new Error("unreachable: the supported probe produced no encode proof");

    expect(encode.pushResponses).toHaveLength(ENCODE_FRAME_COUNT);
    expect(encode.fractionalTimestampRefusal?.kind).toBe("refused");
    expect(encode.fractionalTimestampRefusal?.reason).toBe("invalid-frame");
    for (const [frameIndex, pushResult] of encode.pushResponses.entries()) {
      expect(pushResult.kind).toBe("accepted");
      expect(pushResult.frameIndex).toBe(frameIndex);
      expect(pushResult.keyFrame).toBe(frameIndex === 0);
    }

    expect(encode.finish.kind).toBe("finished");
    expect(encode.finish.chunkCount).toBe(ENCODE_FRAME_COUNT);
    expect(encode.finish.keyFrameCount).toBeGreaterThanOrEqual(1);

    const statuses = encode.chunkStatuses ?? [];
    const byteLengths = encode.chunkByteLengths ?? [];
    expect(statuses).toHaveLength(ENCODE_FRAME_COUNT);
    expect(byteLengths).toHaveLength(ENCODE_FRAME_COUNT);
    let totalBytes = 0;
    const outputTimestamps = [];
    for (const [index, status] of statuses.entries()) {
      expect(status.kind).toBe("chunk");
      expect(status.index).toBe(index);
      expect(status.byteLength).toBe(byteLengths[index]);
      expect(byteLengths[index]).toBeGreaterThan(0);
      expect(typeof status.timestampMicroseconds).toBe("number");
      outputTimestamps.push(status.timestampMicroseconds as number);
      totalBytes += byteLengths[index] ?? 0;
    }
    expect(outputTimestamps).toEqual(EXPECTED_TIMESTAMPS_BY_FRAME_RATE[framesPerSecond]);
    for (let index = 1; index < outputTimestamps.length; index += 1) {
      expect(outputTimestamps[index]).toBeGreaterThan(outputTimestamps[index - 1] ?? Number.MAX_SAFE_INTEGER);
    }
    expect(statuses[0]?.keyFrame).toBe(true);
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
}
