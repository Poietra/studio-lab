import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { savePythonSourceWithDesktop } from "../shell/desktop-bridge";
import {
  abandonManimRender,
  cancelManimRenderSourceAction,
  exportManimSource,
  exportOriginalManimSource,
  isMissingManimSession,
  loadManimRender,
  runManimRenderAction,
  startManimRender,
} from "./client";
import {
  type ManimWorkspaceView,
  type OriginalManimSourceExportRequest,
  type RenderSessionView,
  renderProgramBatchId,
  renderRequestId,
} from "./contracts";
import {
  mutationMayBeAborted,
  mutationTargetIsCurrent,
  type RenderMutationTarget,
  type RenderPipelineMutationContext,
} from "./render-mutation-policy";
import {
  type RenderPipelineAction,
  type RenderProgramCandidate,
  type RenderSourceRefreshTarget,
  renderCandidateRequest,
  renderCandidateRequestKey,
  renderPipelineActionBlocker,
  renderSessionMatchesCandidate,
  renderSourceMutationOutcome,
  renderSourceRefreshTarget,
  resolveRenderPipelinePolicy,
} from "./render-pipeline-policy";

type RenderPipelinePanelProps = Readonly<{
  candidate: RenderProgramCandidate | null;
  candidateLifecycleBlocker: string | null;
  candidateUnavailableReason: string;
  onSessionChange: (session: RenderSessionView | null, projectId?: string) => void;
  onSourceChanged?: (target: RenderSourceRefreshTarget) => void | Promise<void>;
  onSourceMutationPendingChange?: (projectId: string, pending: boolean) => void;
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

type CommitDialogTarget = Readonly<{ candidateKey: string; sessionId: string }>;

async function cleanUpStaleRenderSession(initialSession: RenderSessionView) {
  try {
    await abandonManimRender(initialSession.id, initialSession.renderRequestId);
    return null;
  } catch (cleanupError) {
    if (isMissingManimSession(cleanupError)) return null;
    try {
      const residualSession = await loadManimRender(initialSession.id);
      return residualSession.projectId === initialSession.projectId ? residualSession : initialSession;
    } catch (loadError) {
      return isMissingManimSession(loadError) ? null : initialSession;
    }
  }
}

export function RenderPipelinePanel({
  candidate,
  candidateLifecycleBlocker,
  candidateUnavailableReason,
  onSessionChange,
  onSourceChanged,
  onSourceMutationPendingChange,
  session,
  sourceExport,
  workspace,
}: RenderPipelinePanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<RenderPipelineAction | null>(null);
  const activeMutationTarget = useRef<RenderMutationTarget | null>(null);
  const commitDialog = useRef<HTMLDialogElement | null>(null);
  const commitDialogTarget = useRef<CommitDialogTarget | null>(null);
  const mutationContext = useRef<RenderPipelineMutationContext | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);
  const sessionChangeCallback = useRef(onSessionChange);
  const sourceChangedCallback = useRef(onSourceChanged);
  const sourceMutationPendingCallback = useRef(onSourceMutationPendingChange);
  sessionChangeCallback.current = onSessionChange;
  sourceChangedCallback.current = onSourceChanged;
  sourceMutationPendingCallback.current = onSourceMutationPendingChange;

  useEffect(
    () => () => {
      const target = activeMutationTarget.current;
      if (target && mutationMayBeAborted(target)) mutationRequest.current?.abort();
      activeMutationTarget.current = null;
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
        if (mutationContext.current?.sessionId !== session.id) return;
        sessionChangeCallback.current(nextSession);
        setError(null);
      } catch (nextError) {
        if (isAbortError(nextError)) return;
        if (mutationContext.current?.sessionId !== session.id) return;
        if (isMissingManimSession(nextError)) {
          continuePolling = false;
          sessionChangeCallback.current(null, session.projectId);
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
  }, [pendingAction, session?.id, session?.projectId, session?.status]);

  useEffect(() => {
    if (
      !session ||
      !terminalStatus(session.status) ||
      session.status === "discarded" ||
      !session.actionInProgress ||
      pendingAction
    )
      return;
    const controller = new AbortController();
    let timer = 0;
    const restore = async () => {
      let keepPolling = session.actionInProgress;
      try {
        const nextSession = await loadManimRender(session.id, controller.signal);
        if (nextSession.projectId !== session.projectId) {
          throw new Error("The server returned a render session for a different project.");
        }
        if (mutationContext.current?.sessionId !== session.id) return;
        sessionChangeCallback.current(nextSession);
        keepPolling = nextSession.actionInProgress;
        if (!nextSession.actionInProgress) {
          const sourceOutcome = renderSourceMutationOutcome(session.status, nextSession.status);
          if (sourceOutcome) {
            try {
              await sourceChangedCallback.current?.(renderSourceRefreshTarget(nextSession, sourceOutcome));
            } catch (refreshError) {
              setError(
                refreshError instanceof Error
                  ? `The source changed, but Studio could not reimport it: ${refreshError.message}`
                  : "The source changed, but Studio could not reimport it.",
              );
            }
          }
          sourceMutationPendingCallback.current?.(session.projectId, false);
        }
      } catch (nextError) {
        if (!isAbortError(nextError)) {
          if (mutationContext.current?.sessionId !== session.id) return;
          if (isMissingManimSession(nextError)) {
            keepPolling = false;
            setError(
              "Studio could not recover the source-action outcome because the render session expired. Reload Studio to reimport the current Python source before editing.",
            );
          } else {
            setError(nextError instanceof Error ? nextError.message : "Could not restore the render session.");
          }
        }
      } finally {
        if (!controller.signal.aborted && keepPolling) timer = window.setTimeout(() => void restore(), 100);
      }
    };
    void restore();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [pendingAction, session?.actionInProgress, session?.id, session?.projectId, session?.status]);

  const missingAnchor =
    candidate?.programs.find(
      (program) => !candidate.anchors.some((anchor) => Math.abs(anchor - program.anchor.resolvedSeconds) < 0.0005),
    )?.anchor.resolvedSeconds ?? null;
  const unsupportedProgram = candidate?.programs.find((program) => program.loweringStatus !== "supported") ?? null;
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
  const originalExportBlocker = !workspace
    ? "Inspecting the Manim workspace…"
    : !sourceExport
      ? "Choose an imported Scene to export its Python source."
      : null;
  const policy = resolveRenderPipelinePolicy({
    candidate,
    candidateBlocker,
    candidateLifecycleBlocker,
    originalExportBlocker,
    renderCapability: workspace?.renderCapability ?? {
      kind: "unavailable",
      reason: "local-command-unavailable",
    },
    session,
  });
  const { commitBlocker, exportBlocker, previewBlocker, sessionMatchesCandidate } = policy;
  const videoUrl = session?.videoUrl ?? null;
  const candidateKey = candidate ? renderCandidateRequestKey(candidate) : null;
  const sourceExportKey = sourceExport ? JSON.stringify(sourceExport) : null;
  const currentMutationContext: RenderPipelineMutationContext = {
    candidateKey,
    policy,
    sessionCanCommit: session?.canCommit ?? false,
    sessionId: session?.id ?? null,
    sourceExportKey,
  };

  useLayoutEffect(() => {
    mutationContext.current = currentMutationContext;
    const target = activeMutationTarget.current;
    if (target && mutationMayBeAborted(target) && !mutationTargetIsCurrent(target, currentMutationContext)) {
      mutationRequest.current?.abort();
    }
    const dialogTarget = commitDialogTarget.current;
    if (
      dialogTarget &&
      (commitBlocker ||
        candidateKey !== dialogTarget.candidateKey ||
        session?.id !== dialogTarget.sessionId ||
        session?.canCommit !== true)
    ) {
      commitDialogTarget.current = null;
      if (commitDialog.current?.open) commitDialog.current.close();
    }
  }, [candidateKey, commitBlocker, exportBlocker, previewBlocker, session?.canCommit, session?.id, sourceExportKey]);

  function mutationIsCurrent(controller: AbortController, target: RenderMutationTarget) {
    const context = mutationContext.current;
    return (
      !controller.signal.aborted &&
      mutationRequest.current === controller &&
      activeMutationTarget.current === target &&
      context !== null &&
      mutationTargetIsCurrent(target, context)
    );
  }

  async function startPreview() {
    if (!candidate || !candidateKey || previewBlocker || mutationRequest.current) return;
    if (session && session.status !== "discarded") {
      setError("Discard, commit, or undo the current render session before starting another preview.");
      return;
    }
    const targetCandidate = candidate;
    const target: RenderMutationTarget = { action: "render", candidateKey };
    setError(null);
    setPendingAction("render");
    const controller = new AbortController();
    activeMutationTarget.current = target;
    mutationRequest.current = controller;
    try {
      const started = await startManimRender(
        {
          destination: targetCandidate.destination,
          program: targetCandidate.program,
          programs: targetCandidate.programs,
          projectId: targetCandidate.projectId,
          sceneName: targetCandidate.sceneName,
          sourceBindings: targetCandidate.sourceBindings,
          sourceHash: targetCandidate.sourceHash,
          sourcePath: targetCandidate.sourcePath,
          viewport: targetCandidate.viewport,
        },
        controller.signal,
      );
      if (!renderSessionMatchesCandidate(started, targetCandidate)) {
        const residualSession = await cleanUpStaleRenderSession(started);
        if (residualSession) {
          onSessionChange(residualSession);
          setError("Studio retained the stale render because automatic cleanup did not complete. Discard it manually.");
        }
        throw new Error("The server returned a render session for a different Studio candidate.");
      }
      if (!mutationIsCurrent(controller, target)) {
        const residualSession = await cleanUpStaleRenderSession(started);
        if (residualSession) {
          onSessionChange(residualSession);
          setError("Studio retained the stale render because automatic cleanup did not complete. Discard it manually.");
        }
        return;
      }
      onSessionChange(started);
    } catch (nextError) {
      if (isAbortError(nextError)) return;
      if (!mutationIsCurrent(controller, target)) return;
      setError(nextError instanceof Error ? nextError.message : "Could not start the Manim render.");
    } finally {
      if (mutationRequest.current === controller) {
        activeMutationTarget.current = null;
        mutationRequest.current = null;
        setPendingAction(null);
      }
    }
  }

  async function exportSource() {
    if (exportBlocker || mutationRequest.current || (!candidate && !sourceExport)) return;
    const targetCandidate = candidate;
    const targetSourceExport = sourceExport;
    const target: RenderMutationTarget = targetCandidate
      ? { action: "export-candidate", candidateKey: candidateKey! }
      : { action: "export-source", sourceExportKey: sourceExportKey! };
    setError(null);
    setPendingAction("export");
    const controller = new AbortController();
    activeMutationTarget.current = target;
    mutationRequest.current = controller;
    try {
      const exported = targetCandidate
        ? await exportManimSource(
            {
              destination: targetCandidate.destination,
              program: targetCandidate.program,
              programs: targetCandidate.programs,
              projectId: targetCandidate.projectId,
              sceneName: targetCandidate.sceneName,
              sourceBindings: targetCandidate.sourceBindings,
              sourceHash: targetCandidate.sourceHash,
              sourcePath: targetCandidate.sourcePath,
              viewport: targetCandidate.viewport,
            },
            controller.signal,
          )
        : await exportOriginalManimSource(targetSourceExport!, controller.signal);
      if (!mutationIsCurrent(controller, target)) return;
      const desktopSaved = await savePythonSourceWithDesktop(exported.fileName, exported.source);
      if (desktopSaved === null) {
        if (!mutationIsCurrent(controller, target)) return;
        const url = URL.createObjectURL(new Blob([exported.source], { type: "text/x-python;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = exported.fileName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (nextError) {
      if (isAbortError(nextError)) return;
      if (!mutationIsCurrent(controller, target)) return;
      setError(nextError instanceof Error ? nextError.message : "Could not export the Manim source.");
    } finally {
      if (mutationRequest.current === controller) {
        activeMutationTarget.current = null;
        mutationRequest.current = null;
        setPendingAction(null);
      }
    }
  }

  async function runAction(
    action: "cancel" | "commit" | "discard" | "undo",
    expectedCommitTarget?: CommitDialogTarget,
  ) {
    if (!session || mutationRequest.current) return false;
    const targetSession = session;
    const targetCandidate = candidate;
    const latestContext = mutationContext.current;
    if (
      action === "commit" &&
      (commitBlocker ||
        !targetCandidate ||
        !candidateKey ||
        !targetSession.canCommit ||
        !expectedCommitTarget ||
        latestContext?.candidateKey !== expectedCommitTarget.candidateKey ||
        !latestContext.sessionCanCommit ||
        latestContext.sessionId !== expectedCommitTarget.sessionId ||
        latestContext.policy.commitBlocker)
    ) {
      setError(
        commitBlocker ??
          latestContext?.policy.commitBlocker ??
          "The rendered preview no longer matches the one you chose to Commit.",
      );
      commitDialogTarget.current = null;
      commitDialog.current?.close();
      return false;
    }
    const target: RenderMutationTarget =
      action === "commit"
        ? { action, candidateKey: candidateKey!, sessionId: targetSession.id }
        : { action, sessionId: targetSession.id };
    const sourceActionId = action === "commit" || action === "undo" ? crypto.randomUUID() : null;
    let sourceMutationOutcomeUncertain = false;
    const retainUncertainSourceMutation = () => {
      if (!sourceActionId || (action !== "commit" && action !== "undo")) return;
      sourceMutationOutcomeUncertain = true;
      onSessionChange({
        ...targetSession,
        actionInProgress: true,
        canCancel: false,
        canCommit: false,
        canDiscard: false,
        canUndo: false,
        sourceAction: { id: sourceActionId, kind: action, outcome: null, state: "running" },
      });
    };
    setError(null);
    setPendingAction(action);
    if (sourceActionId) onSourceMutationPendingChange?.(targetSession.projectId, true);
    const controller = new AbortController();
    activeMutationTarget.current = target;
    mutationRequest.current = controller;
    try {
      const nextSession = await runManimRenderAction(
        targetSession.id,
        action,
        controller.signal,
        action === "commit" && targetCandidate
          ? {
              actionId: sourceActionId!,
              programBatchId: renderProgramBatchId(targetCandidate.programs),
              projectId: targetCandidate.projectId,
              renderRequestId: renderRequestId(renderCandidateRequest(targetCandidate)),
              sceneName: targetCandidate.sceneName,
              sourceHash: targetCandidate.sourceHash,
              sourcePath: targetCandidate.sourcePath,
            }
          : action === "undo"
            ? { actionId: sourceActionId! }
            : undefined,
      );
      if (nextSession.projectId !== targetSession.projectId) {
        throw new Error("The server returned a render action for a different project.");
      }
      if (action === "commit" || action === "undo") {
        const expectedOutcome = action === "commit" ? "committed" : "undone";
        const sourceAction = nextSession.sourceAction;
        if (
          !sourceAction ||
          sourceAction.id !== sourceActionId ||
          sourceAction.kind !== action ||
          sourceAction.state !== "succeeded" ||
          sourceAction.outcome !== expectedOutcome ||
          nextSession.status !== expectedOutcome
        ) {
          throw new Error(`The server did not confirm the exact ${action === "commit" ? "Commit" : "Undo"} action.`);
        }
      }
      if (action === "commit" && targetCandidate && !renderSessionMatchesCandidate(nextSession, targetCandidate)) {
        throw new Error("The committed render no longer matches the active Studio candidate.");
      }
      if (action === "discard" && nextSession.status === "discarded") {
        onSessionChange(null, targetSession.projectId);
      } else {
        onSessionChange(nextSession);
      }
      if (action === "commit" || action === "undo") {
        try {
          await onSourceChanged?.(
            renderSourceRefreshTarget(targetSession, action === "commit" ? "committed" : "undone"),
          );
        } catch (refreshError) {
          setError(
            refreshError instanceof Error
              ? `The source changed, but Studio could not reimport it: ${refreshError.message}`
              : "The source changed, but Studio could not reimport it.",
          );
        }
      }
      return true;
    } catch (nextError) {
      if ((action === "commit" || action === "undo") && sourceActionId) {
        try {
          const cancellation = await cancelManimRenderSourceAction(targetSession.id, sourceActionId, action);
          if (
            cancellation.action.id !== sourceActionId ||
            cancellation.action.kind !== action ||
            cancellation.session.projectId !== targetSession.projectId
          ) {
            throw new Error("The server returned a source-action cancellation for a different render target.");
          }
          onSessionChange(cancellation.session);
          const sourceOutcome = renderSourceMutationOutcome(targetSession.status, cancellation.session.status);
          if (sourceOutcome) {
            try {
              await onSourceChanged?.(renderSourceRefreshTarget(targetSession, sourceOutcome));
            } catch (refreshError) {
              setError(
                refreshError instanceof Error
                  ? `The source changed, but Studio could not reimport it: ${refreshError.message}`
                  : "The source changed, but Studio could not reimport it.",
              );
            }
          } else if (cancellation.action.state === "failed") {
            setError(`The ${action === "commit" ? "Commit" : "Undo"} action failed before cancellation completed.`);
          }
        } catch (cancellationError) {
          retainUncertainSourceMutation();
          setError(
            cancellationError instanceof Error
              ? `Studio could not confirm whether ${action === "commit" ? "Commit" : "Undo"} changed the source: ${cancellationError.message}`
              : `Studio could not confirm whether ${action === "commit" ? "Commit" : "Undo"} changed the source. Reload Studio to reimport the current Python source before editing.`,
          );
        }
        return false;
      }
      if (isAbortError(nextError)) return false;
      if (!mutationIsCurrent(controller, target)) {
        if (sourceActionId) retainUncertainSourceMutation();
        return false;
      }
      if (isMissingManimSession(nextError)) {
        onSessionChange(null, targetSession.projectId);
        setError("The previous render session expired. You can start a new preview.");
      } else {
        setError(nextError instanceof Error ? nextError.message : `Could not ${action} the render.`);
      }
      return false;
    } finally {
      if (mutationRequest.current === controller) {
        activeMutationTarget.current = null;
        mutationRequest.current = null;
        setPendingAction(null);
      }
      if (sourceActionId && !sourceMutationOutcomeUncertain) {
        onSourceMutationPendingChange?.(targetSession.projectId, false);
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

      {session && videoUrl ? (
        <div className="mt-3">
          <video
            aria-label={`Rendered Manim preview of ${session.sceneName}`}
            className="aspect-video w-full border border-zinc-700 bg-black"
            controls
            key={`${session.id}-${session.status}`}
            preload="metadata"
            src={`${videoUrl}?v=${encodeURIComponent(session.updatedAt)}`}
          />
          <div className="mt-2 flex justify-end">
            <a
              className="border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
              download={`${session.sceneName}.mp4`}
              href={videoUrl}
            >
              Download MP4
            </a>
          </div>
        </div>
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
      ) : (session?.canCommit ? commitBlocker : previewBlocker) ? (
        <p className="mt-3 text-pretty leading-5 text-amber-300">
          {session?.canCommit ? commitBlocker : previewBlocker}
        </p>
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
            className="bg-sky-500 px-3 py-1 font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            disabled={commitBlocker !== null || pendingAction !== null}
            onClick={() => {
              const context = mutationContext.current;
              const latestBlocker = context ? renderPipelineActionBlocker("commit", context.policy) : commitBlocker;
              if (latestBlocker || !context?.candidateKey || !context.sessionId) {
                setError(latestBlocker ?? "The rendered preview is no longer available to Commit.");
                return;
              }
              commitDialogTarget.current = { candidateKey: context.candidateKey, sessionId: context.sessionId };
              commitDialog.current?.showModal();
            }}
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
        onClose={() => {
          commitDialogTarget.current = null;
        }}
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
              className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              disabled={commitBlocker !== null || pendingAction !== null}
              onClick={async (event) => {
                event.preventDefault();
                const target = commitDialogTarget.current;
                if (target && (await runAction("commit", target))) commitDialog.current?.close();
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
