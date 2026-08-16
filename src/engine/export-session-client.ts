import { type CanvasPngAssetTransferV1, prepareCanvasPngAssetTransfersV1 } from "./canvas-png-assets";
import {
  canvasUrlsShareOrigin,
  MAX_CANVAS_SNAPSHOT_JSON_BYTES,
  MAX_CANVAS_WASM_MODULE_URL_LENGTH,
} from "./canvas-worker-protocol";
import type { SceneIrBundleV1 } from "./contracts";
import { type ExportProfileV1, exportProfileV1Schema } from "./export-profile";
import {
  type ExportSessionFinishedStatusV1,
  type ExportSessionProgressV1,
  type ExportSessionRefusalReasonV1,
  type ExportWorkerRequestV1,
  exportWorkerResponseV1Schema,
} from "./export-worker-protocol";
import { sceneIrSourceRevisionHash } from "./scene-ir";

/**
 * Page-side client for the composed browser MP4 export (#722).
 *
 * One call exports the exact retained validated Scene bundle through a
 * dedicated worker and resolves with either the finalized MP4 bytes plus
 * their evidence or one named refusal from the closed vocabulary. The
 * interactive preview worker is never touched.
 */

export type StudioMp4ExportInputV1 = Readonly<{
  /** PNG payloads matching the bundle's asset manifest; verified before transfer. */
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  /** The exact validated Scene bundle currently installed and presented. */
  bundle: SceneIrBundleV1;
  onProgress?: (progress: ExportSessionProgressV1) => void;
  profile: ExportProfileV1;
  /** Source revision hash the presented frame correlates with. */
  revision: string;
  signal?: AbortSignal;
  wasmModuleUrl?: string | URL;
  workerFactory?: () => Worker;
}>;

export type StudioMp4ExportOutcomeV1 =
  | Readonly<{ kind: "finished"; mp4: Uint8Array<ArrayBuffer>; status: ExportSessionFinishedStatusV1 }>
  | Readonly<{ kind: "refused"; message: string; reason: ExportSessionRefusalReasonV1 }>;

export class ExportSessionClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportSessionClientError";
  }
}

function createExportWorker() {
  return new Worker(new URL("./poietra-export.worker.ts", import.meta.url), { type: "module" });
}

function browserBaseUrl() {
  if (typeof document !== "undefined") return document.baseURI;
  if (typeof location !== "undefined") return location.href;
  throw new ExportSessionClientError("A browser base URL is unavailable.");
}

function resolveSameOriginWasmModuleUrl(configured: string | URL | undefined) {
  const base = new URL(browserBaseUrl());
  const moduleUrl = new URL(configured?.toString() ?? "./engine-wasm/poietra_wasm.js", base);
  if (!canvasUrlsShareOrigin(moduleUrl, base)) {
    throw new ExportSessionClientError("The Poietra WASM module must use the application's origin.");
  }
  if (moduleUrl.href.length > MAX_CANVAS_WASM_MODULE_URL_LENGTH) {
    throw new ExportSessionClientError(
      `The Poietra WASM module URL exceeds ${MAX_CANVAS_WASM_MODULE_URL_LENGTH} characters.`,
    );
  }
  return moduleUrl.href;
}

function encodeSnapshot(revision: string, snapshot: SceneIrBundleV1) {
  if (sceneIrSourceRevisionHash(snapshot.scene) !== revision) {
    throw new ExportSessionClientError("The Scene revision does not match its source revision hash.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (bytes.byteLength > MAX_CANVAS_SNAPSHOT_JSON_BYTES) {
    throw new ExportSessionClientError(`The Scene snapshot exceeds ${MAX_CANVAS_SNAPSHOT_JSON_BYTES} encoded bytes.`);
  }
  return bytes.buffer;
}

/** Sanitized `.mp4` download name derived from a project/scene label. */
export function studioMp4ExportFileNameV1(baseName: string | null | undefined) {
  const slug = (baseName ?? "")
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `poietra-${slug || "scene"}.mp4`;
}

/**
 * Runs one complete MP4 export in a dedicated worker.
 *
 * Resolves with the finished bytes or a named refusal; rejects only on
 * protocol violations or worker crashes. Aborting the signal requests the
 * named `cancelled` refusal from the session — the worker is only terminated
 * after it answers, so no partial state lingers.
 */
export async function runStudioMp4ExportV1(input: StudioMp4ExportInputV1): Promise<StudioMp4ExportOutcomeV1> {
  const profile = exportProfileV1Schema.parse(input.profile);
  const snapshotJson = encodeSnapshot(input.revision, input.bundle);
  const wasmModuleUrl = resolveSameOriginWasmModuleUrl(input.wasmModuleUrl);
  const prepared = await prepareCanvasPngAssetTransfersV1({
    manifest: input.bundle.assets,
    payloads: input.assetPayloads,
  });
  const requestId = 1;
  const request: ExportWorkerRequestV1 = {
    assetPayloads: [...prepared.transfers],
    kind: "export-mp4",
    profile,
    requestId,
    revision: input.revision,
    schema: "poietra.export-worker-request",
    snapshotJson,
    version: 1,
    wasmModuleUrl,
  };
  const worker = (input.workerFactory ?? createExportWorker)();
  try {
    return await new Promise<StudioMp4ExportOutcomeV1>((resolve, reject) => {
      const onAbort = () => {
        worker.postMessage({
          kind: "export-cancel",
          requestId,
          schema: "poietra.export-worker-request",
          version: 1,
        } satisfies ExportWorkerRequestV1);
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      worker.addEventListener("error", (event) => {
        reject(new ExportSessionClientError(event.message || "The export worker crashed."));
      });
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const parsed = exportWorkerResponseV1Schema.safeParse(event.data);
        if (!parsed.success) {
          reject(
            new ExportSessionClientError("The export worker response violated the v1 protocol.", {
              cause: parsed.error,
            }),
          );
          return;
        }
        const response = parsed.data;
        if (response.kind === "export-error") {
          reject(new ExportSessionClientError(response.message));
          return;
        }
        if (response.requestId !== requestId) return;
        if (response.kind === "export-progress") {
          input.onProgress?.(response.progress);
          return;
        }
        if (response.kind === "export-refused") {
          resolve({ kind: "refused", message: response.message, reason: response.reason });
          return;
        }
        resolve({ kind: "finished", mp4: new Uint8Array(response.mp4), status: response.status });
      });
      worker.postMessage(request, {
        transfer: [snapshotJson, ...prepared.transfers.map((transfer) => transfer.bytes)],
      });
    });
  } finally {
    worker.terminate();
  }
}
