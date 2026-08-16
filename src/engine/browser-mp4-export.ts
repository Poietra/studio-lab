import type { CanvasPngAssetTransferV1 } from "./canvas-png-assets";
import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "./contracts";
import {
  canonicalExportProfileV1,
  type ExportProfileV1,
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_OUTPUT_BYTES,
  parseExportProfileV1,
} from "./export-profile";

export const DEFAULT_BROWSER_MP4_EXPORT_PROFILE: ExportProfileV1 = parseExportProfileV1({
  codec: "h264-mp4",
  colorContractVersion: 1,
  frameRate: 30,
  maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS,
  maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
  resolution: "854x480",
  schema: "poietra.export-profile",
  version: 1,
});

export class BrowserMp4ExportRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserMp4ExportRefused";
  }
}

export type BrowserMp4ExportInput = Readonly<{
  assetPayloads?: readonly CanvasPngAssetTransferV1[];
  profile: ExportProfileV1;
  snapshot: SceneIrBundleV1;
}>;

type ExportWorkerResponse =
  | Readonly<{ bytes: ArrayBuffer; kind: "exported" }>
  | Readonly<{ kind: "refused"; message: string; name: string }>;

export async function renderBrowserMp4(input: BrowserMp4ExportInput): Promise<Blob> {
  const snapshot = sceneIrBundleV1Schema.parse(input.snapshot);
  const profile = parseExportProfileV1(input.profile);
  const encoder = new TextEncoder();
  const snapshotJson = encoder.encode(JSON.stringify(snapshot)).buffer;
  const profileJson = encoder.encode(canonicalExportProfileV1(profile)).buffer;
  const worker = new Worker(new URL("./browser-mp4-export.worker.ts", import.meta.url), { type: "module" });
  try {
    const response = new Promise<ExportWorkerResponse>((resolve, reject) => {
      worker.addEventListener(
        "error",
        (event) => reject(new BrowserMp4ExportRefused(event.message || "The browser MP4 export worker crashed.")),
        { once: true },
      );
      worker.addEventListener("message", (event: MessageEvent<ExportWorkerResponse>) => resolve(event.data), {
        once: true,
      });
    });
    worker.postMessage({
      assetPayloads: input.assetPayloads ?? [],
      kind: "export-mp4",
      profileJson,
      snapshotJson,
      wasmModuleUrl: new URL("./engine-wasm/poietra_wasm.js", document.baseURI).href,
    });
    const result = await response;
    if (result.kind !== "exported") {
      throw new BrowserMp4ExportRefused(result.message);
    }
    if (!(result.bytes instanceof ArrayBuffer) || result.bytes.byteLength === 0) {
      throw new BrowserMp4ExportRefused("The browser exporter returned no MP4 bytes.");
    }
    if (result.bytes.byteLength > profile.maxOutputBytes) {
      throw new BrowserMp4ExportRefused("The browser exporter exceeded maxOutputBytes.");
    }
    return new Blob([result.bytes], { type: "video/mp4" });
  } finally {
    worker.terminate();
  }
}

export async function downloadBrowserMp4(input: BrowserMp4ExportInput, fileName: string): Promise<void> {
  const blob = await renderBrowserMp4(input);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = fileName;
  anchor.href = url;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
