/**
 * Dedicated worker for the offscreen export readback proof (#718).
 *
 * Unlike `engine-canvas-readback.worker.ts`, which instruments the canvas
 * surface from JavaScript, this worker calls the hidden WASM proof hook so the
 * browser executes the engine's own async export path: offscreen
 * `COPY_SRC | RENDER_ATTACHMENT` target, `map_async` readback resolved from
 * the event loop, and row de-padding into tight RGBA — the exact code the
 * native headless GPU proofs execute.
 */

type WasmBindingsV1 = {
  default: () => Promise<unknown>;
  poietraProveExportFrameSequenceReadbackV1?: (
    snapshotJson: Uint8Array,
    widthPx: number,
    heightPx: number,
    fps: number,
  ) => Promise<Uint8Array>;
};

type ExportReadbackProofRequestV1 = Readonly<{
  fps: number;
  kind: "prove-export-readback";
  snapshotJson: ArrayBuffer;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
  wasmModuleUrl: string;
}>;

/** Mirrors the proof frame cap enforced inside the renderer hook. */
const MAX_EXPORT_READBACK_PROOF_FRAMES = 32;

async function proveExportReadback(request: ExportReadbackProofRequestV1) {
  const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
  await bindings.default();
  const prove = bindings.poietraProveExportFrameSequenceReadbackV1;
  if (typeof prove !== "function") {
    throw new Error("The WASM module does not expose the export readback proof hook.");
  }
  const concatenated = await prove(
    new Uint8Array(request.snapshotJson),
    request.viewport.widthPx,
    request.viewport.heightPx,
    request.fps,
  );
  const frameBytes = request.viewport.widthPx * request.viewport.heightPx * 4;
  if (frameBytes <= 0 || concatenated.byteLength % frameBytes !== 0) {
    throw new Error(
      `The export readback proof returned ${concatenated.byteLength} bytes, which is not a whole number of ${frameBytes}-byte frames.`,
    );
  }
  const frameCount = concatenated.byteLength / frameBytes;
  if (frameCount < 1 || frameCount > MAX_EXPORT_READBACK_PROOF_FRAMES) {
    throw new Error(
      `The export readback proof returned ${frameCount} frames outside 1-${MAX_EXPORT_READBACK_PROOF_FRAMES}.`,
    );
  }
  const rgba = concatenated.slice().buffer;
  return { frameCount, kind: "export-readback-proof" as const, rgba, viewport: request.viewport };
}

self.addEventListener("message", (event: MessageEvent<ExportReadbackProofRequestV1>) => {
  void (async () => {
    try {
      const request = event.data;
      if (request.kind !== "prove-export-readback") throw new Error("Unknown export readback proof request.");
      const proof = await proveExportReadback(request);
      self.postMessage(proof, { transfer: [proof.rgba] });
    } catch (error) {
      self.postMessage({
        kind: "export-readback-failure" as const,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
