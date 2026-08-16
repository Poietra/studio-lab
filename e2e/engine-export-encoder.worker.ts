/**
 * Dedicated-worker driver for the WASM WebCodecs H.264 export encoder binding.
 *
 * The worker loads the served engine module, runs the fail-closed capability
 * probe, exercises the refusal contract with an invalid session request, and
 * (when the probe proves a codec) encodes a short gradient sequence to prove
 * chunk collection, keyframe-first ordering, and decoderConfig evidence.
 */

const POIETRA_EXPORT_ENCODER_ABI_VERSION = 1;

type ExportEncoderResponseV1 = Readonly<{
  result: Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;
  schema: string;
  version: number;
}>;

type ExportEncoderSessionV1 = Readonly<{
  chunkBytes: (index: number) => Uint8Array;
  chunkStatus: (index: number) => Uint8Array;
  descriptionBytes: () => Uint8Array;
  finish: () => Promise<Uint8Array>;
  free: () => void;
  pushFrame: (rgba: Uint8Array, timestampMicroseconds: number) => Promise<Uint8Array>;
}>;

type WasmBindingsV1 = {
  default: () => Promise<unknown>;
  poietraExportEncoderAbiVersion: () => number;
  probeExportEncoderH264V1: () => Promise<Uint8Array>;
  PoietraExportEncoderSessionV1: {
    create: (requestJson: Uint8Array) => Promise<ExportEncoderSessionV1>;
  };
};

type ProveExportEncodeRequestV1 = Readonly<{
  bitrate: number;
  frameCount: number;
  framesPerSecond: number;
  heightPx: number;
  kind: "prove-export-encode";
  wasmModuleUrl: string;
  widthPx: number;
}>;

type NamedRejectionV1 = Readonly<{
  message: string;
  name: string;
}>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function decodeResponse(bytes: Uint8Array): ExportEncoderResponseV1 {
  const value = JSON.parse(decoder.decode(bytes)) as ExportEncoderResponseV1;
  if (value.schema !== "poietra.export-encoder-response" || value.version !== 1) {
    throw new Error(`Unexpected export encoder response envelope: ${JSON.stringify(value)}`);
  }
  return value;
}

function gradientFrameRgba(widthPx: number, heightPx: number, frameIndex: number): Uint8Array {
  const rgba = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const offset = (y * widthPx + x) * 4;
      rgba[offset] = ((x * 255) / Math.max(1, widthPx - 1)) | 0;
      rgba[offset + 1] = ((y * 255) / Math.max(1, heightPx - 1)) | 0;
      rgba[offset + 2] = (frameIndex * 24) & 0xff;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function frameTimestampMicroseconds(frameIndex: number, framesPerSecond: number): number {
  return Math.floor((frameIndex * 1_000_000) / framesPerSecond);
}

async function captureNamedRejection(operation: () => Promise<unknown>): Promise<NamedRejectionV1 | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error
      ? { message: error.message, name: error.name }
      : { message: String(error), name: "unknown" };
  }
}

async function proveExportEncode(request: ProveExportEncodeRequestV1) {
  const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
  await bindings.default();
  if (bindings.poietraExportEncoderAbiVersion() !== POIETRA_EXPORT_ENCODER_ABI_VERSION) {
    throw new Error("Unexpected export encoder ABI version.");
  }

  const probe = decodeResponse(await bindings.probeExportEncoderH264V1());

  // The invalid-request refusal path must hold in every environment, with or
  // without a usable H.264 encoder.
  const invalidCreateRejection = await captureNamedRejection(() =>
    bindings.PoietraExportEncoderSessionV1.create(
      encoder.encode(JSON.stringify({ schema: "poietra.export-encoder-session-request", version: 1 })),
    ),
  );

  if (probe.result.kind !== "supported") {
    return { encode: null, invalidCreateRejection, kind: "export-encode-proof" as const, probe };
  }

  const codec = probe.result.codec;
  if (typeof codec !== "string") throw new Error("The supported probe result carried no codec string.");
  const sessionRequest = encoder.encode(
    JSON.stringify({
      bitrate: request.bitrate,
      codec,
      framesPerSecond: request.framesPerSecond,
      heightPx: request.heightPx,
      schema: "poietra.export-encoder-session-request",
      version: 1,
      widthPx: request.widthPx,
    }),
  );
  const fractionalTimestampSession = await bindings.PoietraExportEncoderSessionV1.create(sessionRequest);
  let fractionalTimestampRefusal: ExportEncoderResponseV1["result"];
  try {
    fractionalTimestampRefusal = decodeResponse(
      await fractionalTimestampSession.pushFrame(gradientFrameRgba(request.widthPx, request.heightPx, 0), 0.5),
    ).result;
  } finally {
    fractionalTimestampSession.free();
  }

  const session = await bindings.PoietraExportEncoderSessionV1.create(sessionRequest);
  try {
    const pushResponses = [];
    for (let frameIndex = 0; frameIndex < request.frameCount; frameIndex += 1) {
      const timestampMicroseconds = frameTimestampMicroseconds(frameIndex, request.framesPerSecond);
      const response = decodeResponse(
        await session.pushFrame(
          gradientFrameRgba(request.widthPx, request.heightPx, frameIndex),
          timestampMicroseconds,
        ),
      );
      pushResponses.push(response.result);
      if (response.result.kind !== "accepted") {
        return {
          encode: { finish: response.result, fractionalTimestampRefusal, pushResponses },
          invalidCreateRejection,
          kind: "export-encode-proof" as const,
          probe,
        };
      }
    }
    const finish = decodeResponse(await session.finish());
    if (finish.result.kind !== "finished") {
      return {
        encode: { finish: finish.result, fractionalTimestampRefusal, pushResponses },
        invalidCreateRejection,
        kind: "export-encode-proof" as const,
        probe,
      };
    }
    const chunkCount = finish.result.chunkCount;
    if (typeof chunkCount !== "number") throw new Error("The finished result carried no chunk count.");
    const chunkStatuses = [];
    const chunkByteLengths = [];
    for (let index = 0; index < chunkCount; index += 1) {
      chunkStatuses.push(decodeResponse(session.chunkStatus(index)).result);
      chunkByteLengths.push(session.chunkBytes(index).byteLength);
    }
    const description = session.descriptionBytes();
    const closedSessionRefusal = decodeResponse(await session.finish()).result;
    return {
      encode: {
        chunkByteLengths,
        chunkStatuses,
        closedSessionRefusal,
        descriptionFirstByte: description.byteLength > 0 ? description[0] : null,
        descriptionByteLength: description.byteLength,
        finish: finish.result,
        fractionalTimestampRefusal,
        pushResponses,
      },
      invalidCreateRejection,
      kind: "export-encode-proof" as const,
      probe,
    };
  } finally {
    session.free();
  }
}

self.addEventListener("message", (event: MessageEvent<ProveExportEncodeRequestV1>) => {
  void (async () => {
    if (event.data.kind !== "prove-export-encode") throw new Error("Unknown export encoder proof request.");
    self.postMessage(await proveExportEncode(event.data));
  })().catch((error: unknown) => {
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  });
});
