import { POIETRA_CANVAS_ABI_VERSION } from "../src/engine/canvas-abi";

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
  popErrorScope: () => Promise<unknown>;
  pushErrorScope: (filter: unknown) => void;
  queue: { submit: (commands: Iterable<unknown>) => void };
};

type GpuAdapterV1 = {
  requestDevice: (descriptor?: unknown) => Promise<GpuDeviceV1>;
};

type GpuCanvasContextV1 = {
  configure: (configuration: CanvasConfigurationV1) => void;
  getCurrentTexture: () => GpuTextureV1;
};

type GpuTextureV1 = {
  createView: (descriptor?: Readonly<{ format?: string }> & Record<string, unknown>) => unknown;
};

type GpuNavigatorV1 = {
  requestAdapter: (options?: unknown) => Promise<GpuAdapterV1 | null>;
};

type ScheduledErrorScopeFailureV1 = {
  call: number;
  error: unknown;
};

type WasmBindingsV1 = {
  default: () => Promise<unknown>;
  poietraCanvasAbiVersion: () => number;
  PoietraCanvasEngineV1: {
    create: (
      snapshotJson: Uint8Array,
      assetMetadataJson: Uint8Array,
      assetBytes: Uint8Array[],
      canvas: OffscreenCanvas,
    ) => Promise<{
      render: (requestJson: Uint8Array) => Promise<Uint8Array>;
      renderWithTelemetry: (requestJson: Uint8Array) => Promise<Uint8Array>;
    }>;
  };
};

type ProofRequestV1 = Readonly<{
  assetBytes?: readonly ArrayBuffer[];
  assetMetadataJson?: ArrayBuffer;
  fullRgba?: boolean;
  kind: "prove-frame";
  requestJson: ArrayBuffer;
  samplePoints?: Readonly<Record<string, readonly [number, number]>>;
  snapshotJson: ArrayBuffer;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
  wasmModuleUrl: string;
}>;

type RetainedFrameSequenceProofRequestV1 = Readonly<{
  assetBytes?: readonly ArrayBuffer[];
  assetMetadataJson?: ArrayBuffer;
  expectedRevision: string;
  frames: readonly Readonly<{
    id: string;
    requestJson: ArrayBuffer;
  }>[];
  kind: "prove-retained-frame-sequence";
  snapshotJson: ArrayBuffer;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
  wasmModuleUrl: string;
}>;

type ErrorScopeProbeRequestV1 = Readonly<{
  fallbackRequestJson: ArrayBuffer;
  kind: "probe-error-scopes";
  normalRequestJson: ArrayBuffer;
  snapshotJson: ArrayBuffer;
  telemetryRequestJson: ArrayBuffer;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
  wasmModuleUrl: string;
}>;

type WorkerRequestV1 = ErrorScopeProbeRequestV1 | ProofRequestV1 | RetainedFrameSequenceProofRequestV1;

const GPU_BUFFER_USAGE_MAP_READ = 1;
const GPU_BUFFER_USAGE_COPY_DST = 8;
const GPU_MAP_MODE_READ = 1;
const GPU_TEXTURE_USAGE_COPY_SRC = 1;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 16;
const EMPTY_ASSET_METADATA_JSON = new TextEncoder().encode("[]");
const MAX_RETAINED_FRAME_SEQUENCE_COUNT = 16;

function createCanvasEngine(
  bindings: WasmBindingsV1,
  snapshotJson: ArrayBuffer,
  canvas: OffscreenCanvas,
  assetMetadataJson?: ArrayBuffer,
  assetBytes: readonly ArrayBuffer[] = [],
) {
  return bindings.PoietraCanvasEngineV1.create(
    new Uint8Array(snapshotJson),
    assetMetadataJson ? new Uint8Array(assetMetadataJson) : EMPTY_ASSET_METADATA_JSON,
    assetBytes.map((bytes) => new Uint8Array(bytes)),
    canvas,
  );
}

function installReadbackHooks(canvas: OffscreenCanvas, viewport: ProofRequestV1["viewport"]) {
  const context = canvas.getContext("webgpu") as unknown as GpuCanvasContextV1 | null;
  if (!context) throw new Error("The E2E worker could not acquire a WebGPU canvas context.");

  let capturedTexture: GpuTextureV1 | undefined;
  let device: GpuDeviceV1 | null = null;
  let readback: GpuBufferV1 | null = null;
  let surfaceFormat: string | null = null;
  let viewFormat: "Bgra8Unorm" | "Bgra8UnormSrgb" | "Rgba8Unorm" | "Rgba8UnormSrgb" | null = null;
  let armed = false;
  let renderSubmissionCount = 0;
  let delayedErrorScopes: ReturnType<typeof createDelayedErrorScopeBatch> | null = null;
  let errorScopePopCalls = 0;
  let errorScopePushCalls = 0;
  let nativeErrorScopePopCalls = 0;
  let nativeErrorScopePushCalls = 0;
  let scheduledNativePopRejection: ScheduledErrorScopeFailureV1 | null = null;
  let scheduledPushThrow: ScheduledErrorScopeFailureV1 | null = null;
  const hookedAdapters = new WeakSet<object>();
  const hookedDevices = new WeakSet<object>();

  const configure = context.configure.bind(context);
  context.configure = (configuration) => {
    surfaceFormat = configuration.format;
    const configuredViewFormats = configuration.viewFormats;
    const configuredViewFormat = Array.isArray(configuredViewFormats) ? configuredViewFormats[0] : undefined;
    const configuredSrgbViewFormat =
      configuredViewFormat === "bgra8unorm-srgb"
        ? "Bgra8UnormSrgb"
        : configuredViewFormat === "rgba8unorm-srgb"
          ? "Rgba8UnormSrgb"
          : null;
    const expectedViewFormat =
      configuration.format === "bgra8unorm"
        ? "Bgra8UnormSrgb"
        : configuration.format === "rgba8unorm"
          ? "Rgba8UnormSrgb"
          : null;
    if (!configuredSrgbViewFormat || !expectedViewFormat || configuredSrgbViewFormat !== expectedViewFormat) {
      throw new Error(
        `The E2E readback requires the matching sRGB surface view; received ${String(configuredViewFormat)} for ${configuration.format}.`,
      );
    }
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
    const texture = getCurrentTexture();
    const createView = texture.createView.bind(texture);
    const createObservedView = (descriptor?: Readonly<{ format?: string }> & Record<string, unknown>) => {
      const actualFormat = descriptor?.format ?? surfaceFormat;
      viewFormat =
        actualFormat === "bgra8unorm"
          ? "Bgra8Unorm"
          : actualFormat === "bgra8unorm-srgb"
            ? "Bgra8UnormSrgb"
            : actualFormat === "rgba8unorm"
              ? "Rgba8Unorm"
              : actualFormat === "rgba8unorm-srgb"
                ? "Rgba8UnormSrgb"
                : null;
      if (!viewFormat) throw new Error(`The E2E readback observed an unsupported render view ${String(actualFormat)}.`);
      return createView(descriptor);
    };
    capturedTexture = texture;
    return new Proxy(texture, {
      get(target, property) {
        if (property === "createView") return createObservedView;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  const gpu = (self.navigator as unknown as { gpu?: GpuNavigatorV1 }).gpu;
  if (!gpu) throw new Error("WebGPU is unavailable in the E2E worker.");
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (options) => {
    const adapter = await requestAdapter(options);
    if (!adapter) return null;
    if (hookedAdapters.has(adapter)) return adapter;
    hookedAdapters.add(adapter);
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      device = await requestDevice(descriptor);
      if (hookedDevices.has(device)) return device;
      hookedDevices.add(device);
      const pushErrorScope = device.pushErrorScope.bind(device);
      device.pushErrorScope = (filter) => {
        errorScopePushCalls += 1;
        if (scheduledPushThrow?.call === errorScopePushCalls) {
          const failure = scheduledPushThrow.error;
          scheduledPushThrow = null;
          throw failure;
        }
        pushErrorScope(filter);
        nativeErrorScopePushCalls += 1;
      };
      const popErrorScope = device.popErrorScope.bind(device);
      device.popErrorScope = () => {
        errorScopePopCalls += 1;
        const nativeResolution = popErrorScope();
        nativeErrorScopePopCalls += 1;
        let returnedResolution = nativeResolution;
        if (scheduledNativePopRejection?.call === errorScopePopCalls) {
          const failure = scheduledNativePopRejection.error;
          scheduledNativePopRejection = null;
          returnedResolution = Promise.reject(failure);
        }
        const batch = delayedErrorScopes;
        if (!batch) return returnedResolution;
        const delayedResolution = batch.capture(returnedResolution);
        if (batch.popCount === 3) delayedErrorScopes = null;
        return delayedResolution;
      };
      const submit = device.queue.submit.bind(device.queue);
      device.queue.submit = (commands) => {
        if (!armed || !capturedTexture || !device) {
          submit(commands);
          return;
        }
        renderSubmissionCount += 1;
        if (renderSubmissionCount !== 1) {
          submit(commands);
          return;
        }
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
      renderSubmissionCount = 0;
      viewFormat = null;
    },
    delayNextErrorScopes: (injected: readonly unknown[]) => {
      if (delayedErrorScopes) throw new Error("An error-scope delay batch is already active.");
      if (injected.length !== 3) throw new Error("Exactly three error-scope resolutions must be injected.");
      delayedErrorScopes = createDelayedErrorScopeBatch(injected);
      return delayedErrorScopes;
    },
    errorScopeCalls: () => ({ pops: errorScopePopCalls, pushes: errorScopePushCalls }),
    finishCapture: () => {
      armed = false;
      if (renderSubmissionCount !== 1) {
        throw new Error(
          `The visual parity capture requires exactly one render submit; observed ${renderSubmissionCount}.`,
        );
      }
      return renderSubmissionCount;
    },
    nativeErrorScopeCalls: () => ({ pops: nativeErrorScopePopCalls, pushes: nativeErrorScopePushCalls }),
    rejectNativePopAtOffset: (offset: number, error: unknown) => {
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("The pop rejection offset must be positive.");
      if (scheduledNativePopRejection) throw new Error("A native pop rejection is already scheduled.");
      scheduledNativePopRejection = { call: errorScopePopCalls + offset, error };
    },
    readPixels: async (
      samplePoints: Readonly<Record<string, readonly [number, number]>> = {},
      includeFullRgba = false,
    ) => {
      if (!readback || !surfaceFormat || !viewFormat) {
        throw new Error("The WASM renderer did not submit a readable surface frame.");
      }
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
      const fullRgba = includeFullRgba ? new Uint8Array(viewport.widthPx * viewport.heightPx * 4) : undefined;
      for (let y = 0; y < viewport.heightPx; y += 1) {
        for (let x = 0; x < viewport.widthPx; x += 1) {
          const rgba = pixelAt(x, y);
          const [red, green, blue] = rgba;
          fullRgba?.set(rgba, (y * viewport.widthPx + x) * 4);
          if (red === 0 && green === 0 && blue === 0) continue;
          bounds = bounds
            ? [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)]
            : [x, y, x, y];
        }
      }
      const pixels = {
        background: pixelAt(5, 5),
        blueCenter: pixelAt(90, 45),
        greenCapExterior: pixelAt(34, 25),
        greenRoundCap: pixelAt(36, 25),
        greenStrokeCenter: pixelAt(50, 25),
        nonBlackBounds: bounds,
        redCenter: pixelAt(70, 45),
        samples: Object.fromEntries(Object.entries(samplePoints).map(([name, [x, y]]) => [name, pixelAt(x, y)])),
        surfaceFormat,
        viewFormat,
      };
      readback.unmap();
      return { fullRgba, pixels };
    },
    throwPushAtOffset: (offset: number, error: unknown) => {
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("The push throw offset must be positive.");
      if (scheduledPushThrow) throw new Error("A push throw is already scheduled.");
      scheduledPushThrow = { call: errorScopePushCalls + offset, error };
    },
  };
}

function createDelayedErrorScopeBatch(injected: readonly unknown[]) {
  let resolvePopped: (() => void) | null = null;
  const popped = new Promise<void>((resolve) => {
    resolvePopped = resolve;
  });
  const releases: (() => void)[] = [];
  let released = false;
  let popCount = 0;

  return {
    capture(nativeResolution: Promise<unknown>) {
      const index = popCount;
      popCount += 1;
      if (popCount === 3) resolvePopped?.();
      const nativeOutcome = nativeResolution.then(
        () => ({ kind: "fulfilled" as const }),
        (error: unknown) => ({ error, kind: "rejected" as const }),
      );
      const release = new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return Promise.all([nativeOutcome, release]).then(([outcome]) => {
        if (outcome.kind === "rejected") throw outcome.error;
        // The deterministic injected value may replace only a successful
        // native resolution; native rejection is preserved above.
        return injected[index];
      });
    },
    get popCount() {
      return popCount;
    },
    async release() {
      if (released) return;
      released = true;
      for (const release of releases) release();
      await Promise.resolve();
    },
    async waitUntilPopped() {
      await Promise.race([
        popped,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("The engine did not pop all three WebGPU error scopes.")), 2_000),
        ),
      ]);
    },
  };
}

function decodeJson(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
}

function runtimeTraceRevision(snapshotJson: ArrayBuffer, expectedRevision: string) {
  const bundle = decodeJson(new Uint8Array(snapshotJson));
  const scene = bundle.scene;
  if (typeof scene !== "object" || scene === null || !("source" in scene)) {
    throw new Error("The retained readback bundle has no Scene source.");
  }
  const source = scene.source;
  if (
    typeof source !== "object" ||
    source === null ||
    !("kind" in source) ||
    source.kind !== "imported-manim-runtime-trace" ||
    !("traceDigest" in source) ||
    source.traceDigest !== expectedRevision
  ) {
    throw new Error("The retained readback bundle does not match the expected Runtime Trace revision.");
  }
  return expectedRevision;
}

async function proveRetainedFrameSequence(request: RetainedFrameSequenceProofRequestV1) {
  if (request.frames.length < 1 || request.frames.length > MAX_RETAINED_FRAME_SEQUENCE_COUNT) {
    throw new Error(`A retained readback sequence requires 1-${MAX_RETAINED_FRAME_SEQUENCE_COUNT} frames.`);
  }
  const ids = new Set<string>();
  for (const frame of request.frames) {
    if (!frame.id || frame.id.length > 128 || ids.has(frame.id)) {
      throw new Error("Retained readback frame ids must be unique non-empty strings of at most 128 characters.");
    }
    ids.add(frame.id);
  }

  const revision = runtimeTraceRevision(request.snapshotJson, request.expectedRevision);
  const canvas = new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx);
  const hooks = installReadbackHooks(canvas, request.viewport);
  const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
  await bindings.default();
  if (bindings.poietraCanvasAbiVersion() !== POIETRA_CANVAS_ABI_VERSION) {
    throw new Error("Unexpected canvas ABI version.");
  }
  const engine = await createCanvasEngine(
    bindings,
    request.snapshotJson,
    canvas,
    request.assetMetadataJson,
    request.assetBytes,
  );

  const frames = [];
  const renderSubmissionCounts: number[] = [];
  for (const frame of request.frames) {
    hooks.arm();
    const responseJson = await engine.render(new Uint8Array(frame.requestJson));
    const renderSubmissionCount = hooks.finishCapture();
    const response = decodeJson(responseJson);
    const { fullRgba, pixels } = await hooks.readPixels({}, true);
    if (!fullRgba) throw new Error(`The retained readback frame ${frame.id} has no full RGBA payload.`);
    renderSubmissionCounts.push(renderSubmissionCount);
    frames.push({ id: frame.id, pixels, response, rgba: fullRgba.buffer });
  }

  return {
    capture: {
      installCount: 1,
      policy: "one-retained-engine",
      renderSubmissionCounts,
    },
    frames,
    kind: "retained-frame-sequence-proof" as const,
    revision,
    viewport: request.viewport,
  };
}

function scopeCallDelta(
  before: Readonly<{ pops: number; pushes: number }>,
  after: Readonly<{ pops: number; pushes: number }>,
) {
  return { pops: after.pops - before.pops, pushes: after.pushes - before.pushes };
}

function encodePlaybackRequest(template: Record<string, unknown>, packetId: string) {
  return new TextEncoder().encode(JSON.stringify({ ...template, packetId }));
}

function requirePresentedPacketId(response: Record<string, unknown>, expectedPacketId: string) {
  const result = response.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("kind" in result) ||
    result.kind !== "presented" ||
    !("packetId" in result) ||
    result.packetId !== expectedPacketId
  ) {
    throw new Error(`The stalled-scope playback frame was not correlated to ${expectedPacketId}.`);
  }
  return expectedPacketId;
}

function observeSettlement<T>(promise: Promise<T>) {
  let settled = false;
  const value = promise.then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  return { isSettled: () => settled, value };
}

async function waitForTaskTurn() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function probeErrorScopes(request: ErrorScopeProbeRequestV1) {
  const canvas = new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx);
  const hooks = installReadbackHooks(canvas, request.viewport);
  const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
  await bindings.default();
  if (bindings.poietraCanvasAbiVersion() !== POIETRA_CANVAS_ABI_VERSION) {
    throw new Error("Unexpected canvas ABI version.");
  }
  const createEngine = (targetCanvas: OffscreenCanvas) =>
    createCanvasEngine(bindings, request.snapshotJson, targetCanvas);
  const engine = await createEngine(canvas);

  const normalScopeCallsBefore = hooks.errorScopeCalls();
  const normalScopes = hooks.delayNextErrorScopes([null, null, null]);
  const normalRender = observeSettlement(engine.render(new Uint8Array(request.normalRequestJson)));
  await normalScopes.waitUntilPopped();
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  const normalSettledBeforeRelease = normalRender.isSettled();
  if (!normalSettledBeforeRelease) {
    await normalScopes.release();
    throw new Error("The normal render ACK waited for the delayed WebGPU error scopes.");
  }
  const normalResponse = decodeJson(await normalRender.value);
  const normalInitialRotationScopeCalls = scopeCallDelta(normalScopeCallsBefore, hooks.errorScopeCalls());

  // The first batch is pending while one replacement batch remains active on
  // the device stack across enough frames to represent continuous playback.
  // None may add another active batch, pop, Promise set, or detached drain.
  const normalTemplate = decodeJson(new Uint8Array(request.normalRequestJson));
  const stalledPlaybackPacketIds: string[] = [];
  for (let frame = 0; frame < 64; frame += 1) {
    const packetId = `canvas:scope-playback-${frame}`;
    const response = decodeJson(await engine.render(encodePlaybackRequest(normalTemplate, packetId)));
    stalledPlaybackPacketIds.push(requirePresentedPacketId(response, packetId));
  }
  const normalScopeCallsWhilePending = scopeCallDelta(normalScopeCallsBefore, hooks.errorScopeCalls());

  // Diagnostic scopes nest inside the retained normal active batch. They are
  // independently popped/awaited while the outer normal batch remains active.
  const telemetryScopeCallsBefore = hooks.errorScopeCalls();
  const telemetryScopes = hooks.delayNextErrorScopes([null, null, null]);
  const telemetryStarted = performance.now();
  const telemetryRender = observeSettlement(engine.renderWithTelemetry(new Uint8Array(request.telemetryRequestJson)));
  await telemetryScopes.waitUntilPopped();
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  const telemetrySettledBeforeRelease = telemetryRender.isSettled();
  await telemetryScopes.release();
  const telemetryResponse = decodeJson(await telemetryRender.value);
  const telemetryElapsedMs = performance.now() - telemetryStarted;
  const telemetryScopeCalls = scopeCallDelta(telemetryScopeCallsBefore, hooks.errorScopeCalls());

  await normalScopes.release();
  // The detached Rust drain resumes from Promise microtasks. Yield a task turn
  // so the following frame can rotate the rolling active batch into the now
  // free pending slot.
  await waitForTaskTurn();

  const validationError = {
    message: "injected delayed validation failure",
    name: "GPUValidationError",
  };
  const validationScopeCallsBefore = hooks.errorScopeCalls();
  const validationScopes = hooks.delayNextErrorScopes([validationError, null, null]);
  const validationPacketId = "canvas:scope-validation-rotation";
  const validationRender = observeSettlement(engine.render(encodePlaybackRequest(normalTemplate, validationPacketId)));
  await validationScopes.waitUntilPopped();
  await new Promise<void>((resolve) => setTimeout(resolve, 75));
  const validationSettledBeforeRelease = validationRender.isSettled();
  if (!validationSettledBeforeRelease) {
    await validationScopes.release();
    throw new Error("The normal rotation ACK waited for its delayed WebGPU error scopes.");
  }
  const validationResponse = decodeJson(await validationRender.value);
  requirePresentedPacketId(validationResponse, validationPacketId);
  const validationRotationScopeCalls = scopeCallDelta(validationScopeCallsBefore, hooks.errorScopeCalls());
  await validationScopes.release();
  await waitForTaskTurn();
  const fallbackResponse = decodeJson(await engine.render(new Uint8Array(request.fallbackRequestJson)));

  // A telemetry push that throws after one successful nested push must
  // synchronously pop that partial batch, fail the current request, and make
  // the engine terminal before its rolling outer batch can be rotated.
  const pushFailureEngine = await createEngine(
    new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx),
  );
  const pushWarmPacketId = "canvas:scope-push-failure-warm";
  requirePresentedPacketId(
    decodeJson(await pushFailureEngine.render(encodePlaybackRequest(normalTemplate, pushWarmPacketId))),
    pushWarmPacketId,
  );
  await waitForTaskTurn();
  const pushFailureCallsBefore = hooks.errorScopeCalls();
  const pushFailureNativeCallsBefore = hooks.nativeErrorScopeCalls();
  const pushFailureError = new Error("injected synchronous push failure");
  pushFailureError.name = "OperationError";
  hooks.throwPushAtOffset(2, pushFailureError);
  const pushFailurePacketId = "canvas:scope-push-failure";
  const pushFailureResponse = decodeJson(
    await pushFailureEngine.renderWithTelemetry(encodePlaybackRequest(normalTemplate, pushFailurePacketId)),
  );
  await waitForTaskTurn();
  const pushFailureScopeCalls = scopeCallDelta(pushFailureCallsBefore, hooks.errorScopeCalls());
  const pushFailureNativeScopeCalls = scopeCallDelta(pushFailureNativeCallsBefore, hooks.nativeErrorScopeCalls());
  const pushFailureTerminalCallsBefore = hooks.errorScopeCalls();
  const pushFailureFallbackPacketId = "canvas:scope-push-failure-fallback";
  const pushFailureFallbackResponse = decodeJson(
    await pushFailureEngine.render(encodePlaybackRequest(normalTemplate, pushFailureFallbackPacketId)),
  );
  const pushFailureTerminalScopeCalls = scopeCallDelta(pushFailureTerminalCallsBefore, hooks.errorScopeCalls());

  // A native pop Promise rejection is asynchronous, so the awaited telemetry
  // request reports it. Retaining the same failure prevents the next normal
  // request from touching the still-owned rolling outer batch.
  const popRejectionEngine = await createEngine(
    new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx),
  );
  const popWarmPacketId = "canvas:scope-pop-rejection-warm";
  requirePresentedPacketId(
    decodeJson(await popRejectionEngine.render(encodePlaybackRequest(normalTemplate, popWarmPacketId))),
    popWarmPacketId,
  );
  await waitForTaskTurn();
  const popRejectionCallsBefore = hooks.errorScopeCalls();
  const popRejectionNativeCallsBefore = hooks.nativeErrorScopeCalls();
  const popRejectionError = new Error("injected native pop rejection");
  popRejectionError.name = "OperationError";
  const delayedPopRejectionScopes = hooks.delayNextErrorScopes([null, null, null]);
  hooks.rejectNativePopAtOffset(1, popRejectionError);
  const popRejectionPacketId = "canvas:scope-pop-rejection";
  const popRejectionRender = observeSettlement(
    popRejectionEngine.renderWithTelemetry(encodePlaybackRequest(normalTemplate, popRejectionPacketId)),
  );
  await delayedPopRejectionScopes.waitUntilPopped();
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  const popRejectionSettledBeforeRelease = popRejectionRender.isSettled();
  await delayedPopRejectionScopes.release();
  const popRejectionResponse = decodeJson(await popRejectionRender.value);
  const popRejectionScopeCalls = scopeCallDelta(popRejectionCallsBefore, hooks.errorScopeCalls());
  const popRejectionNativeScopeCalls = scopeCallDelta(popRejectionNativeCallsBefore, hooks.nativeErrorScopeCalls());
  const popRejectionTerminalCallsBefore = hooks.errorScopeCalls();
  const popRejectionFallbackPacketId = "canvas:scope-pop-rejection-fallback";
  const popRejectionFallbackResponse = decodeJson(
    await popRejectionEngine.render(encodePlaybackRequest(normalTemplate, popRejectionFallbackPacketId)),
  );
  const popRejectionTerminalScopeCalls = scopeCallDelta(popRejectionTerminalCallsBefore, hooks.errorScopeCalls());

  return {
    fallbackResponse,
    normalResponse,
    normalResponseKeys: Object.keys(normalResponse).sort(),
    normalSettledBeforeRelease,
    normalInitialRotationScopeCalls,
    normalScopeCallsWhilePending,
    popRejectionFallbackResponse,
    popRejectionNativeScopeCalls,
    popRejectionResponse,
    popRejectionScopeCalls,
    popRejectionSettledBeforeRelease,
    popRejectionTerminalScopeCalls,
    pushFailureFallbackResponse,
    pushFailureNativeScopeCalls,
    pushFailureResponse,
    pushFailureScopeCalls,
    pushFailureTerminalScopeCalls,
    scopePopCounts: {
      normal: normalScopes.popCount,
      telemetry: telemetryScopes.popCount,
      validation: validationScopes.popCount,
    },
    stalledPlaybackPacketIds,
    telemetryScopeCalls,
    telemetryElapsedMs,
    telemetryResponse,
    telemetrySettledBeforeRelease,
    validationResponse,
    validationRotationScopeCalls,
    validationSettledBeforeRelease,
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerRequestV1>) => {
  void (async () => {
    const request = event.data;
    if (request.kind === "probe-error-scopes") {
      self.postMessage({ kind: "error-scope-proof", value: await probeErrorScopes(request) });
      return;
    }
    if (request.kind === "prove-retained-frame-sequence") {
      const proof = await proveRetainedFrameSequence(request);
      self.postMessage(proof, { transfer: proof.frames.map(({ rgba }) => rgba) });
      return;
    }
    if (request.kind !== "prove-frame") throw new Error("Unknown E2E canvas proof request.");
    const canvas = new OffscreenCanvas(request.viewport.widthPx, request.viewport.heightPx);
    const hooks = installReadbackHooks(canvas, request.viewport);
    const bindings = (await import(/* @vite-ignore */ request.wasmModuleUrl)) as WasmBindingsV1;
    await bindings.default();
    if (bindings.poietraCanvasAbiVersion() !== POIETRA_CANVAS_ABI_VERSION) {
      throw new Error("Unexpected canvas ABI version.");
    }
    const engine = await createCanvasEngine(
      bindings,
      request.snapshotJson,
      canvas,
      request.assetMetadataJson,
      request.assetBytes,
    );
    hooks.arm();
    const responseJson = await engine.render(new Uint8Array(request.requestJson));
    const renderSubmissionCount = hooks.finishCapture();
    const response = decodeJson(responseJson);
    const { fullRgba, pixels } = await hooks.readPixels(request.samplePoints, request.fullRgba);
    const proof = {
      capture: { policy: "exactly-one-render-submit", renderSubmissionCount },
      kind: "proof",
      pixels,
      response,
      ...(fullRgba ? { rgba: fullRgba.buffer } : {}),
    };
    if (fullRgba) {
      self.postMessage(proof, { transfer: [fullRgba.buffer] });
    } else {
      self.postMessage(proof);
    }
  })().catch((error: unknown) => {
    self.postMessage({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  });
});
