import { describe, expect, it } from "vitest";

import type { RenderCommitRequest, RenderSessionStatus } from "../src/render-pipeline/contracts";
import {
  type RenderedPreviewIdentity,
  type RenderSessionStatusPolicy,
  type RenderSessionTransitionOperation,
  renderCommitCorrelationKey,
  renderCommitMatchesPreview,
  renderSessionCapabilities,
  renderSessionStatusPolicy,
  renderSessionTransitionAllowed,
  renderSessionTransitionSources,
  renderSessionTransitionTarget,
  renderSessionTransitionTargets,
} from "./manim-render-session-policy";

const statusCoverage = {
  cancelled: true,
  committed: true,
  discarded: true,
  failed: true,
  preparing: true,
  ready: true,
  rendering: true,
  undone: true,
} as const satisfies Record<RenderSessionStatus, true>;

const statuses = Object.keys(statusCoverage) as RenderSessionStatus[];

const transitionCoverage = {
  abandon: { sources: ["cancelled", "failed", "preparing", "ready", "rendering"], targets: ["discarded"] },
  cancel: { sources: ["preparing", "rendering"], targets: ["cancelled"] },
  "claim-lease": { sources: ["preparing", "rendering"], targets: ["rendering"] },
  commit: { sources: ["ready"], targets: ["committed"] },
  "complete-lease": {
    sources: ["preparing", "rendering"],
    targets: ["cancelled", "failed", "ready"],
  },
  discard: { sources: ["cancelled", "failed", "ready", "undone"], targets: ["discarded"] },
  expire: { sources: ["preparing", "rendering"], targets: ["failed"] },
  "renew-lease": { sources: ["preparing", "rendering"], targets: ["preparing", "rendering"] },
  undo: { sources: ["committed"], targets: ["undone"] },
} as const satisfies Record<
  RenderSessionTransitionOperation,
  Readonly<{ sources: readonly RenderSessionStatus[]; targets: readonly RenderSessionStatus[] }>
>;

function statusesWith(capability: keyof RenderSessionStatusPolicy) {
  return statuses.filter((status) => renderSessionStatusPolicy(status)[capability]);
}

const preview: RenderedPreviewIdentity = {
  programBatchId: "batch-1",
  projectId: "default",
  renderRequestId: "render-1",
  sceneName: "ExampleScene",
  sourceHash: "a".repeat(64),
  sourcePath: "scene.py",
};

const commit: RenderCommitRequest = {
  ...preview,
  actionId: "00000000-0000-4000-8000-000000000001",
};

describe("Manim render session policy", () => {
  it("locks application and persistence transitions to one exhaustive state machine", () => {
    for (const [operation, expected] of Object.entries(transitionCoverage) as [
      RenderSessionTransitionOperation,
      (typeof transitionCoverage)[RenderSessionTransitionOperation],
    ][]) {
      expect(renderSessionTransitionSources(operation)).toEqual(expected.sources);
      expect(renderSessionTransitionTargets(operation)).toEqual(expected.targets);
      for (const status of statuses) {
        expect(renderSessionTransitionAllowed(operation, status)).toBe(
          (expected.sources as readonly RenderSessionStatus[]).includes(status),
        );
      }
    }

    for (const source of ["preparing", "rendering"] as const) {
      expect(renderSessionTransitionAllowed("complete-lease", source, "cancelled")).toBe(true);
      expect(renderSessionTransitionAllowed("complete-lease", source, "failed")).toBe(true);
      expect(renderSessionTransitionAllowed("complete-lease", source, "ready")).toBe(true);
      expect(renderSessionTransitionTarget("claim-lease", source)).toBe("rendering");
      expect(renderSessionTransitionTarget("renew-lease", source)).toBe(source);
    }
    expect(() => renderSessionTransitionTarget("complete-lease", "preparing")).toThrow(/one target/i);
  });

  it("defines every status transition capability in one exhaustive matrix", () => {
    expect(statusesWith("abandonable")).toEqual(["cancelled", "failed", "preparing", "ready", "rendering"]);
    expect(statusesWith("active")).toEqual(["preparing", "rendering"]);
    expect(statusesWith("cancelable")).toEqual(["preparing", "rendering"]);
    expect(statusesWith("committable")).toEqual(["ready"]);
    expect(statusesWith("discardable")).toEqual(["cancelled", "failed", "ready", "undone"]);
    expect(statusesWith("stopped")).toEqual(["cancelled", "discarded"]);
    expect(statusesWith("undoable")).toEqual(["committed"]);

    for (const status of statuses) {
      const policy = renderSessionStatusPolicy(status);
      expect(renderSessionCapabilities(status, false)).toEqual({
        canCancel: policy.cancelable,
        canCommit: policy.committable,
        canDiscard: policy.discardable,
        canUndo: policy.undoable,
      });
    }
  });

  it("withholds every public action capability while a session action owns the lock", () => {
    for (const status of statuses) {
      expect(renderSessionCapabilities(status, true)).toEqual({
        canCancel: false,
        canCommit: false,
        canDiscard: false,
        canUndo: false,
      });
    }
  });

  it("requires every rendered-preview identity field before consenting to Commit", () => {
    expect(renderCommitMatchesPreview(commit, preview)).toBe(true);

    for (const field of [
      "programBatchId",
      "projectId",
      "renderRequestId",
      "sceneName",
      "sourceHash",
      "sourcePath",
    ] as const) {
      expect(renderCommitMatchesPreview({ ...commit, [field]: `${commit[field]}-different` }, preview)).toBe(false);
    }
  });

  it("keys mutation replay by preview identity without treating the action ID as candidate identity", () => {
    const replay: RenderCommitRequest = {
      ...commit,
      actionId: "00000000-0000-4000-8000-000000000002",
    };

    expect(renderCommitCorrelationKey(commit)).toBe(renderCommitCorrelationKey(preview));
    expect(renderCommitCorrelationKey(replay)).toBe(renderCommitCorrelationKey(commit));
    expect(renderCommitCorrelationKey({ ...commit, sourceHash: "b".repeat(64) })).not.toBe(
      renderCommitCorrelationKey(commit),
    );
  });
});
