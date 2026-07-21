import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/cn";
import type { CreateMotionRenderRequest, ManimWorkspaceView, RenderSessionView } from "./contracts";
import {
  loadManimRender,
  loadManimWorkspace,
  runManimRenderAction,
  startManimRender,
} from "./client";

export type RenderMotionCandidate = Readonly<{
  controlOffsetPixels: Readonly<{ x: number; y: number }>;
  deltaPixels: Readonly<{ x: number; y: number }>;
  interval: Readonly<{ end: number; start: number }>;
  targets: readonly Readonly<{ entityId: string; sourceVariable: string }>[];
  viewport: Readonly<{ height: number; width: number }>;
}>;

type RenderPipelinePanelProps = Readonly<{
  candidate: RenderMotionCandidate | null;
  candidateUnavailableReason: string;
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

export function RenderPipelinePanel({ candidate, candidateUnavailableReason }: RenderPipelinePanelProps) {
  const [workspace, setWorkspace] = useState<ManimWorkspaceView | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sourcePath, setSourcePath] = useState("");
  const [sceneName, setSceneName] = useState("");
  const [session, setSession] = useState<RenderSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commitDialog = useRef<HTMLDialogElement | null>(null);

  async function refreshWorkspace(signal?: AbortSignal) {
    setWorkspaceStatus("loading");
    setError(null);
    try {
      const nextWorkspace = await loadManimWorkspace(signal);
      setWorkspace(nextWorkspace);
      setWorkspaceStatus("ready");
      const preferredSource = nextWorkspace.sources.find((source) => source.path === "examples/relativity.py")
        ?? nextWorkspace.sources[0];
      const nextSource = nextWorkspace.sources.find((source) => source.path === sourcePath) ?? preferredSource;
      setSourcePath(nextSource?.path ?? "");
      setSceneName(nextSource?.scenes.some((scene) => scene.name === sceneName)
        ? sceneName
        : nextSource?.scenes[0]?.name ?? "");
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === "AbortError") return;
      setWorkspaceStatus("error");
      setError(nextError instanceof Error ? nextError.message : "Could not inspect the Manim workspace.");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshWorkspace(controller.signal);
    return () => controller.abort();
  }, []);

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

  const selectedSource = workspace?.sources.find((source) => source.path === sourcePath) ?? null;
  const selectedScenes = selectedSource?.scenes ?? [];
  const selectedScene = selectedScenes.find((scene) => scene.name === sceneName) ?? null;
  const configurationLocked = session?.canCancel === true || session?.canCommit === true || session?.canUndo === true;
  const candidateHasAnchor = candidate !== null
    && selectedScene?.anchors.some((anchor) => Math.abs(anchor - candidate.interval.start) < 0.0005) === true;
  const candidateHasStraightPath = candidate !== null
    && Math.abs(candidate.controlOffsetPixels.x) < 0.001
    && Math.abs(candidate.controlOffsetPixels.y) < 0.001;
  const previewBlocker = useMemo(() => {
    if (workspaceStatus !== "ready") return "Inspecting the Manim workspace…";
    if (!workspace?.commandAvailable) return `Manim command ${JSON.stringify(workspace?.command ?? [])} is unavailable.`;
    if (!selectedSource || !sceneName) return "Choose a Python source and Scene.";
    if (!candidate) return candidateUnavailableReason;
    if (!candidateHasStraightPath) return "Reset the bend handle; the first rendered lowering supports straight paths only.";
    if (!candidateHasAnchor) return `Add # poietra:anchor ${candidate.interval.start.toFixed(3)} at a safe source boundary.`;
    return null;
  }, [candidate, candidateHasAnchor, candidateHasStraightPath, candidateUnavailableReason, sceneName, selectedSource, workspace, workspaceStatus]);

  async function startPreview() {
    if (!candidate || !workspace || previewBlocker) return;
    setError(null);
    const request: CreateMotionRenderRequest = {
      operation: {
        ...candidate,
        kind: "CreateMotion",
        targets: candidate.targets.map((target) => ({ ...target })),
        transactionId: `render-${crypto.randomUUID()}`,
      },
      sceneName,
      sourcePath,
    };
    try {
      setSession(await startManimRender(request));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not start the Manim render.");
    }
  }

  async function runAction(action: "cancel" | "commit" | "discard" | "undo") {
    if (!session) return false;
    setError(null);
    try {
      setSession(await runManimRenderAction(session.id, action));
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
            Lower one straight CreateMotion into an isolated source copy, render it with Manim, then choose whether to commit.
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

      {workspaceStatus === "loading" ? (
        <div aria-label="Inspecting the Manim workspace" className="mt-3 space-y-2">
          <div className="h-8 border border-zinc-800 bg-zinc-900" />
          <div className="h-8 border border-zinc-800 bg-zinc-900" />
        </div>
      ) : workspace?.sources.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="min-w-0 text-zinc-500">
            Source
            <select
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
              disabled={configurationLocked}
              onChange={(event) => {
                const nextPath = event.currentTarget.value;
                const source = workspace.sources.find((candidateSource) => candidateSource.path === nextPath);
                setSourcePath(nextPath);
                setSceneName(source?.scenes[0]?.name ?? "");
                setSession(null);
                setError(null);
              }}
              value={sourcePath}
            >
              {workspace.sources.map((source) => <option key={source.path} value={source.path}>{source.path}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-zinc-500">
            Scene
            <select
              className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-zinc-200 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
              disabled={configurationLocked}
              onChange={(event) => {
                setSceneName(event.currentTarget.value);
                setSession(null);
                setError(null);
              }}
              value={sceneName}
            >
              {selectedScenes.map((scene) => <option key={scene.name} value={scene.name}>{scene.name}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div className="mt-3 border border-dashed border-zinc-700 p-3">
          <p className="text-pretty leading-5 text-zinc-500">No Manim Scene was found under the configured project root.</p>
          <button
            className="mt-2 border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
            onClick={() => void refreshWorkspace()}
            type="button"
          >
            Inspect again
          </button>
        </div>
      )}

      {workspace ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
          <dt className="text-zinc-600">Project</dt>
          <dd className="truncate font-mono text-zinc-400" title={workspace.projectRoot}>{workspace.projectRoot}</dd>
          <dt className="text-zinc-600">Runner</dt>
          <dd className={workspace.commandAvailable ? "font-mono text-zinc-400" : "font-mono text-amber-300"}>
            {workspace.command.join(" ")} · {workspace.commandAvailable ? "available" : "not found"}
          </dd>
          {selectedScene ? (
            <>
              <dt className="text-zinc-600">Anchors</dt>
              <dd className="tabular-nums text-zinc-400">
                {selectedScene.anchors.length > 0 ? selectedScene.anchors.map((anchor) => `${anchor.toFixed(3)}s`).join(", ") : "none"}
              </dd>
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
            Render preview
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
          <h3 className="text-balance text-sm font-medium" id="commit-render-title">Commit rendered motion?</h3>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400">
            This writes the validated patch to <span className="font-mono text-zinc-200">{session?.sourcePath}</span>. Studio will refuse if the file changed after rendering, and this server session can undo the exact committed source.
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
