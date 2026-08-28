type ThumbnailEngine = {
  generateThumbnail: () => Promise<Uint8Array>;
};

type ThumbnailEngineClass = {
  create: (
    snapshotJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    canvas: OffscreenCanvas,
    fragmentMaterialRegistryJson: Uint8Array,
    scenePostEffectRegistryJson: Uint8Array,
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

const EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON = new TextEncoder().encode(
  '{"materials":[],"schema":"poietra.fragment-material-registry","version":1}',
);
const EMPTY_SCENE_POST_EFFECT_REGISTRY_JSON = new TextEncoder().encode(
  '{"effect":null,"schema":"poietra.scene-post-effect-registry","version":1}',
);

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
        EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON,
        EMPTY_SCENE_POST_EFFECT_REGISTRY_JSON,
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
