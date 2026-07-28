import { afterEach, describe, expect, it, vi } from "vitest";

import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { productionSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

afterEach(() => vi.useRealTimers());

describe("fast-manim production shutdown budget", () => {
  it("probes the verified production backend without reading project source", async () => {
    const status = productionSandboxReadyStatus();
    const backend = {
      close: async () => undefined,
      start: () => {
        throw new Error("not used");
      },
      status: async () => status,
    } as FastManimSandboxBackendV1;
    const runner = new FastManimSnapshotRunner({
      attestationVerifier: () => true,
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

    await expect(runner.ready()).resolves.toBe(true);
    await runner.close();
    await expect(runner.ready()).resolves.toBe(false);
  });

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
