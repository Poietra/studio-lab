import {
  type CanvasWorkerErrorCodeV1,
  type CanvasWorkerRequestV1,
  type CanvasWorkerResponseV1,
  canvasEngineSampleRequestV1Schema,
  canvasRenderResponseV1Schema,
  canvasUrlsShareOrigin,
  canvasWorkerRequestV1Schema,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
  MAX_CANVAS_SAMPLE_JSON_BYTES,
  POIETRA_CANVAS_WORKER_VERSION,
} from "./canvas-worker-protocol";

const MAX_ERROR_MESSAGE_LENGTH = 4_096;

export type PoietraWasmCanvasEngineV1 = {
  render: (requestJson: Uint8Array) => Promise<Uint8Array>;
  replaceSnapshot: (snapshotJson: Uint8Array) => void;
};

export type PoietraWasmCanvasEngineClassV1 = {
  create: (snapshotJson: Uint8Array, canvas: OffscreenCanvas) => Promise<PoietraWasmCanvasEngineV1>;
  prototype: PoietraWasmCanvasEngineV1;
};

export type CanvasWorkerRuntimeOptionsV1 = Readonly<{
  loadWasm?: (moduleUrl: URL) => Promise<PoietraWasmCanvasEngineClassV1>;
  postMessage: (response: CanvasWorkerResponseV1) => void;
  scopeUrl: string;
}>;

type CorrelationV1 = Readonly<{ requestId: number | null; revision: string | null }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const bounded = message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return bounded || fallback;
}

function canvasCreateErrorCode(error: unknown): "renderer-unavailable" | "snapshot-rejected" {
  return error instanceof Error && error.name === "PoietraCanvasSnapshotRejected"
    ? "snapshot-rejected"
    : "renderer-unavailable";
}

function correlationFromUnknown(value: unknown): CorrelationV1 {
  if (!isRecord(value)) return { requestId: null, revision: null };
  const requestId =
    typeof value.requestId === "number" && Number.isSafeInteger(value.requestId) && value.requestId > 0
      ? value.requestId
      : null;
  const revision = typeof value.revision === "string" && /^[0-9a-f]{64}$/.test(value.revision) ? value.revision : null;
  return { requestId, revision };
}

function errorResponse(
  correlation: CorrelationV1,
  code: CanvasWorkerErrorCodeV1,
  error: unknown,
  fallback: string,
): CanvasWorkerResponseV1 {
  return {
    code,
    fallback: "whole-scene",
    kind: "error",
    message: errorMessage(error, fallback),
    requestId: correlation.requestId,
    revision: correlation.revision,
    schema: "poietra.canvas-worker-response",
    version: POIETRA_CANVAS_WORKER_VERSION,
  };
}

export async function initializePoietraCanvasBindingsV1(module: unknown): Promise<PoietraWasmCanvasEngineClassV1> {
  if (!isRecord(module) || typeof module.default !== "function") {
    throw new Error("The Poietra WASM module does not export its initializer.");
  }
  await module.default();
  if (typeof module.poietraCanvasAbiVersion !== "function" || module.poietraCanvasAbiVersion() !== 1) {
    throw new Error("The Poietra WASM module does not implement canvas ABI version 1.");
  }
  const Engine: unknown = module.PoietraCanvasEngineV1;
  const EngineClass = Engine as PoietraWasmCanvasEngineClassV1;
  if (
    typeof Engine !== "function" ||
    typeof EngineClass.create !== "function" ||
    !isRecord(EngineClass.prototype) ||
    typeof EngineClass.prototype.replaceSnapshot !== "function" ||
    typeof EngineClass.prototype.render !== "function"
  ) {
    throw new Error("The Poietra WASM module does not implement PoietraCanvasEngineV1.");
  }
  return EngineClass;
}

async function loadPoietraCanvasWasm(moduleUrl: URL) {
  const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
  return initializePoietraCanvasBindingsV1(module);
}

function decodeRenderResponse(responseJson: Uint8Array) {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES
  ) {
    throw new Error("The canvas engine returned an invalid or oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
  } catch (cause) {
    throw new Error("The canvas engine returned malformed UTF-8 JSON.", { cause });
  }
  const parsed = canvasRenderResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The canvas engine response violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

export class PoietraCanvasWorkerRuntimeV1 {
  private readonly loadWasm: (moduleUrl: URL) => Promise<PoietraWasmCanvasEngineClassV1>;
  private readonly postMessage: (response: CanvasWorkerResponseV1) => void;
  private readonly scopeUrl: URL;
  private currentRevision: string | null = null;
  private engine: PoietraWasmCanvasEngineV1 | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CanvasWorkerRuntimeOptionsV1) {
    this.loadWasm = options.loadWasm ?? loadPoietraCanvasWasm;
    this.postMessage = options.postMessage;
    this.scopeUrl = new URL(options.scopeUrl);
  }

  accept(value: unknown) {
    const operation = this.queue
      .then(() => this.handle(value))
      .catch((error) => {
        this.postMessage(
          errorResponse(correlationFromUnknown(value), "internal-error", error, "The canvas worker failed."),
        );
      });
    this.queue = operation;
    return operation;
  }

  private async handle(value: unknown) {
    const parsed = canvasWorkerRequestV1Schema.safeParse(value);
    if (!parsed.success) {
      this.postMessage(
        errorResponse(
          correlationFromUnknown(value),
          "invalid-message",
          parsed.error,
          "The canvas worker request does not match the v1 protocol.",
        ),
      );
      return;
    }
    const request = parsed.data;
    if (request.kind === "install-canvas") {
      await this.install(request);
      return;
    }
    if (request.kind === "replace-scene") {
      this.replace(request);
      return;
    }
    await this.render(request);
  }

  private async install(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "install-canvas" }>>) {
    const correlation = correlationFromUnknown(request);
    if (this.engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "A canvas Scene is already installed."));
      return;
    }
    const moduleUrl = new URL(request.wasmModuleUrl);
    if (!canvasUrlsShareOrigin(moduleUrl, this.scopeUrl)) {
      this.postMessage(
        errorResponse(correlation, "wasm-load-failed", null, "The Poietra WASM module must use the worker's origin."),
      );
      return;
    }
    let Engine: PoietraWasmCanvasEngineClassV1;
    try {
      Engine = await this.loadWasm(moduleUrl);
    } catch (error) {
      this.postMessage(
        errorResponse(correlation, "wasm-load-failed", error, "The Poietra WASM module failed to load."),
      );
      return;
    }
    try {
      this.engine = await Engine.create(new Uint8Array(request.snapshotJson), request.canvas);
      this.currentRevision = request.revision;
    } catch (error) {
      this.postMessage(
        errorResponse(
          correlation,
          canvasCreateErrorCode(error),
          error,
          "The WebGPU canvas engine could not initialize.",
        ),
      );
      return;
    }
    this.postMessage({
      kind: "canvas-ready",
      operation: "install",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
  }

  private replace(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "replace-scene" }>>) {
    const correlation = correlationFromUnknown(request);
    if (!this.engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No canvas Scene is installed."));
      return;
    }
    if (request.baseRevision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The replacement base revision is stale."));
      return;
    }
    try {
      this.engine.replaceSnapshot(new Uint8Array(request.snapshotJson));
      this.currentRevision = request.revision;
    } catch (error) {
      this.postMessage(errorResponse(correlation, "snapshot-rejected", error, "The Scene snapshot was rejected."));
      return;
    }
    this.postMessage({
      kind: "canvas-ready",
      operation: "replace",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
  }

  private async render(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame" }>>) {
    const correlation = correlationFromUnknown(request);
    if (!this.engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No canvas Scene is installed."));
      return;
    }
    if (request.revision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The render revision is stale."));
      return;
    }
    const packetId = `canvas:${request.requestId}`;
    const sample = canvasEngineSampleRequestV1Schema.parse({
      evidence: ["Poietra WASM canvas worker v1"],
      packetId,
      sampleTime: request.sampleTime,
      schema: "poietra.engine-sample-request",
      version: 1,
      viewport: request.viewport,
    });
    const requestJson = new TextEncoder().encode(JSON.stringify(sample));
    if (requestJson.byteLength > MAX_CANVAS_SAMPLE_JSON_BYTES) {
      this.postMessage(errorResponse(correlation, "invalid-request", null, "The encoded render request is too large."));
      return;
    }
    let responseJson: Uint8Array;
    try {
      responseJson = await this.engine.render(requestJson);
    } catch (error) {
      this.postMessage(errorResponse(correlation, "internal-error", error, "The canvas engine render call failed."));
      return;
    }
    let response: ReturnType<typeof decodeRenderResponse>;
    try {
      response = decodeRenderResponse(responseJson);
    } catch (error) {
      this.postMessage(
        errorResponse(correlation, "protocol-violation", error, "The canvas engine returned an invalid response."),
      );
      return;
    }
    const result = response.result;
    if (result.kind === "error") {
      if (
        result.packetId !== packetId ||
        result.sampleTime !== request.sampleTime ||
        result.viewport?.heightPx !== request.viewport.heightPx ||
        result.viewport?.widthPx !== request.viewport.widthPx
      ) {
        this.postMessage(
          errorResponse(correlation, "protocol-violation", null, "The canvas engine error was not correlated."),
        );
        return;
      }
      this.postMessage(errorResponse(correlation, result.code, result.message, result.message));
      return;
    }
    if (
      result.packetId !== packetId ||
      result.sampleTime !== request.sampleTime ||
      result.viewport.heightPx !== request.viewport.heightPx ||
      result.viewport.widthPx !== request.viewport.widthPx
    ) {
      this.postMessage(
        errorResponse(correlation, "protocol-violation", null, "The presented frame was not correlated."),
      );
      return;
    }
    this.postMessage({
      kind: "frame-presented",
      packetId: result.packetId,
      requestId: request.requestId,
      revision: request.revision,
      sampleTime: result.sampleTime,
      schema: "poietra.canvas-worker-response",
      suboptimal: result.suboptimal,
      version: POIETRA_CANVAS_WORKER_VERSION,
      viewport: result.viewport,
    });
  }
}

type WorkerScopeV1 = {
  addEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  location: Location;
  postMessage: (response: CanvasWorkerResponseV1) => void;
};

const possibleWorkerScope = globalThis as unknown as Partial<WorkerScopeV1> & { document?: unknown };
if (
  possibleWorkerScope.document === undefined &&
  typeof possibleWorkerScope.addEventListener === "function" &&
  typeof possibleWorkerScope.postMessage === "function" &&
  possibleWorkerScope.location
) {
  const scope = possibleWorkerScope as WorkerScopeV1;
  const runtime = new PoietraCanvasWorkerRuntimeV1({
    postMessage: (response) => scope.postMessage(response),
    scopeUrl: scope.location.href,
  });
  scope.addEventListener("message", (event) => {
    void runtime.accept(event.data);
  });
}
