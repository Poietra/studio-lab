import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { CanonicalEditProgram } from "../studio/operations";
import {
  renderProgramBatchId,
  type ManimWorkspaceView,
  type OriginalManimSourceExportRequest,
  type ProgramRenderRequest,
  type RenderSessionView,
} from "./contracts";
import {
  exportManimSource,
  exportOriginalManimSource,
  isMissingManimSession,
  loadManimRender,
  runManimRenderAction,
  startManimRender,
} from "./client";
import { savePythonSourceWithDesktop } from "../shell/desktop-bridge";

export type RenderProgramCandidate = Readonly<{
  anchors: readonly number[];
  destination: ProgramRenderRequest["destination"];
  program: CanonicalEditProgram;
  programs: readonly CanonicalEditProgram[];
  projectId: string;
  sceneName: string;
  sourceBindings: ProgramRenderRequest["sourceBindings"];
  sourceHash: string;
  sourcePath: string;
  viewport: ProgramRenderRequest["viewport"];
}>;

type RenderPipelinePanelProps = Readonly<{
  candidate: RenderProgramCandidate | null;
  candidateUnavailableReason: string;
  onSessionChange: (session: RenderSessionView | null, projectId?: string) => void;
  onSourceChanged?: () => void | Promise<void>;
  session: RenderSessionView | null;
  sourceExport: OriginalManimSourceExportRequest | null;
  workspace: ManimWorkspaceView | null;
}>;

function statusLabel(session: RenderSessionView) {
  return {
    cancelled: "Cancelled",
    committed: "Committed",
    discarded: "Discarded",
    failed: "Failed",
    preparing: "Preparing",
    ready: "Rendered",
    rendering: "Rendering",
    undone: "Undone",
  }[session.status];
}

function terminalStatus(status: RenderSessionView["status"]) {
  return ["cancelled", "committed", "discarded", "failed", "ready", "undone"].includes(status);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function RenderPipelinePanel({
  candidate,
  candidateUnavailableReason,
  onSessionChange,
  onSourceChanged,
  session,
  sourceExport,
  workspace,
}: RenderPipelinePanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "cancel" | "commit" | "discard" | "export" | "render" | "undo" | null
  >(null);
  const commitDialog = useRef<HTMLDialogElement | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      mutationRequest.current?.abort();
      mutationRequest.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!session || terminalStatus(session.status) || pendingAction) return;
    const controller = new AbortController();
    let timer = 0;
    let continuePolling = true;
    const poll = async () => {
      try {
        const nextSession = await loadManimRender(session.id, controller.signal);
        if (nextSession.projectId !== session.projectId) {
          throw new Error("The server returned a render session for a different project.");
        }
        onSessionChange(nextSession);
        setError(null);
      } catch (nextError) {
        if (isAbortError(nextError)) return;
        if (isMissingManimSession(nextError)) {
          continuePolling = false;
          onSessionChange(null, session.projectId);
          setError("The previous render session expired. You can start a new preview.");
        } else {
          setError(nextError instanceof Error ? nextError.message : "Could not refresh the render status.");
        }
      } finally {
        if (!controller.signal.aborted && continuePolling) timer = window.setTimeout(() => void poll(), 500);
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [onSessionChange, pendingAction, session?.id, session?.projectId, session?.status]);

  useEffect(() => {
    if (!session || !terminalStatus(session.status) || session.status === "discarded" || pendingAction) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const nextSession = await loadManimRender(session.id, controller.signal);
        if (nextSession.projectId !== session.projectId) {
          throw new Error("The server returned a render session for a different project.");
        }
        onSessionChange(nextSession);
      } catch (nextError) {
        if (!isAbortError(nextError)) {
          if (isMissingManimSession(nextError)) {
            onSessionChange(null, session.projectId);
            setError("The previous render session expired. You can start a new preview.");
          } else {
            setError(nextError instanceof Error ? nextError.message : "Could not restore the render session.");
          }
        }
      }
    })();
    return () => controller.abort();
  }, [onSessionChange, pendingAction, session?.id, session?.projectId, session?.status]);

  const missingAnchor =
    candidate?.programs.find(
      (program) => !candidate.anchors.some((anchor) => Math.abs(anchor - program.anchor.resolvedSeconds) < 0.0005),
    )?.anchor.resolvedSeconds ?? null;
  const unsupportedProgram = candidate?.programs.find((program) => program.loweringStatus !== "supported") ?? null;
  const sessionMatchesCandidate =
    session !== null &&
    candidate !== null &&
    session.projectId === candidate.projectId &&
    session.programBatchId === renderProgramBatchId(candidate.programs) &&
    session.sourcePath === candidate.sourcePath &&
    session.sceneName === candidate.sceneName;
  const candidateBlocker = useMemo(() => {
    if (!workspace) return "Inspecting the Manim workspace…";
    if (!candidate) return candidateUnavailableReason;
    if (candidate.projectId !== workspace.projectId)
      return "The draft belongs to a different project. Recreate it in the active project.";
    if (unsupportedProgram) {
      return `This Program is marked ${unsupportedProgram.loweringStatus}; rendered validation requires supported lowering.`;
    }
    if (missingAnchor !== null) {
      return `Add # poietra:anchor ${missingAnchor.toFixed(3)} at a safe source boundary.`;
    }
    return null;
  }, [candidate, candidateUnavailableReason, missingAnchor, unsupportedProgram, workspace]);
  const previewBlocker =
    candidateBlocker ?? (!workspace?.commandAvailable ? "The configured Manim command is unavailable." : null);
  const exportBlocker = candidate
    ? candidateBlocker
    : !workspace
      ? "Inspecting the Manim workspace…"
      : !sourceExport
        ? "Choose an imported Scene to export its Python source."
        : null;

  async function startPreview() {
    if (!candidate || previewBlocker || pendingAction) return;
    if (session && session.status !== "discarded") {
      setError("Discard, commit, or undo the current render session before starting another preview.");
      return;
    }
    setError(null);
    setPendingAction("render");
    const controller = new AbortController();
    mutationRequest.current = controller;
    try {
      onSessionChange(
        await startManimRender(
          {
            destination: candidate.destination,
            program: candidate.program,
            programs: candidate.programs,
            projectId: candidate.projectId,
            sceneName: candidate.sceneName,
            sourceBindings: candidate.sourceBindings,
            sourceHash: candidate.sourceHash,
            sourcePath: candidate.sourcePath,
            viewport: candidate.viewport,
          },
          controller.signal,
        ),
      );
    } catch (nextError) {
      if (isAbortError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : "Could not start the Manim render.");
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setPendingAction(null);
      }
    }
  }

  async function exportSource() {
    if (exportBlocker || pendingAction || (!candidate && !sourceExport)) return;
    setError(null);
    setPendingAction("export");
    const controller = new AbortController();
    mutationRequest.current = controller;
    try {
      const exported = candidate
        ? await exportManimSource(
            {
              destination: candidate.destination,
              program: candidate.program,
              programs: candidate.programs,
              projectId: candidate.projectId,
              sceneName: candidate.sceneName,
              sourceBindings: candidate.sourceBindings,
              sourceHash: candidate.sourceHash,
              sourcePath: candidate.sourcePath,
              viewport: candidate.viewport,
            },
            controller.signal,
          )
        : await exportOriginalManimSource(sourceExport!, controller.signal);
      const desktopSaved = await savePythonSourceWithDesktop(exported.fileName, exported.source);
      if (desktopSaved === null) {
        const url = URL.createObjectURL(new Blob([exported.source], { type: "text/x-python;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = exported.fileName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (nextError) {
      if (isAbortError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : "Could not export the Manim source.");
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setPendingAction(null);
      }
    }
  }

  async function runAction(action: "cancel" | "commit" | "discard" | "undo") {
    if (!session || pendingAction) return false;
    setError(null);
    setPendingAction(action);
    const controller = new AbortController();
    mutationRequest.current = controller;
    try {
      const nextSession = await runManimRenderAction(session.id, action, controller.signal);
      if (nextSession.projectId !== session.projectId) {
        throw new Error("The server returned a render action for a different project.");
      }
      onSessionChange(nextSession);
      if (action === "commit" || action === "undo") {
        try {
          await onSourceChanged?.();
        } catch (refreshError) {
          if (!controller.signal.aborted) {
            setError(
              refreshError instanceof Error
                ? `The source changed, but Studio could not reimport it: ${refreshError.message}`
                : "The source changed, but Studio could not reimport it.",
            );
          }
        }
      }
      return true;
    } catch (nextError) {
      if (isAbortError(nextError)) return false;
      if (isMissingManimSession(nextError)) {
        onSessionChange(null, session.projectId);
        setError("The previous render session expired. You can start a new preview.");
      } else {
        setError(nextError instanceof Error ? nextError.message : `Could not ${action} the render.`);
      }
      return false;
    } finally {
      if (mutationRequest.current === controller) {
        mutationRequest.current = null;
        setPendingAction(null);
      }
    }
  }

  return (
    <section className="mt-4 border-t border-zinc-800 pt-4 text-xs" data-render-pipeline>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-balance font-medium text-zinc-200">Rendered validation</h3>
          <p className="mt-1 text-pretty leading-5 text-zinc-500">
            Lower the complete Canonical EditProgram into an isolated source copy, render it with Manim, then commit the
            exact previewed patch.
          </p>
        </div>
        {session ? (
          <span
            className={cn(
              "shrink-0 border px-1.5 py-0.5 text-[10px]",
              session.status === "failed"
                ? "border-red-900 text-red-300"
                : session.status === "ready" || session.status === "committed"
                  ? "border-sky-800 text-sky-300"
                  : "border-zinc-700 text-zinc-400",
            )}
          >
            {statusLabel(session)}
          </span>
        ) : null}
      </div>

      {candidate ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
          <dt className="text-zinc-600">Source</dt>
          <dd className="truncate font-mono text-zinc-400" title={candidate.sourcePath}>
            {candidate.sourcePath}
          </dd>
          <dt className="text-zinc-600">Scene</dt>
          <dd className="truncate text-zinc-400">{candidate.sceneName}</dd>
          <dt className="text-zinc-600">Program</dt>
          <dd className="truncate font-mono text-zinc-400">{candidate.program.transactionId}</dd>
          <dt className="text-zinc-600">Anchor</dt>
          <dd className="tabular-nums text-zinc-400">{candidate.program.anchor.resolvedSeconds.toFixed(3)}s</dd>
          {candidate.destination ? (
            <>
              <dt className="text-zinc-600">Incoming</dt>
              <dd className="truncate text-zinc-400">{candidate.destination.sceneName}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {session && candidate && !sessionMatchesCandidate && session.status !== "discarded" ? (
        <p className="mt-3 border border-amber-900/70 p-2 text-pretty leading-5 text-amber-300">
          This render belongs to program <span className="font-mono">{session.programTransactionId}</span>. Resolve it
          before rendering the current draft.
        </p>
      ) : null}

      {session && !terminalStatus(session.status) ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 text-[10px] text-zinc-500">
            <span>{statusLabel(session)}</span>
            <span className="tabular-nums">{Math.round(session.progress * 100)}%</span>
          </div>
          <progress className="mt-1 h-1.5 w-full accent-sky-500" max={1} value={session.progress} />
        </div>
      ) : null}

      {session?.videoUrl ? (
        <video
          aria-label={`Rendered Manim preview of ${session.sceneName}`}
          className="mt-3 aspect-video w-full border border-zinc-700 bg-black"
          controls
          key={`${session.id}-${session.status}`}
          preload="metadata"
          src={`${session.videoUrl}?v=${encodeURIComponent(session.updatedAt)}`}
        />
      ) : null}

      {session ? (
        <details className="mt-3 border border-zinc-800 px-2 text-[10px]">
          <summary className="cursor-pointer py-2 text-zinc-400 hover:text-zinc-200">Rendered source and log</summary>
          <p className="mb-1 text-zinc-600">Inserted after line {session.patch.anchorLine}</p>
          <pre className="overflow-x-auto whitespace-pre border border-zinc-800 bg-zinc-950 p-2 leading-4 text-emerald-300/80">
            {session.patch.insertedCode}
          </pre>
          <pre className="my-2 max-h-32 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-zinc-950 p-2 leading-4 text-zinc-500">
            {session.logTail || "Waiting for Manim output…"}
          </pre>
        </details>
      ) : null}

      {error || session?.error ? (
        <p className="mt-3 border border-red-950 bg-red-950/30 p-2 text-pretty leading-5 text-red-300" role="alert">
          {error ?? session?.error}
        </p>
      ) : previewBlocker ? (
        <p className="mt-3 text-pretty leading-5 text-amber-300">{previewBlocker}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-600"
          disabled={exportBlocker !== null || pendingAction !== null}
          onClick={() => void exportSource()}
          type="button"
        >
          {pendingAction === "export" ? "Exporting…" : "Export .py"}
        </button>
        {session?.canCancel ? (
          <button
            className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
            disabled={pendingAction !== null}
            onClick={() => void runAction("cancel")}
            type="button"
          >
            Cancel render
          </button>
        ) : null}
        {session?.canDiscard ? (
          <button
            className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:text-zinc-600"
            disabled={pendingAction !== null}
            onClick={() => void runAction("discard")}
            type="button"
          >
            Discard preview
          </button>
        ) : null}
        {session?.canUndo ? (
          <button
            className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
            disabled={pendingAction !== null}
            onClick={() => void runAction("undo")}
            type="button"
          >
            Undo source
          </button>
        ) : null}
        {session?.canCommit ? (
          <button
            className="bg-sky-500 px-3 py-1 font-medium text-sky-950 hover:bg-sky-400"
            disabled={pendingAction !== null}
            onClick={() => commitDialog.current?.showModal()}
            type="button"
          >
            Commit to source
          </button>
        ) : !session || session.status === "discarded" ? (
          <button
            className="bg-sky-500 px-3 py-1 font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            disabled={previewBlocker !== null || pendingAction !== null}
            onClick={() => void startPreview()}
            type="button"
          >
            {pendingAction === "render" ? "Starting…" : "Render program"}
          </button>
        ) : null}
      </div>

      <dialog
        aria-labelledby="commit-render-title"
        className="m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
        ref={commitDialog}
        role="alertdialog"
      >
        <form className="p-4" method="dialog">
          <h3 className="text-balance text-sm font-medium" id="commit-render-title">
            Commit rendered program?
          </h3>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400">
            This writes only the source patch that produced the video above. Studio refuses the write if the source
            changed after rendering.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              value="cancel"
            >
              Cancel
            </button>
            <button
              className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400"
              disabled={pendingAction !== null}
              onClick={async (event) => {
                event.preventDefault();
                if (await runAction("commit")) commitDialog.current?.close();
              }}
              value="confirm"
            >
              Commit source
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
