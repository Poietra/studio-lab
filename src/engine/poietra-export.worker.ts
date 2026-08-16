import { canvasUrlsShareOrigin } from "./canvas-worker-protocol";
import {
  type ExportSessionRefusalReasonV1,
  type ExportWorkerRequestV1,
  type ExportWorkerResponseV1,
  exportEncoderProbeResponseV1Schema,
  exportSessionRefusalFromError,
  exportSessionResponseV1Schema,
  exportWorkerRequestV1Schema,
  MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES,
  MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES,
  POIETRA_EXPORT_ENCODER_ABI_VERSION,
  POIETRA_EXPORT_SESSION_ABI_VERSION,
  POIETRA_EXPORT_WORKER_VERSION,
} from "./export-worker-protocol";

/**
 * Dedicated-worker runtime for the composed browser MP4 export (#722).
 *
 * One request drives the whole pipeline inside WASM: probe the H.264 encoder
 * fail-closed, admit the validated Scene bundle + profile into
 * `PoietraExportSessionV1`, run it with bounded-JSON progress, and hand the
 * finalized MP4 back as one transferred `ArrayBuffer`. Any failure — probe
 * refusal, admission rejection, or run refusal — posts one named refusal and
 * nothing else; a partial file can never leave this worker.
 */

const MAX_ERROR_MESSAGE_LENGTH = 4_096;

export type PoietraWasmExportSessionV1 = {
  free: () => void;
  outputBytes: () => Uint8Array;
  run: (progress?: (envelopeJson: Uint8Array) => boolean | undefined) => Promise<Uint8Array>;
};

export type PoietraWasmExportSessionClassV1 = {
  create: (
    snapshotJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    profileJson: Uint8Array,
  ) => Promise<PoietraWasmExportSessionV1>;
  prototype: PoietraWasmExportSessionV1;
};

export type PoietraWasmExportBindingsV1 = Readonly<{
  probeExportEncoderH264V1: () => Promise<Uint8Array>;
  Session: PoietraWasmExportSessionClassV1;
}>;

export type ExportWorkerRuntimeOptionsV1 = Readonly<{
  loadWasm?: (moduleUrl: URL) => Promise<PoietraWasmExportBindingsV1>;
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

export async function initializePoietraExportBindingsV1(module: unknown): Promise<PoietraWasmExportBindingsV1> {
  if (!isRecord(module) || typeof module.default !== "function") {
    throw new Error("The Poietra WASM module does not export its initializer.");
  }
  await module.default();
  if (
    typeof module.poietraExportSessionAbiVersion !== "function" ||
    module.poietraExportSessionAbiVersion() !== POIETRA_EXPORT_SESSION_ABI_VERSION
  ) {
    throw new Error(
      `The Poietra WASM module does not implement export session ABI version ${POIETRA_EXPORT_SESSION_ABI_VERSION}.`,
    );
  }
  if (
    typeof module.poietraExportEncoderAbiVersion !== "function" ||
    module.poietraExportEncoderAbiVersion() !== POIETRA_EXPORT_ENCODER_ABI_VERSION
  ) {
    throw new Error(
      `The Poietra WASM module does not implement export encoder ABI version ${POIETRA_EXPORT_ENCODER_ABI_VERSION}.`,
    );
  }
  if (typeof module.probeExportEncoderH264V1 !== "function") {
    throw new Error("The Poietra WASM module does not implement probeExportEncoderH264V1.");
  }
  const Session: unknown = module.PoietraExportSessionV1;
  const SessionClass = Session as PoietraWasmExportSessionClassV1;
  if (
    typeof Session !== "function" ||
    typeof SessionClass.create !== "function" ||
    !isRecord(SessionClass.prototype) ||
    typeof SessionClass.prototype.run !== "function" ||
    typeof SessionClass.prototype.outputBytes !== "function"
  ) {
    throw new Error("The Poietra WASM module does not implement PoietraExportSessionV1.");
  }
  const probe = module.probeExportEncoderH264V1 as () => Promise<Uint8Array>;
  return { probeExportEncoderH264V1: () => probe.call(module), Session: SessionClass };
}

async function loadPoietraExportWasm(moduleUrl: URL) {
  const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
  return initializePoietraExportBindingsV1(module);
}

function decodeBoundedJson(responseJson: Uint8Array, maximumBytes: number) {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > maximumBytes
  ) {
    throw new Error("The export session returned an invalid or oversized response.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson)) as unknown;
  } catch (cause) {
    throw new Error("The export session returned malformed UTF-8 JSON.", { cause });
  }
}

function decodeSessionResponse(responseJson: Uint8Array) {
  const parsed = exportSessionResponseV1Schema.safeParse(
    decodeBoundedJson(responseJson, MAX_EXPORT_SESSION_RESPONSE_JSON_BYTES),
  );
  if (!parsed.success) {
    throw new Error("The export session response violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

function decodeProbeResponse(responseJson: Uint8Array) {
  const parsed = exportEncoderProbeResponseV1Schema.safeParse(
    decodeBoundedJson(responseJson, MAX_EXPORT_ENCODER_RESPONSE_JSON_BYTES),
  );
  if (!parsed.success) {
    throw new Error("The export encoder probe response violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

/** The exact PNG metadata JSON shape the Rust asset registry deserializes. */
function encodeAssetTransfers(
  assets: Extract<ExportWorkerRequestV1, Readonly<{ kind: "export-mp4" }>>["assetPayloads"],
) {
  const metadataJson = new TextEncoder().encode(
    JSON.stringify(
      assets.map(({ assetId, bytes: _bytes, ...metadata }) => ({
        alphaMode: "straight",
        colorSpace: "srgb",
        id: assetId,
        kind: "png-image",
        ...metadata,
      })),
    ),
  );
  return {
    bytes: assets.map((asset) => new Uint8Array(asset.bytes)),
    metadataJson,
  };
}

export class PoietraExportWorkerRuntimeV1 {
  private readonly loadWasm: (moduleUrl: URL) => Promise<PoietraWasmExportBindingsV1>;
  private readonly post: ExportWorkerRuntimeOptionsV1["postMessage"];
  private readonly scopeUrl: URL;
  private active: { cancelled: boolean; requestId: number } | null = null;

  constructor(options: ExportWorkerRuntimeOptionsV1) {
    this.loadWasm = options.loadWasm ?? loadPoietraExportWasm;
    this.post = options.postMessage;
    this.scopeUrl = new URL(options.scopeUrl);
  }

  /**
   * Accepts one message. An export request runs to completion; a cancel
   * request only flips the active run's flag, which the session observes at
   * its next progress report and turns into the named `cancelled` refusal.
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

  private postRefused(requestId: number, reason: ExportSessionRefusalReasonV1, message: string) {
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
    let bindings: PoietraWasmExportBindingsV1;
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

    // The fail-closed capability probe runs before any session exists so a
    // missing H.264 encoder surfaces as its own named refusal, never as a
    // broken export attempt.
    const probe = decodeProbeResponse(await bindings.probeExportEncoderH264V1());
    if (probe.result.kind !== "supported") {
      this.postRefused(request.requestId, "unsupported-codec", `${probe.result.reason}: ${probe.result.message}`);
      return;
    }

    const assets = encodeAssetTransfers(request.assetPayloads);
    const profileJson = new TextEncoder().encode(JSON.stringify(request.profile));
    let session: PoietraWasmExportSessionV1;
    try {
      session = await bindings.Session.create(
        new Uint8Array(request.snapshotJson),
        assets.metadataJson,
        assets.bytes,
        profileJson,
      );
    } catch (error) {
      const refusal = exportSessionRefusalFromError(error);
      if (refusal) {
        this.postRefused(request.requestId, refusal.reason, refusal.message);
      } else {
        this.postError(request.requestId, errorMessage(error, "The export session could not be created."));
      }
      return;
    }
    try {
      const runResponse = decodeSessionResponse(
        await session.run((envelopeJson) => {
          try {
            const envelope = decodeSessionResponse(envelopeJson);
            if (envelope.result.kind === "progress") {
              this.post({
                kind: "export-progress",
                progress: envelope.result,
                requestId: request.requestId,
                schema: "poietra.export-worker-response",
                version: POIETRA_EXPORT_WORKER_VERSION,
              });
            }
          } catch {
            // A malformed progress envelope never crashes the run; the final
            // response is still validated strictly below.
          }
          return active.cancelled ? false : undefined;
        }),
      );
      if (runResponse.result.kind === "refused") {
        this.postRefused(request.requestId, runResponse.result.reason, runResponse.result.message);
        return;
      }
      if (runResponse.result.kind !== "finished") {
        this.postError(request.requestId, "The export session settled without a finished result.");
        return;
      }
      const output = session.outputBytes();
      if (output.byteLength !== runResponse.result.outputByteLength) {
        this.postError(request.requestId, "The export output bytes do not match the finished evidence.");
        return;
      }
      // One exact-length copy so the transfer never leaks WASM memory pages.
      const mp4 = output.slice().buffer;
      this.post(
        {
          kind: "export-finished",
          mp4,
          requestId: request.requestId,
          schema: "poietra.export-worker-response",
          status: runResponse.result,
          version: POIETRA_EXPORT_WORKER_VERSION,
        },
        [mp4],
      );
    } finally {
      session.free();
    }
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
export function registerPoietraExportWorkerScopeV1() {
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
  const runtime = new PoietraExportWorkerRuntimeV1({
    postMessage: (response, transfer) =>
      transfer ? scope.postMessage(response, { transfer }) : scope.postMessage(response),
    scopeUrl: scope.location.href,
  });
  activeScopeListener = (event) => {
    void runtime.accept(event.data);
  };
  scope.addEventListener("message", activeScopeListener);
}

registerPoietraExportWorkerScopeV1();
