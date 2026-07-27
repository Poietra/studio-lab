import type { RenderCommitRequest, RenderSessionStatus, RenderSessionView } from "../src/render-pipeline/contracts";

export type RenderSessionStatusPolicy = Readonly<{
  abandonable: boolean;
  active: boolean;
  cancelable: boolean;
  committable: boolean;
  discardable: boolean;
  stopped: boolean;
  undoable: boolean;
}>;

export type RenderSessionCapabilities = Readonly<
  Pick<RenderSessionView, "canCancel" | "canCommit" | "canDiscard" | "canUndo">
>;

export type RenderedPreviewIdentity = Readonly<
  Pick<
    RenderCommitRequest,
    "programBatchId" | "projectId" | "renderRequestId" | "sceneName" | "sourceHash" | "sourcePath"
  >
>;

const STATUS_POLICIES = {
  cancelled: {
    abandonable: true,
    active: false,
    cancelable: false,
    committable: false,
    discardable: true,
    stopped: true,
    undoable: false,
  },
  committed: {
    abandonable: false,
    active: false,
    cancelable: false,
    committable: false,
    discardable: false,
    stopped: false,
    undoable: true,
  },
  discarded: {
    abandonable: false,
    active: false,
    cancelable: false,
    committable: false,
    discardable: false,
    stopped: true,
    undoable: false,
  },
  failed: {
    abandonable: true,
    active: false,
    cancelable: false,
    committable: false,
    discardable: true,
    stopped: false,
    undoable: false,
  },
  preparing: {
    abandonable: true,
    active: true,
    cancelable: true,
    committable: false,
    discardable: false,
    stopped: false,
    undoable: false,
  },
  ready: {
    abandonable: true,
    active: false,
    cancelable: false,
    committable: true,
    discardable: true,
    stopped: false,
    undoable: false,
  },
  rendering: {
    abandonable: true,
    active: true,
    cancelable: true,
    committable: false,
    discardable: false,
    stopped: false,
    undoable: false,
  },
  undone: {
    abandonable: false,
    active: false,
    cancelable: false,
    committable: false,
    discardable: true,
    stopped: false,
    undoable: false,
  },
} as const satisfies Record<RenderSessionStatus, RenderSessionStatusPolicy>;

export function renderSessionStatusPolicy(status: RenderSessionStatus): RenderSessionStatusPolicy {
  return STATUS_POLICIES[status];
}

// The Manager owns the action lock; policy only decides which status would
// permit each action after that lock is available.
export function renderSessionCapabilities(
  status: RenderSessionStatus,
  actionInProgress: boolean,
): RenderSessionCapabilities {
  const policy = renderSessionStatusPolicy(status);
  return {
    canCancel: !actionInProgress && policy.cancelable,
    canCommit: !actionInProgress && policy.committable,
    canDiscard: !actionInProgress && policy.discardable,
    canUndo: !actionInProgress && policy.undoable,
  };
}

function renderCommitCorrelation(expected: RenderedPreviewIdentity) {
  return [
    expected.programBatchId,
    expected.projectId,
    expected.renderRequestId,
    expected.sceneName,
    expected.sourceHash,
    expected.sourcePath,
  ] as const;
}

export function renderCommitCorrelationKey(expected: RenderedPreviewIdentity) {
  return JSON.stringify(renderCommitCorrelation(expected));
}

// Commit is consent to publish one exact rendered candidate. actionId is
// deliberately excluded because mutation replay is owned by the Manager ledger.
export function renderCommitMatchesPreview(expected: RenderCommitRequest, preview: RenderedPreviewIdentity) {
  const expectedCorrelation = renderCommitCorrelation(expected);
  const previewCorrelation = renderCommitCorrelation(preview);
  return expectedCorrelation.every((value, index) => value === previewCorrelation[index]);
}
