/**
 * Dev/test-only GPU readback instrumentation for the retained canvas worker.
 *
 * Inside a `beginFrame`/`commit` window, every submission on the device that
 * owns the configured canvas surface copies the acquired surface texture into
 * a staged mappable buffer (the copy must ride the submission — the texture
 * expires when the acquiring task ends); a later submission replaces the copy,
 * so a frame is always proven by its FINAL draw. `commit` promotes the staged
 * copy only after the worker verified the response correlation; failed renders
 * discard it and keep the last committed (still-presented) frame.
 *
 * Invariants:
 * - At most one staged and one committed buffer exist; every replacement,
 *   discard, dispose, staging failure, and non-promoting commit destroys the
 *   buffer it releases exactly once. A commit that cannot promote (nothing
 *   staged, viewport mismatch) also clears the committed evidence — the
 *   surface is unproven, so stale pixels must never pass as proof.
 * - Staging is bound to `configure(configuration.device)`; other devices'
 *   queues pass through untouched. A successful reconfigure atomically rebinds
 *   device/format and destroys captured texture plus staged/committed
 *   evidence; a throwing reconfigure preserves the previous state exactly.
 * - Install is failure-atomic (any mid-install throw rolls back every hook),
 *   and dispose restores every tracked hook identity-safely: a hook is only
 *   restored while the property still holds this capture's wrapper, so later
 *   external wrappers survive and ours degrades to a passthrough.
 *
 * Callers serialize readSamples/commit/discard (the worker's queue does).
 */

type CanvasConfigurationV1 = Readonly<{
  device: unknown;
  format: string;
  usage?: number;
}> &
  Record<string, unknown>;

export type GpuBufferV1 = {
  destroy: () => void;
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

export type GpuNavigatorV1 = {
  requestAdapter: (options?: unknown) => Promise<GpuAdapterV1 | null>;
};

export type EvidenceCanvasV1 = Readonly<{
  getContext: (contextId: "webgpu") => unknown;
}>;

const GPU_BUFFER_USAGE_MAP_READ = 1;
const GPU_BUFFER_USAGE_COPY_DST = 8;
const GPU_MAP_MODE_READ = 1;
const GPU_TEXTURE_USAGE_COPY_SRC = 1;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 16;

export type CapturedFrameCorrelationV1 = Readonly<{
  packetId: string;
  /** Scene revision the frame was rendered against, kept with the evidence
   * so a response can never claim a revision the pixels were not drawn for. */
  revision: string;
  sampleTime: number;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

export type CapturedFrameEvidenceV1 = Readonly<{
  correlation: CapturedFrameCorrelationV1;
  samples: readonly (readonly [number, number, number, number])[];
  surfaceFormat: string;
}>;

/**
 * Explicit result of a commit attempt. Only `committed` means the evidence now
 * proves the frame the correlation describes; the other outcomes mean the
 * committed evidence was cleared and readSamples will refuse until a later
 * frame commits.
 */
export type CanvasFrameEvidenceCommitOutcomeV1 = "committed" | "no-staged-submission" | "viewport-mismatch";

export type CanvasFrameEvidenceCaptureV1 = Readonly<{
  /** Start staging copies for the frame about to be rendered. */
  beginFrame: (viewport: CapturedFrameCorrelationV1["viewport"]) => void;
  /**
   * Promote the staged (final-submission) copy to the committed evidence.
   * A non-`committed` outcome clears the previously committed evidence so a
   * stale frame can never be exposed as proof of this one.
   */
  commit: (correlation: CapturedFrameCorrelationV1) => CanvasFrameEvidenceCommitOutcomeV1;
  /** Drop the staged copy after a failed render; the committed frame stays. */
  discard: () => void;
  /** Destroy every retained GPU buffer and restore every installed hook. */
  dispose: () => void;
  /**
   * Drop the committed evidence without touching the hooks — used after a
   * successful Scene replace, when the retained frame no longer describes the
   * installed Scene; evidence then refuses until a new frame commits.
   */
  invalidateCommitted: () => void;
  readSamples: (
    points: readonly Readonly<{ fractionX: number; fractionY: number }>[],
  ) => Promise<CapturedFrameEvidenceV1 | null>;
}>;

type StagedCopyV1 = Readonly<{ buffer: GpuBufferV1; viewport: CapturedFrameCorrelationV1["viewport"] }>;

export function installCanvasFrameEvidenceCaptureV1(
  canvas: EvidenceCanvasV1,
  gpuNavigator?: GpuNavigatorV1,
): CanvasFrameEvidenceCaptureV1 {
  const context = canvas.getContext("webgpu") as GpuCanvasContextV1 | null;
  if (!context) throw new Error("The frame evidence capture could not acquire a WebGPU canvas context.");

  let capturedTexture: unknown;
  let committed: Readonly<{ buffer: GpuBufferV1; correlation: CapturedFrameCorrelationV1 }> | null = null;
  let disposed = false;
  let staged: StagedCopyV1 | null = null;
  let stagingViewport: CapturedFrameCorrelationV1["viewport"] | null = null;
  // The one device allowed to stage: a copy recorded on a foreign device
  // would be a cross-device validation error and perturb unrelated work.
  let surfaceDevice: unknown = null;
  let surfaceFormat: string | null = null;

  const bytesPerRowFor = (viewport: CapturedFrameCorrelationV1["viewport"]) =>
    Math.ceil((viewport.widthPx * 4) / 256) * 256;
  const destroyStaged = () => {
    staged?.buffer.destroy();
    staged = null;
  };
  const destroyCommitted = () => {
    committed?.buffer.destroy();
    committed = null;
  };

  // Central hook registry: rollback/dispose restore in reverse order, and
  // only while the property still holds this capture's wrapper (see header).
  const installedHooks: { restore: () => void }[] = [];
  const installHook = <Target extends object, Key extends keyof Target>(
    target: Target,
    key: Key,
    createWrapper: (original: Target[Key]) => Target[Key],
  ) => {
    const original = target[key];
    const wrapper = createWrapper(original);
    target[key] = wrapper;
    installedHooks.push({
      restore: () => {
        if (target[key] === wrapper) target[key] = original;
      },
    });
  };
  const restoreInstalledHooks = () => {
    while (installedHooks.length > 0) installedHooks.pop()?.restore();
  };

  // Each adapter and queue is hooked at most once, and marked as hooked only
  // after its hook installed successfully, so a failed wrap can be retried.
  const hookedAdapters = new WeakSet<object>();
  const hookedQueues = new WeakSet<object>();

  const hookQueue = (gpuDevice: GpuDeviceV1) => {
    if (hookedQueues.has(gpuDevice.queue)) return;
    installHook(gpuDevice.queue, "submit", (original) => {
      const submit = original.bind(gpuDevice.queue);
      return (commands) => {
        const viewport = stagingViewport;
        // Only the surface-owning device may stage; every other queue
        // submits unchanged.
        if (disposed || !viewport || !capturedTexture || gpuDevice !== surfaceDevice) {
          submit(commands);
          return;
        }
        // Every submission of the staged frame replaces the previous copy so
        // the committed evidence always reflects the final draw.
        destroyStaged();
        const buffer = gpuDevice.createBuffer({
          size: bytesPerRowFor(viewport) * viewport.heightPx,
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        });
        try {
          const encoder = gpuDevice.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture: capturedTexture },
            { buffer, bytesPerRow: bytesPerRowFor(viewport), rowsPerImage: viewport.heightPx },
            { depthOrArrayLayers: 1, height: viewport.heightPx, width: viewport.widthPx },
          );
          submit([...commands, encoder.finish()]);
        } catch (error) {
          // Never assigned to `staged`, so this is its only destroy; the
          // failure still propagates so the worker discards the frame.
          buffer.destroy();
          throw error;
        }
        staged = { buffer, viewport };
      };
    });
    hookedQueues.add(gpuDevice.queue);
  };

  const hookAdapter = (adapter: GpuAdapterV1) => {
    if (hookedAdapters.has(adapter)) return;
    installHook(adapter, "requestDevice", (original) => {
      const requestDevice = original.bind(adapter);
      return async (descriptor) => {
        const gpuDevice = await requestDevice(descriptor);
        if (!disposed) hookQueue(gpuDevice);
        return gpuDevice;
      };
    });
    hookedAdapters.add(adapter);
  };

  const gpu = gpuNavigator ?? (globalThis.navigator as unknown as { gpu?: GpuNavigatorV1 }).gpu;
  try {
    installHook(context, "configure", (original) => {
      const configure = original.bind(context);
      return (configuration) => {
        if (disposed) {
          configure(configuration);
          return;
        }
        // The underlying (usage-widened) configure runs FIRST: if it
        // throws, the previous binding and evidence stay exactly as they were.
        configure({
          ...configuration,
          usage:
            (configuration.usage ?? GPU_TEXTURE_USAGE_RENDER_ATTACHMENT) |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_COPY_SRC,
        });
        // Success atomically rebinds staging and invalidates everything
        // captured from the old surface; only a fresh acquisition and
        // submission on the new device can re-arm evidence.
        surfaceFormat = configuration.format;
        surfaceDevice = configuration.device;
        capturedTexture = undefined;
        destroyStaged();
        destroyCommitted();
      };
    });
    installHook(context, "getCurrentTexture", (original) => {
      const getCurrentTexture = original.bind(context);
      return () => {
        const texture = getCurrentTexture();
        if (!disposed) capturedTexture = texture;
        return texture;
      };
    });
    if (!gpu) throw new Error("WebGPU is unavailable for frame evidence capture.");
    installHook(gpu, "requestAdapter", (original) => {
      const requestAdapter = original.bind(gpu);
      return async (options) => {
        const adapter = await requestAdapter(options);
        if (!adapter || disposed) return adapter;
        hookAdapter(adapter);
        return adapter;
      };
    });
  } catch (error) {
    // Failure-atomic install: leave no partial monkey patch behind.
    restoreInstalledHooks();
    throw error;
  }

  return {
    beginFrame: (viewport) => {
      destroyStaged();
      stagingViewport = viewport;
      capturedTexture = undefined;
    },
    commit: (correlation) => {
      stagingViewport = null;
      if (!staged) {
        // Nothing proves what the surface now shows — stale committed
        // evidence must not pass as this response's proof.
        destroyCommitted();
        return "no-staged-submission";
      }
      if (
        staged.viewport.heightPx !== correlation.viewport.heightPx ||
        staged.viewport.widthPx !== correlation.viewport.widthPx
      ) {
        destroyStaged();
        destroyCommitted();
        return "viewport-mismatch";
      }
      destroyCommitted();
      committed = { buffer: staged.buffer, correlation };
      staged = null;
      return "committed";
    },
    discard: () => {
      stagingViewport = null;
      destroyStaged();
    },
    dispose: () => {
      disposed = true;
      stagingViewport = null;
      capturedTexture = undefined;
      surfaceDevice = null;
      destroyStaged();
      destroyCommitted();
      restoreInstalledHooks();
    },
    invalidateCommitted: () => {
      destroyCommitted();
    },
    readSamples: async (points) => {
      const frame = committed;
      if (!frame || !surfaceFormat) return null;
      const { viewport } = frame.correlation;
      await frame.buffer.mapAsync(GPU_MAP_MODE_READ);
      try {
        const mapped = new Uint8Array(frame.buffer.getMappedRange());
        const bytesPerRow = bytesPerRowFor(viewport);
        const bgra = surfaceFormat.startsWith("bgra8");
        const samples = points.map((point) => {
          const x = Math.min(viewport.widthPx - 1, Math.round(viewport.widthPx * point.fractionX));
          const y = Math.min(viewport.heightPx - 1, Math.round(viewport.heightPx * point.fractionY));
          const offset = y * bytesPerRow + x * 4;
          return [
            mapped[offset + (bgra ? 2 : 0)] ?? 0,
            mapped[offset + 1] ?? 0,
            mapped[offset + (bgra ? 0 : 2)] ?? 0,
            mapped[offset + 3] ?? 0,
          ] as const;
        });
        return { correlation: frame.correlation, samples, surfaceFormat };
      } finally {
        frame.buffer.unmap();
      }
    },
  };
}
