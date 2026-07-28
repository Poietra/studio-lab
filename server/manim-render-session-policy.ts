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

type RenderSessionTransitionDefinition = Readonly<{
  sources: readonly RenderSessionStatus[];
  target: RenderSessionStatus | readonly RenderSessionStatus[] | "same";
}>;

const ACTIVE_SESSION_STATUSES = ["preparing", "rendering"] as const;
const RENDER_SESSION_TRANSITIONS = {
  abandon: {
    sources: ["cancelled", "failed", "preparing", "ready", "rendering"],
    target: "discarded",
  },
  cancel: { sources: ACTIVE_SESSION_STATUSES, target: "cancelled" },
  "claim-lease": { sources: ACTIVE_SESSION_STATUSES, target: "rendering" },
  commit: { sources: ["ready"], target: "committed" },
  "complete-lease": { sources: ACTIVE_SESSION_STATUSES, target: ["cancelled", "failed", "ready"] },
  discard: { sources: ["cancelled", "failed", "ready", "undone"], target: "discarded" },
  expire: { sources: ACTIVE_SESSION_STATUSES, target: "failed" },
  "renew-lease": { sources: ACTIVE_SESSION_STATUSES, target: "same" },
  undo: { sources: ["committed"], target: "undone" },
} as const satisfies Record<string, RenderSessionTransitionDefinition>;

export type RenderSessionTransitionOperation = keyof typeof RENDER_SESSION_TRANSITIONS;

const STOPPED_SESSION_STATUSES: readonly RenderSessionStatus[] = ["cancelled", "discarded"];

function transitionDefinition(operation: RenderSessionTransitionOperation): RenderSessionTransitionDefinition {
  return RENDER_SESSION_TRANSITIONS[operation];
}

function transitionTargets(
  operation: RenderSessionTransitionOperation,
  status: RenderSessionStatus,
): readonly RenderSessionStatus[] {
  const definition = transitionDefinition(operation);
  if (!definition.sources.includes(status)) return [];
  if (definition.target === "same") return [status];
  return typeof definition.target === "string" ? [definition.target] : definition.target;
}

export function renderSessionTransitionSources(
  operation: RenderSessionTransitionOperation,
): readonly RenderSessionStatus[] {
  return transitionDefinition(operation).sources;
}

export function renderSessionTransitionTargets(
  operation: RenderSessionTransitionOperation,
): readonly RenderSessionStatus[] {
  const definition = transitionDefinition(operation);
  if (definition.target === "same") return definition.sources;
  return typeof definition.target === "string" ? [definition.target] : definition.target;
}

export function renderSessionTransitionAllowed(
  operation: RenderSessionTransitionOperation,
  status: RenderSessionStatus,
  target?: RenderSessionStatus,
) {
  const targets = transitionTargets(operation, status);
  return target === undefined ? targets.length > 0 : targets.includes(target);
}

export function renderSessionTransitionTarget(
  operation: RenderSessionTransitionOperation,
  status: RenderSessionStatus,
): RenderSessionStatus {
  const targets = transitionTargets(operation, status);
  if (targets.length !== 1) {
    throw new Error(`Render session ${operation} from ${status} does not have one target.`);
  }
  return targets[0]!;
}

export function renderSessionStatusPolicy(status: RenderSessionStatus): RenderSessionStatusPolicy {
  return {
    abandonable: renderSessionTransitionAllowed("abandon", status),
    active: renderSessionTransitionAllowed("claim-lease", status),
    cancelable: renderSessionTransitionAllowed("cancel", status),
    committable: renderSessionTransitionAllowed("commit", status),
    discardable: renderSessionTransitionAllowed("discard", status),
    stopped: STOPPED_SESSION_STATUSES.includes(status),
    undoable: renderSessionTransitionAllowed("undo", status),
  };
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
