type ThumbnailEngine = {
  generateThumbnail: () => Promise<Uint8Array>;
};

type ThumbnailEngineClass = {
  create: (
    snapshotJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    canvas: OffscreenCanvas,
  ) => Promise<ThumbnailEngine>;
};

type WasmBindings = {
  default: () => Promise<unknown>;
  PoietraCanvasEngineV1?: ThumbnailEngineClass;
};

type ThumbnailRequest = Readonly<{
  kind: "generate-engine-thumbnail";
  snapshotJson: ArrayBuffer;
  wasmModuleUrl: string;
}>;

self.addEventListener("message", (event: MessageEvent<ThumbnailRequest>) => {
  void (async () => {
    try {
      const request = event.data;
      if (request.kind !== "generate-engine-thumbnail") throw new Error("Unknown thumbnail request.");
      const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindings;
      await bindings.default();
      const Engine = bindings.PoietraCanvasEngineV1;
      if (!Engine || typeof Engine.create !== "function") {
        throw new Error("The WASM module does not expose the canvas engine.");
      }
      const engine = await Engine.create(
        new Uint8Array(request.snapshotJson),
        new TextEncoder().encode("[]"),
        [],
        new OffscreenCanvas(160, 90),
      );
      if (typeof engine.generateThumbnail !== "function") {
        throw new Error("The canvas engine does not expose thumbnail generation.");
      }
      const png = await engine.generateThumbnail();
      const bytes = png.slice().buffer;
      self.postMessage({ bytes, kind: "engine-thumbnail-generated" }, { transfer: [bytes] });
    } catch (error) {
      self.postMessage({
        kind: "engine-thumbnail-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});
