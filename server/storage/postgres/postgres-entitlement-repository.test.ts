import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type ApplyEntitlementSnapshotInputV1,
  MAX_USAGE_RESERVATION_LIFETIME_MS_V1,
} from "../../billing/entitlement-repository";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import {
  PostgresBillingEntitlementRepositoryV1,
  reserveRenderUsageWithClientV1,
  settleRenderUsageWithClientV1,
} from "./postgres-entitlement-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

const TENANT = "tenant-a";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const PERIOD_START = new Date("2026-08-01T00:00:00.000Z");
const ACCESS_UNTIL = new Date("2026-08-31T00:00:00.000Z");
const PERIOD_END = new Date("2026-09-01T00:00:00.000Z");
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakeClient(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => handle(text, values));
  return { client: { query, release: vi.fn() } as unknown as PoolClient, query };
}

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const fixture = fakeClient((text, values) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    return handle(text, values);
  });
  const pool = {
    connect: vi.fn(async () => fixture.client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { ...fixture, pool };
}

function snapshotInput(overrides: Partial<ApplyEntitlementSnapshotInputV1> = {}): ApplyEntitlementSnapshotInputV1 {
  return {
    accessState: "active",
    accessUntil: ACCESS_UNTIL,
    expectedGeneration: 0n,
    periodEnd: PERIOD_END,
    periodStart: PERIOD_START,
    planKey: "starter",
    renderEnabled: true,
    renderJobLimit: 1,
    snapshotId: SNAPSHOT_ID,
    sourceGeneration: 1n,
    tenantId: TENANT,
    usagePeriodKey: "2026-08",
    ...overrides,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    access_expired: false,
    access_state: "active",
    access_until: ACCESS_UNTIL,
    created_at: CREATED_AT,
    period_end: PERIOD_END,
    period_inactive: false,
    period_start: PERIOD_START,
    plan_key: "starter",
    render_enabled: true,
    render_job_limit: 1,
    snapshot_id: SNAPSHOT_ID,
    source_generation: "1",
    tenant_id: TENANT,
    usage_period_key: "2026-08",
    ...overrides,
  };
}

function reservationRow(state: "reserved" | "committed" | "released" = "reserved", overrides = {}) {
  const terminal = state !== "reserved";
  return {
    created_at: CREATED_AT,
    expired: false,
    expires_at: new Date(CREATED_AT.getTime() + MAX_USAGE_RESERVATION_LIFETIME_MS_V1),
    operation_id: OPERATION_ID,
    operation_kind: "render",
    settled_at: terminal ? new Date("2026-08-01T00:01:00.000Z") : null,
    snapshot_id: SNAPSHOT_ID,
    source_generation: "1",
    state,
    tenant_id: TENANT,
    updated_at: terminal ? new Date("2026-08-01T00:01:00.000Z") : CREATED_AT,
    usage_period_key: "2026-08",
    version: terminal ? "2" : "1",
    ...overrides,
  };
}

describe("PostgresBillingEntitlementRepositoryV1", () => {
  it("requires the exact billing migration checksum", async () => {
    const valid = fakePool(() => ({
      rowCount: 1,
      rows: [{ checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 }],
    }));
    const invalid = fakePool(() => ({ rowCount: 1, rows: [{ checksum: "wrong", version: 14 }] }));

    await expect(new PostgresBillingEntitlementRepositoryV1({ pool: valid.pool }).ready()).resolves.toBe(true);
    await expect(new PostgresBillingEntitlementRepositoryV1({ pool: invalid.pool }).ready()).resolves.toBe(false);
  });

  it("rejects invalid generations, blocked rendering, and unbounded reservations before pool acquisition", async () => {
    const fixture = fakePool(() => {
      throw new Error("validation must happen before querying PostgreSQL");
    });
    const repository = new PostgresBillingEntitlementRepositoryV1({ pool: fixture.pool });

    await expect(repository.applySnapshot(snapshotInput({ sourceGeneration: 2n }))).rejects.toThrow(
      "source generation",
    );
    await expect(
      repository.applySnapshot(snapshotInput({ accessState: "blocked", renderEnabled: true, renderJobLimit: 1 })),
    ).rejects.toThrow("blocked entitlement");
    await expect(
      repository.reserveRender({
        lifetimeMs: MAX_USAGE_RESERVATION_LIFETIME_MS_V1 + 1,
        operationId: OPERATION_ID,
        tenantId: TENANT,
      }),
    ).rejects.toThrow();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("creates and locks the account before appending the initial snapshot and advancing its head", async () => {
    const actions: string[] = [];
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: TENANT }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) {
        actions.push("create-account");
        expect(text).toContain("ON CONFLICT");
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM public.billing_accounts") && text.includes("FOR UPDATE")) {
        actions.push("lock-account");
        return { rowCount: 1, rows: [{ applied_generation: "0" }] };
      }
      if (text.startsWith("INSERT INTO public.entitlement_snapshots")) {
        actions.push("append-snapshot");
        return { rowCount: 1, rows: [snapshotRow()] };
      }
      if (text.startsWith("UPDATE public.billing_accounts")) {
        actions.push("advance-head");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresBillingEntitlementRepositoryV1({ pool: fixture.pool });

    await expect(repository.applySnapshot(snapshotInput())).resolves.toMatchObject({
      kind: "applied",
      snapshot: { snapshotId: SNAPSHOT_ID, sourceGeneration: 1n },
    });
    expect(actions).toEqual(["create-account", "lock-account", "append-snapshot", "advance-head"]);
  });

  it("classifies a stale snapshot CAS without appending data", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: TENANT }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.billing_accounts")) {
        return { rowCount: 1, rows: [{ applied_generation: "2" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresBillingEntitlementRepositoryV1({ pool: fixture.pool });

    await expect(repository.applySnapshot(snapshotInput())).resolves.toEqual({
      appliedGeneration: 2n,
      kind: "conflict",
    });
    expect(fixture.query.mock.calls.some(([text]) => text.includes("INTO public.entitlement_snapshots"))).toBe(false);
  });
});

describe("billing usage transaction helpers", () => {
  it("classifies every fail-closed entitlement and quota denial", async () => {
    const cases = [
      { current: null, reason: "unconfigured" },
      {
        current: snapshotRow({ access_state: "blocked", render_enabled: false, render_job_limit: 0 }),
        reason: "blocked",
      },
      { current: snapshotRow({ access_expired: true }), reason: "expired" },
      { current: snapshotRow({ render_enabled: false, render_job_limit: 0 }), reason: "render-disabled" },
      { current: snapshotRow(), reason: "quota-exhausted" },
    ] as const;

    for (const testCase of cases) {
      const fixture = fakeClient((text) => {
        if (text.includes("FROM public.billing_accounts")) {
          return testCase.current ? { rowCount: 1, rows: [testCase.current] } : { rowCount: 0, rows: [] };
        }
        if (text.includes("FROM public.usage_reservations") && text.includes("operation_id")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.startsWith("WITH expired AS")) return { rowCount: 0, rows: [] };
        if (text.includes("count(*)::text AS consumed")) return { rowCount: 1, rows: [{ consumed: "1" }] };
        throw new Error(`Unexpected query: ${text}`);
      });

      await expect(
        reserveRenderUsageWithClientV1(fixture.client, {
          lifetimeMs: 1_000,
          operationId: OPERATION_ID,
          tenantId: TENANT,
        }),
      ).resolves.toEqual({ kind: "denied", reason: testCase.reason });
    }
  });

  it("replays only a live reservation and rejects a terminal operation", async () => {
    for (const [state, expectedKind] of [
      ["reserved", "reserved"],
      ["committed", "denied"],
    ] as const) {
      const fixture = fakeClient((text) => {
        if (text.includes("FROM public.billing_accounts")) return { rowCount: 1, rows: [snapshotRow()] };
        if (text.includes("FROM public.usage_reservations")) {
          return { rowCount: 1, rows: [reservationRow(state)] };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      const result = await reserveRenderUsageWithClientV1(fixture.client, {
        lifetimeMs: 1_000,
        operationId: OPERATION_ID,
        tenantId: TENANT,
      });

      expect(result.kind).toBe(expectedKind);
      if (state === "reserved") expect(result).toMatchObject({ replayed: true });
      else expect(result).toEqual({ kind: "denied", reason: "operation-settled" });
    }
  });

  it("aggregates the immutable period quota and uses one database timestamp at the maximum lifetime", async () => {
    const fixture = fakeClient((text, values) => {
      if (text.includes("FROM public.billing_accounts")) return { rowCount: 1, rows: [snapshotRow()] };
      if (text.includes("FROM public.usage_reservations") && text.includes("operation_id")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("WITH expired AS")) {
        expect(text).not.toContain("ON CONFLICT");
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("count(*)::text AS consumed")) {
        expect(values).toEqual([TENANT, "2026-08"]);
        return { rowCount: 1, rows: [{ consumed: "0" }] };
      }
      if (text.startsWith("WITH reservation_clock AS")) {
        expect(text).toContain("expires_at, created_at, updated_at");
        expect(text.match(/issued_at/g)).toHaveLength(4);
        expect(values.at(-1)).toBe(MAX_USAGE_RESERVATION_LIFETIME_MS_V1);
        return { rowCount: 1, rows: [reservationRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      reserveRenderUsageWithClientV1(fixture.client, {
        lifetimeMs: MAX_USAGE_RESERVATION_LIFETIME_MS_V1,
        operationId: OPERATION_ID,
        tenantId: TENANT,
      }),
    ).resolves.toMatchObject({ kind: "reserved", replayed: false });
  });

  it("classifies settlement retries and conflicts without mutating terminal reservations", async () => {
    for (const [state, expected] of [
      ["committed", { kind: "settled", replayed: true }],
      ["released", { kind: "conflict", state: "released" }],
    ] as const) {
      const fixture = fakeClient((text) => {
        if (text.includes("FROM public.usage_reservations")) {
          return { rowCount: 1, rows: [reservationRow(state)] };
        }
        throw new Error(`Unexpected query: ${text}`);
      });

      await expect(
        settleRenderUsageWithClientV1(fixture.client, TENANT, OPERATION_ID, "committed"),
      ).resolves.toMatchObject(expected);
      expect(fixture.query).toHaveBeenCalledTimes(1);
    }
  });
});
