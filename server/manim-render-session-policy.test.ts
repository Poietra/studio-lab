import { describe, expect, it } from "vitest";

import type { RenderCommitRequest, RenderSessionStatus } from "../src/render-pipeline/contracts";
import {
  type RenderedPreviewIdentity,
  type RenderSessionStatusPolicy,
  renderCommitCorrelationKey,
  renderCommitMatchesPreview,
  renderSessionCapabilities,
  renderSessionStatusPolicy,
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
