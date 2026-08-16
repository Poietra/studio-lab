import { useRef, useState } from "react";

import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import type { SceneIrBundleV1 } from "../engine/contracts";
import {
  type ExportProfileV1,
  type ExportResolutionV1,
  exportResolutionV1Schema,
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_OUTPUT_BYTES,
} from "../engine/export-profile";
import { runStudioMp4ExportV1, studioMp4ExportFileNameV1 } from "../engine/export-session-client";
import type { ExportSessionProgressV1, ExportSessionRefusalReasonV1 } from "../engine/export-worker-protocol";
import { cn } from "../lib/cn";

/**
 * Export MP4 affordance for the exact, truthfully presented Scene (#722).
 *
 * The control only accepts a non-null source, which the caller supplies while
 * the presented preview frame correlates with the installed validated Scene;
 * everything else renders as an honestly disabled affordance. A refused
 * export shows its stable named reason from the closed vocabulary — never a
 * broken button, never a partial file.
 */

export type StudioMp4ExportSourceV1 = Readonly<{
  assetPayloads: readonly CanvasPngAssetTransferV1[];
  bundle: SceneIrBundleV1;
  revision: string;
}>;

export type StudioExportControlProps = Readonly<{
  disabled?: boolean;
  /** Non-null only while the presented preview correlates with this exact Scene. */
  exportSource: StudioMp4ExportSourceV1 | null;
  fileBaseName: string | null;
}>;

type ExportRunStateV1 =
  | Readonly<{ kind: "done"; fileName: string }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "refused"; message: string; reason: ExportSessionRefusalReasonV1 }>
  | Readonly<{ kind: "running"; progress: ExportSessionProgressV1 | null }>;

export type StudioExportControlStateKindV1 = ExportRunStateV1["kind"] | "unavailable";

/** Default profile: 854×480 @ 30 fps H.264/MP4 with the canonical v1 bounds. */
export function studioExportProfileV1(resolution: ExportResolutionV1): ExportProfileV1 {
  return {
    codec: "h264-mp4",
    colorContractVersion: 1,
    frameRate: 30,
    maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS,
    maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
    resolution,
    schema: "poietra.export-profile",
    version: 1,
  };
}

export function studioExportProgressPercentV1(progress: ExportSessionProgressV1 | null) {
  if (!progress || progress.frameCount === 0) return 0;
  return Math.min(100, Math.round((progress.framesEncoded / progress.frameCount) * 100));
}

function downloadMp4(fileName: string, mp4: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([mp4], { type: "video/mp4" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function StudioExportControl({ disabled = false, exportSource, fileBaseName }: StudioExportControlProps) {
  const [resolution, setResolution] = useState<ExportResolutionV1>("854x480");
  const [run, setRun] = useState<ExportRunStateV1>({ kind: "idle" });
  const activeExport = useRef<AbortController | null>(null);

  const stateKind: StudioExportControlStateKindV1 =
    run.kind === "running" ? "running" : exportSource === null ? "unavailable" : run.kind;
  const running = run.kind === "running";
  const startBlocked = disabled || running || exportSource === null;

  async function startExport() {
    if (startBlocked || activeExport.current || !exportSource) return;
    const controller = new AbortController();
    activeExport.current = controller;
    setRun({ kind: "running", progress: null });
    try {
      const outcome = await runStudioMp4ExportV1({
        assetPayloads: exportSource.assetPayloads,
        bundle: exportSource.bundle,
        onProgress: (progress) => {
          if (activeExport.current === controller) setRun({ kind: "running", progress });
        },
        profile: studioExportProfileV1(resolution),
        revision: exportSource.revision,
        signal: controller.signal,
      });
      if (activeExport.current !== controller) return;
      if (outcome.kind === "refused") {
        setRun({ kind: "refused", message: outcome.message, reason: outcome.reason });
        return;
      }
      const fileName = studioMp4ExportFileNameV1(fileBaseName);
      downloadMp4(fileName, outcome.mp4);
      setRun({ kind: "done", fileName });
    } catch (error) {
      if (activeExport.current !== controller) return;
      setRun({ kind: "failed", message: error instanceof Error ? error.message : "The MP4 export failed." });
    } finally {
      if (activeExport.current === controller) activeExport.current = null;
    }
  }

  return (
    <div
      className="flex items-center gap-1 border border-zinc-700 px-2 py-1 text-zinc-400"
      data-studio-export-mp4-reason={run.kind === "refused" ? run.reason : undefined}
      data-studio-export-mp4-state={stateKind}
      role="status"
      title={
        exportSource === null
          ? "Export requires an exactly presented verified preview."
          : run.kind === "refused" || run.kind === "failed"
            ? run.message
            : run.kind === "done"
              ? `Saved ${run.fileName}`
              : undefined
      }
    >
      <select
        aria-label="Export resolution"
        className="h-6 border border-zinc-700 bg-zinc-950 px-1 text-xs text-zinc-300 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={startBlocked}
        onChange={(event) => setResolution(exportResolutionV1Schema.parse(event.target.value))}
        value={resolution}
      >
        {exportResolutionV1Schema.options.map((rung) => (
          <option key={rung} value={rung}>
            {rung}
          </option>
        ))}
      </select>
      <button
        className="h-6 border border-zinc-700 px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={startBlocked}
        onClick={() => void startExport()}
        type="button"
      >
        {running ? `Exporting… ${studioExportProgressPercentV1(run.progress)}%` : "Export MP4"}
      </button>
      {running ? (
        <button
          className="h-6 border border-zinc-700 px-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => activeExport.current?.abort()}
          type="button"
        >
          Cancel
        </button>
      ) : null}
      {run.kind === "refused" || run.kind === "failed" ? (
        <span className={cn("text-xs", run.kind === "refused" ? "text-amber-300" : "text-red-300")}>
          {run.kind === "refused" ? `Export refused · ${run.reason}` : "Export failed"}
        </span>
      ) : null}
      {run.kind === "done" ? <span className="text-xs text-emerald-300">Saved</span> : null}
    </div>
  );
}
