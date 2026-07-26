import {
  type CanvasFrameTelemetryV1,
  type CanvasWorkerErrorCodeV1,
  type CanvasWorkerRequestV1,
  type CanvasWorkerResponseV1,
  canvasUrlsShareOrigin,
  canvasWorkerRequestV1Schema,
  canvasWorkerResponseV1Schema,
  MAX_CANVAS_SNAPSHOT_JSON_BYTES,
  MAX_CANVAS_WASM_MODULE_URL_LENGTH,
  POIETRA_CANVAS_WORKER_VERSION,
} from "./canvas-worker-protocol";
import type { SceneIrBundleV1 } from "./contracts";
import { sceneIrBundleV1Schema } from "./contracts";
import { sceneIrSourceRevisionHash } from "./scene-ir";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

type LocalCanvasWorkerErrorCode =
  | "crashed"
  | "disposed"
  | "invalid-input"
  | "invalid-state"
  | "protocol-violation"
  | "stale-response"
  | "timeout"
  | "transport-failed";

export type CanvasWorkerClientErrorCode = LocalCanvasWorkerErrorCode | CanvasWorkerErrorCodeV1;

const RECOVERABLE_RENDER_ERROR_CODES = new Set<CanvasWorkerClientErrorCode>([
  "evaluation-failed",
  "invalid-request",
  "surface-occluded",
  "surface-outdated",
  "surface-timeout",
  "telemetry-unavailable",
  "unsupported-frame",
]);

export class CanvasWorkerClientError extends Error {
  readonly code: CanvasWorkerClientErrorCode;
  readonly fallback = "whole-scene" as const;
  readonly requiresWholeSceneFallback = true;

  constructor(code: CanvasWorkerClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "CanvasWorkerClientError";
  }
}

/**
 * A telemetry render that failed inside the engine while still producing
 * partial per-phase telemetry. The typed error preserves that telemetry and
 * the engine's error correlation for the harness; it never widens the normal
 * render error path.
 */
export class CanvasTelemetryRenderError extends CanvasWorkerClientError {
  readonly errorCorrelation: Readonly<{
    packetId: string | null;
    sampleTime: number | null;
    viewport: Readonly<{ heightPx: number; widthPx: number }> | null;
  }>;
  readonly telemetry: CanvasFrameTelemetryV1;

  constructor(
    code: CanvasWorkerClientErrorCode,
    message: string,
    telemetry: CanvasFrameTelemetryV1,
    errorCorrelation: CanvasTelemetryRenderError["errorCorrelation"],
  ) {
    super(code, message);
    this.errorCorrelation = errorCorrelation;
    this.name = "CanvasTelemetryRenderError";
    this.telemetry = telemetry;
  }
}

export type InstallCanvasSceneInputV1 = Readonly<{
  canvas: HTMLCanvasElement;
  revision: string;
  snapshot: SceneIrBundleV1;
}>;

export type ReplaceCanvasSceneInputV1 = Readonly<{
  baseRevision: string;
  revision: string;
  snapshot: SceneIrBundleV1;
}>;

export type RenderCanvasFrameInputV1 = Readonly<{
  revision: string;
  sampleTime: number;
  viewport: Readonly<{ heightPx: number; widthPx: number }>;
}>;

export type CanvasWorkerClientOptions = Readonly<{
  requestTimeoutMs?: number;
  wasmModuleUrl?: string | URL;
  workerFactory?: () => Worker;
}>;

type SuccessfulResponseV1 = Exclude<CanvasWorkerResponseV1, Readonly<{ kind: "error" }>>;
export type PresentedCanvasFrameV1 = Extract<SuccessfulResponseV1, Readonly<{ kind: "frame-presented" }>>;
export type PresentedCanvasFrameTelemetryV1 = Extract<
  SuccessfulResponseV1,
  Readonly<{ kind: "frame-presented-telemetry" }>
>;
export type CollectedAdapterEvidenceV1 = Extract<SuccessfulResponseV1, Readonly<{ kind: "adapter-evidence" }>>;

type PendingRequestV1 = {
  expectedKinds: readonly SuccessfulResponseV1["kind"][];
  expectedOperation?: "install" | "replace";
  reject: (error: CanvasWorkerClientError) => void;
  resolve: (response: SuccessfulResponseV1) => void;
  revision: string;
  timeout: ReturnType<typeof setTimeout>;
};

type RenderWorkerRequestV1 = Extract<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame" }>>;
type ScheduledRenderV1 = {
  reject: (error: CanvasWorkerClientError) => void;
  request: RenderWorkerRequestV1;
  resolve: (frame: PresentedCanvasFrameV1) => void;
  settled: boolean;
};

type ExclusiveCanvasOperationV1 = "adapter-evidence" | "telemetry-render";

function createCanvasWorker() {
  return new Worker(new URL("./poietra-canvas.worker.ts", import.meta.url), { type: "module" });
}

function validationError(message: string, cause?: unknown) {
  return new CanvasWorkerClientError("invalid-input", message, cause === undefined ? undefined : { cause });
}

function encodeSnapshot(revision: string, snapshot: SceneIrBundleV1) {
  const parsed = sceneIrBundleV1Schema.safeParse(snapshot);
  if (!parsed.success) throw validationError("The Scene snapshot does not match the v1 engine contract.", parsed.error);
  if (sceneIrSourceRevisionHash(parsed.data.scene) !== revision) {
    throw validationError("The Scene revision does not match its source revision hash.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.byteLength > MAX_CANVAS_SNAPSHOT_JSON_BYTES) {
    throw validationError(`The Scene snapshot exceeds ${MAX_CANVAS_SNAPSHOT_JSON_BYTES} encoded bytes.`);
  }
  return bytes.buffer;
}

function parseWorkerRequest(value: unknown) {
  const parsed = canvasWorkerRequestV1Schema.safeParse(value);
  if (!parsed.success) throw validationError("The canvas worker request does not match the v1 protocol.", parsed.error);
  return parsed.data;
}

function browserBaseUrl() {
  if (typeof document !== "undefined") return document.baseURI;
  if (typeof location !== "undefined") return location.href;
  throw new CanvasWorkerClientError("invalid-state", "A browser base URL is unavailable.");
}

function resolveSameOriginWasmModuleUrl(configured: string | URL | undefined) {
  const base = new URL(browserBaseUrl());
  const moduleUrl = new URL(configured?.toString() ?? "./engine-wasm/poietra_wasm.js", base);
  if (!canvasUrlsShareOrigin(moduleUrl, base)) {
    throw validationError("The Poietra WASM module must use the application's origin.");
  }
  if (moduleUrl.href.length > MAX_CANVAS_WASM_MODULE_URL_LENGTH) {
    throw validationError(`The Poietra WASM module URL exceeds ${MAX_CANVAS_WASM_MODULE_URL_LENGTH} characters.`);
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

function normalizeError(error: unknown, code: CanvasWorkerClientErrorCode, message: string) {
  return error instanceof CanvasWorkerClientError
    ? error
    : new CanvasWorkerClientError(code, message, { cause: error });
}

export class PoietraCanvasWorkerClient {
  private readonly pending = new Map<number, PendingRequestV1>();
  private readonly requestTimeoutMs: number;
  private readonly wasmModuleUrl: string | URL | undefined;
  private readonly worker: Worker;
  private activeRender: ScheduledRenderV1 | null = null;
  private currentRevision: string | null = null;
  private nextRequestId = 1;
  private queuedRender: ScheduledRenderV1 | null = null;
  private exclusiveOperation: ExclusiveCanvasOperationV1 | null = null;
  private state: "empty" | "failed" | "installing" | "ready" | "replacing" | "disposed" = "empty";

  private readonly handleError = (event: ErrorEvent) => {
    event.preventDefault();
    this.failFatally(new CanvasWorkerClientError("crashed", event.message || "The canvas worker crashed."));
  };

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    const parsed = canvasWorkerResponseV1Schema.safeParse(event.data);
    if (!parsed.success) {
      this.failFatally(
        new CanvasWorkerClientError("protocol-violation", "The canvas worker returned an invalid response.", {
          cause: parsed.error,
        }),
      );
      return;
    }
    const response = parsed.data;
    if (response.kind === "error") {
      if (response.requestId === null || response.revision === null) {
        this.failFatally(
          new CanvasWorkerClientError(
            response.code,
            `The canvas worker rejected an uncorrelated request: ${response.message}`,
          ),
        );
        return;
      }
      const pending = this.correlatedPending(response.requestId, response.revision);
      if (!pending) return;
      pending.reject(new CanvasWorkerClientError(response.code, response.message));
      return;
    }
    const pending = this.correlatedPending(response.requestId, response.revision);
    if (!pending) return;
    if (
      !pending.expectedKinds.includes(response.kind) ||
      (response.kind === "canvas-ready" && response.operation !== pending.expectedOperation)
    ) {
      const error = new CanvasWorkerClientError(
        "protocol-violation",
        "The canvas worker returned an unexpected response kind.",
      );
      pending.reject(error);
      this.failFatally(error);
      return;
    }
    pending.resolve(response);
  };

  private readonly handleMessageError = () => {
    this.failFatally(
      new CanvasWorkerClientError("protocol-violation", "The canvas worker response could not be cloned."),
    );
  };

  constructor(options: CanvasWorkerClientOptions = {}) {
    this.requestTimeoutMs = validateTimeout(options.requestTimeoutMs);
    this.wasmModuleUrl = options.wasmModuleUrl;
    this.worker = (options.workerFactory ?? createCanvasWorker)();
    this.worker.addEventListener("error", this.handleError);
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("messageerror", this.handleMessageError);
  }

  get revision() {
    return this.currentRevision;
  }

  async installScene(input: InstallCanvasSceneInputV1) {
    if (this.state !== "empty")
      throw new CanvasWorkerClientError("invalid-state", "A canvas Scene is already installed.");
    const snapshotJson = encodeSnapshot(input.revision, input.snapshot);
    const wasmModuleUrl = resolveSameOriginWasmModuleUrl(this.wasmModuleUrl);
    if (typeof input.canvas.transferControlToOffscreen !== "function") {
      throw validationError("The target canvas cannot transfer control to a Worker.");
    }
    let canvas: OffscreenCanvas;
    try {
      canvas = input.canvas.transferControlToOffscreen();
    } catch (cause) {
      throw validationError("The target canvas could not transfer control to a Worker.", cause);
    }
    let request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "install-canvas" }>>;
    try {
      const parsed = parseWorkerRequest({
        canvas,
        kind: "install-canvas",
        requestId: this.takeRequestId(),
        revision: input.revision,
        schema: "poietra.canvas-worker-request",
        snapshotJson,
        version: POIETRA_CANVAS_WORKER_VERSION,
        wasmModuleUrl,
      });
      if (parsed.kind !== "install-canvas") throw new Error("The install request kind was lost.");
      request = parsed;
    } catch (error) {
      const normalized = normalizeError(error, "protocol-violation", "The canvas install request failed.");
      this.failFatally(normalized);
      throw normalized;
    }
    this.state = "installing";
    try {
      await this.dispatch(request, ["canvas-ready"], "install", [canvas, snapshotJson]);
      this.requirePendingState("installing", "The canvas Scene installation was superseded.");
      this.currentRevision = input.revision;
      this.state = "ready";
    } catch (error) {
      const normalized = normalizeError(error, "internal-error", "The canvas Scene installation failed.");
      this.failFatally(normalized);
      throw normalized;
    }
  }

  async replaceScene(input: ReplaceCanvasSceneInputV1) {
    if (this.exclusiveOperation !== null) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        `The ${this.exclusiveOperation} operation is in flight; Scene replacement is mutually exclusive with it.`,
      );
    }
    if (this.state !== "ready" || this.currentRevision !== input.baseRevision) {
      throw new CanvasWorkerClientError("invalid-state", "The replacement base revision is not installed.");
    }
    const snapshotJson = encodeSnapshot(input.revision, input.snapshot);
    const request = parseWorkerRequest({
      baseRevision: input.baseRevision,
      kind: "replace-scene",
      requestId: this.takeRequestId(),
      revision: input.revision,
      schema: "poietra.canvas-worker-request",
      snapshotJson,
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
    if (request.kind !== "replace-scene") {
      throw new CanvasWorkerClientError("protocol-violation", "The replacement request kind was lost.");
    }
    this.cancelScheduledRenders(
      new CanvasWorkerClientError("stale-response", "A Scene replacement superseded this canvas render."),
    );
    this.state = "replacing";
    try {
      await this.dispatch(request, ["canvas-ready"], "replace", [snapshotJson]);
      this.requirePendingState("replacing", "The canvas Scene replacement was superseded.");
      this.currentRevision = input.revision;
      this.state = "ready";
    } catch (error) {
      const normalized = normalizeError(error, "internal-error", "The canvas Scene replacement failed.");
      if (normalized.code === "snapshot-rejected") {
        if (this.state === "replacing") this.state = "ready";
      } else {
        this.failFatally(normalized);
      }
      throw normalized;
    }
  }

  async render(input: RenderCanvasFrameInputV1): Promise<PresentedCanvasFrameV1> {
    if (this.exclusiveOperation !== null) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        `The ${this.exclusiveOperation} operation is in flight; normal renders are mutually exclusive with it.`,
      );
    }
    if (this.state !== "ready" || this.currentRevision !== input.revision) {
      throw new CanvasWorkerClientError("invalid-state", "The requested canvas Scene revision is not installed.");
    }
    const request = parseWorkerRequest({
      kind: "render-frame",
      requestId: this.takeRequestId(),
      revision: input.revision,
      sampleTime: input.sampleTime,
      schema: "poietra.canvas-worker-request",
      version: POIETRA_CANVAS_WORKER_VERSION,
      viewport: input.viewport,
    });
    if (request.kind !== "render-frame") {
      return Promise.reject(new CanvasWorkerClientError("protocol-violation", "The render request kind was lost."));
    }
    return new Promise<PresentedCanvasFrameV1>((resolve, reject) => {
      const scheduled = { reject, request, resolve, settled: false } satisfies ScheduledRenderV1;
      if (this.activeRender) {
        this.settleRenderError(
          this.activeRender,
          new CanvasWorkerClientError("stale-response", "A newer canvas render superseded this request."),
        );
        if (this.queuedRender) {
          this.settleRenderError(
            this.queuedRender,
            new CanvasWorkerClientError("stale-response", "A newer canvas render superseded this request."),
          );
        }
        this.queuedRender = scheduled;
        return;
      }
      this.startRender(scheduled);
    });
  }

  /**
   * Opt-in stage telemetry render. A telemetry render is mutually exclusive
   * with EVERY other client operation: while one is in flight, a second
   * telemetry render, a normal render, a Scene replacement, or adapter
   * evidence collection all reject synchronously with invalid-state, and all
   * of them recover once the telemetry render settles. A failed telemetry
   * frame surfaces as [`CanvasTelemetryRenderError`], preserving the engine's
   * partial per-phase telemetry and error correlation.
   */
  async renderTelemetry(input: RenderCanvasFrameInputV1): Promise<PresentedCanvasFrameTelemetryV1> {
    if (this.exclusiveOperation !== null) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        `The ${this.exclusiveOperation} operation is in flight; telemetry renders are mutually exclusive with it.`,
      );
    }
    if (this.state !== "ready" || this.currentRevision !== input.revision) {
      throw new CanvasWorkerClientError("invalid-state", "The requested canvas Scene revision is not installed.");
    }
    // A settled active render may linger until its finally-cleanup microtask
    // runs; only genuinely unsettled work counts as interleaving.
    if (this.activeRender?.settled === false || this.queuedRender?.settled === false) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        "A telemetry render cannot interleave with in-flight canvas renders.",
      );
    }
    const request = parseWorkerRequest({
      kind: "render-frame-telemetry",
      requestId: this.takeRequestId(),
      revision: input.revision,
      sampleTime: input.sampleTime,
      schema: "poietra.canvas-worker-request",
      version: POIETRA_CANVAS_WORKER_VERSION,
      viewport: input.viewport,
    });
    if (request.kind !== "render-frame-telemetry") {
      throw new CanvasWorkerClientError("protocol-violation", "The telemetry render request kind was lost.");
    }
    this.exclusiveOperation = "telemetry-render";
    try {
      const response = await this.dispatch(request, ["frame-presented-telemetry", "frame-telemetry-failed"]);
      if (response.kind === "frame-telemetry-failed") {
        throw new CanvasTelemetryRenderError(response.error.code, response.error.message, response.telemetry, {
          packetId: response.error.packetId,
          sampleTime: response.error.sampleTime,
          viewport: response.error.viewport,
        });
      }
      if (response.kind !== "frame-presented-telemetry") {
        throw new CanvasWorkerClientError("protocol-violation", "The canvas worker did not present a telemetry frame.");
      }
      if (
        response.packetId !== `canvas:${request.requestId}` ||
        response.sampleTime !== request.sampleTime ||
        response.viewport.heightPx !== request.viewport.heightPx ||
        response.viewport.widthPx !== request.viewport.widthPx
      ) {
        throw new CanvasWorkerClientError(
          "protocol-violation",
          "The presented telemetry frame does not match its correlated request.",
        );
      }
      return response;
    } catch (error) {
      const normalized = normalizeError(error, "internal-error", "The canvas telemetry render failed.");
      if (!RECOVERABLE_RENDER_ERROR_CODES.has(normalized.code)) {
        this.failFatally(normalized);
      }
      throw normalized;
    } finally {
      this.exclusiveOperation = null;
    }
  }

  /**
   * Collects bounded adapter/device evidence captured inside the Worker's
   * own WASM engine, as opposed to the page-level `navigator.gpu` hint.
   */
  async collectAdapterEvidence(): Promise<CollectedAdapterEvidenceV1> {
    if (this.exclusiveOperation !== null) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        `The ${this.exclusiveOperation} operation is in flight; adapter evidence collection is mutually exclusive with it.`,
      );
    }
    if (this.state !== "ready" || this.currentRevision === null) {
      throw new CanvasWorkerClientError("invalid-state", "No canvas Scene revision is installed.");
    }
    if (this.activeRender?.settled === false || this.queuedRender?.settled === false) {
      throw new CanvasWorkerClientError(
        "invalid-state",
        "Adapter evidence collection cannot interleave with in-flight canvas renders.",
      );
    }
    const request = parseWorkerRequest({
      kind: "collect-adapter-evidence",
      requestId: this.takeRequestId(),
      revision: this.currentRevision,
      schema: "poietra.canvas-worker-request",
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
    if (request.kind !== "collect-adapter-evidence") {
      throw new CanvasWorkerClientError("protocol-violation", "The adapter evidence request kind was lost.");
    }
    this.exclusiveOperation = "adapter-evidence";
    try {
      const response = await this.dispatch(request, ["adapter-evidence"]);
      if (response.kind !== "adapter-evidence") {
        throw new CanvasWorkerClientError("protocol-violation", "The canvas worker did not return adapter evidence.");
      }
      return response;
    } catch (error) {
      const normalized = normalizeError(error, "internal-error", "The adapter evidence collection failed.");
      if (!RECOVERABLE_RENDER_ERROR_CODES.has(normalized.code)) {
        this.failFatally(normalized);
      }
      throw normalized;
    } finally {
      this.exclusiveOperation = null;
    }
  }

  dispose() {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.currentRevision = null;
    const error = new CanvasWorkerClientError("disposed", "The canvas worker client was disposed.");
    this.cancelScheduledRenders(error);
    this.rejectPending(error);
    this.detachAndTerminate();
  }

  private dispatch(
    request: CanvasWorkerRequestV1,
    expectedKinds: readonly SuccessfulResponseV1["kind"][],
    expectedOperation?: "install" | "replace",
    transfer: Transferable[] = [],
  ) {
    return new Promise<SuccessfulResponseV1>((resolve, reject: (error: CanvasWorkerClientError) => void) => {
      const timeout = setTimeout(() => {
        this.failFatally(
          new CanvasWorkerClientError(
            "timeout",
            `The canvas worker did not answer request ${request.requestId} within ${this.requestTimeoutMs}ms.`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(request.requestId, {
        expectedKinds,
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
          new CanvasWorkerClientError("transport-failed", "The canvas worker request could not be cloned.", { cause }),
        );
      }
    });
  }

  private startRender(render: ScheduledRenderV1) {
    this.activeRender = render;
    void this.dispatch(render.request, ["frame-presented"])
      .then((response) => {
        if (response.kind !== "frame-presented") {
          this.settleRenderError(
            render,
            new CanvasWorkerClientError("protocol-violation", "The canvas worker did not present a frame."),
          );
          return;
        }
        if (
          response.packetId !== `canvas:${render.request.requestId}` ||
          response.sampleTime !== render.request.sampleTime ||
          response.viewport.heightPx !== render.request.viewport.heightPx ||
          response.viewport.widthPx !== render.request.viewport.widthPx
        ) {
          const error = new CanvasWorkerClientError(
            "protocol-violation",
            "The presented frame does not match its correlated request.",
          );
          this.settleRenderError(render, error);
          this.failFatally(error);
          return;
        }
        if (render.settled) return;
        render.settled = true;
        render.resolve(response);
      })
      .catch((error: unknown) => {
        const normalized = normalizeError(error, "internal-error", "The canvas render failed.");
        this.settleRenderError(render, normalized);
        if (!RECOVERABLE_RENDER_ERROR_CODES.has(normalized.code)) {
          this.failFatally(normalized);
        }
      })
      .finally(() => {
        if (this.activeRender !== render) return;
        this.activeRender = null;
        if (this.state !== "ready" || !this.queuedRender) return;
        const queued = this.queuedRender;
        this.queuedRender = null;
        this.startRender(queued);
      });
  }

  private settleRenderError(render: ScheduledRenderV1, error: CanvasWorkerClientError) {
    if (render.settled) return;
    render.settled = true;
    render.reject(error);
  }

  private requirePendingState(expected: "installing" | "replacing", message: string) {
    if (this.state === expected) return;
    throw new CanvasWorkerClientError(this.state === "disposed" ? "disposed" : "invalid-state", message);
  }

  private cancelScheduledRenders(error: CanvasWorkerClientError) {
    if (this.activeRender) this.settleRenderError(this.activeRender, error);
    if (this.queuedRender) this.settleRenderError(this.queuedRender, error);
    this.queuedRender = null;
  }

  private takeRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId = requestId === Number.MAX_SAFE_INTEGER ? 1 : requestId + 1;
    if (this.pending.has(requestId)) {
      throw new CanvasWorkerClientError("invalid-state", "The canvas worker request ID space is exhausted.");
    }
    return requestId;
  }

  private failFatally(error: CanvasWorkerClientError) {
    if (this.state === "failed" || this.state === "disposed") return;
    this.state = "failed";
    this.currentRevision = null;
    this.cancelScheduledRenders(error);
    this.rejectPending(error);
    this.detachAndTerminate();
  }

  private rejectPending(error: CanvasWorkerClientError) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private correlatedPending(requestId: number, revision: string) {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.failFatally(
        new CanvasWorkerClientError(
          "protocol-violation",
          `The canvas worker returned unknown or duplicate request ID ${requestId}.`,
        ),
      );
      return null;
    }
    if (revision !== pending.revision) {
      this.failFatally(
        new CanvasWorkerClientError("protocol-violation", "The canvas worker returned a mismatched Scene revision."),
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
