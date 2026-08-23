import { useEffect, useRef, useState } from "react";

import { exportStudioNativeManimSource } from "../render-pipeline/client";
import type { StudioNativeManimSourceExportRequest } from "../render-pipeline/contracts";
import { savePythonSourceWithDesktop } from "../shell/desktop-bridge";

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function downloadPythonSource(fileName: string, source: string) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/x-python;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function StudioManimSourceExportControl({
  blocker = null,
  disabled = false,
  request,
}: Readonly<{
  blocker?: string | null;
  disabled?: boolean;
  request: StudioNativeManimSourceExportRequest | null;
}>) {
  const activeRequest = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    },
    [],
  );

  const unavailableReason = blocker ?? (request ? null : "Open a Studio-native Scene before exporting Manim source.");
  const exportDisabled = disabled || exporting || unavailableReason !== null;

  async function exportSource() {
    if (exportDisabled || !request || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setError(null);
    setExporting(true);
    try {
      const exported = await exportStudioNativeManimSource(request, controller.signal);
      const saved = await savePythonSourceWithDesktop(exported.fileName, exported.source);
      if (saved === null && !controller.signal.aborted) downloadPythonSource(exported.fileName, exported.source);
    } catch (cause) {
      if (!isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Could not export this Scene as Manim source.");
      }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <div data-studio-manim-source-export-state={exporting ? "exporting" : unavailableReason ? "unavailable" : "ready"}>
      <button
        className="min-h-9 border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={exportDisabled}
        onClick={() => void exportSource()}
        title={unavailableReason ?? undefined}
        type="button"
      >
        {exporting ? "Generating .py…" : "Download .py"}
      </button>
      {unavailableReason ? (
        <p className="mt-2 text-pretty text-xs leading-5 text-amber-300">{unavailableReason}</p>
      ) : null}
      {error ? (
        <p
          className="mt-2 border border-red-950 bg-red-950/30 p-2 text-pretty text-xs leading-5 text-red-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
