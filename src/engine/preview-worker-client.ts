import type { SceneIrBundleV1 } from "./contracts";
import { sceneIrBundleV1Schema } from "./contracts";
import {
  engineWorkerResponseV1Schema,
  MAX_PREVIEW_SNAPSHOT_JSON_BYTES,
  POIETRA_PREVIEW_WORKER_VERSION,
  type PreviewWorkerErrorCodeV1,
  type PreviewWorkerRequestV1,
  type PreviewWorkerResponseV1,
  previewUrlsShareOrigin,
  previewWorkerRequestV1Schema,
  previewWorkerResponseV1Schema,
} from "./preview-worker-protocol";
import type { RenderPacketV1 } from "./render-packet";
import { sceneIrSourceRevisionHash } from "./scene-ir";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

type LocalPreviewWorkerErrorCode =
  | "crashed"
  | "disposed"
  | "invalid-input"
  | "invalid-state"
  | "protocol-violation"
  | "stale-response"
  | "timeout"
  | "transport-failed";

export type PreviewWorkerClientErrorCode = LocalPreviewWorkerErrorCode | PreviewWorkerErrorCodeV1;

export class PreviewWorkerClientError extends Error {
  readonly code: PreviewWorkerClientErrorCode;

  constructor(code: PreviewWorkerClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "PreviewWorkerClientError";
  }
}

export type PreviewSceneSnapshotInputV1 = Readonly<{
  revision: string;
  snapshot: SceneIrBundleV1;
}>;

export type ReplacePreviewSceneInputV1 = PreviewSceneSnapshotInputV1 & Readonly<{ baseRevision: string }>;
export type SamplePreviewSceneInputV1 = Readonly<{
  revision: string;
  sampleTime: number;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

export type PreviewWorkerClientOptions = Readonly<{
  requestTimeoutMs?: number;
  wasmModuleUrl?: string | URL;
  workerFactory?: () => Worker;
}>;

type SuccessfulResponseV1 = Exclude<PreviewWorkerResponseV1, Readonly<{ kind: "error" }>>;
type PendingRequestV1 = {
  expectedKind: SuccessfulResponseV1["kind"];
  expectedOperation?: "install" | "replace";
  reject: (error: PreviewWorkerClientError) => void;
  resolve: (response: SuccessfulResponseV1) => void;
  revision: string;
  timeout: ReturnType<typeof setTimeout>;
};

type SampleWorkerRequestV1 = Extract<PreviewWorkerRequestV1, Readonly<{ kind: "sample" }>>;
type ScheduledSampleV1 = {
  reject: (error: PreviewWorkerClientError) => void;
  request: SampleWorkerRequestV1;
  resolve: (packet: RenderPacketV1) => void;
  settled: boolean;
};

function createPreviewWorker() {
  return new Worker(new URL("./poietra-engine.worker.ts", import.meta.url), { type: "module" });
}

function validationError(message: string, cause?: unknown) {
  return new PreviewWorkerClientError("invalid-input", message, cause === undefined ? undefined : { cause });
}

function encodeSnapshot(input: PreviewSceneSnapshotInputV1) {
  const parsed = sceneIrBundleV1Schema.safeParse(input.snapshot);
  if (!parsed.success) throw validationError("The Scene snapshot does not match the v1 engine contract.", parsed.error);
  if (sceneIrSourceRevisionHash(parsed.data.scene) !== input.revision) {
    throw validationError("The Scene revision does not match its source revision hash.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.byteLength > MAX_PREVIEW_SNAPSHOT_JSON_BYTES) {
    throw validationError(`The Scene snapshot exceeds ${MAX_PREVIEW_SNAPSHOT_JSON_BYTES} encoded bytes.`);
  }
  return bytes.buffer;
}

function parseWorkerRequest(value: unknown) {
  const parsed = previewWorkerRequestV1Schema.safeParse(value);
  if (!parsed.success)
    throw validationError("The preview worker request does not match the v1 protocol.", parsed.error);
  return parsed.data;
}

function browserBaseUrl() {
  if (typeof document !== "undefined") return document.baseURI;
  if (typeof location !== "undefined") return location.href;
  throw new PreviewWorkerClientError("invalid-state", "A browser base URL is unavailable.");
}

function resolveSameOriginWasmModuleUrl(configured: string | URL | undefined) {
  const base = new URL(browserBaseUrl());
  const moduleUrl = new URL(configured?.toString() ?? "./engine-wasm/poietra_wasm.js", base);
  if (!previewUrlsShareOrigin(moduleUrl, base)) {
    throw validationError("The Poietra WASM module must use the application's origin.");
  }
  return moduleUrl.href;
}

function validateTimeout(value: number | undefined) {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw validationError(`requestTimeoutMs must be an integer from 1 through ${MAX_REQUEST_TIMEOUT_MS}.`);
  }
  return timeout;
}

export class PoietraPreviewWorkerClient {
  private readonly pending = new Map<number, PendingRequestV1>();
  private readonly requestTimeoutMs: number;
  private readonly wasmModuleUrl: string | URL | undefined;
  private readonly worker: Worker;
  private currentRevision: string | null = null;
  private activeSample: ScheduledSampleV1 | null = null;
  private nextRequestId = 1;
  private queuedSample: ScheduledSampleV1 | null = null;
  private state: "empty" | "failed" | "installing" | "ready" | "replacing" | "disposed" = "empty";

  private readonly handleError = (event: ErrorEvent) => {
    event.preventDefault();
    this.failFatally(new PreviewWorkerClientError("crashed", event.message || "The preview worker crashed."));
  };

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const parsed = previewWorkerResponseV1Schema.safeParse(event.data);
    if (!parsed.success) {
      this.failFatally(
        new PreviewWorkerClientError("protocol-violation", "The preview worker returned an invalid response.", {
          cause: parsed.error,
        }),
      );
      return;
    }
    const response = parsed.data;
    if (response.kind === "error") {
      if (response.requestId === null || response.revision === null) {
        this.failFatally(
          new PreviewWorkerClientError(
            response.code,
            `The preview worker rejected an uncorrelated request: ${response.message}`,
          ),
        );
        return;
      }
      const pending = this.correlatedPending(response.requestId, response.revision);
      if (!pending) return;
      pending.reject(new PreviewWorkerClientError(response.code, response.message));
      return;
    }
    const pending = this.correlatedPending(response.requestId, response.revision);
    if (!pending) return;
    if (
      response.kind !== pending.expectedKind ||
      (response.kind === "scene-ready" && response.operation !== pending.expectedOperation)
    ) {
      const error = new PreviewWorkerClientError(
        "protocol-violation",
        "The preview worker returned an unexpected response kind.",
      );
      pending.reject(error);
      this.failFatally(error);
      return;
    }
    pending.resolve(response);
  };

  private readonly handleMessageError = () => {
    this.failFatally(
      new PreviewWorkerClientError("protocol-violation", "The preview worker response could not be cloned."),
    );
  };

  constructor(options: PreviewWorkerClientOptions = {}) {
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs);
    this.wasmModuleUrl = options.wasmModuleUrl;
    this.worker = (options.workerFactory ?? createPreviewWorker)();
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  get revision() {
    return this.currentRevision;
  }

  async installScene(input: PreviewSceneSnapshotInputV1) {
    if (this.state !== "empty") throw new PreviewWorkerClientError("invalid-state", "A Scene is already installed.");
    const snapshotJson = encodeSnapshot(input);
    const request = parseWorkerRequest({
      kind: "install-scene",
      requestId: this.takeRequestId(),
      revision: input.revision,
      schema: "poietra.preview-worker-request",
      snapshotJson,
      version: POIETRA_PREVIEW_WORKER_VERSION,
      wasmModuleUrl: resolveSameOriginWasmModuleUrl(this.wasmModuleUrl),
    });
    this.state = "installing";
    try {
      await this.dispatch(request, "scene-ready", "install", [snapshotJson]);
      this.currentRevision = input.revision;
      this.state = "ready";
    } catch (error) {
      if (this.state === "installing") this.state = "empty";
      throw error;
    }
  }

  async replaceScene(input: ReplacePreviewSceneInputV1) {
    if (this.state !== "ready" || this.currentRevision !== input.baseRevision) {
      throw new PreviewWorkerClientError("invalid-state", "The replacement base revision is not installed.");
    }
    const snapshotJson = encodeSnapshot(input);
    const request = parseWorkerRequest({
      baseRevision: input.baseRevision,
      kind: "replace-scene",
      requestId: this.takeRequestId(),
      revision: input.revision,
      schema: "poietra.preview-worker-request",
      snapshotJson,
      version: POIETRA_PREVIEW_WORKER_VERSION,
    });
    this.cancelScheduledSamples(
      new PreviewWorkerClientError("stale-response", "A Scene replacement superseded this preview sample."),
    );
    this.state = "replacing";
    try {
      await this.dispatch(request, "scene-ready", "replace", [snapshotJson]);
      this.currentRevision = input.revision;
      this.state = "ready";
    } catch (error) {
      if (this.state === "replacing") this.state = "ready";
      throw error;
    }
  }

  async sample(input: SamplePreviewSceneInputV1): Promise<RenderPacketV1> {
    if (this.state !== "ready" || this.currentRevision !== input.revision) {
      throw new PreviewWorkerClientError("invalid-state", "The requested Scene revision is not installed.");
    }
    const request = parseWorkerRequest({
      kind: "sample",
      requestId: this.takeRequestId(),
      revision: input.revision,
      sampleTime: input.sampleTime,
      schema: "poietra.preview-worker-request",
      version: POIETRA_PREVIEW_WORKER_VERSION,
      viewport: input.viewport,
    });
    if (request.kind !== "sample") {
      return Promise.reject(new PreviewWorkerClientError("protocol-violation", "The sample request kind was lost."));
    }
    return new Promise<RenderPacketV1>((resolve, reject) => {
      const scheduled = { reject, request, resolve, settled: false } satisfies ScheduledSampleV1;
      if (this.activeSample) {
        this.settleSampleError(
          this.activeSample,
          new PreviewWorkerClientError("stale-response", "A newer preview sample superseded this request."),
        );
        if (this.queuedSample) {
          this.settleSampleError(
            this.queuedSample,
            new PreviewWorkerClientError("stale-response", "A newer preview sample superseded this request."),
          );
        }
        this.queuedSample = scheduled;
        return;
      }
      this.startSample(scheduled);
    });
  }

  dispose() {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.currentRevision = null;
    const error = new PreviewWorkerClientError("disposed", "The preview worker client was disposed.");
    this.cancelScheduledSamples(error);
    this.rejectPending(error);
    this.detachAndTerminate();
  }

  private dispatch(
    request: PreviewWorkerRequestV1,
    expectedKind: SuccessfulResponseV1["kind"],
    expectedOperation?: "install" | "replace",
    transfer: Transferable[] = [],
  ) {
    return new Promise<SuccessfulResponseV1>((resolve, reject: (error: PreviewWorkerClientError) => void) => {
      const timeout = setTimeout(() => {
        const error = new PreviewWorkerClientError(
          "timeout",
          `The preview worker did not answer request ${request.requestId} within ${this.requestTimeoutMs}ms.`,
        );
        this.failFatally(error);
      }, this.requestTimeoutMs);
      this.pending.set(request.requestId, {
        expectedKind,
        expectedOperation,
        reject,
        resolve,
        revision: request.revision,
        timeout,
      });
      try {
        this.worker.postMessage(request, transfer);
      } catch (cause) {
        this.pending.delete(request.requestId);
        clearTimeout(timeout);
        reject(
          new PreviewWorkerClientError("transport-failed", "The preview worker request could not be cloned.", {
            cause,
          }),
        );
      }
    });
  }

  private startSample(sample: ScheduledSampleV1) {
    this.activeSample = sample;
    void this.dispatch(sample.request, "sample-response")
      .then((response) => {
        if (response.kind !== "sample-response") {
          this.settleSampleError(
            sample,
            new PreviewWorkerClientError("protocol-violation", "The preview worker did not return an engine response."),
          );
          return;
        }
        if (sample.settled) return;
        const packet = this.decodeSampleResponse(sample.request, response.responseJson);
        sample.settled = true;
        sample.resolve(packet);
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof PreviewWorkerClientError
            ? error
            : new PreviewWorkerClientError("internal-error", "The preview sample failed.", { cause: error });
        this.settleSampleError(sample, normalized);
        if (normalized.code === "protocol-violation") this.failFatally(normalized);
      })
      .finally(() => {
        if (this.activeSample !== sample) return;
        this.activeSample = null;
        if (this.state !== "ready" || !this.queuedSample) return;
        const queued = this.queuedSample;
        this.queuedSample = null;
        this.startSample(queued);
      });
  }

  private decodeSampleResponse(request: SampleWorkerRequestV1, responseJson: ArrayBuffer) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
    } catch (cause) {
      throw new PreviewWorkerClientError("protocol-violation", "The engine returned malformed UTF-8 JSON.", { cause });
    }
    const response = engineWorkerResponseV1Schema.safeParse(decoded);
    if (!response.success) {
      throw new PreviewWorkerClientError("protocol-violation", "The engine response violated the v1 contract.", {
        cause: response.error,
      });
    }
    if (response.data.result.kind === "error") {
      throw new PreviewWorkerClientError("sample-rejected", response.data.result.message);
    }
    const { packet } = response.data.result;
    if (
      packet.sceneRevisionHash !== request.revision ||
      packet.packetId !== `preview:${request.requestId}` ||
      packet.sampleTime !== request.sampleTime ||
      packet.viewport.heightPx !== request.viewport.heightPx ||
      packet.viewport.widthPx !== request.viewport.widthPx
    ) {
      throw new PreviewWorkerClientError(
        "protocol-violation",
        "The RenderPacket does not match its correlated request.",
      );
    }
    return packet;
  }

  private settleSampleError(sample: ScheduledSampleV1, error: PreviewWorkerClientError) {
    if (sample.settled) return;
    sample.settled = true;
    sample.reject(error);
  }

  private cancelScheduledSamples(error: PreviewWorkerClientError) {
    if (this.activeSample) this.settleSampleError(this.activeSample, error);
    if (this.queuedSample) this.settleSampleError(this.queuedSample, error);
    this.queuedSample = null;
  }

  private takeRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId = requestId === Number.MAX_SAFE_INTEGER ? 1 : requestId + 1;
    if (this.pending.has(requestId)) {
      throw new PreviewWorkerClientError("invalid-state", "The preview worker request ID space is exhausted.");
    }
    return requestId;
  }

  private failFatally(error: PreviewWorkerClientError) {
    if (this.state === "failed" || this.state === "disposed") return;
    this.state = "failed";
    this.currentRevision = null;
    this.cancelScheduledSamples(error);
    this.rejectPending(error);
    this.detachAndTerminate();
  }

  private rejectPending(error: PreviewWorkerClientError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private correlatedPending(requestId: number, revision: string) {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    if (revision !== pending.revision) {
      this.failFatally(
        new PreviewWorkerClientError("protocol-violation", "The preview worker returned a mismatched Scene revision."),
      );
      return null;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  private detachAndTerminate() {
    this.worker.removeEventListener("error", this.handleError);
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("messageerror", this.handleMessageError);
    this.worker.terminate();
  }
}
