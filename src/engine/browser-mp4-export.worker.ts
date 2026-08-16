import { type CanvasPngAssetTransferV1, encodeCanvasPngAssetTransfersForWasmV1 } from "./canvas-png-assets";

type ExportRequest = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  kind: "export-mp4";
  profileJson: ArrayBuffer;
  snapshotJson: ArrayBuffer;
  wasmModuleUrl: string;
}>;

type WasmBindings = Readonly<{
  default: () => Promise<unknown>;
  exportSceneMp4V1?: (
    snapshotJson: Uint8Array,
    profileJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
  ) => Promise<Uint8Array>;
}>;

self.addEventListener("message", (event: MessageEvent<ExportRequest>) => {
  void (async () => {
    try {
      const request = event.data;
      if (request.kind !== "export-mp4") throw new Error("Unknown browser MP4 export request.");
      const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindings;
      await bindings.default();
      if (typeof bindings.exportSceneMp4V1 !== "function") {
        throw new Error("The Poietra WASM module does not expose browser MP4 export.");
      }
      const assets = encodeCanvasPngAssetTransfersForWasmV1(request.assetPayloads);
      const output = await bindings.exportSceneMp4V1(
        new Uint8Array(request.snapshotJson),
        new Uint8Array(request.profileJson),
        assets.metadataJson,
        assets.bytes,
      );
      const bytes = output.slice().buffer;
      self.postMessage({ bytes, kind: "exported" }, { transfer: [bytes] });
    } catch (error) {
      self.postMessage({
        kind: "refused",
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
      });
    }
  })();
});
