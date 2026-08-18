import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type ApplyEntitlementSnapshotInputV1,
  MAX_USAGE_RESERVATION_LIFETIME_MS_V1,
} from "../../billing/entitlement-repository";
import { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import {
  allocateStockWithClientV1,
  PostgresBillingEntitlementRepositoryV1,
  releaseStockWithClientV1,
  reserveFlowUsageWithClientV1,
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
  it("requires the exact billing and entitlement-grant migration checksums", async () => {
    const valid = fakePool(() => ({
      rowCount: 2,
      rows: [
        { checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 },
        { checksum: BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM, version: 32 },
      ],
    }));
    const missingGrants = fakePool(() => ({
      rowCount: 1,
      rows: [{ checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM, version: 14 }],
    }));
    const invalid = fakePool(() => ({
      rowCount: 2,
      rows: [
        { checksum: "wrong", version: 14 },
        { checksum: BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM, version: 32 },
      ],
    }));

    await expect(new PostgresBillingEntitlementRepositoryV1({ pool: valid.pool }).ready()).resolves.toBe(true);
    await expect(new PostgresBillingEntitlementRepositoryV1({ pool: missingGrants.pool }).ready()).resolves.toBe(false);
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

  it("creates and locks the account before appending the initial snapshot, its grants, and the head", async () => {
    const actions: string[] = [];
    const fixture = fakePool((text, values) => {
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
      if (text.startsWith("INSERT INTO public.entitlement_flow_grants")) {
        actions.push("append-flow-grants");
        // The render grant is mirrored from the snapshot by the v32 trigger.
        expect(text).toContain("'ai-suggestion'");
        expect(text).toContain("'export-publication'");
        expect(text).not.toContain("'render'");
        expect(values.slice(-2)).toEqual([7, 3]);
        return { rowCount: 2, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.entitlement_stock_grants")) {
        actions.push("append-stock-grant");
        expect(text).toContain("'published-artifact-bytes'");
        expect(values.at(-1)).toBe(1_024);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("UPDATE public.billing_accounts")) {
        actions.push("advance-head");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresBillingEntitlementRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.applySnapshot(
        snapshotInput({ aiSuggestionLimit: 7, exportPublicationLimit: 3, publishedArtifactBytesLimit: 1_024 }),
      ),
    ).resolves.toMatchObject({
      kind: "applied",
      snapshot: { snapshotId: SNAPSHOT_ID, sourceGeneration: 1n },
    });
    expect(actions).toEqual([
      "create-account",
      "lock-account",
      "append-snapshot",
      "append-flow-grants",
      "append-stock-grant",
      "advance-head",
    ]);
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
        if (text.includes("FROM public.entitlement_flow_grants")) {
          return { rowCount: 1, rows: [{ unit_limit: testCase.current?.render_job_limit ?? 0 }] };
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

  it("denies a flow kind whose snapshot carries no grant and counts quota per operation kind", async () => {
    const withoutGrant = fakeClient((text) => {
      if (text.includes("FROM public.billing_accounts")) return { rowCount: 1, rows: [snapshotRow()] };
      if (text.includes("FROM public.usage_reservations") && text.includes("operation_id")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.entitlement_flow_grants")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      reserveFlowUsageWithClientV1(withoutGrant.client, {
        lifetimeMs: 1_000,
        operationId: OPERATION_ID,
        operationKind: "ai-suggestion",
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "operation-disabled" });

    const partitioned = fakeClient((text, values) => {
      if (text.includes("FROM public.billing_accounts")) return { rowCount: 1, rows: [snapshotRow()] };
      if (text.includes("FROM public.usage_reservations") && text.includes("operation_id")) {
        expect(values[1]).toBe("ai-suggestion");
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.entitlement_flow_grants")) {
        expect(values).toEqual([TENANT, SNAPSHOT_ID, "1", "ai-suggestion", "2026-08"]);
        return { rowCount: 1, rows: [{ unit_limit: 2 }] };
      }
      if (text.startsWith("WITH expired AS")) {
        expect(values).toEqual([TENANT, "ai-suggestion", "2026-08"]);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("count(*)::text AS consumed")) {
        expect(values).toEqual([TENANT, "ai-suggestion", "2026-08"]);
        return { rowCount: 1, rows: [{ consumed: "1" }] };
      }
      if (text.startsWith("WITH reservation_clock AS")) {
        expect(values[1]).toBe("ai-suggestion");
        return { rowCount: 1, rows: [reservationRow("reserved", { operation_kind: "ai-suggestion" })] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      reserveFlowUsageWithClientV1(partitioned.client, {
        lifetimeMs: 1_000,
        operationId: OPERATION_ID,
        operationKind: "ai-suggestion",
        tenantId: TENANT,
      }),
    ).resolves.toMatchObject({
      kind: "reserved",
      replayed: false,
      reservation: { operationKind: "ai-suggestion" },
    });
  });

  it("admits stock by summing unreleased allocations under the account lock and rejects over-limit growth", async () => {
    const queries: string[] = [];
    const overLimit = fakeClient((text, values) => {
      queries.push(text);
      if (text.includes("FROM public.billing_accounts")) {
        expect(text).toContain("FOR UPDATE OF account");
        return { rowCount: 1, rows: [snapshotRow()] };
      }
      if (text.includes("FROM public.stock_allocations") && text.includes("publication_id = $3::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.entitlement_stock_grants")) {
        expect(values).toEqual([TENANT, SNAPSHOT_ID, "1", "published-artifact-bytes"]);
        return { rowCount: 1, rows: [{ quantity_limit: "1000" }] };
      }
      if (text.includes("COALESCE(sum(allocation.quantity), 0)")) {
        expect(text).toContain("released_at IS NULL");
        return { rowCount: 1, rows: [{ allocated: "600" }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      allocateStockWithClientV1(overLimit.client, {
        publicationId: OPERATION_ID,
        quantity: 500,
        resourceKind: "published-artifact-bytes",
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "quota-exhausted" });
    expect(queries.some((text) => text.startsWith("INSERT INTO public.stock_allocations"))).toBe(false);

    const admitted = fakeClient((text) => {
      if (text.includes("FROM public.billing_accounts")) return { rowCount: 1, rows: [snapshotRow()] };
      if (text.includes("FROM public.stock_allocations") && text.includes("publication_id = $3::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.entitlement_stock_grants")) {
        return { rowCount: 1, rows: [{ quantity_limit: "1000" }] };
      }
      if (text.includes("COALESCE(sum(allocation.quantity), 0)")) return { rowCount: 1, rows: [{ allocated: "600" }] };
      if (text.startsWith("INSERT INTO public.stock_allocations")) {
        return {
          rowCount: 1,
          rows: [
            {
              allocated_at: CREATED_AT,
              publication_id: OPERATION_ID,
              quantity: "400",
              released_at: null,
              resource_kind: "published-artifact-bytes",
              tenant_id: TENANT,
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      allocateStockWithClientV1(admitted.client, {
        publicationId: OPERATION_ID,
        quantity: 400,
        resourceKind: "published-artifact-bytes",
        tenantId: TENANT,
      }),
    ).resolves.toMatchObject({ allocation: { quantity: 400, releasedAt: null }, kind: "allocated", replayed: false });
  });

  it.each([
    ["access has expired", { access_expired: true }],
    ["period has not started", { period_inactive: true }],
  ] as const)("denies new stock when entitlement %s under the billing-account lock", async (_condition, flags) => {
    const queries: string[] = [];
    const expired = fakeClient((text) => {
      queries.push(text);
      if (text.includes("FROM public.billing_accounts")) {
        expect(text).toContain("access_until <= clock_timestamp() AS access_expired");
        expect(text).toContain("clock_timestamp() < snapshot.period_start AS period_inactive");
        expect(text).toContain("FOR UPDATE OF account");
        return { rowCount: 1, rows: [snapshotRow(flags)] };
      }
      if (text.includes("FROM public.stock_allocations") && text.includes("publication_id = $3::uuid")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      allocateStockWithClientV1(expired.client, {
        publicationId: OPERATION_ID,
        quantity: 1,
        resourceKind: "published-artifact-bytes",
        tenantId: TENANT,
      }),
    ).resolves.toEqual({ kind: "denied", reason: "expired" });
    expect(queries.some((text) => text.includes("FROM public.entitlement_stock_grants"))).toBe(false);
    expect(queries.some((text) => text.includes("COALESCE(sum(allocation.quantity), 0)"))).toBe(false);
  });

  it("releases a stock allocation once and replays the release idempotently", async () => {
    const released = new Date(CREATED_AT.getTime() + 1_000);
    for (const [existingReleasedAt, replayed] of [
      [null, false],
      [released, true],
    ] as const) {
      const fixture = fakeClient((text) => {
        if (text.includes("FROM public.stock_allocations")) {
          return {
            rowCount: 1,
            rows: [
              {
                allocated_at: CREATED_AT,
                publication_id: OPERATION_ID,
                quantity: "400",
                released_at: existingReleasedAt,
                resource_kind: "published-artifact-bytes",
                tenant_id: TENANT,
              },
            ],
          };
        }
        if (text.startsWith("UPDATE public.stock_allocations")) {
          expect(existingReleasedAt).toBeNull();
          return {
            rowCount: 1,
            rows: [
              {
                allocated_at: CREATED_AT,
                publication_id: OPERATION_ID,
                quantity: "400",
                released_at: released,
                resource_kind: "published-artifact-bytes",
                tenant_id: TENANT,
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      });
      await expect(
        releaseStockWithClientV1(fixture.client, {
          publicationId: OPERATION_ID,
          resourceKind: "published-artifact-bytes",
          tenantId: TENANT,
        }),
      ).resolves.toMatchObject({ allocation: { releasedAt: released }, kind: "released", replayed });
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
      if (text.includes("FROM public.entitlement_flow_grants")) {
        expect(values).toEqual([TENANT, SNAPSHOT_ID, "1", "render", "2026-08"]);
        return { rowCount: 1, rows: [{ unit_limit: 1 }] };
      }
      if (text.startsWith("WITH expired AS")) {
        expect(text).not.toContain("ON CONFLICT");
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("count(*)::text AS consumed")) {
        expect(values).toEqual([TENANT, "render", "2026-08"]);
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
