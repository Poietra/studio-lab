/**
 * Dedicated-worker driver for the composed WASM MP4 export session (#722).
 *
 * The worker loads the served engine module, runs the fail-closed H.264
 * probe, proves the named admission refusal with an invalid profile, and
 * (when the probe proves a codec) drives the complete real pipeline —
 * offscreen WebGPU frames → WebCodecs encoder → Rust MP4 muxer — for one
 * validated fixture Scene, returning the finalized MP4 bytes by transfer.
 */

const POIETRA_EXPORT_SESSION_ABI_VERSION = 1;

type ExportSessionEnvelopeV1 = Readonly<{
  result: Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;
  schema: string;
  version: number;
}>;

type ExportSessionV1 = Readonly<{
  free: () => void;
  outputBytes: () => Uint8Array;
  run: (progress?: (envelopeJson: Uint8Array) => boolean | undefined) => Promise<Uint8Array>;
}>;

type WasmBindingsV1 = {
  default: () => Promise<unknown>;
  poietraExportSessionAbiVersion: () => number;
  probeExportEncoderH264V1: () => Promise<Uint8Array>;
  PoietraExportSessionV1: {
    create: (
      snapshotJson: Uint8Array,
      assetMetadataJson: Uint8Array,
      assetBytes: Uint8Array[],
      profileJson: Uint8Array,
    ) => Promise<ExportSessionV1>;
  };
};

type ProveExportSessionRequestV1 = Readonly<{
  kind: "prove-export-session";
  profileJson: string;
  snapshotJson: ArrayBuffer;
  wasmModuleUrl: string;
}>;

type NamedRejectionV1 = Readonly<{ message: string; name: string }>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function decodeEnvelope(bytes: Uint8Array): ExportSessionEnvelopeV1 {
  const value = JSON.parse(decoder.decode(bytes)) as ExportSessionEnvelopeV1;
  if (value.version !== 1) {
    throw new Error(`Unexpected export envelope version: ${JSON.stringify(value)}`);
  }
  return value;
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

async function proveExportSession(request: ProveExportSessionRequestV1) {
  const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
  await bindings.default();
  if (bindings.poietraExportSessionAbiVersion() !== POIETRA_EXPORT_SESSION_ABI_VERSION) {
    throw new Error("Unexpected export session ABI version.");
  }
  const snapshotJson = new Uint8Array(request.snapshotJson);
  const emptyAssetMetadata = encoder.encode("[]");

  const probe = decodeEnvelope(await bindings.probeExportEncoderH264V1());
  if (probe.schema !== "poietra.export-encoder-response") {
    throw new Error(`Unexpected probe schema: ${probe.schema}`);
  }

  // The named admission refusal must hold in every environment: an invalid
  // profile rejects by name before any encoder or GPU work happens.
  const invalidProfileRejection = await captureNamedRejection(() =>
    bindings.PoietraExportSessionV1.create(
      snapshotJson,
      emptyAssetMetadata,
      [],
      encoder.encode(JSON.stringify({ schema: "poietra.export-profile", version: 1 })),
    ),
  );

  if (probe.result.kind !== "supported") {
    return {
      invalidProfileRejection,
      kind: "export-session-proof" as const,
      mp4: null,
      probe,
      progress: [],
      run: null,
    };
  }

  const session = await bindings.PoietraExportSessionV1.create(
    snapshotJson,
    emptyAssetMetadata,
    [],
    encoder.encode(request.profileJson),
  );
  try {
    const progress: ExportSessionEnvelopeV1["result"][] = [];
    const run = decodeEnvelope(
      await session.run((envelopeJson) => {
        progress.push(decodeEnvelope(envelopeJson).result);
        return undefined;
      }),
    );
    if (run.schema !== "poietra.export-session-response") {
      throw new Error(`Unexpected run schema: ${run.schema}`);
    }
    if (run.result.kind !== "finished") {
      return {
        invalidProfileRejection,
        kind: "export-session-proof" as const,
        mp4: null,
        probe,
        progress,
        run: run.result,
      };
    }
    const output = session.outputBytes();
    const mp4 = output.slice().buffer as ArrayBuffer;
    return { invalidProfileRejection, kind: "export-session-proof" as const, mp4, probe, progress, run: run.result };
  } finally {
    session.free();
  }
}

self.addEventListener("message", (event: MessageEvent<ProveExportSessionRequestV1>) => {
  void (async () => {
    if (event.data.kind !== "prove-export-session") throw new Error("Unknown export session proof request.");
    const proof = await proveExportSession(event.data);
    if (proof.mp4) {
      self.postMessage(proof, { transfer: [proof.mp4] });
    } else {
      self.postMessage(proof);
    }
  })().catch((error: unknown) => {
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  });
});
