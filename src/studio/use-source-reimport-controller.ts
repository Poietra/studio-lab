import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { ManimWorkspaceView } from "../render-pipeline/contracts";
import {
  type RenderSourceIdentity,
  type RenderSourceRefreshTarget,
  renderSourceRefreshMatches,
  renderSourceRefreshResolved,
} from "../render-pipeline/render-pipeline-policy";
import type { EditorSessionIdentity } from "./editor-session-store";

export type SourceReimportActiveSource = RenderSourceIdentity & Readonly<{ sceneId: string }>;

export type SourceReimportSelection = Readonly<{
  activeProjectId: string | null;
  activeSource: SourceReimportActiveSource | null;
}>;

export type SourceReimportTicket = Readonly<{
  generation: number;
  sceneId: string | null;
  target: RenderSourceRefreshTarget;
}>;

type SourceReimportControllerInput = SourceReimportSelection &
  Readonly<{
    clearSession: (identity: EditorSessionIdentity) => void;
    refreshWorkspace: () => Promise<ManimWorkspaceView | null>;
    resetPrograms: () => void;
  }>;

function sameActiveSource(left: SourceReimportActiveSource | null, right: SourceReimportActiveSource | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.projectId === right.projectId &&
      left.sceneId === right.sceneId &&
      left.sceneName === right.sceneName &&
      left.sourceHash === right.sourceHash &&
      left.sourcePath === right.sourcePath)
  );
}

function sameSelection(left: SourceReimportSelection, right: SourceReimportSelection) {
  return left.activeProjectId === right.activeProjectId && sameActiveSource(left.activeSource, right.activeSource);
}

function selectionSupportsTicket(selection: SourceReimportSelection, ticket: SourceReimportTicket) {
  if (selection.activeProjectId !== ticket.target.projectId) return false;
  const source = selection.activeSource;
  if (source === null) return ticket.sceneId === null;
  return (
    source.projectId === ticket.target.projectId &&
    source.sceneName === ticket.target.sceneName &&
    source.sourcePath === ticket.target.sourcePath &&
    (ticket.sceneId === null || source.sceneId === ticket.sceneId) &&
    (source.sourceHash === ticket.target.sourceHash || source.sourceHash === ticket.target.resultSourceHash)
  );
}

/**
 * Owns the monotonic token used by source re-import work. Selection changes
 * permanently invalidate the active ticket unless the change is the expected
 * old-source to post-mutation-source transition for that exact Scene.
 */
export class SourceReimportGenerationController {
  #selection: SourceReimportSelection;
  #generation = 0;
  #ticket: SourceReimportTicket | null = null;

  constructor(selection: SourceReimportSelection) {
    this.#selection = selection;
  }

  get activeSource() {
    return this.#selection.activeSource;
  }

  get activeProjectId() {
    return this.#selection.activeProjectId;
  }

  begin(target: RenderSourceRefreshTarget) {
    const ticket: SourceReimportTicket = {
      generation: this.#generation + 1,
      sceneId: this.activeSource?.sceneId ?? null,
      target,
    };
    if (!selectionSupportsTicket(this.#selection, ticket)) return null;
    this.#generation = ticket.generation;
    this.#ticket = ticket;
    return ticket;
  }

  cancel() {
    this.#generation += 1;
    this.#ticket = null;
  }

  complete(ticket: SourceReimportTicket) {
    if (!this.isCurrent(ticket)) return false;
    this.#ticket = null;
    return true;
  }

  isCurrent(ticket: SourceReimportTicket) {
    return (
      this.#ticket === ticket &&
      this.#generation === ticket.generation &&
      selectionSupportsTicket(this.#selection, ticket)
    );
  }

  retains(target: RenderSourceRefreshTarget) {
    return this.#ticket?.target === target && this.isCurrent(this.#ticket);
  }

  synchronizeSelection(selection: SourceReimportSelection) {
    if (sameSelection(this.#selection, selection)) return;
    this.#selection = selection;
    if (this.#ticket && !selectionSupportsTicket(selection, this.#ticket)) this.cancel();
  }
}

export function useSourceReimportController({
  activeProjectId,
  activeSource,
  clearSession,
  refreshWorkspace,
  resetPrograms,
}: SourceReimportControllerInput) {
  const [sourceMutationPendingProjectId, setSourceMutationPendingProjectId] = useState<string | null>(null);
  const [sourceReimportTarget, setSourceReimportTarget] = useState<RenderSourceRefreshTarget | null>(null);
  const generationController = useRef<SourceReimportGenerationController | null>(null);
  if (generationController.current === null) {
    generationController.current = new SourceReimportGenerationController({ activeProjectId, activeSource });
  }
  const generation = generationController.current;

  useLayoutEffect(() => {
    generation.synchronizeSelection({ activeProjectId, activeSource });
  }, [activeProjectId, activeSource, generation]);

  const setSourceMutationPending = useCallback(
    (projectId: string, pending: boolean) => {
      if (pending && generation.activeProjectId !== projectId) return;
      setSourceMutationPendingProjectId((current) => (pending ? projectId : current === projectId ? null : current));
    },
    [generation],
  );

  const reconcileRenderedSource = useCallback(
    async (target: RenderSourceRefreshTarget) => {
      const ticket = generation.begin(target);
      if (ticket === null) return;
      setSourceReimportTarget(target);
      const source = generation.activeSource;
      if (renderSourceRefreshMatches(target, source) && source) {
        clearSession({ projectId: source.projectId, sceneId: source.sceneId, sourceHash: source.sourceHash });
        resetPrograms();
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const refreshed = await refreshWorkspace();
        if (!generation.isCurrent(ticket)) return;
        if (refreshed && renderSourceRefreshResolved(target, refreshed)) {
          if (!generation.complete(ticket)) return;
          setSourceReimportTarget((current) => (current === target ? null : current));
          return;
        }
      }
      throw new Error("The reimported workspace did not contain the expected Python source revision.");
    },
    [clearSession, generation, refreshWorkspace, resetPrograms],
  );

  const reimportWorkspace = useCallback(async () => {
    try {
      if (sourceReimportTarget) await reconcileRenderedSource(sourceReimportTarget);
      else await refreshWorkspace();
    } catch {
      // The workspace hook and render panel retain the actionable error while
      // the source lifecycle blocker stays active.
    }
  }, [reconcileRenderedSource, refreshWorkspace, sourceReimportTarget]);

  useEffect(() => {
    if (sourceMutationPendingProjectId && sourceMutationPendingProjectId !== activeProjectId) {
      setSourceMutationPendingProjectId(null);
    }
    if (sourceReimportTarget && !generation.retains(sourceReimportTarget)) {
      setSourceReimportTarget(null);
    }
  }, [activeProjectId, activeSource, generation, sourceMutationPendingProjectId, sourceReimportTarget]);

  useLayoutEffect(
    () => () => {
      generation.cancel();
    },
    [generation],
  );

  return {
    reconcileRenderedSource,
    reimportWorkspace,
    setSourceMutationPending,
    sourceMutationPendingProjectId,
    sourceReimportTarget,
  } as const;
}
