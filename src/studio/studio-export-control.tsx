import { useRef, useState } from "react";

import {
  browserMp4ExportFileNameV1,
  DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
  downloadMp4Blob,
  runBrowserMp4ExportV1,
} from "../engine/browser-mp4-export";
import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import type { SceneIrBundleV1 } from "../engine/contracts";
import type { ExportProgressV1, ExportRefusalReasonV1 } from "../engine/export-worker-protocol";
import { cn } from "../lib/cn";
import { saveVideoFileWithDesktop } from "../shell/desktop-bridge";

/**
 * Export MP4 affordance for the exact, truthfully presented Scene
 * (#722, #723).
 *
 * The control only accepts a non-null source, which the caller supplies while
 * the presented preview frame correlates with the installed validated Scene;
 * everything else renders as an honestly disabled affordance. A running
 * export reports its bounded per-frame progress and offers Cancel, which
 * turns into the session's named `cancelled` refusal — never a partial file.
 * A finished export prefers the desktop shell's native save dialog and falls
 * back to the browser Blob download.
 */

export type StudioMp4ExportSourceV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
}>;

export type StudioExportControlProps = Readonly<{
  disabled?: boolean;
  /** Non-null only while the presented preview correlates with this exact Scene. */
  exportSource: StudioMp4ExportSourceV1 | null;
}>;

type ExportRunStateV1 =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ fileName: string; kind: "done" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "refused"; message: string; reason: ExportRefusalReasonV1 }>
  | Readonly<{ kind: "running"; progress: ExportProgressV1 | null }>
  | Readonly<{ kind: "saving" }>;

export type StudioExportControlStateKindV1 = ExportRunStateV1["kind"] | "unavailable";

/** Bounded whole percentage of encoded frames, honest about the empty grid. */
export function studioExportProgressPercentV1(progress: ExportProgressV1 | null) {
  if (!progress || progress.frameCount === 0) return 0;
  return Math.min(100, Math.floor((progress.framesEncoded / progress.frameCount) * 100));
}

export function StudioExportControl({ disabled = false, exportSource }: StudioExportControlProps) {
  const [run, setRun] = useState<ExportRunStateV1>({ kind: "idle" });
  const activeExport = useRef<AbortController | null>(null);

  const stateKind: StudioExportControlStateKindV1 =
    run.kind === "running" ? "running" : exportSource === null ? "unavailable" : run.kind;
  const running = run.kind === "running";
  const saving = run.kind === "saving";
  const startBlocked = disabled || running || saving || exportSource === null;

  async function startExport() {
    if (startBlocked || activeExport.current || !exportSource) return;
    const controller = new AbortController();
    activeExport.current = controller;
    setRun({ kind: "running", progress: null });
    try {
      const outcome = await runBrowserMp4ExportV1({
        assetPayloads: exportSource.assetPayloads,
        onProgress: (progress) => {
          if (activeExport.current === controller) setRun({ kind: "running", progress });
        },
        profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
        signal: controller.signal,
        snapshot: exportSource.bundle,
      });
      if (activeExport.current !== controller) return;
      if (outcome.kind === "refused") {
        setRun(
          outcome.reason === "cancelled"
            ? { kind: "cancelled" }
            : { kind: "refused", message: outcome.message, reason: outcome.reason },
        );
        return;
      }
      const fileName = browserMp4ExportFileNameV1(exportSource.bundle.scene.sceneId);
      setRun({ kind: "saving" });
      const desktopSaved = await saveVideoFileWithDesktop(fileName, new Uint8Array(await outcome.mp4.arrayBuffer()));
      if (desktopSaved === null) {
        downloadMp4Blob(fileName, outcome.mp4);
        setRun({ fileName, kind: "done" });
      } else if (desktopSaved) {
        setRun({ fileName, kind: "done" });
      } else {
        // The user declined the native save dialog: nothing was written.
        setRun({ kind: "idle" });
      }
    } catch (error) {
      if (activeExport.current !== controller) return;
      setRun({ kind: "failed", message: error instanceof Error ? error.message : "The browser MP4 export failed." });
    } finally {
      if (activeExport.current === controller) activeExport.current = null;
    }
  }

  return (
    <div
      className="flex items-center gap-1"
      data-studio-export-mp4-reason={run.kind === "refused" ? run.reason : undefined}
      data-studio-export-mp4-state={stateKind}
      role="status"
    >
      <button
        className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-wait disabled:text-zinc-600"
        disabled={startBlocked}
        onClick={() => void startExport()}
        title="Export the exact Scene shown by the canonical WebGPU preview"
        type="button"
      >
        {running
          ? `Exporting MP4… ${studioExportProgressPercentV1(run.progress)}%`
          : saving
            ? "Saving MP4…"
            : "Export MP4"}
      </button>
      {running ? (
        <button
          className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => activeExport.current?.abort()}
          type="button"
        >
          Cancel
        </button>
      ) : null}
      {run.kind === "refused" || run.kind === "failed" ? (
        <span
          className={cn("max-w-64 truncate", run.kind === "refused" ? "text-amber-300" : "text-red-300")}
          role="alert"
          title={run.message}
        >
          {run.kind === "refused" ? `Export refused · ${run.reason}` : `Export failed: ${run.message}`}
        </span>
      ) : null}
      {run.kind === "cancelled" ? <span className="text-zinc-500">Export cancelled</span> : null}
      {run.kind === "done" ? (
        <span className="text-emerald-300" title={`Saved ${run.fileName}`}>
          Saved
        </span>
      ) : null}
    </div>
  );
}
