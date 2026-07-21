import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { CanonicalEditProgram } from "../studio/operations";
import type { ManimWorkspaceView, ProgramRenderRequest, RenderSessionView } from "./contracts";
import { loadManimRender, runManimRenderAction, startManimRender } from "./client";

export type RenderProgramCandidate = Readonly<{
  anchors: readonly number[];
  destination: ProgramRenderRequest["destination"];
  program: CanonicalEditProgram;
  sceneName: string;
  sourceBindings: ProgramRenderRequest["sourceBindings"];
  sourcePath: string;
  viewport: ProgramRenderRequest["viewport"];
}>;

type RenderPipelinePanelProps = Readonly<{
  candidate: RenderProgramCandidate | null;
  candidateUnavailableReason: string;
  onCommitted?: () => void | Promise<void>;
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

export function RenderPipelinePanel({
  candidate,
  candidateUnavailableReason,
  onCommitted,
  workspace,
}: RenderPipelinePanelProps) {
  const [session, setSession] = useState<RenderSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commitDialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    setSession(null);
    setError(null);
  }, [candidate?.program.transactionId, candidate?.sourcePath, candidate?.sceneName]);

  useEffect(() => {
    if (!session || terminalStatus(session.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setSession(await loadManimRender(session.id, controller.signal));
      } catch (nextError) {
        if (nextError instanceof DOMException && nextError.name === "AbortError") return;
        setError(nextError instanceof Error ? nextError.message : "Could not refresh the render status.");
      }
    }, 500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [session]);

  const candidateHasAnchor = candidate !== null && candidate.anchors.some((anchor) => (
    Math.abs(anchor - candidate.program.anchor.resolvedSeconds) < 0.0005
  ));
  const previewBlocker = useMemo(() => {
    if (!workspace) return "Inspecting the Manim workspace…";
    if (!workspace.commandAvailable) return `Manim command ${JSON.stringify(workspace.command)} is unavailable.`;
    if (!candidate) return candidateUnavailableReason;
    if (!candidateHasAnchor) {
      return `Add # poietra:anchor ${candidate.program.anchor.resolvedSeconds.toFixed(3)} at a safe source boundary.`;
    }
    return null;
  }, [candidate, candidateHasAnchor, candidateUnavailableReason, workspace]);

  async function startPreview() {
    if (!candidate || previewBlocker) return;
    setError(null);
    try {
      setSession(await startManimRender({
        destination: candidate.destination,
        program: candidate.program,
        sceneName: candidate.sceneName,
        sourceBindings: candidate.sourceBindings,
        sourcePath: candidate.sourcePath,
        viewport: candidate.viewport,
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not start the Manim render.");
    }
  }

  async function runAction(action: "cancel" | "commit" | "discard" | "undo") {
    if (!session) return false;
    setError(null);
    try {
      const nextSession = await runManimRenderAction(session.id, action);
      setSession(nextSession);
      if (action === "commit") await onCommitted?.();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `Could not ${action} the render.`);
      return false;
    }
  }

  return (
    <section className="mt-4 border-t border-zinc-800 pt-4 text-xs" data-render-pipeline>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-balance font-medium text-zinc-200">Rendered validation</h3>
          <p className="mt-1 text-pretty leading-5 text-zinc-500">
            Lower the complete Canonical EditProgram into an isolated source copy, render it with Manim, then commit the exact previewed patch.
          </p>
        </div>
        {session ? (
          <span className={cn(
            "shrink-0 border px-1.5 py-0.5 text-[10px]",
            session.status === "failed" ? "border-red-900 text-red-300"
              : session.status === "ready" || session.status === "committed" ? "border-sky-800 text-sky-300"
                : "border-zinc-700 text-zinc-400",
          )}>
            {statusLabel(session)}
          </span>
        ) : null}
      </div>

      {candidate ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
          <dt className="text-zinc-600">Source</dt>
          <dd className="truncate font-mono text-zinc-400" title={candidate.sourcePath}>{candidate.sourcePath}</dd>
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
          <pre className="overflow-x-auto whitespace-pre border border-zinc-800 bg-zinc-950 p-2 leading-4 text-emerald-300/80">{session.patch.insertedCode}</pre>
          <pre className="my-2 max-h-32 overflow-auto whitespace-pre-wrap border border-zinc-800 bg-zinc-950 p-2 leading-4 text-zinc-500">{session.logTail || "Waiting for Manim output…"}</pre>
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
        {session?.canCancel ? (
          <button className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800" onClick={() => void runAction("cancel")} type="button">
            Cancel render
          </button>
        ) : null}
        {session?.canDiscard ? (
          <button className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => void runAction("discard")} type="button">
            Discard preview
          </button>
        ) : null}
        {session?.canUndo ? (
          <button className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800" onClick={() => void runAction("undo")} type="button">
            Undo source
          </button>
        ) : null}
        {session?.canCommit ? (
          <button
            className="bg-sky-500 px-3 py-1 font-medium text-sky-950 hover:bg-sky-400"
            onClick={() => commitDialog.current?.showModal()}
            type="button"
          >
            Commit to source
          </button>
        ) : session?.status !== "committed" ? (
          <button
            className="bg-sky-500 px-3 py-1 font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            disabled={previewBlocker !== null || session?.canCancel === true}
            onClick={() => void startPreview()}
            type="button"
          >
            Render program
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
          <h3 className="text-balance text-sm font-medium" id="commit-render-title">Commit rendered program?</h3>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400">
            This writes only the source patch that produced the video above. Studio refuses the write if the source changed after rendering.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" value="cancel">Cancel</button>
            <button
              className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400"
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
