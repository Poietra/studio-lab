import { afterEach, describe, expect, it, vi } from "vitest";

import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";

afterEach(() => vi.useRealTimers());

describe("fast-manim production shutdown budget", () => {
  it("outlives the production UDS broker's 30-second cleanup bound", async () => {
    vi.useFakeTimers();
    const backend = {
      close: () => new Promise<void>((resolve) => setTimeout(resolve, 30_001)),
      start: () => {
        throw new Error("not used");
      },
      status: async () => {
        throw new Error("not used");
      },
    } as FastManimSandboxBackendV1;
    const runner = new FastManimSnapshotRunner({
      backend,
      deployment: "production",
      frame: { height: 8, width: 14.222 },
      projectId: "project-a",
      sourceProvider: {
        readVerified: async () => {
          throw new Error("not used");
        },
      },
      tenantId: "tenant-a",
    });

    const closing = runner.close();
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(closing).resolves.toBeUndefined();
  });
});
