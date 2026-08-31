import { useRef, useState } from "react";

import {
  type ClientExportPublicationClientV1,
  FetchClientExportPublicationClientV1,
} from "../collaboration/client-export-client";
import {
  browserMp4ExportFileNameV1,
  browserMp4ExportProfileV1,
  DEFAULT_BROWSER_MP4_EXPORT_PROFILE,
  downloadMp4Blob,
  runBrowserMp4ExportV1,
} from "../engine/browser-mp4-export";
import { type ExportProfileV1, exportFrameRateV1Schema, exportResolutionV1Schema } from "../engine/export-profile";
import {
  type ExportProgressV1,
  type ExportRefusalReasonV1,
  MAX_EXPORT_WAV_BYTES,
} from "../engine/export-worker-protocol";
import { cn } from "../lib/cn";
import { saveVideoFileWithDesktop } from "../shell/desktop-bridge";
import type { ProjectAudioTrack } from "./project-audio-track";
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
  audioTrack?: ProjectAudioTrack | null;
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

const EXPORT_RESOLUTION_OPTIONS = [
  { label: "480p", value: "854x480" },
  { label: "720p", value: "1280x720" },
  { label: "1080p", value: "1920x1080" },
] as const satisfies ReadonlyArray<Readonly<{ label: string; value: ExportProfileV1["resolution"] }>>;

const EXPORT_FRAME_RATE_OPTIONS = [30, 60] as const satisfies readonly ExportProfileV1["frameRate"][];

const fieldClassName =
  "mt-1 min-h-9 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs tabular-nums text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600";
const secondaryButtonClassName =
  "min-h-9 border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600";
const primaryButtonClassName =
  "min-h-9 bg-sky-500 px-3 text-xs font-medium text-sky-950 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-500";

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
    profile: ExportProfileV1;
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
      input.profile,
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
  audioTrack,
  client = defaultPublicationClient,
  disabled = false,
  exportSource,
  publication,
}: StudioExportControlProps) {
  const [run, setRun] = useState<ExportRunStateV1>({ kind: "idle" });
  const [publicationRun, setPublicationRun] = useState<PublicationRunStateV1>({ kind: "idle" });
  const [transientAudioFile, setTransientAudioFile] = useState<File | null>(null);
  const [transientAudioError, setTransientAudioError] = useState<string | null>(null);
  const [exportFrameRate, setExportFrameRate] = useState<ExportProfileV1["frameRate"]>(
    DEFAULT_BROWSER_MP4_EXPORT_PROFILE.frameRate,
  );
  const [exportResolution, setExportResolution] = useState<ExportProfileV1["resolution"]>(
    DEFAULT_BROWSER_MP4_EXPORT_PROFILE.resolution,
  );
  const activeExport = useRef<AbortController | null>(null);
  const transientAudioInput = useRef<HTMLInputElement | null>(null);
  const pendingPublication = useRef<PreparedStudioExportPublicationV1 | null>(null);
  const selectedProfile = browserMp4ExportProfileV1({
    frameRate: exportFrameRate,
    resolution: exportResolution,
  });

  const stateKind: StudioExportControlStateKindV1 =
    run.kind === "running" ? "running" : exportSource === null ? "unavailable" : run.kind;
  const running = run.kind === "running";
  const saving = run.kind === "saving";
  const publishing = publicationRun.kind === "publishing";
  const hasAudio = audioTrack ? true : audioTrack === undefined && transientAudioFile !== null;
  const startBlocked = disabled || running || saving || publishing || exportSource === null;
  const publishBlocked =
    disabled || hasAudio || publishing || publicationRun.kind === "published" || pendingPublication.current === null;
  const publishUnavailableReason = hasAudio
    ? "WAV audio exports are local-only in this release."
    : publicationRun.kind === "unavailable"
      ? publicationRun.reason
      : pendingPublication.current === null
        ? publication.kind === "unavailable"
          ? publication.reason
          : "Export the current Scene in this browser before publishing it."
        : null;
  const exportUnavailableReason = disabled
    ? "Export is unavailable while the Editor session changes."
    : exportSource === null
      ? "Wait for the canonical WebGPU preview before exporting."
      : null;

  async function startExport() {
    if (startBlocked || activeExport.current || !exportSource) return;
    // Snapshot both inputs synchronously. Nothing below this point may read a
    // later preview or Editor Document revision for this artifact.
    const capturedSource = exportSource;
    const capturedAudioTrack = audioTrack ?? null;
    const capturedTransientAudioFile = audioTrack === undefined ? transientAudioFile : null;
    const capturedHasAudio = capturedAudioTrack !== null || capturedTransientAudioFile !== null;
    const capturedAvailability = publication;
    const capturedProfile = selectedProfile;
    let capturedPublication: ReturnType<typeof captureStudioExportPublicationV1> = null;
    let publicationCaptureFailure: string | null = null;
    if (!capturedHasAudio) {
      try {
        capturedPublication = captureStudioExportPublicationV1(capturedAvailability);
      } catch (error) {
        publicationCaptureFailure =
          error instanceof Error ? error.message : "The MP4 publication identity could not be created.";
      }
    }
    const controller = new AbortController();
    activeExport.current = controller;
    pendingPublication.current = null;
    setPublicationRun({ kind: "idle" });
    setRun({ kind: "running", progress: null });
    try {
      const outcome = await runBrowserMp4ExportV1({
        ...(capturedAudioTrack
          ? {
              audioTiming: {
                fadeInSampleFrames: capturedAudioTrack.fadeInSampleFrames,
                fadeOutSampleFrames: capturedAudioTrack.fadeOutSampleFrames,
                timelineOffsetSampleFrames: capturedAudioTrack.timelineOffsetSampleFrames,
                trimEndSampleFrames: capturedAudioTrack.trimEndSampleFrames,
                trimStartSampleFrames: capturedAudioTrack.trimStartSampleFrames,
                volumePercent: capturedAudioTrack.volumePercent,
              },
              audioWav: capturedAudioTrack.wavBytes.slice(0),
            }
          : capturedTransientAudioFile
            ? { audioWav: await capturedTransientAudioFile.arrayBuffer() }
            : {}),
        assetPayloads: capturedSource.assetPayloads,
        fragmentMaterialRegistry: capturedSource.fragmentMaterialRegistry,
        onProgress: (progress) => {
          if (activeExport.current === controller) setRun({ kind: "running", progress });
        },
        profile: capturedProfile,
        scenePostEffectRegistry: capturedSource.scenePostEffectRegistry,
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
        if (capturedHasAudio) {
          downloadMp4Blob(fileName, outcome.mp4);
          setPublicationRun({ kind: "unavailable", reason: "WAV audio exports are local-only in this release." });
          setRun({ fileName, kind: "done" });
          return;
        }
        const completion = await completeBrowserMp4ExportV1({
          capturedAvailability,
          capturedPublication,
          deliverLocal: () => {
            downloadMp4Blob(fileName, outcome.mp4);
            setRun({ fileName, kind: "done" });
          },
          profile: capturedProfile,
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

  function selectTransientAudio(file: File | undefined) {
    if (!file) return;
    if (file.size === 0 || file.size > MAX_EXPORT_WAV_BYTES) {
      setTransientAudioFile(null);
      setTransientAudioError(`Choose a non-empty WAV file no larger than ${MAX_EXPORT_WAV_BYTES / (1024 * 1024)} MiB.`);
      return;
    }
    setTransientAudioFile(file);
    setTransientAudioError(null);
  }

  function removeTransientAudio() {
    setTransientAudioFile(null);
    setTransientAudioError(null);
    if (transientAudioInput.current) transientAudioInput.current.value = "";
  }

  function discardPendingPublicationForProfileChange() {
    pendingPublication.current = null;
    setPublicationRun({ kind: "idle" });
  }

  async function publishExport() {
    const artifact = pendingPublication.current;
    if (disabled || hasAudio || publicationRun.kind === "publishing" || !artifact) return;
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
    <section
      aria-labelledby="studio-video-export-title"
      data-studio-export-mp4-reason={run.kind === "refused" ? run.reason : undefined}
      data-studio-export-mp4-state={stateKind}
      data-studio-export-profile={`${exportResolution}@${exportFrameRate}`}
      data-studio-export-publication-state={publicationRun.kind}
    >
      <h3 className="text-balance text-sm font-medium text-zinc-200" id="studio-video-export-title">
        Video export
      </h3>
      <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
        Export the exact Scene shown by the canonical WebGPU preview as a local MP4.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-400" htmlFor="studio-export-resolution">
          Resolution
          <select
            className={fieldClassName}
            disabled={disabled || running || saving || publishing}
            id="studio-export-resolution"
            onChange={(event) => {
              const resolution = exportResolutionV1Schema.safeParse(event.currentTarget.value);
              if (resolution.success && resolution.data !== exportResolution) {
                discardPendingPublicationForProfileChange();
                setExportResolution(resolution.data);
              }
            }}
            value={exportResolution}
          >
            {EXPORT_RESOLUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-zinc-400" htmlFor="studio-export-frame-rate">
          Frame rate
          <select
            className={fieldClassName}
            disabled={disabled || running || saving || publishing}
            id="studio-export-frame-rate"
            onChange={(event) => {
              const frameRate = exportFrameRateV1Schema.safeParse(Number(event.currentTarget.value));
              if (frameRate.success && frameRate.data !== exportFrameRate) {
                discardPendingPublicationForProfileChange();
                setExportFrameRate(frameRate.data);
              }
            }}
            value={exportFrameRate}
          >
            {EXPORT_FRAME_RATE_OPTIONS.map((frameRate) => (
              <option key={frameRate} value={frameRate}>
                {frameRate} fps
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 border-y border-zinc-800 py-4">
        <h4 className="text-balance text-xs font-medium text-zinc-300">Audio</h4>
        <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500" id="studio-export-audio-description">
          {audioTrack === undefined
            ? "Optionally attach one 48 kHz PCM WAV to this imported Scene export."
            : audioTrack
              ? `The project track “${audioTrack.fileName}” will be attached to this local export.`
              : "No project audio is attached. Import a WAV or MP3 from Assets to include it."}
        </p>
        {audioTrack === undefined ? (
          <>
            <input
              accept=".wav,audio/wav,audio/x-wav"
              aria-describedby="studio-export-audio-description"
              aria-label="WAV audio file"
              className="sr-only"
              disabled={disabled || running || saving || publishing}
              onChange={(event) => selectTransientAudio(event.currentTarget.files?.[0])}
              ref={transientAudioInput}
              type="file"
            />
            <div className="mt-3">
              {transientAudioFile ? (
                <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-400">
                  <span className="min-w-0 flex-1 truncate" title={transientAudioFile.name}>
                    {transientAudioFile.name}
                  </span>
                  <button
                    aria-label={`Remove WAV ${transientAudioFile.name}`}
                    className={secondaryButtonClassName}
                    disabled={running || saving}
                    onClick={removeTransientAudio}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <button
                  className={secondaryButtonClassName}
                  disabled={disabled || running || saving || publishing}
                  onClick={() => transientAudioInput.current?.click()}
                  type="button"
                >
                  Choose WAV
                </button>
              )}
            </div>
            {transientAudioError ? (
              <p className="mt-2 text-pretty text-xs leading-5 text-amber-300" role="alert">
                {transientAudioError}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className={primaryButtonClassName}
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
          <button className={secondaryButtonClassName} onClick={() => activeExport.current?.abort()} type="button">
            Cancel
          </button>
        ) : null}
      </div>
      {exportUnavailableReason ? (
        <p className="mt-2 text-pretty text-xs leading-5 text-amber-300">{exportUnavailableReason}</p>
      ) : null}
      {running || saving || run.kind === "cancelled" || run.kind === "done" ? (
        <p aria-live="polite" className="mt-2 text-pretty text-xs leading-5 text-zinc-400" role="status">
          {running
            ? `Encoded ${studioExportProgressPercentV1(run.progress)}% of frames.`
            : saving
              ? "Saving the completed MP4."
              : run.kind === "cancelled"
                ? "Export cancelled."
                : run.kind === "done"
                  ? `Saved ${run.fileName}.`
                  : null}
        </p>
      ) : null}
      {run.kind === "refused" || run.kind === "failed" ? (
        <p
          className={cn(
            "mt-2 text-pretty text-xs leading-5",
            run.kind === "refused" ? "text-amber-300" : "text-red-300",
          )}
          role="alert"
        >
          {run.kind === "refused" ? `Export refused · ${run.reason}: ${run.message}` : `Export failed: ${run.message}`}
        </p>
      ) : null}

      <section aria-labelledby="studio-mp4-publishing-title" className="mt-5 border-t border-zinc-800 pt-4">
        <h4 className="text-balance text-xs font-medium text-zinc-300" id="studio-mp4-publishing-title">
          MP4 publishing
        </h4>
        <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
          Publish the most recent browser export after its local download succeeds.
        </p>
        <button
          className={cn(secondaryButtonClassName, "mt-3")}
          disabled={publishBlocked}
          onClick={() => void publishExport()}
          type="button"
        >
          {publishing
            ? "Publishing…"
            : publicationRun.kind === "published"
              ? "Published"
              : publicationRun.kind === "failed"
                ? "Retry publish"
                : "Publish MP4"}
        </button>
        {publishUnavailableReason ? (
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">{publishUnavailableReason}</p>
        ) : null}
        {publicationRun.kind === "failed" ? (
          <p className="mt-2 text-pretty text-xs leading-5 text-red-300" role="alert">
            Publish failed: {publicationRun.message}
          </p>
        ) : null}
      </section>
    </section>
  );
}
