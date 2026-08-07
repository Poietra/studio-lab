import { createHash } from "node:crypto";

import type { Page } from "@playwright/test";
import type { SceneIrBundleV1 } from "../src/engine/contracts";

export const RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1 = { heightPx: 360, widthPx: 640 } as const;

export type RetainedWebGpuReadbackSampleV1 = Readonly<{
  id: string;
  packetId: string;
  sampleTime: number;
}>;

export type RuntimeTraceWebGpuReadbackSampleV1 = RetainedWebGpuReadbackSampleV1 &
  Readonly<{
    frameIndex: number;
  }>;

function sample(id: string, frameIndex: number, sampleTime: number): RuntimeTraceWebGpuReadbackSampleV1 {
  return { frameIndex, id, packetId: `runtime-trace:full-rgba:${id}`, sampleTime };
}

/** Seven Cairo comparison frames followed by one backward seek to `bottom`. */
export const UPDATERS_RUNTIME_TRACE_WEBGPU_SAMPLES_V1 = [
  sample("initial", 0, 0),
  sample("descent", 75, 75 / 60),
  sample("bottom", 150, 150 / 60),
  sample("return", 225, 225 / 60),
  sample("play-end", 299, 299 / 60),
  sample("hold", 330, 330 / 60),
  sample("duration-end", 359, 6),
  sample("bottom-repeat", 150, 150 / 60),
] as const satisfies readonly RuntimeTraceWebGpuReadbackSampleV1[];

/** Twenty-six OpeningManim frames followed by unordered repeat seeks across all four animated phases. */
export const OPENING_MANIM_RUNTIME_TRACE_WEBGPU_SAMPLES_V2 = [
  sample("initial", 0, 0),
  sample("opening-animation-midpoint", 60, 1),
  sample("opening-play-end", 120, 2),
  sample("opening-hold-last", 179, 179 / 60),
  sample("transform-start", 180, 3),
  sample("transform-midpoint", 210, 3.5),
  sample("transform-play-end", 240, 4),
  sample("wait-end", 299, 299 / 60),
  sample("grid-create-start", 300, 5),
  sample("grid-create-early", 330, 5.5),
  sample("grid-create-midpoint", 390, 6.5),
  sample("grid-create-last", 479, 479 / 60),
  sample("grid-play-end", 480, 8),
  sample("grid-wait-end", 539, 539 / 60),
  sample("warp-start", 540, 9),
  sample("warp-early", 570, 9.5),
  sample("warp-midpoint", 630, 10.5),
  sample("warp-late", 690, 11.5),
  sample("warp-last", 719, 719 / 60),
  sample("warp-play-end", 720, 12),
  sample("warp-hold-last", 779, 779 / 60),
  sample("final-title-transform-start", 780, 13),
  sample("final-title-transform-midpoint", 810, 13.5),
  sample("final-title-transform-last", 839, 839 / 60),
  sample("final-title-transform-play-end", 840, 14),
  sample("terminal-hold-end", 899, 15),
  sample("final-title-transform-midpoint-repeat", 810, 13.5),
  sample("transform-midpoint-repeat", 210, 3.5),
  sample("warp-midpoint-repeat", 630, 10.5),
  sample("grid-create-midpoint-repeat", 390, 6.5),
] as const satisfies readonly RuntimeTraceWebGpuReadbackSampleV1[];

type RetainedFrameSequenceProofWireV1 = Readonly<{
  capture: Readonly<{
    installCount: number;
    policy: string;
    renderSubmissionCounts: readonly number[];
  }>;
  frames: readonly Readonly<{
    id: string;
    pixels: Readonly<{
      nonBlackBounds: readonly [number, number, number, number] | null;
      surfaceFormat: string;
      viewFormat: string;
    }>;
    response: Readonly<{
      result?: Readonly<{
        kind?: string;
        packetId?: string;
        sampleTime?: number;
        suboptimal?: boolean;
        viewport?: Readonly<{ heightPx: number; widthPx: number }>;
      }>;
      schema?: string;
      version?: number;
    }>;
    rgba: ArrayBuffer;
  }>[];
  kind: "retained-frame-sequence-proof";
  revision: string;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

type RetainedFrameSequenceProofBridgeV1 = Omit<RetainedFrameSequenceProofWireV1, "frames"> &
  Readonly<{
    frames: readonly Readonly<{
      id: string;
      pixels: RetainedFrameSequenceProofWireV1["frames"][number]["pixels"];
      response: RetainedFrameSequenceProofWireV1["frames"][number]["response"];
      rgbaBase64: string;
    }>[];
  }>;

export type RetainedWebGpuReadbackFrameV1 = Readonly<{
  id: string;
  packetId: string;
  pixels: RetainedFrameSequenceProofWireV1["frames"][number]["pixels"];
  presentedSampleTime: number;
  requestSampleTime: number;
  rgba: Uint8Array;
  sha256: string;
}>;

export type RuntimeTraceWebGpuReadbackFrameV1 = RetainedWebGpuReadbackFrameV1 &
  Readonly<{
    frameIndex: number;
    frameSampleTime: number;
  }>;

export type RetainedWebGpuReadbackV1 = Readonly<{
  capture: Readonly<{
    installCount: 1;
    policy: "one-retained-engine";
    renderSubmissionCounts: readonly 1[];
  }>;
  frames: readonly RetainedWebGpuReadbackFrameV1[];
  revision: string;
  viewport: typeof RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1;
}>;

export type RuntimeTraceWebGpuReadbackV1 = Omit<RetainedWebGpuReadbackV1, "frames"> &
  Readonly<{ frames: readonly RuntimeTraceWebGpuReadbackFrameV1[] }>;

const MAX_READBACK_FRAME_COUNT = 32;
const RUNTIME_TRACE_FRAMES_PER_SECOND = 60;
const MAX_RUNTIME_TRACE_DURATION_SECONDS = 15;
const MAX_READBACK_RGBA_BYTES =
  MAX_READBACK_FRAME_COUNT *
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.widthPx *
  RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.heightPx *
  4;

function sourceRevision(bundle: SceneIrBundleV1) {
  const source = bundle.scene.source;
  if (source.kind === "imported-manim-runtime-trace") return source.traceDigest;
  if (source.kind === "imported-manim-server-snapshot") return source.snapshotHash;
  throw new Error("The full RGBA capture requires a verified server-backed Scene revision.");
}

function validateRetainedCaptureInput(
  input: Readonly<{
    bundle: SceneIrBundleV1;
    revision: string;
    samples: readonly RetainedWebGpuReadbackSampleV1[];
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
) {
  if (sourceRevision(input.bundle) !== input.revision) {
    throw new Error("The full RGBA capture requires the verified Scene bundle revision.");
  }
  const duration = input.bundle.scene.duration;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_RUNTIME_TRACE_DURATION_SECONDS) {
    throw new Error("The retained readback requires a bounded positive Scene duration.");
  }
  if (
    input.viewport.widthPx !== RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.widthPx ||
    input.viewport.heightPx !== RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1.heightPx
  ) {
    throw new Error("The retained Cairo parity capture is sealed to 640x360.");
  }
  if (input.samples.length < 1 || input.samples.length > MAX_READBACK_FRAME_COUNT) {
    throw new Error(`The retained readback requires 1-${MAX_READBACK_FRAME_COUNT} samples.`);
  }
  const ids = new Set<string>();
  const packetIds = new Set<string>();
  for (const entry of input.samples) {
    if (!entry.id || ids.has(entry.id) || !entry.packetId || packetIds.has(entry.packetId)) {
      throw new Error("Retained readback ids and packet ids must be non-empty and unique.");
    }
    if (!Number.isFinite(entry.sampleTime) || entry.sampleTime < 0 || entry.sampleTime > duration) {
      throw new Error(`Retained readback sample ${entry.id} has an invalid request time.`);
    }
    ids.add(entry.id);
    packetIds.add(entry.packetId);
  }
  const rgbaBytes = input.samples.length * input.viewport.widthPx * input.viewport.heightPx * 4;
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > MAX_READBACK_RGBA_BYTES) {
    throw new Error("The retained readback exceeds its bounded RGBA byte budget.");
  }
}

function validateRuntimeTraceCaptureInput(
  input: Readonly<{
    bundle: SceneIrBundleV1;
    revision: string;
    samples: readonly RuntimeTraceWebGpuReadbackSampleV1[];
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
) {
  validateRetainedCaptureInput(input);
  const source = input.bundle.scene.source;
  if (
    source.kind !== "imported-manim-runtime-trace" ||
    (source.traceVersion !== 1 && source.traceVersion !== 2 && source.traceVersion !== 3)
  ) {
    throw new Error("The Runtime Trace readback requires a verified Runtime Trace bundle revision.");
  }
  const frameCount = input.bundle.scene.duration * RUNTIME_TRACE_FRAMES_PER_SECOND;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) {
    throw new Error("The Runtime Trace readback requires a bounded 60 fps Scene duration.");
  }
  for (const entry of input.samples) {
    if (!Number.isSafeInteger(entry.frameIndex) || entry.frameIndex < 0 || entry.frameIndex >= frameCount) {
      throw new Error(`Runtime Trace readback sample ${entry.id} has an invalid frame index.`);
    }
    const expectedFrame =
      entry.sampleTime === input.bundle.scene.duration
        ? frameCount - 1
        : entry.sampleTime * RUNTIME_TRACE_FRAMES_PER_SECOND;
    if (Math.abs(expectedFrame - entry.frameIndex) > 1e-9) {
      throw new Error(`Runtime Trace readback sample ${entry.id} is not backed by frame ${entry.frameIndex}.`);
    }
  }
}

function decodeBase64Rgba(base64: string) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Captures exact sample times from one retained WASM/WebGPU engine. */
export async function captureRetainedWebGpuFramesV1(
  page: Page,
  input: Readonly<{
    bundle: SceneIrBundleV1;
    revision: string;
    samples: readonly RetainedWebGpuReadbackSampleV1[];
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
): Promise<RetainedWebGpuReadbackV1> {
  validateRetainedCaptureInput(input);
  const bridge = await page.evaluate(async ({ bundle, revision, samples, viewport }) => {
    const worker = new Worker("/e2e/engine-canvas-readback.worker.ts", { type: "module" });
    const proof = new Promise<RetainedFrameSequenceProofWireV1>((resolve, reject) => {
      worker.addEventListener(
        "error",
        (event) => reject(new Error(event.message || "The retained readback worker crashed.")),
        { once: true },
      );
      worker.addEventListener(
        "message",
        (event: MessageEvent<RetainedFrameSequenceProofWireV1 | Readonly<{ kind: "error"; message: string }>>) => {
          if (event.data.kind === "error") reject(new Error(event.data.message));
          else resolve(event.data);
        },
        { once: true },
      );
    });
    const snapshotJson = new TextEncoder().encode(JSON.stringify(bundle)).buffer;
    const frames = samples.map((entry) => ({
      id: entry.id,
      requestJson: new TextEncoder().encode(
        JSON.stringify({
          evidence: ["Retained full RGBA readback v1", entry.id, revision],
          packetId: entry.packetId,
          sampleTime: entry.sampleTime,
          schema: "poietra.engine-sample-request",
          version: 1,
          viewport,
        }),
      ).buffer,
    }));
    worker.postMessage(
      {
        expectedRevision: revision,
        frames,
        kind: "prove-retained-frame-sequence",
        snapshotJson,
        viewport,
        wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
      },
      [snapshotJson, ...frames.map(({ requestJson }) => requestJson)],
    );
    try {
      const result = await proof;
      const rgbaBase64 = (rgba: ArrayBuffer) => {
        const bytes = new Uint8Array(rgba);
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
        }
        return btoa(chunks.join(""));
      };
      return {
        ...result,
        frames: result.frames.map(({ rgba, ...frame }) => ({ ...frame, rgbaBase64: rgbaBase64(rgba) })),
      } satisfies RetainedFrameSequenceProofBridgeV1;
    } finally {
      worker.terminate();
    }
  }, input);

  if (
    bridge.kind !== "retained-frame-sequence-proof" ||
    bridge.revision !== input.revision ||
    bridge.capture.policy !== "one-retained-engine" ||
    bridge.capture.installCount !== 1 ||
    bridge.frames.length !== input.samples.length ||
    bridge.capture.renderSubmissionCounts.length !== input.samples.length ||
    bridge.capture.renderSubmissionCounts.some((count) => count !== 1)
  ) {
    throw new Error("The retained readback returned an invalid capture envelope.");
  }
  if (bridge.viewport.widthPx !== input.viewport.widthPx || bridge.viewport.heightPx !== input.viewport.heightPx) {
    throw new Error("The retained readback changed its viewport.");
  }

  const expectedRgbaBytes = input.viewport.widthPx * input.viewport.heightPx * 4;
  const frames = bridge.frames.map((frame, index): RetainedWebGpuReadbackFrameV1 => {
    const requested = input.samples[index];
    const presented = frame.response.result;
    if (
      !requested ||
      frame.id !== requested.id ||
      frame.response.schema !== "poietra.canvas-render-response" ||
      frame.response.version !== 1 ||
      presented?.kind !== "presented" ||
      presented.packetId !== requested.packetId ||
      presented.sampleTime !== requested.sampleTime ||
      presented.viewport?.widthPx !== input.viewport.widthPx ||
      presented.viewport.heightPx !== input.viewport.heightPx
    ) {
      throw new Error(`The retained frame at index ${index} lost packet/sample correlation.`);
    }
    const rgba = decodeBase64Rgba(frame.rgbaBase64);
    if (rgba.byteLength !== expectedRgbaBytes) {
      throw new Error(`The retained frame ${requested.id} has an invalid RGBA byte length.`);
    }
    return {
      id: requested.id,
      packetId: requested.packetId,
      pixels: frame.pixels,
      presentedSampleTime: presented.sampleTime,
      requestSampleTime: requested.sampleTime,
      rgba,
      sha256: sha256(rgba),
    };
  });

  return {
    capture: {
      installCount: 1,
      policy: "one-retained-engine",
      renderSubmissionCounts: bridge.capture.renderSubmissionCounts as readonly 1[],
    },
    frames,
    revision: bridge.revision,
    viewport: RUNTIME_TRACE_WEBGPU_READBACK_VIEWPORT_V1,
  };
}

/** Preserves the 60 fps frame-index proof required by Runtime Trace fixtures. */
export async function captureRuntimeTraceWebGpuFramesV1(
  page: Page,
  input: Readonly<{
    bundle: SceneIrBundleV1;
    revision: string;
    samples: readonly RuntimeTraceWebGpuReadbackSampleV1[];
    viewport: Readonly<{ heightPx: number; widthPx: number }>;
  }>,
): Promise<RuntimeTraceWebGpuReadbackV1> {
  validateRuntimeTraceCaptureInput(input);
  const capture = await captureRetainedWebGpuFramesV1(page, input);
  return {
    ...capture,
    frames: capture.frames.map((frame, index) => {
      const requested = input.samples[index];
      if (!requested || requested.id !== frame.id) throw new Error("The Runtime Trace frame order changed.");
      return {
        ...frame,
        frameIndex: requested.frameIndex,
        frameSampleTime: requested.frameIndex / RUNTIME_TRACE_FRAMES_PER_SECOND,
      };
    }),
  };
}
