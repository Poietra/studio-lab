import { afterEach, describe, expect, it, vi } from "vitest";

import { createFastManimProductionSandboxClientV1 } from "./fast-manim-production-sandbox-client";
import { FastManimProductionSnapshotRunnerFactoryV1 } from "./fast-manim-production-snapshot-runner-factory";
import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import {
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
} from "./fast-manim-snapshot-contract";
import { productionSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

vi.mock("./fast-manim-production-sandbox-client", () => ({
  createFastManimProductionSandboxClientV1: vi.fn(),
}));
vi.mock("./fast-manim-gated-oci-release", () => ({
  verifyFastManimGatedOciReleaseV1: vi.fn(() => ({
    descriptor: () => ({ runtimeDigest: "b".repeat(64) }),
  })),
}));

const PROFILE = "a".repeat(64);
const RUNTIME = "b".repeat(64);
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
  return { attestationVerifier: () => true, backend, profileDigest: PROFILE, runtimeDigest: RUNTIME };
}

afterEach(() => vi.clearAllMocks());

describe("FastManimProductionSnapshotRunnerFactoryV1", () => {
  it("requires both durable PNG authorities for snapshot profile V4", async () => {
    const base = {
      client: {} as never,
      frame: { height: 8, width: 14.222 },
      snapshotVersion: 4 as const,
      tenantId: "tenant-a",
    };
    expect(() => new FastManimProductionSnapshotRunnerFactoryV1(base)).toThrow(/requires durable project PNG/i);
    expect(
      () =>
        new FastManimProductionSnapshotRunnerFactoryV1({
          ...base,
          projectPngRepository: { readHead: vi.fn() },
        }),
    ).toThrow(/configured together/i);

    const configured = new FastManimProductionSnapshotRunnerFactoryV1({
      ...base,
      projectPngRepository: { readHead: vi.fn() },
      projectPngs: { read: vi.fn() },
    });
    expect(configured.runtimeConfigHash).toBe(
      digestFastManimSnapshotRuntimeConfigV1({
        capabilities: ["png-image"],
        frame: base.frame,
        randomSeed: 0,
        schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
        snapshotVersion: 4,
        version: 1,
      }),
    );
    await configured.close();
  });

  it("pins the exact V8 capability surface into the factory and runner handle identity", async () => {
    const frame = { height: 8, width: 14.222222222222221 } as const;
    const configured = new FastManimProductionSnapshotRunnerFactoryV1({
      client: {} as never,
      frame,
      snapshotVersion: 8,
      tenantId: "tenant-a",
    });
    const expectedRuntimeConfigHash = digestFastManimSnapshotRuntimeConfigV1({
      capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8],
      frame,
      randomSeed: 0,
      schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
      snapshotVersion: 8,
      version: 1,
    });

    expect(configured.runtimeConfigHash).toBe(expectedRuntimeConfigHash);

    const created = client();
    createClient.mockResolvedValue(created as never);
    const handle = await configured.create({
      projectId: "project-a",
      sourceProvider: { readVerified: async () => Promise.reject(new Error("not used")) },
    });
    expect(handle.runtimeConfigHash).toBe(expectedRuntimeConfigHash);

    await handle.runner.close();
    await configured.close();
  });

  it("uses a fresh verified broker client for readiness and closes its runner", async () => {
    const created = client();
    createClient.mockResolvedValue(created as never);
    const runners = factory();

    await expect(runners.ready()).resolves.toBe(true);

    expect(createClient).toHaveBeenCalledOnce();
    expect(created.backend.status).toHaveBeenCalledOnce();
    expect(created.backend.close).toHaveBeenCalledOnce();
  });

  it("closes a fresh broker client before propagating readiness cancellation", async () => {
    const created = client();
    const cancellation = new Error("readiness cancelled");
    const controller = new AbortController();
    created.backend.status = vi.fn(async () => {
      controller.abort(cancellation);
      throw cancellation;
    });
    createClient.mockResolvedValue(created as never);
    const runners = factory();

    await expect(runners.ready(controller.signal)).rejects.toBe(cancellation);

    expect(created.backend.close).toHaveBeenCalledOnce();
  });

  it("waits for an active readiness runner to close before factory shutdown completes", async () => {
    const created = client();
    let releaseStatus!: () => void;
    let reachStatus!: () => void;
    const statusReached = new Promise<void>((resolve) => {
      reachStatus = resolve;
    });
    const heldStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    created.backend.status = vi.fn(async () => {
      reachStatus();
      await heldStatus;
      return productionSandboxReadyStatus(PROFILE);
    });
    createClient.mockResolvedValue(created as never);
    const runners = factory();
    const readiness = runners.ready();
    await statusReached;

    let closeSettled = false;
    const closing = runners.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    releaseStatus();
    await expect(readiness).resolves.toBe(false);
    await closing;
    expect(created.backend.close).toHaveBeenCalledOnce();
  });

  it("reports client cleanup that fails when factory close races readiness creation", async () => {
    const created = client();
    const cleanupFailure = new Error("broker cleanup failed");
    created.backend.close = vi.fn(async () => Promise.reject(cleanupFailure));
    let resolveClient!: (value: ReturnType<typeof client>) => void;
    createClient.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClient = resolve;
      }) as never,
    );
    const runners = factory();
    const readiness = runners.ready();
    const closing = runners.close();

    resolveClient(created);

    await expect(readiness).resolves.toBe(false);
    const closeError = await closing.catch((error: unknown) => error);
    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).errors).toEqual([expect.objectContaining({ errors: [cleanupFailure] })]);
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

    expect(runners.runtimeDigest).toBe(RUNTIME);
    expect(runners.runtimeConfigHash).toBe(
      digestFastManimSnapshotRuntimeConfigV1({
        capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1],
        frame: { height: 8, width: 14.222 },
        randomSeed: 0,
        schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
        snapshotVersion: 1,
        version: 1,
      }),
    );
    expect(handle.profileDigest).toBe(PROFILE);
    expect(handle.runtimeConfigHash).toBe(runners.runtimeConfigHash);
    expect(handle.runtimeDigest).toBe(RUNTIME);
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

  it("closes and rejects a client from a different runtime generation", async () => {
    const created = { ...client(), runtimeDigest: "c".repeat(64) };
    createClient.mockResolvedValue(created as never);
    const runners = factory();

    await expect(
      runners.create({
        projectId: "project-a",
        sourceProvider: { readVerified: async () => Promise.reject(new Error("not used")) },
      }),
    ).rejects.toThrow(/runtime digest does not match/i);
    expect(created.backend.close).toHaveBeenCalledOnce();
  });
});
