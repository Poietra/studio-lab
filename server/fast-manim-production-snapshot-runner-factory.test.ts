import { afterEach, describe, expect, it, vi } from "vitest";

import { createFastManimProductionSandboxClientV1 } from "./fast-manim-production-sandbox-client";
import { FastManimProductionSnapshotRunnerFactoryV1 } from "./fast-manim-production-snapshot-runner-factory";
import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import { productionSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

vi.mock("./fast-manim-production-sandbox-client", () => ({
  createFastManimProductionSandboxClientV1: vi.fn(),
}));

const PROFILE = "a".repeat(64);
const createClient = vi.mocked(createFastManimProductionSandboxClientV1);

function factory() {
  return new FastManimProductionSnapshotRunnerFactoryV1({
    client: {} as never,
    frame: { height: 8, width: 14.222 },
    tenantId: "tenant-a",
  });
}

function client() {
  const backend = {
    close: vi.fn(async () => undefined),
    start: () => {
      throw new Error("not used");
    },
    status: vi.fn(async () => productionSandboxReadyStatus(PROFILE)),
  } as FastManimSandboxBackendV1;
  return { attestationVerifier: () => true, backend, profileDigest: PROFILE };
}

afterEach(() => vi.clearAllMocks());

describe("FastManimProductionSnapshotRunnerFactoryV1", () => {
  it("uses a fresh verified broker client for readiness and closes its runner", async () => {
    const created = client();
    createClient.mockResolvedValue(created as never);
    const runners = factory();

    await expect(runners.ready()).resolves.toBe(true);

    expect(createClient).toHaveBeenCalledOnce();
    expect(created.backend.status).toHaveBeenCalledOnce();
    expect(created.backend.close).toHaveBeenCalledOnce();
  });

  it("returns a project-owned runner and refuses creation after close", async () => {
    const created = client();
    createClient.mockResolvedValue(created as never);
    const runners = factory();
    const handle = await runners.create({
      projectId: "project-a",
      sourceProvider: {
        readVerified: async () => {
          throw new Error("not used");
        },
      },
    });

    expect(handle.profileDigest).toBe(PROFILE);
    await handle.runner.close();
    await runners.close();

    await expect(
      runners.create({
        projectId: "project-b",
        sourceProvider: { readVerified: async () => Promise.reject(new Error("not used")) },
      }),
    ).rejects.toThrow(/factory is closed/i);
    expect(created.backend.close).toHaveBeenCalledOnce();
  });
});
