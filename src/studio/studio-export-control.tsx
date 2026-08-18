import { useRef, useState } from "react";

import {
  type ClientExportPublicationClientV1,
  FetchClientExportPublicationClientV1,
} from "../collaboration/client-export-client";
import {
  browserMp4ExportFileNameV1,
  DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
  downloadMp4Blob,
  runBrowserMp4ExportV1,
} from "../engine/browser-mp4-export";
import type { ExportProgressV1, ExportRefusalReasonV1 } from "../engine/export-worker-protocol";
import { cn } from "../lib/cn";
import { saveVideoFileWithDesktop } from "../shell/desktop-bridge";
import {
  captureStudioExportPublicationV1,
  type PreparedStudioExportPublicationV1,
  prepareStudioExportPublicationV1,
  type StudioExportPublicationAvailabilityV1,
  type StudioMp4ExportSourceV1,
} from "./studio-export-publication";

export type { StudioMp4ExportSourceV1 } from "./studio-export-publication";

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

export type StudioExportControlProps = Readonly<{
  client?: ClientExportPublicationClientV1;
  disabled?: boolean;
  /** Non-null only while the presented preview correlates with this exact Scene. */
  exportSource: StudioMp4ExportSourceV1 | null;
  publication: StudioExportPublicationAvailabilityV1;
}>;

type ExportRunStateV1 =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ fileName: string; kind: "done" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "refused"; message: string; reason: ExportRefusalReasonV1 }>
  | Readonly<{ kind: "running"; progress: ExportProgressV1 | null }>
  | Readonly<{ kind: "saving" }>;

type PublicationRunStateV1 =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "published" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "failed"; message: string }>;

type BrowserExportPublicationCompletionV1 = Readonly<{
  artifact: PreparedStudioExportPublicationV1 | null;
  state: PublicationRunStateV1;
}>;

const defaultPublicationClient = new FetchClientExportPublicationClientV1();

export type StudioExportControlStateKindV1 = ExportRunStateV1["kind"] | "unavailable";

/** Bounded whole percentage of encoded frames, honest about the empty grid. */
export function studioExportProgressPercentV1(progress: ExportProgressV1 | null) {
  if (!progress || progress.frameCount === 0) return 0;
  return Math.min(100, Math.floor((progress.framesEncoded / progress.frameCount) * 100));
}

/**
 * Commits the browser download before optional publication work. A failure to
 * mint or digest cloud lineage must never discard an already encoded MP4.
 */
export async function completeBrowserMp4ExportV1(
  input: Readonly<{
    capturedAvailability: StudioExportPublicationAvailabilityV1;
    capturedPublication: ReturnType<typeof captureStudioExportPublicationV1>;
    deliverLocal: () => void;
    publicationCaptureFailure: string | null;
    video: Uint8Array<ArrayBuffer>;
    preparePublication?: typeof prepareStudioExportPublicationV1;
  }>,
): Promise<BrowserExportPublicationCompletionV1> {
  input.deliverLocal();
  if (input.publicationCaptureFailure) {
    return {
      artifact: null,
      state: { kind: "failed", message: input.publicationCaptureFailure },
    };
  }
  if (!input.capturedPublication) {
    return {
      artifact: null,
      state: {
        kind: "unavailable",
        reason:
          input.capturedAvailability.kind === "unavailable"
            ? input.capturedAvailability.reason
            : "This export has no publishable Editor Document lineage.",
      },
    };
  }
  try {
    const artifact = await (input.preparePublication ?? prepareStudioExportPublicationV1)(
      input.capturedPublication,
      DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
      input.video,
    );
    return { artifact, state: { kind: "ready" } };
  } catch (error) {
    return {
      artifact: null,
      state: {
        kind: "failed",
        message: error instanceof Error ? error.message : "The MP4 publication could not be prepared.",
      },
    };
  }
}

export function StudioExportControl({
  client = defaultPublicationClient,
  disabled = false,
  exportSource,
  publication,
}: StudioExportControlProps) {
  const [run, setRun] = useState<ExportRunStateV1>({ kind: "idle" });
  const [publicationRun, setPublicationRun] = useState<PublicationRunStateV1>({ kind: "idle" });
  const activeExport = useRef<AbortController | null>(null);
  const pendingPublication = useRef<PreparedStudioExportPublicationV1 | null>(null);

  const stateKind: StudioExportControlStateKindV1 =
    run.kind === "running" ? "running" : exportSource === null ? "unavailable" : run.kind;
  const running = run.kind === "running";
  const saving = run.kind === "saving";
  const publishing = publicationRun.kind === "publishing";
  const startBlocked = disabled || running || saving || publishing || exportSource === null;
  const publishBlocked =
    disabled || publishing || publicationRun.kind === "published" || pendingPublication.current === null;
  const publishUnavailableReason =
    publicationRun.kind === "unavailable"
      ? publicationRun.reason
      : pendingPublication.current === null
        ? publication.kind === "unavailable"
          ? publication.reason
          : "Export the current Scene in this browser before publishing it."
        : null;

  async function startExport() {
    if (startBlocked || activeExport.current || !exportSource) return;
    // Snapshot both inputs synchronously. Nothing below this point may read a
    // later preview or Editor Document revision for this artifact.
    const capturedSource = exportSource;
    const capturedAvailability = publication;
    let capturedPublication: ReturnType<typeof captureStudioExportPublicationV1> = null;
    let publicationCaptureFailure: string | null = null;
    try {
      capturedPublication = captureStudioExportPublicationV1(capturedAvailability);
    } catch (error) {
      publicationCaptureFailure =
        error instanceof Error ? error.message : "The MP4 publication identity could not be created.";
    }
    const controller = new AbortController();
    activeExport.current = controller;
    pendingPublication.current = null;
    setPublicationRun({ kind: "idle" });
    setRun({ kind: "running", progress: null });
    try {
      const outcome = await runBrowserMp4ExportV1({
        assetPayloads: capturedSource.assetPayloads,
        onProgress: (progress) => {
          if (activeExport.current === controller) setRun({ kind: "running", progress });
        },
        profile: DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
        signal: controller.signal,
        snapshot: capturedSource.bundle,
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
      const fileName = browserMp4ExportFileNameV1(capturedSource.bundle.scene.sceneId);
      setRun({ kind: "saving" });
      const video = new Uint8Array(await outcome.mp4.arrayBuffer());
      const desktopSaved = await saveVideoFileWithDesktop(fileName, video);
      if (desktopSaved === null) {
        const completion = await completeBrowserMp4ExportV1({
          capturedAvailability,
          capturedPublication,
          deliverLocal: () => {
            downloadMp4Blob(fileName, outcome.mp4);
            setRun({ fileName, kind: "done" });
          },
          publicationCaptureFailure,
          video,
        });
        pendingPublication.current = completion.artifact;
        setPublicationRun(completion.state);
      } else if (desktopSaved) {
        setPublicationRun({ kind: "unavailable", reason: "Desktop exports are saved locally and are not published." });
        setRun({ fileName, kind: "done" });
      } else {
        // The user declined the native save dialog: nothing was written.
        setPublicationRun({ kind: "idle" });
        setRun({ kind: "idle" });
      }
    } catch (error) {
      if (activeExport.current !== controller) return;
      setRun({ kind: "failed", message: error instanceof Error ? error.message : "The browser MP4 export failed." });
    } finally {
      if (activeExport.current === controller) activeExport.current = null;
    }
  }

  async function publishExport() {
    const artifact = pendingPublication.current;
    if (disabled || publicationRun.kind === "publishing" || !artifact) return;
    setPublicationRun({ kind: "publishing" });
    try {
      await client.publish(artifact);
      if (pendingPublication.current === artifact) {
        pendingPublication.current = null;
        setPublicationRun({ kind: "published" });
      }
    } catch (error) {
      if (pendingPublication.current !== artifact) return;
      setPublicationRun({
        kind: "failed",
        message: error instanceof Error ? error.message : "The MP4 publication failed.",
      });
    }
  }

  return (
    <div
      className="flex items-center gap-1"
      data-studio-export-mp4-reason={run.kind === "refused" ? run.reason : undefined}
      data-studio-export-mp4-state={stateKind}
      data-studio-export-publication-state={publicationRun.kind}
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
      <button
        aria-label={publishUnavailableReason ? `Publish MP4 unavailable: ${publishUnavailableReason}` : "Publish MP4"}
        className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={publishBlocked}
        onClick={() => void publishExport()}
        title={publishUnavailableReason ?? "Publish this exact browser export"}
        type="button"
      >
        {publishing
          ? "Publishing…"
          : publicationRun.kind === "published"
            ? "Published"
            : publicationRun.kind === "failed"
              ? "Retry publish"
              : "Publish"}
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
      {publicationRun.kind === "failed" ? (
        <span className="max-w-64 truncate text-red-300" role="alert" title={publicationRun.message}>
          Publish failed: {publicationRun.message}
        </span>
      ) : null}
    </div>
  );
}
