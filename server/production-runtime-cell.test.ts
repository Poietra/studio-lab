import { describe, expect, it, vi } from "vitest";

import type { ManimApi } from "./manim-api";
import { authenticateManimPrincipal } from "./manim-request-principal";
import {
  BoundedProductionManimRuntimeCellResolverV1,
  type ProductionManimRuntimeAdapterV1,
  type ProductionRuntimeCellAssignmentV1,
} from "./production-runtime-cell";

function runtime(tenantId: string, close = vi.fn(async () => undefined)): ProductionManimRuntimeAdapterV1 {
  return {
    api: {
      storageBoundary: { kind: "shared-durable", namespace: "production-test" },
      tenantId,
    } as ManimApi,
    close,
    ready: async () => ({
      executionBoundary: "adapter-attests-external-sandbox",
      ready: true,
      storageBoundary: "shared-durable",
      tenantBoundary: "server-owned-tenant-key",
    }),
    renderReady: async () => true,
    workspaceReady: async () => true,
  };
}

async function principal(tenantId: string) {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId: `user-${tenantId}`, tenantId }) },
    null,
    new AbortController().signal,
  );
}

function assignment(tenantId: string, generation = 1, cellId = `cell-${tenantId}`): ProductionRuntimeCellAssignmentV1 {
  return { cellId, generation, state: "active", tenantId };
}

describe("bounded production runtime cell resolver", () => {
  it("resolves and caches two Organizations only from their verified principals", async () => {
    const assignments = new Map([
      ["tenant-a", assignment("tenant-a")],
      ["tenant-b", assignment("tenant-b")],
    ]);
    const resolve = vi.fn(async (tenantId: string) => assignments.get(tenantId) ?? null);
    const provision = vi.fn(async ({ tenantId }: ProductionRuntimeCellAssignmentV1) => runtime(tenantId));
    const resolver = new BoundedProductionManimRuntimeCellResolverV1({
      assignments: { ready: async () => true, resolve },
      maxCells: 2,
      provisioner: { provision },
    });

    const [tenantA, tenantB] = await Promise.all([
      resolver.acquire(await principal("tenant-a"), new AbortController().signal),
      resolver.acquire(await principal("tenant-b"), new AbortController().signal),
    ]);
    const tenantAAgain = await resolver.acquire(await principal("tenant-a"), new AbortController().signal);

    expect(tenantA.runtime.api.tenantId).toBe("tenant-a");
    expect(tenantB.runtime.api.tenantId).toBe("tenant-b");
    expect(tenantAAgain.runtime).toBe(tenantA.runtime);
    expect(resolve.mock.calls.map(([tenantId]) => tenantId)).toEqual(["tenant-a", "tenant-b", "tenant-a"]);
    expect(provision).toHaveBeenCalledTimes(2);

    tenantA.release();
    tenantAAgain.release();
    tenantB.release();
    await resolver.close();
  });

  it("rotates a generation without restarting and drains the leased old cell", async () => {
    let current = assignment("tenant-a", 1, "cell-a-v1");
    const oldClose = vi.fn(async () => undefined);
    const newClose = vi.fn(async () => undefined);
    const provision = vi.fn(async ({ generation, tenantId }: ProductionRuntimeCellAssignmentV1) =>
      runtime(tenantId, generation === 1 ? oldClose : newClose),
    );
    const resolver = new BoundedProductionManimRuntimeCellResolverV1({
      assignments: { ready: async () => true, resolve: async () => current },
      maxCells: 2,
      provisioner: { provision },
    });
    const verified = await principal("tenant-a");

    const oldLease = await resolver.acquire(verified, new AbortController().signal);
    current = assignment("tenant-a", 2, "cell-a-v2");
    const newLease = await resolver.acquire(verified, new AbortController().signal);

    expect(newLease.runtime).not.toBe(oldLease.runtime);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(oldClose).not.toHaveBeenCalled();
    oldLease.release();
    await vi.waitFor(() => expect(oldClose).toHaveBeenCalledOnce());
    newLease.release();
    await resolver.close();
    expect(newClose).toHaveBeenCalledOnce();
  });

  it("fails closed for missing, disabled, stale, conflicting, or forged assignments", async () => {
    let current: unknown = assignment("tenant-a", 2, "shared-cell");
    const activeClose = vi.fn(async () => undefined);
    const provision = vi.fn(async ({ tenantId }: ProductionRuntimeCellAssignmentV1) => runtime(tenantId, activeClose));
    const resolver = new BoundedProductionManimRuntimeCellResolverV1({
      assignments: { ready: async () => true, resolve: async () => current },
      maxCells: 2,
      provisioner: { provision },
    });
    const tenantA = await principal("tenant-a");
    const tenantB = await principal("tenant-b");
    const lease = await resolver.acquire(tenantA, new AbortController().signal);
    lease.release();

    current = null;
    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    current = { ...assignment("tenant-b", 1), state: "disabled" };
    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    current = { ...assignment("tenant-a", 3, "disabled-cell"), state: "disabled" };
    await expect(resolver.acquire(tenantA, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(activeClose).toHaveBeenCalledOnce());
    current = assignment("tenant-a", 1, "shared-cell");
    await expect(resolver.acquire(tenantA, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    current = assignment("tenant-b", 1, "shared-cell");
    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    current = assignment("tenant-b");
    current = { ...(current as ProductionRuntimeCellAssignmentV1), tenantId: "tenant-a" };
    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });

    expect(provision).toHaveBeenCalledOnce();
    await resolver.close();
  });

  it("bounds live cells, evicts only idle entries, and closes a forged runtime", async () => {
    const assignments = new Map([
      ["tenant-a", assignment("tenant-a")],
      ["tenant-b", assignment("tenant-b")],
    ]);
    const tenantAClose = vi.fn(async () => undefined);
    let forgeTenantB = false;
    const forgedClose = vi.fn(async () => undefined);
    const resolver = new BoundedProductionManimRuntimeCellResolverV1({
      assignments: { ready: async () => true, resolve: async (tenantId) => assignments.get(tenantId) },
      maxCells: 1,
      provisioner: {
        provision: async ({ tenantId }) =>
          tenantId === "tenant-a"
            ? runtime(tenantId, tenantAClose)
            : runtime(forgeTenantB ? "tenant-a" : tenantId, forgedClose),
      },
    });
    const tenantA = await principal("tenant-a");
    const tenantB = await principal("tenant-b");
    const active = await resolver.acquire(tenantA, new AbortController().signal);

    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    expect(tenantAClose).not.toHaveBeenCalled();
    active.release();
    forgeTenantB = true;
    await expect(resolver.acquire(tenantB, new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    expect(tenantAClose).toHaveBeenCalledOnce();
    expect(forgedClose).toHaveBeenCalledOnce();
    await resolver.close();
  });
});
