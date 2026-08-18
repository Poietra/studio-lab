import { POIETRA_CANVAS_ABI_VERSION } from "./canvas-abi";
import type { CanvasFrameEvidenceCaptureV1 } from "./canvas-frame-evidence";
import { encodeCanvasPngAssetTransfersForWasmV1 } from "./canvas-png-assets";
import {
  type CanvasRenderResponseV1,
  type CanvasRenderTelemetryResponseV1,
  type CanvasWorkerErrorCodeV1,
  type CanvasWorkerRequestV1,
  type CanvasWorkerResponseV1,
  canvasAdapterEvidenceResponseV1Schema,
  canvasEngineSampleRequestV1Schema,
  canvasRenderResponseV1Schema,
  canvasRenderTelemetryResponseV1Schema,
  canvasUrlsShareOrigin,
  canvasWorkerRequestV1Schema,
  MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES,
  MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES,
  MAX_CANVAS_SAMPLE_JSON_BYTES,
  MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES,
  MAX_CANVAS_THUMBNAIL_PNG_BYTES,
  normalizeCanvasInteractionEntityIdsV1,
  POIETRA_CANVAS_TELEMETRY_ABI_VERSION,
  POIETRA_CANVAS_WORKER_VERSION,
} from "./canvas-worker-protocol";

const MAX_ERROR_MESSAGE_LENGTH = 4_096;
const EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON = new TextEncoder().encode(
  '{"materials":[],"schema":"poietra.fragment-material-registry","version":1}',
);

export type PoietraWasmCanvasEngineV1 = {
  generateThumbnail?: () => Promise<Uint8Array>;
  render: (requestJson: Uint8Array) => Promise<Uint8Array>;
  replaceSnapshot: (
    snapshotJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    fragmentMaterialRegistryJson: Uint8Array,
  ) => void | Promise<void>;
  // Telemetry-free modules remain supported. A module that exposes any
  // telemetry surface must complete the exact v4 handshake below; ABI3 is
  // intentionally rejected instead of being partially interpreted.
  adapterEvidence?: () => Uint8Array;
  renderWithTelemetry?: (requestJson: Uint8Array) => Promise<Uint8Array>;
};

export type PoietraWasmCanvasEngineClassV1 = {
  create: (
    snapshotJson: Uint8Array,
    assetMetadataJson: Uint8Array,
    assetBytes: Uint8Array[],
    canvas: OffscreenCanvas,
    fragmentMaterialRegistryJson?: Uint8Array,
  ) => Promise<PoietraWasmCanvasEngineV1>;
  prototype: PoietraWasmCanvasEngineV1;
};

/**
 * Dev-only seam for the frame-proof extension: the production runtime carries
 * no readback code and treats extended requests as ordinary protocol errors;
 * the dev worker entry injects this support object instead. All evidence
 * types here are erased at build time (type-only imports).
 */
export type CanvasWorkerEvidenceHostV1 = Readonly<{
  capture: CanvasFrameEvidenceCaptureV1 | null;
  postError: (value: unknown, code: CanvasWorkerErrorCodeV1, error: unknown, fallback: string) => void;
  postResponse: (response: Record<string, unknown>) => void;
  revision: string | null;
}>;

export type CanvasWorkerEvidenceSupportV1 = Readonly<{
  createCapture: (canvas: OffscreenCanvas) => CanvasFrameEvidenceCaptureV1;
  /** Handles an extended-protocol request; false when it is not one. */
  handleRequest: (value: unknown, host: CanvasWorkerEvidenceHostV1) => Promise<boolean>;
}>;

export type CanvasWorkerRuntimeOptionsV1 = Readonly<{
  evidence?: CanvasWorkerEvidenceSupportV1;
  loadWasm?: (moduleUrl: URL) => Promise<PoietraWasmCanvasEngineClassV1>;
  postMessage: (response: CanvasWorkerResponseV1, transfer?: Transferable[]) => void;
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
  if (
    typeof module.poietraCanvasAbiVersion !== "function" ||
    module.poietraCanvasAbiVersion() !== POIETRA_CANVAS_ABI_VERSION
  ) {
    throw new Error(`The Poietra WASM module does not implement canvas ABI version ${POIETRA_CANVAS_ABI_VERSION}.`);
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
  // Telemetry is optional, but never trusted on method presence alone: any
  // telemetry surface requires an exact version-4 handshake AND the complete
  // method pair. A version without methods, methods without a version, or a
  // foreign version all fail closed instead of being partially used.
  const telemetryVersion =
    typeof module.poietraCanvasTelemetryAbiVersion === "function" ? module.poietraCanvasTelemetryAbiVersion() : null;
  const hasRenderWithTelemetry = typeof EngineClass.prototype.renderWithTelemetry === "function";
  const hasAdapterEvidence = typeof EngineClass.prototype.adapterEvidence === "function";
  if (telemetryVersion !== null || hasRenderWithTelemetry || hasAdapterEvidence) {
    if (telemetryVersion !== POIETRA_CANVAS_TELEMETRY_ABI_VERSION || !hasRenderWithTelemetry || !hasAdapterEvidence) {
      throw new Error("The Poietra WASM module exposes telemetry without a complete telemetry ABI version 4.");
    }
  }
  return EngineClass;
}

async function loadPoietraCanvasWasm(moduleUrl: URL) {
  const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
  return initializePoietraCanvasBindingsV1(module);
}

function decodeBoundedJson(responseJson: Uint8Array, maximumBytes: number) {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > maximumBytes
  ) {
    throw new Error("The canvas engine returned an invalid or oversized response.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson)) as unknown;
  } catch (cause) {
    throw new Error("The canvas engine returned malformed UTF-8 JSON.", { cause });
  }
}

function decodeRenderResponse(responseJson: Uint8Array) {
  const decoded = decodeBoundedJson(responseJson, MAX_CANVAS_RENDER_RESPONSE_JSON_BYTES);
  const parsed = canvasRenderResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The canvas engine response violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

function decodeTelemetryResponse(responseJson: Uint8Array) {
  const decoded = decodeBoundedJson(responseJson, MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES);
  const parsed = canvasRenderTelemetryResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The canvas engine telemetry response violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

function decodeAdapterEvidence(evidenceJson: Uint8Array) {
  const decoded = decodeBoundedJson(evidenceJson, MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES);
  const parsed = canvasAdapterEvidenceResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The canvas engine adapter evidence violated the v1 contract.", { cause: parsed.error });
  }
  return parsed.data;
}

export class PoietraCanvasWorkerRuntimeV1 {
  private readonly loadWasm: (moduleUrl: URL) => Promise<PoietraWasmCanvasEngineClassV1>;
  private readonly postMessage: (response: CanvasWorkerResponseV1, transfer?: Transferable[]) => void;
  private readonly scopeUrl: URL;
  private readonly evidence: CanvasWorkerEvidenceSupportV1 | null;
  private currentRevision: string | null = null;
  private engine: PoietraWasmCanvasEngineV1 | null = null;
  private evidenceCapture: CanvasFrameEvidenceCaptureV1 | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CanvasWorkerRuntimeOptionsV1) {
    this.evidence = options.evidence ?? null;
    this.loadWasm = options.loadWasm ?? loadPoietraCanvasWasm;
    this.postMessage = options.postMessage;
    this.scopeUrl = new URL(options.scopeUrl);
  }

  /**
   * Accepts one request. Requests are strictly serialized through a single
   * promise chain: at most one engine operation is ever active, and responses
   * are posted in request order.
   */
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
      if (this.evidence && (await this.evidence.handleRequest(value, this.evidenceHost()))) return;
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
      await this.replace(request);
      return;
    }
    if (request.kind === "render-frame-telemetry") {
      await this.renderTelemetry(request);
      return;
    }
    if (request.kind === "collect-adapter-evidence") {
      this.collectAdapterEvidence(request);
      return;
    }
    if (request.kind === "generate-thumbnail") {
      await this.generateThumbnail(request);
      return;
    }
    await this.render(request);
  }

  private evidenceHost(): CanvasWorkerEvidenceHostV1 {
    return {
      capture: this.engine ? this.evidenceCapture : null,
      postError: (value, code, error, fallback) =>
        this.postMessage(errorResponse(correlationFromUnknown(value), code, error, fallback)),
      postResponse: (response) => this.postMessage(response as unknown as CanvasWorkerResponseV1),
      revision: this.currentRevision,
    };
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
    if (request.captureFrameEvidence === true && !this.evidence) {
      this.postMessage(
        errorResponse(
          correlation,
          "invalid-state",
          null,
          "This worker build cannot fulfil the requested install options.",
        ),
      );
      return;
    }
    try {
      if (request.captureFrameEvidence === true && this.evidence) {
        this.evidenceCapture = this.evidence.createCapture(request.canvas);
      }
      const assets = encodeCanvasPngAssetTransfersForWasmV1(request.assetPayloads);
      this.engine = await Engine.create(
        new Uint8Array(request.snapshotJson),
        assets.metadataJson,
        assets.bytes,
        request.canvas,
        request.fragmentMaterialRegistryJson
          ? new Uint8Array(request.fragmentMaterialRegistryJson)
          : EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON,
      );
      this.currentRevision = request.revision;
    } catch (error) {
      // A failed create must fully unwind the evidence hooks so a retried
      // install cannot double-wrap them or retain the dead capture's buffers.
      this.evidenceCapture?.dispose();
      this.evidenceCapture = null;
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

  private async replace(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "replace-scene" }>>) {
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
      const assets = encodeCanvasPngAssetTransfersForWasmV1(request.assetPayloads);
      await this.engine.replaceSnapshot(
        new Uint8Array(request.snapshotJson),
        assets.metadataJson,
        assets.bytes,
        request.fragmentMaterialRegistryJson
          ? new Uint8Array(request.fragmentMaterialRegistryJson)
          : EMPTY_FRAGMENT_MATERIAL_REGISTRY_JSON,
      );
      this.currentRevision = request.revision;
    } catch (error) {
      // A rejected replace leaves both the Scene and the surface in their
      // previous state, so the previously committed evidence stays valid.
      this.postMessage(errorResponse(correlation, "snapshot-rejected", error, "The Scene snapshot was rejected."));
      return;
    }
    // A successful replace atomically installs a new Scene: the committed
    // evidence describes a frame of the OLD Scene, so it is invalidated and
    // evidence capture refuses until a frame of the new revision commits.
    this.evidenceCapture?.invalidateCommitted();
    this.postMessage({
      kind: "canvas-ready",
      operation: "replace",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
  }

  private encodeSampleRequest(
    correlation: CorrelationV1,
    request: Readonly<{
      interactionEntityIds?: unknown;
      requestId: number;
      sampleTime: number;
      viewport: Readonly<{ heightPx: number; widthPx: number }>;
    }>,
  ) {
    const packetId = `canvas:${request.requestId}`;
    const normalizedInteraction = normalizeCanvasInteractionEntityIdsV1(request.interactionEntityIds);
    const interactionEntityIds =
      Array.isArray(normalizedInteraction) && normalizedInteraction.length === 0 ? undefined : normalizedInteraction;
    const sample = canvasEngineSampleRequestV1Schema.parse({
      evidence: ["Poietra WASM canvas worker v1"],
      ...(interactionEntityIds === undefined ? {} : { interactionEntityIds }),
      packetId,
      sampleTime: request.sampleTime,
      schema: "poietra.engine-sample-request",
      version: 1,
      viewport: request.viewport,
    });
    const requestJson = new TextEncoder().encode(JSON.stringify(sample));
    if (requestJson.byteLength > MAX_CANVAS_SAMPLE_JSON_BYTES) {
      this.postMessage(errorResponse(correlation, "invalid-request", null, "The encoded render request is too large."));
      return null;
    }
    return {
      interactionExpectedEntries:
        interactionEntityIds === undefined
          ? undefined
          : Array.isArray(interactionEntityIds)
            ? interactionEntityIds.length
            : null,
      packetId,
      requestJson,
    };
  }

  private correlatePresentedResult(
    correlation: CorrelationV1,
    result: CanvasRenderResponseV1["result"],
    packetId: string,
    request: Readonly<{ sampleTime: number; viewport: Readonly<{ heightPx: number; widthPx: number }> }>,
  ) {
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
        return null;
      }
      this.postMessage(errorResponse(correlation, result.code, result.message, result.message));
      return null;
    }
    if (
      result.packetId !== packetId ||
      result.sampleTime !== request.sampleTime ||
      result.viewport.heightPx !== request.viewport.heightPx ||
      result.viewport.widthPx !== request.viewport.widthPx
    ) {
      this.postMessage(
        errorResponse(
          correlation,
          "protocol-violation",
          null,
          `The presented frame was not correlated: expected ${packetId} at ${request.sampleTime} for ${request.viewport.widthPx}x${request.viewport.heightPx}, received ${result.packetId} at ${result.sampleTime} for ${result.viewport.widthPx}x${result.viewport.heightPx}.`,
        ),
      );
      return null;
    }
    return result;
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
    const encoded = this.encodeSampleRequest(correlation, request);
    if (!encoded) return;
    this.evidenceCapture?.beginFrame(request.viewport);
    let committedEvidence = false;
    try {
      let responseJson: Uint8Array;
      try {
        responseJson = await this.engine.render(encoded.requestJson);
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
      const result = this.correlatePresentedResult(correlation, response.result, encoded.packetId, request);
      if (!result) return;
      const interaction =
        encoded.interactionExpectedEntries === undefined
          ? undefined
          : encoded.interactionExpectedEntries !== null &&
              result.interaction?.status === "available" &&
              result.interaction.entries.length === encoded.interactionExpectedEntries
            ? result.interaction
            : ({ status: "unavailable" } as const);
      // Only a fully verified, correlated response commits the staged copy.
      // A non-"committed" outcome (zero submissions) already cleared the
      // committed evidence inside the capture, so a later evidence request
      // refuses; the production frame-presented response is unaffected.
      this.evidenceCapture?.commit({
        packetId: encoded.packetId,
        revision: request.revision,
        sampleTime: result.sampleTime,
        viewport: result.viewport,
      });
      committedEvidence = true;
      this.postMessage({
        ...(interaction ? { interaction } : {}),
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
    } finally {
      // Every non-committing path — engine throw, malformed or uncorrelated
      // response, unexpected internal throw — discards the staged copy and
      // closes the staging window.
      if (!committedEvidence) this.evidenceCapture?.discard();
    }
  }

  private async renderTelemetry(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "render-frame-telemetry" }>>) {
    const correlation = correlationFromUnknown(request);
    if (!this.engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No canvas Scene is installed."));
      return;
    }
    if (request.revision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The render revision is stale."));
      return;
    }
    const renderWithTelemetry = this.engine.renderWithTelemetry;
    if (typeof renderWithTelemetry !== "function") {
      this.postMessage(
        errorResponse(
          correlation,
          "telemetry-unavailable",
          null,
          "The loaded Poietra WASM module does not implement canvas telemetry ABI v4.",
        ),
      );
      return;
    }
    const encoded = this.encodeSampleRequest(correlation, request);
    if (!encoded) return;
    this.evidenceCapture?.beginFrame(request.viewport);
    let committedEvidence = false;
    try {
      let responseJson: Uint8Array;
      try {
        responseJson = await renderWithTelemetry.call(this.engine, encoded.requestJson);
      } catch (error) {
        this.postMessage(
          errorResponse(correlation, "internal-error", error, "The canvas engine telemetry render call failed."),
        );
        return;
      }
      let response: CanvasRenderTelemetryResponseV1;
      try {
        response = decodeTelemetryResponse(responseJson);
      } catch (error) {
        this.postMessage(
          errorResponse(
            correlation,
            "protocol-violation",
            error,
            "The canvas engine returned an invalid telemetry response.",
          ),
        );
        return;
      }
      if (response.result.kind === "error") {
        const failure = response.result;
        // A failed telemetry frame keeps its partial per-phase telemetry and
        // the engine's error correlation in a dedicated envelope; only an
        // uncorrelated engine error stays a fail-closed protocol violation.
        if (
          failure.packetId !== encoded.packetId ||
          failure.sampleTime !== request.sampleTime ||
          failure.viewport?.heightPx !== request.viewport.heightPx ||
          failure.viewport?.widthPx !== request.viewport.widthPx
        ) {
          this.postMessage(
            errorResponse(
              correlation,
              "protocol-violation",
              null,
              "The canvas engine telemetry error was not correlated.",
            ),
          );
          return;
        }
        this.postMessage({
          error: {
            code: failure.code,
            message: failure.message,
            packetId: failure.packetId,
            sampleTime: failure.sampleTime,
            viewport: failure.viewport,
          },
          kind: "frame-telemetry-failed",
          requestId: request.requestId,
          revision: request.revision,
          schema: "poietra.canvas-worker-response",
          telemetry: response.telemetry,
          version: POIETRA_CANVAS_WORKER_VERSION,
        });
        return;
      }
      const result = this.correlatePresentedResult(correlation, response.result, encoded.packetId, request);
      if (!result) return;
      this.evidenceCapture?.commit({
        packetId: encoded.packetId,
        revision: request.revision,
        sampleTime: result.sampleTime,
        viewport: result.viewport,
      });
      committedEvidence = true;
      this.postMessage({
        kind: "frame-presented-telemetry",
        packetId: result.packetId,
        requestId: request.requestId,
        revision: request.revision,
        sampleTime: result.sampleTime,
        schema: "poietra.canvas-worker-response",
        suboptimal: result.suboptimal,
        telemetry: response.telemetry,
        version: POIETRA_CANVAS_WORKER_VERSION,
        viewport: result.viewport,
      });
    } finally {
      if (!committedEvidence) this.evidenceCapture?.discard();
    }
  }

  private collectAdapterEvidence(
    request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "collect-adapter-evidence" }>>,
  ) {
    const correlation = correlationFromUnknown(request);
    if (!this.engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No canvas Scene is installed."));
      return;
    }
    if (request.revision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The evidence revision is stale."));
      return;
    }
    const adapterEvidence = this.engine.adapterEvidence;
    if (typeof adapterEvidence !== "function") {
      this.postMessage(
        errorResponse(
          correlation,
          "telemetry-unavailable",
          null,
          "The loaded Poietra WASM module does not expose worker adapter evidence.",
        ),
      );
      return;
    }
    let evidenceJson: Uint8Array;
    try {
      evidenceJson = adapterEvidence.call(this.engine);
    } catch (error) {
      this.postMessage(
        errorResponse(correlation, "internal-error", error, "The canvas engine adapter evidence call failed."),
      );
      return;
    }
    let evidence: ReturnType<typeof decodeAdapterEvidence>;
    try {
      evidence = decodeAdapterEvidence(evidenceJson);
    } catch (error) {
      this.postMessage(
        errorResponse(correlation, "protocol-violation", error, "The canvas engine returned invalid adapter evidence."),
      );
      return;
    }
    if (evidence.kind === "unavailable") {
      this.postMessage(errorResponse(correlation, "telemetry-unavailable", null, evidence.reason));
      return;
    }
    this.postMessage({
      evidence,
      kind: "adapter-evidence",
      requestId: request.requestId,
      revision: request.revision,
      schema: "poietra.canvas-worker-response",
      version: POIETRA_CANVAS_WORKER_VERSION,
    });
  }

  private async generateThumbnail(request: Extract<CanvasWorkerRequestV1, Readonly<{ kind: "generate-thumbnail" }>>) {
    const correlation = correlationFromUnknown(request);
    const engine = this.engine;
    if (!engine) {
      this.postMessage(errorResponse(correlation, "invalid-state", null, "No canvas Scene is installed."));
      return;
    }
    if (request.revision !== this.currentRevision) {
      this.postMessage(errorResponse(correlation, "stale-revision", null, "The thumbnail revision is stale."));
      return;
    }
    if (typeof engine.generateThumbnail !== "function") {
      this.postMessage(
        errorResponse(correlation, "thumbnail-failed", null, "The loaded engine cannot generate thumbnails."),
      );
      return;
    }
    try {
      const generated = await engine.generateThumbnail.call(engine);
      if (
        !(generated instanceof Uint8Array) ||
        generated.byteLength < 1 ||
        generated.byteLength > MAX_CANVAS_THUMBNAIL_PNG_BYTES
      ) {
        throw new TypeError("The engine returned an invalid thumbnail payload.");
      }
      const png = Uint8Array.from(generated).buffer;
      this.postMessage(
        {
          kind: "thumbnail-generated",
          png,
          requestId: request.requestId,
          revision: request.revision,
          schema: "poietra.canvas-worker-response",
          version: POIETRA_CANVAS_WORKER_VERSION,
        },
        [png],
      );
    } catch (error) {
      this.postMessage(errorResponse(correlation, "thumbnail-failed", error, "The canonical thumbnail render failed."));
    }
  }
}

type WorkerScopeV1 = {
  addEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  location: Location;
  postMessage: (response: CanvasWorkerResponseV1, transfer?: Transferable[]) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
};

let activeScopeListener: ((event: MessageEvent<unknown>) => void) | null = null;

/**
 * Registers a runtime on the current worker scope; a no-op elsewhere. This
 * module registers the evidence-free production runtime on load; the dev
 * worker entry re-registers with its injected support and takes over.
 */
export function registerPoietraCanvasWorkerScopeV1(
  options: Readonly<{ evidence?: CanvasWorkerEvidenceSupportV1 }> = {},
) {
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
  const runtime = new PoietraCanvasWorkerRuntimeV1({
    evidence: options.evidence,
    postMessage: (response, transfer) => scope.postMessage(response, transfer),
    scopeUrl: scope.location.href,
  });
  activeScopeListener = (event) => {
    void runtime.accept(event.data);
  };
  scope.addEventListener("message", activeScopeListener);
}

registerPoietraCanvasWorkerScopeV1();
