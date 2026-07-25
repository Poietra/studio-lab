type CanvasConfigurationV1 = Readonly<{
  device: unknown;
  format: string;
  usage?: number;
}> &
  Record<string, unknown>;

type GpuBufferV1 = {
  getMappedRange: () => ArrayBuffer;
  mapAsync: (mode: number) => Promise<void>;
  unmap: () => void;
};

type GpuCommandEncoderV1 = {
  copyTextureToBuffer: (source: unknown, destination: unknown, extent: unknown) => void;
  finish: () => unknown;
};

type GpuDeviceV1 = {
  createBuffer: (descriptor: Readonly<{ size: number; usage: number }>) => GpuBufferV1;
  createCommandEncoder: () => GpuCommandEncoderV1;
  queue: { submit: (commands: Iterable<unknown>) => void };
};

type GpuAdapterV1 = {
  requestDevice: (descriptor?: unknown) => Promise<GpuDeviceV1>;
};

type GpuCanvasContextV1 = {
  configure: (configuration: CanvasConfigurationV1) => void;
  getCurrentTexture: () => unknown;
};

type GpuNavigatorV1 = {
  requestAdapter: (options?: unknown) => Promise<GpuAdapterV1 | null>;
};

type WasmBindingsV1 = {
  default: () => Promise<unknown>;
  poietraCanvasAbiVersion: () => number;
  PoietraCanvasEngineV1: {
    create: (
      snapshotJson: Uint8Array,
      canvas: OffscreenCanvas,
    ) => Promise<{ render: (requestJson: Uint8Array) => Promise<Uint8Array> }>;
  };
};

type ProofRequestV1 = Readonly<{
  kind: "prove-frame";
  requestJson: ArrayBuffer;
  snapshotJson: ArrayBuffer;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
  wasmModuleUrl: string;
}>;

const GPU_BUFFER_USAGE_MAP_READ = 1;
const GPU_BUFFER_USAGE_COPY_DST = 8;
const GPU_MAP_MODE_READ = 1;
const GPU_TEXTURE_USAGE_COPY_SRC = 1;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 16;

function installReadbackHooks(canvas: OffscreenCanvas, viewport: ProofRequestV1["viewport"]) {
  const context = canvas.getContext("webgpu") as unknown as GpuCanvasContextV1 | null;
  if (!context) throw new Error("The E2E worker could not acquire a WebGPU canvas context.");

  let capturedTexture: unknown;
  let device: GpuDeviceV1 | null = null;
  let readback: GpuBufferV1 | null = null;
  let surfaceFormat: string | null = null;
  let armed = false;

  const configure = context.configure.bind(context);
  context.configure = (configuration) => {
    surfaceFormat = configuration.format;
    configure({
      ...configuration,
      usage:
        (configuration.usage ?? GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) |
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        GPU_TEXTURE_USAGE_COPY_SRC,
    });
  };
  const getCurrentTexture = context.getCurrentTexture.bind(context);
  context.getCurrentTexture = () => {
    capturedTexture = getCurrentTexture();
    return capturedTexture;
  };

  const gpu = (self.navigator as unknown as { gpu?: GpuNavigatorV1 }).gpu;
  if (!gpu) throw new Error("WebGPU is unavailable in the E2E worker.");
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    if (!adapter) return null;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      device = await requestDevice(descriptor);
      const submit = device.queue.submit.bind(device.queue);
      device.queue.submit = (commands) => {
        if (!armed || !capturedTexture || !device) {
          submit(commands);
          return;
        }
        armed = false;
        const bytesPerRow = Math.ceil((viewport.widthPx * 4) / 256) * 256;
        readback = device.createBuffer({
          size: bytesPerRow * viewport.heightPx,
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: capturedTexture },
          { buffer: readback, bytesPerRow, rowsPerImage: viewport.heightPx },
          { depthOrArrayLayers: 1, height: viewport.heightPx, width: viewport.widthPx },
        );
        submit([...commands, encoder.finish()]);
      };
      return device;
    };
    return adapter;
  };

  return {
    arm: () => {
      armed = true;
      capturedTexture = undefined;
      readback = null;
    },
    readPixels: async () => {
      if (!readback || !surfaceFormat) throw new Error("The WASM renderer did not submit a readable surface frame.");
      await readback.mapAsync(GPU_MAP_MODE_READ);
      const mapped = new Uint8Array(readback.getMappedRange());
      const bytesPerRow = Math.ceil((viewport.widthPx * 4) / 256) * 256;
      const bgra = surfaceFormat.startsWith("bgra8");
      const pixelAt = (x: number, y: number) => {
        const offset = y * bytesPerRow + x * 4;
        const red = mapped[offset + (bgra ? 2 : 0)] ?? 0;
        const green = mapped[offset + 1] ?? 0;
        const blue = mapped[offset + (bgra ? 0 : 2)] ?? 0;
        const alpha = mapped[offset + 3] ?? 0;
        return [red, green, blue, alpha] as const;
      };
      let bounds: [number, number, number, number] | null = null;
      for (let y = 0; y < viewport.heightPx; y += 1) {
        for (let x = 0; x < viewport.widthPx; x += 1) {
          const [red, green, blue] = pixelAt(x, y);
          if (red === 0 && green === 0 && blue === 0) continue;
          bounds = bounds
            ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]
            : [x, y, x, y];
        }
      }
      const pixels = {
        background: pixelAt(5, 5),
        blueCenter: pixelAt(90, 45),
        nonBlackBounds: bounds,
        redCenter: pixelAt(70, 45),
        surfaceFormat,
      };
      readback.unmap();
      return pixels;
    },
  };
}

self.addEventListener("message", (event: MessageEvent<ProofRequestV1>) => {
  void (async () => {
    const request = event.data;
    if (request.kind !== "prove-frame") throw new Error("Unknown E2E canvas proof request.");
    const canvas = new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx);
    const hooks = installReadbackHooks(canvas, request.viewport);
    const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
    await bindings.default();
    if (bindings.poietraCanvasAbiVersion() !== 1) throw new Error("Unexpected canvas ABI version.");
    const engine = await bindings.PoietraCanvasEngineV1.create(new Uint8Array(request.snapshotJson), canvas);
    hooks.arm();
    const responseJson = await engine.render(new Uint8Array(request.requestJson));
    const response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson)) as unknown;
    const pixels = await hooks.readPixels();
    self.postMessage({ kind: "proof", pixels, response });
  })().catch((error: unknown) => {
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  });
});
