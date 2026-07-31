import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ManimWorkspaceView, RenderSessionView } from "./contracts";
import { RenderPipelinePanel } from "./render-pipeline-panel";

const VIDEO_URL = "/api/manim/renders/render-id/video";

const workspace: ManimWorkspaceView = {
  frame: { height: 8, width: 14.222 },
  projectId: "project-a",
  projectName: "Project A",
  renderCapability: { backend: "local-command", kind: "ready" },
  sources: [],
};

function session(overrides: Partial<RenderSessionView> = {}): RenderSessionView {
  return {
    actionInProgress: false,
    canCancel: false,
    canCommit: false,
    canDiscard: false,
    canUndo: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    error: null,
    failureCode: null,
    id: "render-id",
    logTail: "done",
    patch: {
      anchorLine: 4,
      anchorLines: [4],
      insertedCode: "self.wait(1)",
      patchedSourceHash: "b".repeat(64),
      sourceHash: "a".repeat(64),
    },
    programBatchId: "batch-id",
    programTransactionId: "transaction-id",
    progress: 1,
    projectId: workspace.projectId,
    renderRequestId: "request-id",
    sceneName: "SceneOne",
    sourceAction: null,
    sourcePath: "scene.py",
    status: "ready",
    updatedAt: "2026-07-31T00:00:01.000Z",
    videoUrl: VIDEO_URL,
    ...overrides,
  };
}

function renderPanel(renderSession: RenderSessionView) {
  return renderToStaticMarkup(
    <RenderPipelinePanel
      candidate={null}
      candidateLifecycleBlocker={null}
      candidateUnavailableReason="Create a Canonical draft first."
      onSessionChange={vi.fn()}
      session={renderSession}
      sourceExport={null}
      workspace={workspace}
    />,
  );
}

function downloadLink(markup: string) {
  return Array.from(markup.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g), ([link]) => link).find((link) =>
    link.includes("Download MP4"),
  );
}

describe("RenderPipelinePanel MP4 download", () => {
  it("offers the authenticated session video without copying it into browser memory", () => {
    const link = downloadLink(renderPanel(session()));

    expect(link).toBeDefined();
    expect(link).toContain('download="SceneOne.mp4"');
    expect(link).toContain(`href="${VIDEO_URL}"`);
    expect(link).toContain("Download MP4");
  });

  it("does not offer a download until the durable artifact URL exists", () => {
    expect(downloadLink(renderPanel(session({ videoUrl: null })))).toBeUndefined();
  });
});
