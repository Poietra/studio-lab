import { encodeCanvasPngAssetTransfersForWasmV1 } from "./canvas-png-assets";
import { canvasUrlsShareOrigin } from "./canvas-worker-protocol";
import {
  type ExportRefusalReasonV1,
  type ExportWorkerRequestV1,
  type ExportWorkerResponseV1,
  exportProgressEnvelopeV1Schema,
  exportRefusalFromError,
  exportWorkerRequestV1Schema,
  MAX_EXPORT_PROGRESS_JSON_BYTES,
  POIETRA_EXPORT_WORKER_VERSION,
} from "./export-worker-protocol";

/**
 * Dedicated-worker runtime for the composed browser MP4 export (#722, #723).
 *
 * One request drives the whole pipeline inside WASM `exportSceneMp4V1`:
 * bounded JSON progress envelopes stream back per encoded frame, and the
 * finalized MP4 returns as one transferred `ArrayBuffer`. A cancel request
 * flips the active run's flag, which the Rust export loop observes at its
 * next progress report and turns into the named `cancelled` refusal — a
 * partial file can never leave this worker.
 */

const MAX_ERROR_MESSAGE_LENGTH = 4_096;
const EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON = new TextEncoder().encode(
  '{"materials":[],"schema":"poietra.fragment-material-registry","version":1}',
);

export type BrowserMp4ExportProgressCallbackV1 = (envelopeJson: Uint8Array) => boolean | undefined;

export type BrowserMp4ExportWasmBindingsV1 = Readonly<{
  exportSceneMp4V1: (
    snapshotJson: Uint8Array,
    profileJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    progress?: BrowserMp4ExportProgressCallbackV1,
    fragmentMaterialRegistryJson?: Uint8Array,
  ) => Promise<Uint8Array>;
  exportSceneMp4WithWavV1?: (
    snapshotJson: Uint8Array,
    profileJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    wavBytes: Uint8Array,
    progress?: BrowserMp4ExportProgressCallbackV1,
    fragmentMaterialRegistryJson?: Uint8Array,
  ) => Promise<Uint8Array>;
}>;

export type BrowserMp4ExportWorkerRuntimeOptionsV1 = Readonly<{
  loadWasm?: (moduleUrl: URL) => Promise<BrowserMp4ExportWasmBindingsV1>;
  postMessage: (response: ExportWorkerResponseV1, transfer?: readonly ArrayBuffer[]) => void;
  scopeUrl: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const bounded = message.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return bounded || fallback;
}

function yieldToQueuedWorkerMessages() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function initializeBrowserMp4ExportBindingsV1(module: unknown): Promise<BrowserMp4ExportWasmBindingsV1> {
  if (!isRecord(module) || typeof module.default !== "function") {
    throw new Error("The Poietra WASM module does not export its initializer.");
  }
  await module.default();
  if (typeof module.exportSceneMp4V1 !== "function") {
    throw new Error("The Poietra WASM module does not expose browser MP4 export.");
  }
  const exportSceneMp4V1 = module.exportSceneMp4V1 as BrowserMp4ExportWasmBindingsV1["exportSceneMp4V1"];
  const exportSceneMp4WithWavV1 =
    typeof module.exportSceneMp4WithWavV1 === "function"
      ? (module.exportSceneMp4WithWavV1 as NonNullable<BrowserMp4ExportWasmBindingsV1["exportSceneMp4WithWavV1"]>)
      : null;
  return {
    exportSceneMp4V1: (...inputs) => exportSceneMp4V1.call(module, ...inputs),
    ...(exportSceneMp4WithWavV1
      ? { exportSceneMp4WithWavV1: (...inputs) => exportSceneMp4WithWavV1.call(module, ...inputs) }
      : {}),
  };
}

async function loadBrowserMp4ExportWasm(moduleUrl: URL) {
  const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
  return initializeBrowserMp4ExportBindingsV1(module);
}

function decodeProgressEnvelope(envelopeJson: Uint8Array) {
  if (
    !(envelopeJson instanceof Uint8Array) ||
    envelopeJson.byteLength === 0 ||
    envelopeJson.byteLength > MAX_EXPORT_PROGRESS_JSON_BYTES
  ) {
    throw new Error("The export progress envelope is empty or oversized.");
  }
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelopeJson));
  const parsed = exportProgressEnvelopeV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The export progress envelope violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

export class BrowserMp4ExportWorkerRuntimeV1 {
  private readonly loadWasm: (moduleUrl: URL) => Promise<BrowserMp4ExportWasmBindingsV1>;
  private readonly post: BrowserMp4ExportWorkerRuntimeOptionsV1["postMessage"];
  private readonly scopeUrl: URL;
  private active: { cancelled: boolean; requestId: number } | null = null;

  constructor(options: BrowserMp4ExportWorkerRuntimeOptionsV1) {
    this.loadWasm = options.loadWasm ?? loadBrowserMp4ExportWasm;
    this.post = options.postMessage;
    this.scopeUrl = new URL(options.scopeUrl);
  }

  /**
   * Accepts one message. An export request runs to completion; a cancel
   * request only flips the active run's flag, which the Rust export loop
   * observes at its next progress report and turns into the named
   * `cancelled` refusal.
   */
  async accept(value: unknown): Promise<void> {
    const parsed = exportWorkerRequestV1Schema.safeParse(value);
    if (!parsed.success) {
      this.postError(null, "The export worker request does not match the v1 protocol.");
      return;
    }
    const request = parsed.data;
    if (request.kind === "export-cancel") {
      if (this.active !== null && this.active.requestId === request.requestId) this.active.cancelled = true;
      return;
    }
    if (this.active !== null) {
      this.postRefused(request.requestId, "session-closed", "An export is already running in this worker.");
      return;
    }
    const active = { cancelled: false, requestId: request.requestId };
    this.active = active;
    try {
      await this.runExport(request, active);
    } catch (error) {
      this.postError(request.requestId, errorMessage(error, "The export worker failed."));
    } finally {
      this.active = null;
    }
  }

  private postError(requestId: number | null, message: string) {
    this.post({
      kind: "export-error",
      message,
      requestId,
      schema: "poietra.export-worker-response",
      version: POIETRA_EXPORT_WORKER_VERSION,
    });
  }

  private postRefused(requestId: number, reason: ExportRefusalReasonV1, message: string) {
    this.post({
      kind: "export-refused",
      message,
      reason,
      requestId,
      schema: "poietra.export-worker-response",
      version: POIETRA_EXPORT_WORKER_VERSION,
    });
  }

  private async runExport(
    request: Extract<ExportWorkerRequestV1, Readonly<{ kind: "export-mp4" }>>,
    active: Readonly<{ cancelled: boolean; requestId: number }>,
  ) {
    const moduleUrl = new URL(request.wasmModuleUrl);
    if (!canvasUrlsShareOrigin(moduleUrl, this.scopeUrl)) {
      this.postRefused(request.requestId, "invalid-request", "The Poietra WASM module must use the worker's origin.");
      return;
    }
    let bindings: BrowserMp4ExportWasmBindingsV1;
    try {
      bindings = await this.loadWasm(moduleUrl);
    } catch (error) {
      this.postRefused(
        request.requestId,
        "api-unavailable",
        errorMessage(error, "The Poietra WASM module failed to load."),
      );
      return;
    }
    // A cancel that landed while the WASM module was loading is honored
    // before any GPU or encoder work begins.
    if (active.cancelled) {
      this.postRefused(request.requestId, "cancelled", "the export was cancelled before it started");
      return;
    }
    const assets = encodeCanvasPngAssetTransfersForWasmV1(request.assetPayloads);
    let output: Uint8Array;
    try {
      const progress = (envelopeJson: Uint8Array) => {
        try {
          const envelope = decodeProgressEnvelope(envelopeJson);
          this.post({
            kind: "export-progress",
            progress: envelope.result,
            requestId: request.requestId,
            schema: "poietra.export-worker-response",
            version: POIETRA_EXPORT_WORKER_VERSION,
          });
        } catch {
          // A malformed progress envelope never crashes the run; the export
          // outcome itself stays authoritative.
        }
        return active.cancelled ? false : undefined;
      };
      const snapshotJson = new Uint8Array(request.snapshotJson);
      const profileJson = new Uint8Array(request.profileJson);
      const fragmentMaterialRegistryJson = request.fragmentMaterialRegistryJson
        ? new Uint8Array(request.fragmentMaterialRegistryJson)
        : EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON;
      if (request.audioWav) {
        if (!bindings.exportSceneMp4WithWavV1) {
          this.postRefused(
            request.requestId,
            "api-unavailable",
            "This Poietra engine build does not support WAV audio export.",
          );
          return;
        }
        output = await bindings.exportSceneMp4WithWavV1(
          snapshotJson,
          profileJson,
          assets.metadataJson,
          assets.bytes,
          new Uint8Array(request.audioWav),
          progress,
          fragmentMaterialRegistryJson,
        );
      } else {
        output = await bindings.exportSceneMp4V1(
          snapshotJson,
          profileJson,
          assets.metadataJson,
          assets.bytes,
          progress,
          fragmentMaterialRegistryJson,
        );
      }
    } catch (error) {
      const refusal = exportRefusalFromError(error);
      if (refusal) {
        this.postRefused(request.requestId, refusal.reason, refusal.message);
      } else {
        this.postError(request.requestId, errorMessage(error, "The browser MP4 export failed."));
      }
      return;
    }
    // WASM final muxing is synchronous. Yield once after it returns so a
    // cancel message queued while JS was blocked can update this run before
    // finished bytes leave the worker.
    await yieldToQueuedWorkerMessages();
    if (active.cancelled) {
      this.postRefused(request.requestId, "cancelled", "the export was cancelled before its bytes were delivered");
      return;
    }
    if (!(output instanceof Uint8Array) || output.byteLength === 0) {
      this.postError(request.requestId, "The browser exporter returned no MP4 bytes.");
      return;
    }
    // One exact-length copy so the transfer never leaks WASM memory pages.
    const bytes = output.slice().buffer;
    this.post(
      {
        bytes,
        kind: "export-finished",
        requestId: request.requestId,
        schema: "poietra.export-worker-response",
        version: POIETRA_EXPORT_WORKER_VERSION,
      },
      [bytes],
    );
  }
}

type WorkerScopeV1 = {
  addEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  location: Location;
  postMessage: (response: ExportWorkerResponseV1, options?: Readonly<{ transfer: readonly ArrayBuffer[] }>) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
};

let activeScopeListener: ((event: MessageEvent<unknown>) => void) | null = null;

/** Registers the runtime on the current worker scope; a no-op elsewhere. */
export function registerBrowserMp4ExportWorkerScopeV1() {
  const possibleWorkerScope = globalThis as unknown as Partial<WorkerScopeV1> & { document?: unknown };
  if (
    possibleWorkerScope.document !== undefined ||
    typeof possibleWorkerScope.addEventListener !== "function" ||
    typeof possibleWorkerScope.postMessage !== "function" ||
    !possibleWorkerScope.location
  ) {
    return;
  }
  const scope = possibleWorkerScope as WorkerScopeV1;
  if (activeScopeListener) scope.removeEventListener("message", activeScopeListener);
  const runtime = new BrowserMp4ExportWorkerRuntimeV1({
    postMessage: (response, transfer) =>
      transfer ? scope.postMessage(response, { transfer }) : scope.postMessage(response),
    scopeUrl: scope.location.href,
  });
  activeScopeListener = (event) => {
    void runtime.accept(event.data);
  };
  scope.addEventListener("message", activeScopeListener);
}

registerBrowserMp4ExportWorkerScopeV1();
