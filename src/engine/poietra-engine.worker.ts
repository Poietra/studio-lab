import {
  engineSampleRequestV1Schema,
  MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES,
  MAX_PREVIEW_SAMPLE_JSON_BYTES,
  POIETRA_PREVIEW_WORKER_VERSION,
  type PreviewWorkerErrorCodeV1,
  type PreviewWorkerRequestV1,
  type PreviewWorkerResponseV1,
  previewUrlsShareOrigin,
  previewWorkerRequestV1Schema,
} from "./preview-worker-protocol";

const MAX_ERROR_MESSAGE_LENGTH = 4_096;

export type PoietraWasmSessionV1 = {
  replaceSnapshot: (snapshotJson: Uint8Array) => void;
  sample: (requestJson: Uint8Array) => Uint8Array;
};

export type PoietraWasmSessionConstructorV1 = new (snapshotJson: Uint8Array) => PoietraWasmSessionV1;

export type PreviewWorkerRuntimeOptionsV1 = Readonly<{
  loadWasm?: (moduleUrl: URL) => Promise<PoietraWasmSessionConstructorV1>;
  postMessage: (response: PreviewWorkerResponseV1, transfer?: Transferable[]) => void;
  scopeUrl: string;
}>;

type CorrelationV1 = Readonly<{ requestId: number | null; revision: string | null }>;

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const bounded = message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return bounded || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  code: PreviewWorkerErrorCodeV1,
  error: unknown,
  fallback: string,
): PreviewWorkerResponseV1 {
  return {
    code,
    kind: "error",
    message: errorMessage(error, fallback),
    requestId: correlation.requestId,
    revision: correlation.revision,
    schema: "poietra.preview-worker-response",
    version: POIETRA_PREVIEW_WORKER_VERSION,
  };
}

export async function initializePoietraWasmBindingsV1(module: unknown): Promise<PoietraWasmSessionConstructorV1> {
  if (!isRecord(module) || typeof module.default !== "function") {
    throw new Error("The Poietra WASM module does not export its initializer.");
  }
  await module.default();
  if (typeof module.poietraEngineAbiVersion !== "function" || module.poietraEngineAbiVersion() !== 1) {
    throw new Error("The Poietra WASM module does not implement engine ABI version 1.");
  }
  const Session = module.PoietraEngineSessionV1;
  if (
    typeof Session !== "function" ||
    !isRecord(Session.prototype) ||
    typeof Session.prototype.replaceSnapshot !== "function" ||
    typeof Session.prototype.sample !== "function"
  ) {
    throw new Error("The Poietra WASM module does not implement PoietraEngineSessionV1.");
  }
  return Session as PoietraWasmSessionConstructorV1;
}

async function loadPoietraWasm(moduleUrl: URL): Promise<PoietraWasmSessionConstructorV1> {
  const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
  return initializePoietraWasmBindingsV1(module);
}

export class PoietraPreviewWorkerRuntimeV1 {
  private readonly loadWasm: (moduleUrl: URL) => Promise<PoietraWasmSessionConstructorV1>;
  private readonly postMessage: (response: PreviewWorkerResponseV1, transfer?: Transferable[]) => void;
  private readonly scopeUrl: URL;
  private currentRevision: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private session: PoietraWasmSessionV1 | null = null;

  constructor(options: PreviewWorkerRuntimeOptionsV1) {
    this.loadWasm = options.loadWasm ?? loadPoietraWasm;
    this.postMessage = options.postMessage;
    this.scopeUrl = new URL(options.scopeUrl);
  }

  accept(value: unknown) {
    const operation = this.queue
      .then(() => this.handle(value))
      .catch((error) => {
        this.postMessage(
          errorResponse(correlationFromUnknown(value), "internal-error", error, "The preview worker failed."),
        );
      });
    this.queue = operation;
    return operation;
  }

  private async handle(value: unknown) {
    const parsed = previewWorkerRequestV1Schema.safeParse(value);
    if (!parsed.success) {
      this.postMessage(
        errorResponse(
          correlationFromUnknown(value),
          "invalid-message",
          parsed.error,
          "The preview worker request does not match the v1 protocol.",
        ),
      );
      return;
    }
    const request = parsed.data;
    if (request.kind === "install-scene") {
      await this.install(request);
      return;
    }
    if (request.kind === "replace-scene") {
      this.replace(request);
      return;
    }
    this.sample(request);
  }

  private async install(request: Extract<PreviewWorkerRequestV1, Readonly<{ kind: "install-scene" }>>) {
    const correlation = correlationFromUnknown(request);
    if (this.session) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "A Scene is already installed."));
      return;
    }
    const moduleUrl = new URL(request.wasmModuleUrl);
    if (!previewUrlsShareOrigin(moduleUrl, this.scopeUrl)) {
      this.postMessage(
        errorResponse(correlation, "wasm-load-failed", null, "The Poietra WASM module must use the worker's origin."),
      );
      return;
    }
    let Session: PoietraWasmSessionConstructorV1;
    try {
      Session = await this.loadWasm(moduleUrl);
    } catch (error) {
      this.postMessage(
        errorResponse(correlation, "wasm-load-failed", error, "The Poietra WASM module failed to load."),
      );
      return;
    }
    try {
      this.session = new Session(new Uint8Array(request.snapshotJson));
      this.currentRevision = request.revision;
    } catch (error) {
      this.postMessage(errorResponse(correlation, "snapshot-rejected", error, "The Scene snapshot was rejected."));
      return;
    }
    this.postMessage({
      kind: "scene-ready",
      operation: "install",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.preview-worker-response",
      version: POIETRA_PREVIEW_WORKER_VERSION,
    });
  }

  private replace(request: Extract<PreviewWorkerRequestV1, Readonly<{ kind: "replace-scene" }>>) {
    const correlation = correlationFromUnknown(request);
    if (!this.session) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No Scene is installed."));
      return;
    }
    if (request.baseRevision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The replacement base revision is stale."));
      return;
    }
    try {
      this.session.replaceSnapshot(new Uint8Array(request.snapshotJson));
      this.currentRevision = request.revision;
    } catch (error) {
      this.postMessage(errorResponse(correlation, "snapshot-rejected", error, "The Scene snapshot was rejected."));
      return;
    }
    this.postMessage({
      kind: "scene-ready",
      operation: "replace",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.preview-worker-response",
      version: POIETRA_PREVIEW_WORKER_VERSION,
    });
  }

  private sample(request: Extract<PreviewWorkerRequestV1, Readonly<{ kind: "sample" }>>) {
    const correlation = correlationFromUnknown(request);
    if (!this.session) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No Scene is installed."));
      return;
    }
    if (request.revision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The sample revision is stale."));
      return;
    }
    const sample = engineSampleRequestV1Schema.parse({
      evidence: ["Poietra WASM preview worker v1"],
      packetId: `preview:${request.requestId}`,
      sampleTime: request.sampleTime,
      schema: "poietra.engine-sample-request",
      version: POIETRA_PREVIEW_WORKER_VERSION,
      viewport: request.viewport,
    });
    const requestJson = new TextEncoder().encode(JSON.stringify(sample));
    if (requestJson.byteLength > MAX_PREVIEW_SAMPLE_JSON_BYTES) {
      this.postMessage(errorResponse(correlation, "sample-rejected", null, "The encoded sample request is too large."));
      return;
    }
    let responseJson: Uint8Array;
    try {
      responseJson = this.session.sample(requestJson);
    } catch (error) {
      this.postMessage(errorResponse(correlation, "sample-rejected", error, "The engine sample failed."));
      return;
    }
    if (!(responseJson instanceof Uint8Array) || responseJson.byteLength > MAX_PREVIEW_ENGINE_RESPONSE_JSON_BYTES) {
      this.postMessage(
        errorResponse(correlation, "sample-rejected", null, "The engine returned an invalid or oversized response."),
      );
      return;
    }
    const transferable =
      responseJson.buffer instanceof ArrayBuffer
        ? responseJson.byteOffset === 0 && responseJson.byteLength === responseJson.buffer.byteLength
          ? responseJson.buffer
          : responseJson.slice().buffer
        : responseJson.slice().buffer;
    this.postMessage(
      {
        kind: "sample-response",
        requestId: request.requestId,
        responseJson: transferable,
        revision: request.revision,
        schema: "poietra.preview-worker-response",
        version: POIETRA_PREVIEW_WORKER_VERSION,
      },
      [transferable],
    );
  }
}

type WorkerScopeV1 = {
  addEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  location: Location;
  postMessage: (response: PreviewWorkerResponseV1, transfer?: Transferable[]) => void;
};

const possibleWorkerScope = globalThis as unknown as Partial<WorkerScopeV1> & { document?: unknown };
if (
  possibleWorkerScope.document === undefined &&
  typeof possibleWorkerScope.addEventListener === "function" &&
  typeof possibleWorkerScope.postMessage === "function" &&
  possibleWorkerScope.location
) {
  const scope = possibleWorkerScope as WorkerScopeV1;
  const runtime = new PoietraPreviewWorkerRuntimeV1({
    postMessage: (response, transfer) => scope.postMessage(response, transfer),
    scopeUrl: scope.location.href,
  });
  scope.addEventListener("message", (event) => {
    void runtime.accept(event.data);
  });
}
