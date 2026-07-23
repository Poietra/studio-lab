import { describe, expect, it, vi } from "vitest";

import { refreshThumbnailAfterOpen, scheduleWorkspaceRefresh } from "./use-manim-workspace";

function thumbnailStatus(state: "current" | "generating" | "missing") {
  return {
    cachedSourceHash: null,
    error: null,
    generatedAt: null,
    imageKind: "semantic" as const,
    projectId: "project-a",
    sceneName: "SceneOne",
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    state,
  };
}

describe("scheduleWorkspaceRefresh", () => {
  it("does not start a refresh after its effect setup has been discarded", async () => {
    const refresh = vi.fn();
    const cancel = scheduleWorkspaceRefresh(refresh);

    cancel();
    await Promise.resolve();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("starts only the live refresh across a StrictMode-style reconnect", async () => {
    const refresh = vi.fn();
    const cancelDiscardedSetup = scheduleWorkspaceRefresh(refresh);
    cancelDiscardedSetup();
    scheduleWorkspaceRefresh(refresh);

    await Promise.resolve();

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("refreshThumbnailAfterOpen", () => {
  it("does not rerender a current or already-generating thumbnail", async () => {
    const generate = vi.fn();

    await refreshThumbnailAfterOpen("project-a", async () => thumbnailStatus("current"), generate);
    await refreshThumbnailAfterOpen("project-a", async () => thumbnailStatus("generating"), generate);

    expect(generate).not.toHaveBeenCalled();
  });

  it("starts generation after an explicit workspace open when the cache is not current", async () => {
    const generating = thumbnailStatus("generating");
    const generate = vi.fn(async () => generating);

    await expect(refreshThumbnailAfterOpen(
      "project-a",
      async () => thumbnailStatus("missing"),
      generate,
    )).resolves.toBe(generating);
    expect(generate).toHaveBeenCalledWith("project-a");
  });
});
