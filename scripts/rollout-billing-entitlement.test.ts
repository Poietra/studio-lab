import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseBillingEntitlementRolloutArgumentsV1,
  parseBillingEntitlementRolloutSpecV1,
  rolloutBillingEntitlementV1,
} from "./rollout-billing-entitlement.mjs";

const SPEC = Object.freeze({
  accessUntil: "2026-08-31T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  periodStart: "2026-08-01T00:00:00.000Z",
  planKey: "starter",
  renderJobLimit: 100,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  tenantId: "tenant-a",
  usagePeriodKey: "2026-08",
});

const DATABASE_NOW = new Date("2026-08-15T00:00:00.000Z");

function exactHead(input = parseBillingEntitlementRolloutSpecV1(SPEC)) {
  return {
    activeNow: true,
    appliedGeneration: 1n,
    organizationActive: true,
    snapshot: { ...input, createdAt: DATABASE_NOW },
  };
}

function dependencies(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    applySnapshot: vi.fn(async (input) => ({ kind: "applied", snapshot: { ...input, createdAt: DATABASE_NOW } })),
    databaseNow: vi.fn(async () => DATABASE_NOW),
    migrate: vi.fn(async () => ({ applied: true, version: 18 })),
    readCurrentHead: vi.fn(async () => exactHead()),
    ready: vi.fn(async () => true),
    ...overrides,
  };
}

describe("billing entitlement rollout", () => {
  it("accepts only one strict operator spec and derives the fixed generation-1 grant", () => {
    expect(parseBillingEntitlementRolloutArgumentsV1(["--", "--spec", "tenant.json"])).toEqual({
      specPath: resolve("tenant.json"),
    });
    expect(parseBillingEntitlementRolloutSpecV1(SPEC)).toMatchObject({
      accessState: "active",
      expectedGeneration: 0n,
      renderEnabled: true,
      renderJobLimit: 100,
      sourceGeneration: 1n,
    });
    expect(() => parseBillingEntitlementRolloutArgumentsV1(["--spec", "tenant.json", "--force"])).toThrow();
    for (const invalid of [
      { ...SPEC, accessState: "active" },
      { ...SPEC, periodStart: "2026-08-01T00:00:00Z" },
      { ...SPEC, renderJobLimit: 1_000_001 },
      { ...SPEC, snapshotId: "00000000-0000-5000-8000-000000000001" },
    ]) {
      expect(() => parseBillingEntitlementRolloutSpecV1(invalid)).toThrow();
    }
  });

  it("migrates, applies, and verifies a fresh tenant in rollout order", async () => {
    const calls: string[] = [];
    const fixture = dependencies({
      applySnapshot: vi.fn(async (input) => {
        calls.push("apply");
        return { kind: "applied", snapshot: { ...input, createdAt: DATABASE_NOW } };
      }),
      databaseNow: vi.fn(async () => {
        calls.push("clock");
        return DATABASE_NOW;
      }),
      migrate: vi.fn(async () => {
        calls.push("migrate");
        return { applied: true, version: 18 };
      }),
      readCurrentHead: vi.fn(async () => {
        calls.push("verify");
        return exactHead();
      }),
      ready: vi.fn(async () => {
        calls.push("ready");
        return true;
      }),
    });

    await expect(rolloutBillingEntitlementV1(SPEC, fixture)).resolves.toMatchObject({
      generation: "1",
      promotionReady: true,
      snapshotId: SPEC.snapshotId,
      status: "seeded",
      tenantId: SPEC.tenantId,
    });
    expect(calls).toEqual(["migrate", "ready", "clock", "apply", "verify"]);
  });

  it("accepts only an exact generation-1 replay", async () => {
    const fixture = dependencies({
      applySnapshot: vi.fn(async () => ({ appliedGeneration: 1n, kind: "conflict" })),
    });

    await expect(rolloutBillingEntitlementV1(SPEC, fixture)).resolves.toMatchObject({
      promotionReady: true,
      status: "already-current",
    });
    expect(fixture.readCurrentHead).toHaveBeenCalledWith(SPEC.tenantId);
  });

  it("fails closed before promotion for readiness, generation, identity, or activity drift", async () => {
    const input = parseBillingEntitlementRolloutSpecV1(SPEC);
    const cases = [
      dependencies({ migrate: vi.fn(async () => ({ applied: true, version: 14 })) }),
      dependencies({ ready: vi.fn(async () => false) }),
      dependencies({ applySnapshot: vi.fn(async () => ({ appliedGeneration: 2n, kind: "conflict" })) }),
      dependencies({
        applySnapshot: vi.fn(async () => ({ appliedGeneration: 1n, kind: "conflict" })),
        readCurrentHead: vi.fn(async () => exactHead({ ...input, planKey: "different" })),
      }),
      dependencies({ readCurrentHead: vi.fn(async () => ({ ...exactHead(), activeNow: false })) }),
    ];

    for (const fixture of cases) {
      await expect(rolloutBillingEntitlementV1(SPEC, fixture)).rejects.toThrow();
    }
  });
});
