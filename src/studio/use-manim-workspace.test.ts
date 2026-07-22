import { describe, expect, it, vi } from "vitest";

import { scheduleWorkspaceRefresh } from "./use-manim-workspace";

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
