import type { CanvasPngAssetTransferV1 } from "./canvas-png-assets";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import {
  canonicalExportProfileV1,
  type ExportProfileV1,
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_OUTPUT_BYTES,
  parseExportProfileV1,
} from "./export-profile";
import {
  type ExportAudioTimingV1,
  type ExportProgressV1,
  type ExportRefusalReasonV1,
  type ExportWorkerRequestV1,
  exportAudioTimingV1Schema,
  exportWorkerResponseV1Schema,
  MAX_EXPORT_WAV_BYTES,
} from "./export-worker-protocol";
import {
  EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  encodeFragmentMaterialRegistryV1,
  type FragmentMaterialRegistryV1,
} from "./fragment-material-registry";
import {
  EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  encodeScenePostEffectRegistryV1,
  type ScenePostEffectRegistryV1,
} from "./scene-post-effect-registry";

export function browserMp4ExportProfileV1(
  selection: Pick<ExportProfileV1, "frameRate" | "resolution">,
): ExportProfileV1 {
  return parseExportProfileV1({
    codec: "h264-mp4",
    colorContractVersion: 1,
    frameRate: selection.frameRate,
    maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS,
    maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
    resolution: selection.resolution,
    schema: "poietra.export-profile",
    version: 1,
  });
}

export const DEFAULT_BROWSER_MP4_EXPORT_PROFILE = browserMp4ExportProfileV1({
  frameRate: 30,
  resolution: "854x480",
});

export class BrowserMp4ExportRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserMp4ExportRefused";
  }
}

export type BrowserMp4ExportInput = Readonly<{
  audioTiming?: ExportAudioTimingV1;
  /** Optional local WAV attachment. It is transferred to, validated, and encoded in the worker. */
  audioWav?: ArrayBuffer;
  assetPayloads?: readonly CanvasPngAssetTransferV1[];
  fragmentMaterialRegistry?: FragmentMaterialRegistryV1;
  /** Bounded per-frame progress reports from the Rust export loop (#723). */
  onProgress?: (progress: ExportProgressV1) => void;
  profile: ExportProfileV1;
  scenePostEffectRegistry?: ScenePostEffectRegistryV1;
  /**
   * Aborting requests the named `cancelled` refusal from the export session:
   * everything collected is discarded and no partial Blob is ever produced.
   */
  signal?: AbortSignal;
  snapshot: SceneIrBundleV1;
  workerFactory?: () => Worker;
}>;

export type BrowserMp4ExportOutcome =
  | Readonly<{ kind: "exported"; mp4: Blob }>
  | Readonly<{ kind: "refused"; message: string; reason: ExportRefusalReasonV1 }>;

/** Sanitized `.mp4` download name derived from the exported Scene's ID. */
export function browserMp4ExportFileNameV1(sceneId: string) {
  const base = sceneId.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return `${base || "poietra-scene"}.mp4`;
}

function createExportWorker() {
  return new Worker(new URL("./browser-mp4-export.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Runs one complete MP4 export in a dedicated worker.
 *
 * Resolves with the finished Blob or one named refusal from the closed
 * vocabulary; rejects only on protocol violations or worker crashes.
 * Aborting the signal requests the named `cancelled` refusal — the worker is
 * only terminated after it answers, so no partial state lingers.
 */
export async function runBrowserMp4ExportV1(input: BrowserMp4ExportInput): Promise<BrowserMp4ExportOutcome> {
  const snapshot = sceneIrBundleV1Schema.parse(input.snapshot);
  const profile = parseExportProfileV1(input.profile);
  const encoder = new TextEncoder();
  const snapshotJson = encoder.encode(JSON.stringify(snapshot)).buffer;
  const profileJson = encoder.encode(canonicalExportProfileV1(profile)).buffer;
  const fragmentMaterialRegistryJson = encodeFragmentMaterialRegistryV1(
    input.fragmentMaterialRegistry ?? EMPTY_FRAGMENT_MATERIAL_REGISTRY_V1,
  );
  const scenePostEffectRegistryJson = encodeScenePostEffectRegistryV1(
    input.scenePostEffectRegistry ?? EMPTY_SCENE_POST_EFFECT_REGISTRY_V1,
  );
  const requestId = 1;
  if (input.audioWav && (input.audioWav.byteLength === 0 || input.audioWav.byteLength > MAX_EXPORT_WAV_BYTES)) {
    throw new BrowserMp4ExportRefused(`The WAV attachment must be between 1 byte and ${MAX_EXPORT_WAV_BYTES} bytes.`);
  }
  if (input.audioTiming && !input.audioWav) {
    throw new BrowserMp4ExportRefused("Audio timeline timing requires a WAV attachment.");
  }
  const audioTiming = input.audioTiming ? exportAudioTimingV1Schema.parse(input.audioTiming) : undefined;
  if (
    audioTiming &&
    audioTiming.trimEndSampleFrames !== null &&
    audioTiming.trimEndSampleFrames <= audioTiming.trimStartSampleFrames
  ) {
    throw new BrowserMp4ExportRefused("Audio trim out must be later than trim in.");
  }
  const request: ExportWorkerRequestV1 = {
    ...(audioTiming ? { audioTiming } : {}),
    ...(input.audioWav ? { audioWav: input.audioWav } : {}),
    assetPayloads: [...(input.assetPayloads ?? [])],
    fragmentMaterialRegistryJson,
    kind: "export-mp4",
    profileJson,
    requestId,
    scenePostEffectRegistryJson,
    schema: "poietra.export-worker-request",
    snapshotJson,
    version: 1,
    wasmModuleUrl: new URL("./engine-wasm/poietra_wasm.js", document.baseURI).href,
  };
  const worker = (input.workerFactory ?? createExportWorker)();
  const onAbort = () => {
    worker.postMessage({
      kind: "export-cancel",
      requestId,
      schema: "poietra.export-worker-request",
      version: 1,
    } satisfies ExportWorkerRequestV1);
  };
  try {
    return await new Promise<BrowserMp4ExportOutcome>((resolve, reject) => {
      input.signal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("error", (event) => {
        reject(new BrowserMp4ExportRefused(event.message || "The browser MP4 export worker crashed."));
      });
      worker.addEventListener("message", (event: MessageEvent<unknown>) => {
        const parsed = exportWorkerResponseV1Schema.safeParse(event.data);
        if (!parsed.success) {
          reject(
            new BrowserMp4ExportRefused("The export worker response violated the v1 protocol.", {
              cause: parsed.error,
            }),
          );
          return;
        }
        const response = parsed.data;
        if (response.kind === "export-error") {
          reject(new BrowserMp4ExportRefused(response.message));
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
        if (response.bytes.byteLength === 0) {
          reject(new BrowserMp4ExportRefused("The browser exporter returned no MP4 bytes."));
          return;
        }
        if (response.bytes.byteLength > profile.maxOutputBytes) {
          reject(new BrowserMp4ExportRefused("The browser exporter exceeded maxOutputBytes."));
          return;
        }
        resolve({ kind: "exported", mp4: new Blob([response.bytes], { type: "video/mp4" }) });
      });
      // Transfer the potentially large WAV without a second main-thread copy.
      if (input.audioWav)
        worker.postMessage(request, [input.audioWav, fragmentMaterialRegistryJson, scenePostEffectRegistryJson]);
      else worker.postMessage(request, [fragmentMaterialRegistryJson, scenePostEffectRegistryJson]);
      if (input.signal?.aborted) onAbort();
    });
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}

/** Browser-path save: one object-URL `<a download>` click, then cleanup. */
export function downloadMp4Blob(fileName: string, mp4: Blob) {
  const url = URL.createObjectURL(mp4);
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
