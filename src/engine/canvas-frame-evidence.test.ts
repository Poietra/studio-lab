import { describe, expect, it } from "vitest";
import {
  type CanvasFrameEvidenceCaptureV1,
  type CapturedFrameCorrelationV1,
  type GpuNavigatorV1,
  installCanvasFrameEvidenceCaptureV1,
} from "./canvas-frame-evidence";
import { createFakeGpuDevice, type FakeGpuStageFailures } from "./canvas-frame-evidence.test-fixtures";

const VIEWPORT = { heightPx: 2, widthPx: 2 } as const;
const CORRELATION = { packetId: "canvas:1", revision: "a".repeat(64), sampleTime: 1, viewport: VIEWPORT } as const;
const CENTER = [{ fractionX: 0, fractionY: 0 }] as const;

function createFakeGpu() {
  const configureCalls: Record<string, unknown>[] = [];
  const failures: FakeGpuStageFailures = {};
  const textures: { fill: number }[] = [];
  const { buffers, device } = createFakeGpuDevice(failures);
  const adapter = { requestDevice: () => Promise.resolve(device) };
  const gpu = { requestAdapter: () => Promise.resolve(adapter) };
  const context = {
    configure: (configuration: unknown) => {
      configureCalls.push(configuration as Record<string, unknown>);
    },
    getCurrentTexture: () => textures.at(-1),
  };
  const canvas = { getContext: (id: string) => (id === "webgpu" ? context : null) };
  return {
    buffers,
    canvas,
    configureCalls,
    device,
    failures,
    gpu,
    async initialize(capture: CanvasFrameEvidenceCaptureV1) {
      // Mirrors the engine's initialization order: request the (hooked)
      // adapter and device, then configure the surface with that device.
      const hookedAdapter = await gpu.requestAdapter();
      await hookedAdapter?.requestDevice();
      (canvas.getContext("webgpu") as { configure: (value: unknown) => void }).configure({
        device,
        format: "rgba8unorm",
      });
      return capture;
    },
    renderFrame(fill: number, submissions = 1) {
      // One engine render: acquire the surface texture, then submit one or
      // more times; later submissions bump the fill (fresh draw contents).
      const texture = { fill };
      textures.push(texture);
      const context = canvas.getContext("webgpu") as { getCurrentTexture: () => unknown };
      context.getCurrentTexture();
      for (let index = 0; index < submissions; index += 1) {
        texture.fill = fill + index;
        device.queue.submit([]);
      }
    },
  };
}

type CaptureFixture = Readonly<{ capture: CanvasFrameEvidenceCaptureV1; fake: ReturnType<typeof createFakeGpu> }>;

async function createCapture(): Promise<CaptureFixture> {
  const fake = createFakeGpu();
  const capture = installCanvasFrameEvidenceCaptureV1(fake.canvas, fake.gpu);
  await fake.initialize(capture);
  return { capture, fake };
}

function presentFrame(
  { capture, fake }: CaptureFixture,
  fill: number,
  correlation: CapturedFrameCorrelationV1 = CORRELATION,
) {
  capture.beginFrame(VIEWPORT);
  fake.renderFrame(fill);
  return capture.commit(correlation);
}

async function firstSample(capture: CanvasFrameEvidenceCaptureV1) {
  return (await capture.readSamples(CENTER))?.samples[0]?.[0];
}

/** Two independent stageable devices behind one hooked navigator. */
async function createCrossDeviceFixture() {
  const deviceA = createFakeGpuDevice();
  const deviceB = createFakeGpuDevice();
  const pendingDevices = [deviceA.device, deviceB.device];
  const gpu = {
    requestAdapter: () => {
      const device = pendingDevices.shift();
      if (!device) throw new Error("No more fake adapters are available.");
      return Promise.resolve({ requestDevice: () => Promise.resolve(device) });
    },
  };
  const state = { configureError: null as Error | null, texture: null as { fill: number } | null };
  const context = {
    configure: (_configuration?: unknown) => {
      if (state.configureError) throw state.configureError;
    },
    getCurrentTexture: () => state.texture as unknown,
  };
  const canvas = { getContext: (contextId: string) => (contextId === "webgpu" ? context : null) };
  const capture = installCanvasFrameEvidenceCaptureV1(canvas, gpu as unknown as GpuNavigatorV1);
  await (await gpu.requestAdapter()).requestDevice();
  await (await gpu.requestAdapter()).requestDevice();
  return {
    acquire: (fill: number) => {
      state.texture = { fill };
      context.getCurrentTexture();
    },
    capture,
    context,
    deviceA,
    deviceB,
    state,
  };
}

describe("installCanvasFrameEvidenceCaptureV1", () => {
  it("commits the final submission of a multi-submit frame and serves repeated reads", async () => {
    const fixture = await createCapture();
    fixture.capture.beginFrame(VIEWPORT);
    fixture.fake.renderFrame(10, 2);
    fixture.capture.commit(CORRELATION);
    const evidence = await fixture.capture.readSamples(CENTER);
    expect(evidence?.samples[0]?.[0]).toBe(11);
    expect(evidence?.correlation).toEqual(CORRELATION);
    expect(await firstSample(fixture.capture)).toBe(11);
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1, 0]);
  });

  it("destroys the previous committed buffer exactly once on consecutive frame captures", async () => {
    const fixture = await createCapture();
    presentFrame(fixture, 10);
    presentFrame(fixture, 20, { ...CORRELATION, packetId: "canvas:2", sampleTime: 2 });
    presentFrame(fixture, 30, { ...CORRELATION, packetId: "canvas:3", sampleTime: 3 });
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1, 1, 0]);
    const evidence = await fixture.capture.readSamples(CENTER);
    expect(evidence?.samples[0]?.[0]).toBe(30);
    expect(evidence?.correlation.packetId).toBe("canvas:3");
  });

  it("discards a failed render's staged copy while keeping the last presented frame", async () => {
    const fixture = await createCapture();
    presentFrame(fixture, 10);
    fixture.capture.beginFrame(VIEWPORT);
    fixture.fake.renderFrame(99);
    fixture.capture.discard();
    expect(await firstSample(fixture.capture)).toBe(10);
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([0, 1]);
  });

  it("returns null before any frame was committed and after dispose", async () => {
    const fixture = await createCapture();
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    presentFrame(fixture, 10);
    fixture.capture.dispose();
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    fixture.capture.dispose();
    fixture.capture.discard();
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1]);
  });

  it("stops staging copies for submissions outside beginFrame/commit windows", async () => {
    const fixture = await createCapture();
    presentFrame(fixture, 10);
    fixture.fake.renderFrame(50);
    expect(fixture.fake.buffers).toHaveLength(1);
    expect(await firstSample(fixture.capture)).toBe(10);
  });

  it.each([["createCommandEncoder"], ["copyTextureToBuffer"], ["finish"], ["submit"]] as const)(
    "destroys the staged buffer exactly once when %s throws mid-staging",
    async (stage) => {
      const fixture = await createCapture();
      presentFrame(fixture, 10);
      fixture.capture.beginFrame(VIEWPORT);
      fixture.fake.failures[stage] = new Error(`${stage} failed`);
      expect(() => fixture.fake.renderFrame(20)).toThrow(`${stage} failed`);
      delete fixture.fake.failures[stage];
      fixture.capture.discard();
      expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([0, 1]);
      expect(await firstSample(fixture.capture)).toBe(10);
      expect(presentFrame(fixture, 30, { ...CORRELATION, packetId: "canvas:2", sampleTime: 2 })).toBe("committed");
      expect(await firstSample(fixture.capture)).toBe(30);
    },
  );

  it("propagates a createBuffer failure without corrupting the staging window", async () => {
    const fixture = await createCapture();
    fixture.capture.beginFrame(VIEWPORT);
    fixture.fake.failures.createBuffer = new Error("createBuffer failed");
    expect(() => fixture.fake.renderFrame(10)).toThrow("createBuffer failed");
    delete fixture.fake.failures.createBuffer;
    fixture.capture.discard();
    expect(fixture.fake.buffers).toHaveLength(0);
    expect(presentFrame(fixture, 20)).toBe("committed");
    expect(await firstSample(fixture.capture)).toBe(20);
  });

  it("makes zero-submission commits explicit and clears any previously committed evidence", async () => {
    const fixture = await createCapture();
    fixture.capture.beginFrame(VIEWPORT);
    expect(fixture.capture.commit(CORRELATION)).toBe("no-staged-submission");
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    presentFrame(fixture, 10);
    fixture.capture.beginFrame(VIEWPORT);
    expect(fixture.capture.commit({ ...CORRELATION, packetId: "canvas:2", sampleTime: 2 })).toBe(
      "no-staged-submission",
    );
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1]);
  });

  it("clears previously committed evidence when the staged viewport mismatches the correlation", async () => {
    const fixture = await createCapture();
    presentFrame(fixture, 10);
    fixture.capture.beginFrame(VIEWPORT);
    fixture.fake.renderFrame(20);
    expect(fixture.capture.commit({ ...CORRELATION, viewport: { heightPx: 4, widthPx: 4 } })).toBe("viewport-mismatch");
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
  });

  it("invalidates committed evidence explicitly while keeping the hooks and staging path alive", async () => {
    const fixture = await createCapture();
    presentFrame(fixture, 10);
    fixture.capture.invalidateCommitted();
    expect(await fixture.capture.readSamples(CENTER)).toBeNull();
    expect(fixture.fake.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1]);
    expect(presentFrame(fixture, 20, { ...CORRELATION, packetId: "canvas:4", revision: "b".repeat(64) })).toBe(
      "committed",
    );
    const evidence = await fixture.capture.readSamples(CENTER);
    expect(evidence?.samples[0]?.[0]).toBe(20);
    expect(evidence?.correlation.revision).toBe("b".repeat(64));
  });

  it("restores the context, adapter, and queue hooks on dispose so a retry wraps exactly once", async () => {
    const fixture = await createCapture();
    const { fake } = fixture;
    presentFrame(fixture, 10);
    const context = fake.canvas.getContext("webgpu") as { configure: (value: unknown) => void };
    context.configure({ device: {}, format: "rgba8unorm" });
    expect(fake.configureCalls.at(-1)).toHaveProperty("usage");
    fixture.capture.dispose();
    context.configure({ device: {}, format: "rgba8unorm" });
    expect(fake.configureCalls.at(-1)).not.toHaveProperty("usage");
    fixture.capture.beginFrame(VIEWPORT);
    fake.renderFrame(20);
    expect(fake.buffers).toHaveLength(1);
    const second = installCanvasFrameEvidenceCaptureV1(fake.canvas, fake.gpu);
    await fake.initialize(second);
    second.beginFrame(VIEWPORT);
    fake.renderFrame(30);
    expect(second.commit({ ...CORRELATION, packetId: "canvas:2", sampleTime: 2 })).toBe("committed");
    expect(await firstSample(second)).toBe(30);
    expect(fake.buffers).toHaveLength(2);
  });

  it.each([
    ["WebGPU is unavailable", undefined, /WebGPU is unavailable/],
    ["the adapter hook cannot be assigned", "frozen-gpu", TypeError],
  ] as const)("rolls back the context hooks when %s, and a retry succeeds", async (_mode, gpuMode, thrown) => {
    const fake = createFakeGpu();
    const context = fake.canvas.getContext("webgpu") as { configure: unknown; getCurrentTexture: unknown };
    const originalConfigure = context.configure;
    const originalGetCurrentTexture = context.getCurrentTexture;
    // The install throws AFTER wrapping the context (no navigator.gpu in this
    // environment, or an unassignable requestAdapter): failure-atomic rollback
    // must leave no monkey patch behind.
    const badGpu = gpuMode === "frozen-gpu" ? Object.freeze({ requestAdapter: fake.gpu.requestAdapter }) : undefined;
    expect(() => installCanvasFrameEvidenceCaptureV1(fake.canvas, badGpu)).toThrow(thrown);
    expect(context.configure).toBe(originalConfigure);
    expect(context.getCurrentTexture).toBe(originalGetCurrentTexture);
    const capture = installCanvasFrameEvidenceCaptureV1(fake.canvas, fake.gpu);
    await fake.initialize(capture);
    capture.beginFrame(VIEWPORT);
    fake.renderFrame(10);
    expect(capture.commit(CORRELATION)).toBe("committed");
    expect(await firstSample(capture)).toBe(10);
  });

  it("propagates an adapter that cannot be hooked and restores the navigator hook on dispose", async () => {
    const fake = createFakeGpu();
    const frozenAdapter = Object.freeze({ requestDevice: () => Promise.resolve(fake.device) });
    const gpu = { requestAdapter: () => Promise.resolve(frozenAdapter) };
    const originalRequestAdapter = gpu.requestAdapter;
    const capture = installCanvasFrameEvidenceCaptureV1(fake.canvas, gpu as unknown as GpuNavigatorV1);
    await expect(gpu.requestAdapter()).rejects.toThrow(TypeError);
    capture.dispose();
    expect(gpu.requestAdapter).toBe(originalRequestAdapter);
  });

  it("propagates a device queue that cannot be hooked and restores the adapter hook on dispose", async () => {
    const fake = createFakeGpu();
    const frozenQueueDevice = { ...fake.device, queue: Object.freeze({ submit: () => undefined }) };
    const adapter = { requestDevice: () => Promise.resolve(frozenQueueDevice) };
    const originalRequestDevice = adapter.requestDevice;
    const gpu = { requestAdapter: () => Promise.resolve(adapter) };
    const originalRequestAdapter = gpu.requestAdapter;
    const capture = installCanvasFrameEvidenceCaptureV1(fake.canvas, gpu as unknown as GpuNavigatorV1);
    const hookedAdapter = await gpu.requestAdapter();
    await expect(hookedAdapter.requestDevice()).rejects.toThrow(TypeError);
    capture.dispose();
    expect(gpu.requestAdapter).toBe(originalRequestAdapter);
    expect(adapter.requestDevice).toBe(originalRequestDevice);
  });

  it("preserves external wrappers installed after this capture when disposing", async () => {
    const fixture = await createCapture();
    const { fake } = fixture;
    presentFrame(fixture, 10);
    const context = fake.canvas.getContext("webgpu") as {
      configure: (value: unknown) => void;
      getCurrentTexture: () => unknown;
    };
    const innerConfigure = context.configure;
    const externalConfigure = (value: unknown) => innerConfigure(value);
    context.configure = externalConfigure;
    const innerGetCurrentTexture = context.getCurrentTexture;
    const externalGetCurrentTexture = () => innerGetCurrentTexture();
    context.getCurrentTexture = externalGetCurrentTexture;
    const innerRequestAdapter = fake.gpu.requestAdapter;
    const externalRequestAdapter = () => innerRequestAdapter();
    fake.gpu.requestAdapter = externalRequestAdapter;
    const innerSubmit = fake.device.queue.submit;
    const externalSubmit = (commands: Iterable<unknown>) => innerSubmit(commands);
    fake.device.queue.submit = externalSubmit;
    fixture.capture.dispose();
    // Dispose must not clobber the external wrappers; the capture's own
    // wrappers degrade to passthroughs inside the preserved chain.
    expect(context.configure).toBe(externalConfigure);
    expect(context.getCurrentTexture).toBe(externalGetCurrentTexture);
    expect(fake.gpu.requestAdapter).toBe(externalRequestAdapter);
    expect(fake.device.queue.submit).toBe(externalSubmit);
    context.configure({ device: {}, format: "rgba8unorm" });
    expect(fake.configureCalls.at(-1)).not.toHaveProperty("usage");
    fixture.capture.beginFrame(VIEWPORT);
    fake.renderFrame(20);
    expect(fake.buffers).toHaveLength(1);
  });

  it("stages only through the device the canvas surface was configured with", async () => {
    const { acquire, capture, context, deviceA, deviceB } = await createCrossDeviceFixture();
    context.configure({ device: deviceA.device, format: "rgba8unorm" });
    capture.beginFrame(VIEWPORT);
    acquire(7);
    const marker = { execute: () => undefined };
    deviceB.device.queue.submit([marker]);
    expect(deviceB.originalSubmits).toEqual([[marker]]);
    expect(deviceB.buffers).toHaveLength(0);
    deviceA.device.queue.submit([]);
    deviceB.device.queue.submit([]);
    expect(deviceA.buffers.map((buffer) => buffer.destroyCalls)).toEqual([0]);
    expect(deviceB.buffers).toHaveLength(0);
    expect(capture.commit(CORRELATION)).toBe("committed");
    expect(await firstSample(capture)).toBe(7);
  });

  it("preserves the previous binding, captured texture, and evidence when a reconfigure fails", async () => {
    const { acquire, capture, context, deviceA, deviceB, state } = await createCrossDeviceFixture();
    context.configure({ device: deviceA.device, format: "rgba8unorm" });
    capture.beginFrame(VIEWPORT);
    acquire(7);
    deviceA.device.queue.submit([]);
    expect(capture.commit(CORRELATION)).toBe("committed");
    // The reconfigure onto B throws inside the underlying configure: the A
    // binding, format, and committed evidence stay exactly as they were.
    state.configureError = new Error("The surface rejected this configuration.");
    expect(() => context.configure({ device: deviceB.device, format: "bgra8unorm" })).toThrow(
      "The surface rejected this configuration.",
    );
    state.configureError = null;
    const preserved = await capture.readSamples(CENTER);
    expect(preserved?.samples[0]?.[0]).toBe(7);
    expect(preserved?.surfaceFormat).toBe("rgba8unorm");
    // A captured texture inside an open frame window also survives a failed
    // reconfigure: A still stages, B still passes through.
    capture.beginFrame(VIEWPORT);
    acquire(8);
    state.configureError = new Error("The surface rejected this configuration.");
    expect(() => context.configure({ device: deviceB.device, format: "bgra8unorm" })).toThrow();
    state.configureError = null;
    deviceB.device.queue.submit([]);
    expect(deviceB.buffers).toHaveLength(0);
    deviceA.device.queue.submit([]);
    expect(deviceA.buffers).toHaveLength(2);
    expect(capture.commit({ ...CORRELATION, packetId: "canvas:2", sampleTime: 2 })).toBe("committed");
    expect(await firstSample(capture)).toBe(8);
  });

  it("invalidates old-surface evidence on a successful reconfigure so only the new device re-arms it", async () => {
    const { acquire, capture, context, deviceA, deviceB } = await createCrossDeviceFixture();
    context.configure({ device: deviceA.device, format: "rgba8unorm" });
    capture.beginFrame(VIEWPORT);
    acquire(7);
    deviceA.device.queue.submit([]);
    expect(capture.commit(CORRELATION)).toBe("committed");
    capture.beginFrame(VIEWPORT);
    acquire(9);
    deviceA.device.queue.submit([]);
    // The successful post-present reconfigure onto B destroys BOTH the
    // committed evidence and the staged copy — nothing from the old surface
    // can be exposed as proof of the new one.
    context.configure({ device: deviceB.device, format: "bgra8unorm" });
    expect(deviceA.buffers.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
    expect(await capture.readSamples(CENTER)).toBeNull();
    // The old device cannot stage into the still-open frame window, and even
    // B cannot until a fresh texture is acquired under the new configuration.
    deviceA.device.queue.submit([]);
    deviceB.device.queue.submit([]);
    expect(deviceA.buffers).toHaveLength(2);
    expect(deviceB.buffers).toHaveLength(0);
    // A fresh acquisition and submission on B re-arms evidence with the new
    // surface format.
    acquire(5);
    deviceA.device.queue.submit([]);
    expect(deviceA.buffers).toHaveLength(2);
    deviceB.device.queue.submit([]);
    expect(deviceB.buffers).toHaveLength(1);
    expect(capture.commit({ ...CORRELATION, packetId: "canvas:3", sampleTime: 3 })).toBe("committed");
    const evidence = await capture.readSamples(CENTER);
    expect(evidence?.samples[0]?.[0]).toBe(5);
    expect(evidence?.surfaceFormat).toBe("bgra8unorm");
  });

  it("restores every hooked adapter and device queue identity-safely across multiple adapters", async () => {
    const mintedAdapters: { adapter: { requestDevice: () => Promise<unknown> }; original: unknown }[] = [];
    const mintedQueues: { original: unknown; queue: { submit: (commands: Iterable<unknown>) => void } }[] = [];
    const mintDevice = () => {
      const queue = { submit: (_commands: Iterable<unknown>) => undefined };
      mintedQueues.push({ original: queue.submit, queue });
      return { createBuffer: () => null, createCommandEncoder: () => null, queue };
    };
    const gpu = {
      requestAdapter: () => {
        const adapter = { requestDevice: () => Promise.resolve(mintDevice()) };
        mintedAdapters.push({ adapter, original: adapter.requestDevice });
        return Promise.resolve(adapter);
      },
    };
    const originalRequestAdapter = gpu.requestAdapter;
    const context = { configure: () => undefined, getCurrentTexture: () => null };
    const originalConfigure = context.configure;
    const canvas = { getContext: (contextId: string) => (contextId === "webgpu" ? context : null) };
    const capture = installCanvasFrameEvidenceCaptureV1(canvas, gpu as unknown as GpuNavigatorV1);
    await (await gpu.requestAdapter()).requestDevice();
    await (await gpu.requestAdapter()).requestDevice();
    expect(gpu.requestAdapter).not.toBe(originalRequestAdapter);
    for (const minted of mintedAdapters) {
      expect(minted.adapter.requestDevice).not.toBe(minted.original);
    }
    for (const minted of mintedQueues) {
      expect(minted.queue.submit).not.toBe(minted.original);
    }
    capture.dispose();
    capture.dispose();
    expect(gpu.requestAdapter).toBe(originalRequestAdapter);
    expect(context.configure).toBe(originalConfigure);
    for (const minted of mintedAdapters) {
      expect(minted.adapter.requestDevice).toBe(minted.original);
    }
    for (const minted of mintedQueues) {
      expect(minted.queue.submit).toBe(minted.original);
    }
  });
});
