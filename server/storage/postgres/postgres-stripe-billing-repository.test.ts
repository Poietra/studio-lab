import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";
import { PostgresStripeBillingRepositoryV1 } from "./postgres-stripe-billing-repository";
import { STRIPE_BILLING_MIGRATION_V16_CHECKSUM } from "./stripe-billing-schema";

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config")) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    return handle(text, values);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { pool, query };
}

const tenantId = "organization-a";
const attemptId = "10000000-0000-4000-8000-000000000001";
const snapshotId = "20000000-0000-4000-8000-000000000001";
const stripeCustomerId = "cus_customer_a";
const stripeCheckoutSessionId = "cs_test_checkout_a";
const stripeEventId = "evt_event_a";
const stripeSubscriptionId = "sub_subscription_a";
const createdAt = new Date("2026-08-01T00:00:00.000Z");
const expiresAt = new Date("2026-08-01T01:00:00.000Z");
const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-09-01T00:00:00.000Z");
const reconciledAt = new Date("2026-08-01T00:00:20.000Z");
const canonicalDigest = "a".repeat(64);

function accountRow(
  overrides: Partial<{
    applied_generation: string;
    stripe_customer_id: string | null;
    stripe_livemode: boolean | null;
    stripe_observation_generation: string;
    stripe_reconcile_generation: string;
    stripe_reconciled_at: Date | null;
  }> = {},
) {
  return {
    applied_generation: "0",
    created_at: createdAt,
    stripe_customer_id: null,
    stripe_livemode: null,
    stripe_observation_generation: "0",
    stripe_reconcile_generation: "0",
    stripe_reconciled_at: null,
    tenant_id: tenantId,
    updated_at: createdAt,
    ...overrides,
  };
}

function checkoutRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    attempt_id: attemptId,
    created_at: createdAt,
    expires_at: expiresAt,
    plan_key: "pro",
    state: "open",
    stripe_checkout_session_id: stripeCheckoutSessionId,
    stripe_customer_id: null,
    stripe_livemode: false,
    stripe_price_id: "price_checkout_a",
    tenant_id: tenantId,
    ...overrides,
  };
}

function eventRow(payload: Buffer, state: "pending" | "processed" = "pending") {
  return {
    checkout_attempt_id: null,
    event_created_at: createdAt,
    event_type: "customer.subscription.updated",
    payload_digest: createHash("sha256").update(payload).digest(),
    processed_at: state === "processed" ? reconciledAt : null,
    received_at: createdAt,
    source_object_id: stripeSubscriptionId,
    state,
    stripe_customer_id: stripeCustomerId,
    stripe_event_id: stripeEventId,
    stripe_livemode: false,
    stripe_subscription_id: stripeSubscriptionId,
    tenant_id: tenantId,
  };
}

function entitlementRow() {
  return {
    access_state: "active",
    access_until: periodEnd,
    created_at: reconciledAt,
    period_end: periodEnd,
    period_start: periodStart,
    plan_key: "pro",
    render_enabled: true,
    render_job_limit: 100,
    snapshot_id: snapshotId,
    source_generation: "1",
    tenant_id: tenantId,
    usage_period_key: "stripe:sub_subscription_a:2026-08",
  };
}

function subscriptionRow() {
  return {
    cancel_at_period_end: false,
    canonical_digest: Buffer.from(canonicalDigest, "hex"),
    canonical_retrieved_at: reconciledAt,
    created_at: reconciledAt,
    current_period_end: periodEnd,
    current_period_start: periodStart,
    entitlement_snapshot_id: snapshotId,
    entitlement_source_generation: "1",
    plan_key: "pro",
    reconcile_generation: "1",
    source_event_id: stripeEventId,
    status: "active",
    stripe_customer_id: stripeCustomerId,
    stripe_livemode: false,
    stripe_subscription_id: stripeSubscriptionId,
    tenant_id: tenantId,
    updated_at: reconciledAt,
  };
}

function reconciliation(expectedReconcileGeneration = 0n) {
  return {
    cancelAtPeriodEnd: false,
    canonicalDigest,
    canonicalRetrievedAt: reconciledAt,
    currentPeriodEnd: periodEnd,
    currentPeriodStart: periodStart,
    entitlement: {
      accessState: "active",
      accessUntil: periodEnd,
      expectedGeneration: 0n,
      periodEnd,
      periodStart,
      planKey: "pro",
      renderEnabled: true,
      renderJobLimit: 100,
      snapshotId,
      sourceGeneration: 1n,
      tenantId,
      usagePeriodKey: "stripe:sub_subscription_a:2026-08",
    },
    expectedObservationGeneration: 1n,
    expectedReconcileGeneration,
    livemode: false,
    planKey: "pro",
    sourceEventId: stripeEventId,
    status: "active",
    stripeCustomerId,
    stripeSubscriptionId,
    tenantId,
  } as const;
}

describe("PostgresStripeBillingRepositoryV1", () => {
  it("requires the exact Stripe billing and normalized entitlement migrations", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version IN (16, 32)");
      expect(values).toEqual([]);
      return {
        rowCount: 2,
        rows: [
          { checksum: STRIPE_BILLING_MIGRATION_V16_CHECKSUM, version: 16 },
          { checksum: BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM, version: 32 },
        ],
      };
    });
    const missingGrants = fakePool(() => ({
      rowCount: 1,
      rows: [{ checksum: STRIPE_BILLING_MIGRATION_V16_CHECKSUM, version: 16 }],
    }));
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });
    const repositoryMissingGrants = new PostgresStripeBillingRepositoryV1({ pool: missingGrants.pool });

    await expect(repository.ready()).resolves.toBe(true);
    await expect(repositoryMissingGrants.ready()).resolves.toBe(false);
  });

  it("persists and resolves initial Checkout correlation without a customer binding", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [accountRow()] };
      }
      if (text.includes("FROM public.billing_subscriptions subscription") && text.includes("LIMIT 1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.billing_checkout_attempts") && text.includes("state = 'expired'")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("attempt.state IN ('reserved', 'open')")) return { rowCount: 0, rows: [] };
      if (text.startsWith("INSERT INTO public.billing_checkout_attempts")) {
        return {
          rowCount: 1,
          rows: [checkoutRow({ state: "reserved", stripe_checkout_session_id: null })],
        };
      }
      if (text.startsWith("UPDATE public.billing_checkout_attempts attempt") && text.includes("state = 'open'")) {
        return { rowCount: 1, rows: [checkoutRow()] };
      }
      if (text.includes("WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid")) {
        return text.includes("FOR UPDATE")
          ? { rowCount: 1, rows: [checkoutRow({ state: "reserved", stripe_checkout_session_id: null })] }
          : { rowCount: 1, rows: [checkoutRow()] };
      }
      if (text.includes("WHERE attempt.attempt_id = $1::uuid")) {
        return { rowCount: 1, rows: [checkoutRow()] };
      }
      if (text.includes("WHERE attempt.stripe_checkout_session_id = $1")) {
        return { rowCount: 1, rows: [checkoutRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.reserveCheckoutAttempt({
        attemptId,
        livemode: false,
        planKey: "pro",
        stripeCustomerId: null,
        stripePriceId: "price_checkout_a",
        tenantId,
      }),
    ).resolves.toMatchObject({ attempt: { state: "reserved" }, kind: "reserved", replayed: false });
    await expect(
      repository.openCheckoutAttempt({ attemptId, expiresAt, stripeCheckoutSessionId, tenantId }),
    ).resolves.toMatchObject({ attempt: { state: "open" }, kind: "open", replayed: false });
    await expect(repository.readCheckoutAttempt(attemptId)).resolves.toMatchObject({
      tenantId,
      stripeCustomerId: null,
    });
    await expect(repository.readCheckoutAttemptBySessionId(stripeCheckoutSessionId)).resolves.toMatchObject({
      attemptId,
      tenantId,
    });
  });

  it("rejects a null-customer Checkout attempt after the tenant is bound", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [accountRow({ stripe_customer_id: stripeCustomerId, stripe_livemode: false })],
        };
      }
      if (text.includes("FROM public.billing_subscriptions subscription") && text.includes("LIMIT 1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.startsWith("UPDATE public.billing_checkout_attempts") && text.includes("state = 'expired'")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("attempt.state IN ('reserved', 'open')")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.reserveCheckoutAttempt({
        attemptId,
        livemode: false,
        planKey: "pro",
        stripeCustomerId: null,
        stripePriceId: "price_checkout_a",
        tenantId,
      }),
    ).resolves.toEqual({ kind: "conflict" });
    expect(
      fixture.query.mock.calls.some(([text]) =>
        String(text).startsWith("INSERT INTO public.billing_checkout_attempts"),
      ),
    ).toBe(false);
  });

  it("refuses a Checkout reservation after a subscription becomes authoritative", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [accountRow({ stripe_customer_id: stripeCustomerId, stripe_livemode: false })],
        };
      }
      if (text.includes("FROM public.billing_subscriptions subscription")) {
        return { rowCount: 1, rows: [subscriptionRow()] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.reserveCheckoutAttempt({
        attemptId,
        livemode: false,
        planKey: "pro",
        stripeCustomerId,
        stripePriceId: "price_checkout_a",
        tenantId,
      }),
    ).resolves.toEqual({ kind: "conflict" });
    expect(
      fixture.query.mock.calls.some(([text]) =>
        String(text).startsWith("INSERT INTO public.billing_checkout_attempts"),
      ),
    ).toBe(false);
  });

  it("binds one immutable customer and resolves its tenant", async () => {
    const bound = accountRow({ stripe_customer_id: stripeCustomerId, stripe_livemode: false });
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [accountRow()] };
      }
      if (text.startsWith("UPDATE public.billing_accounts account")) return { rowCount: 1, rows: [bound] };
      if (text.includes("account.stripe_customer_id = $1")) return { rowCount: 1, rows: [bound] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(repository.bindCustomer({ livemode: false, stripeCustomerId, tenantId })).resolves.toMatchObject({
      account: { stripeCustomerId, tenantId },
      kind: "bound",
      replayed: false,
    });
    await expect(repository.readAccountByStripeCustomerId(stripeCustomerId, false)).resolves.toMatchObject({
      tenantId,
    });
  });

  it("deduplicates exact raw events and fails closed on a changed payload", async () => {
    const original = Buffer.from('{"id":"evt_event_a"}');
    let inserts = 0;
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [accountRow({ stripe_customer_id: stripeCustomerId, stripe_livemode: false })],
        };
      }
      if (text.startsWith("INSERT INTO public.stripe_event_inbox")) {
        inserts += 1;
        return inserts === 1 ? { rowCount: 1, rows: [eventRow(original)] } : { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM public.stripe_event_inbox event")) {
        return { rowCount: 1, rows: [eventRow(original)] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });
    const input = {
      checkoutAttemptId: null,
      eventCreatedAt: createdAt,
      eventType: "customer.subscription.updated",
      livemode: false,
      payloadBytes: original,
      payloadDigest: createHash("sha256").update(original).digest("hex"),
      sourceObjectId: stripeSubscriptionId,
      stripeCustomerId,
      stripeEventId,
      stripeSubscriptionId,
      tenantId,
    } as const;

    await expect(repository.ingestEvent(input)).resolves.toMatchObject({ kind: "received", replayed: false });
    await expect(repository.ingestEvent(input)).resolves.toMatchObject({ kind: "received", replayed: true });
    const changed = Buffer.from('{"id":"evt_event_a","changed":true}');
    await expect(
      repository.ingestEvent({
        ...input,
        payloadBytes: changed,
        payloadDigest: createHash("sha256").update(changed).digest("hex"),
      }),
    ).resolves.toEqual({ kind: "conflict" });

    const mismatchFixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const mismatchRepository = new PostgresStripeBillingRepositoryV1({ pool: mismatchFixture.pool });
    await expect(mismatchRepository.ingestEvent({ ...input, payloadDigest: "0".repeat(64) })).rejects.toThrow(
      /does not match/i,
    );
    expect(mismatchFixture.pool.connect).not.toHaveBeenCalled();
  });

  it("reserves a monotonic canonical observation only for the correlated pending event", async () => {
    const payload = Buffer.from('{"id":"evt_event_a"}');
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        expect(values).toEqual([tenantId]);
        return {
          rowCount: 1,
          rows: [accountRow({ stripe_customer_id: stripeCustomerId, stripe_livemode: false })],
        };
      }
      if (text.includes("FROM public.stripe_event_inbox event")) {
        expect(values).toEqual([stripeEventId, false]);
        return { rowCount: 1, rows: [eventRow(payload)] };
      }
      if (
        text.startsWith("UPDATE public.billing_accounts account") &&
        text.includes("stripe_observation_generation = stripe_observation_generation + 1")
      ) {
        expect(values).toEqual([tenantId, "0"]);
        return {
          rowCount: 1,
          rows: [
            accountRow({
              stripe_customer_id: stripeCustomerId,
              stripe_livemode: false,
              stripe_observation_generation: "1",
            }),
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.reserveCanonicalObservation({
        livemode: false,
        stripeCustomerId,
        stripeEventId,
        tenantId,
      }),
    ).resolves.toEqual({ kind: "reserved", observationGeneration: 1n });
    const texts = fixture.query.mock.calls.map(([text]) => String(text));
    expect(texts.findIndex((text) => text.includes("FROM public.billing_accounts account"))).toBeLessThan(
      texts.findIndex((text) => text.includes("FROM public.stripe_event_inbox event")),
    );
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("applies canonical subscription, entitlement, fence, and event settlement in one transaction", async () => {
    const payload = Buffer.from('{"id":"evt_event_a"}');
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [
            accountRow({
              stripe_customer_id: stripeCustomerId,
              stripe_livemode: false,
              stripe_observation_generation: "1",
            }),
          ],
        };
      }
      if (text.includes("FROM public.stripe_event_inbox event")) {
        return { rowCount: 1, rows: [eventRow(payload)] };
      }
      if (text.includes("FROM public.billing_subscriptions subscription")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.startsWith("INSERT INTO public.billing_accounts")) return { rowCount: 0, rows: [] };
      if (text.includes("SELECT applied_generation::text")) {
        return { rowCount: 1, rows: [{ applied_generation: "0" }] };
      }
      if (text.startsWith("INSERT INTO public.entitlement_snapshots")) {
        return { rowCount: 1, rows: [entitlementRow()] };
      }
      if (text.startsWith("INSERT INTO public.entitlement_flow_grants")) return { rowCount: 2, rows: [] };
      if (text.startsWith("INSERT INTO public.entitlement_stock_grants")) return { rowCount: 1, rows: [] };
      if (text.startsWith("UPDATE public.billing_accounts") && !text.includes("account\n")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.billing_subscriptions")) {
        return { rowCount: 1, rows: [subscriptionRow()] };
      }
      if (text.startsWith("UPDATE public.billing_accounts account")) {
        return {
          rowCount: 1,
          rows: [
            accountRow({
              applied_generation: "1",
              stripe_customer_id: stripeCustomerId,
              stripe_livemode: false,
              stripe_observation_generation: "1",
              stripe_reconcile_generation: "1",
              stripe_reconciled_at: reconciledAt,
            }),
          ],
        };
      }
      if (text.startsWith("UPDATE public.billing_checkout_attempts")) return { rowCount: 0, rows: [] };
      if (text.startsWith("UPDATE public.stripe_event_inbox")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(repository.reconcileSubscription(reconciliation())).resolves.toMatchObject({
      account: { entitlementGeneration: 1n, observationGeneration: 1n, reconcileGeneration: 1n },
      entitlement: { snapshotId, sourceGeneration: 1n },
      kind: "applied",
      replayed: false,
      subscription: { reconcileGeneration: 1n, stripeSubscriptionId },
    });

    const texts = fixture.query.mock.calls.map(([text]) => text as string);
    const organizationLock = texts.findIndex((text) => text.includes("FROM public.organizations"));
    const accountLock = texts.findIndex(
      (text) => text.includes("FROM public.billing_accounts account") && text.includes("FOR UPDATE"),
    );
    const snapshotWrite = texts.findIndex((text) => text.startsWith("INSERT INTO public.entitlement_snapshots"));
    const subscriptionWrite = texts.findIndex((text) => text.startsWith("INSERT INTO public.billing_subscriptions"));
    const fenceWrite = texts.findIndex((text) => text.startsWith("UPDATE public.billing_accounts account"));
    const eventWrite = texts.findIndex((text) => text.startsWith("UPDATE public.stripe_event_inbox"));
    expect(organizationLock).toBeGreaterThan(-1);
    expect(organizationLock).toBeLessThan(accountLock);
    expect(accountLock).toBeLessThan(snapshotWrite);
    expect(snapshotWrite).toBeLessThan(subscriptionWrite);
    expect(subscriptionWrite).toBeLessThan(fenceWrite);
    expect(fenceWrite).toBeLessThan(eventWrite);
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("returns a fence conflict without mutating entitlement or subscription state", async () => {
    const payload = Buffer.from('{"id":"evt_event_a"}');
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.includes("FROM public.billing_accounts account")) {
        return {
          rowCount: 1,
          rows: [
            accountRow({
              applied_generation: "2",
              stripe_customer_id: stripeCustomerId,
              stripe_livemode: false,
              stripe_observation_generation: "2",
              stripe_reconcile_generation: "2",
              stripe_reconciled_at: reconciledAt,
            }),
          ],
        };
      }
      if (text.includes("FROM public.stripe_event_inbox event")) {
        return { rowCount: 1, rows: [eventRow(payload)] };
      }
      if (text.includes("FROM public.billing_subscriptions subscription")) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(repository.reconcileSubscription(reconciliation())).resolves.toEqual({
      entitlementGeneration: 2n,
      kind: "conflict",
      observationGeneration: 2n,
      reconcileGeneration: 2n,
    });
    expect(fixture.query.mock.calls.some(([text]) => String(text).includes("entitlement_snapshots"))).toBe(false);
  });

  it("settles a pending event replay of the same canonical subscription without advancing state", async () => {
    const payload = Buffer.from('{"id":"evt_event_b"}');
    const replayEventId = "evt_event_b";
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.organizations")) return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
      if (text.includes("FROM public.billing_accounts account")) {
        return {
          rowCount: 1,
          rows: [
            accountRow({
              applied_generation: "1",
              stripe_customer_id: stripeCustomerId,
              stripe_livemode: false,
              stripe_observation_generation: "1",
              stripe_reconcile_generation: "1",
              stripe_reconciled_at: reconciledAt,
            }),
          ],
        };
      }
      if (text.includes("FROM public.stripe_event_inbox event")) {
        return { rowCount: 1, rows: [{ ...eventRow(payload), stripe_event_id: replayEventId }] };
      }
      if (text.includes("FROM public.billing_subscriptions subscription")) {
        return { rowCount: 1, rows: [subscriptionRow()] };
      }
      if (text.startsWith("UPDATE public.billing_checkout_attempts")) return { rowCount: 0, rows: [] };
      if (text.startsWith("UPDATE public.stripe_event_inbox")) {
        expect(values).toEqual([replayEventId, false]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.reconcileSubscription({ ...reconciliation(1n), sourceEventId: replayEventId }),
    ).resolves.toMatchObject({
      account: { entitlementGeneration: 1n, observationGeneration: 1n, reconcileGeneration: 1n },
      entitlement: null,
      kind: "applied",
      replayed: true,
      subscription: { reconcileGeneration: 1n, sourceEventId: stripeEventId },
    });
    const texts = fixture.query.mock.calls.map(([text]) => String(text));
    expect(texts.some((text) => text.includes("entitlement_snapshots"))).toBe(false);
    expect(texts.some((text) => text.startsWith("INSERT INTO public.billing_subscriptions"))).toBe(false);
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("reads the current local entitlement without consulting Stripe", async () => {
    const fixture = fakePool((text) => {
      expect(text).toContain("JOIN public.entitlement_snapshots");
      expect(text).toContain("snapshot.source_generation = account.applied_generation");
      return { rowCount: 1, rows: [entitlementRow()] };
    });
    const repository = new PostgresStripeBillingRepositoryV1({ pool: fixture.pool });

    await expect(repository.readCurrentEntitlement(tenantId)).resolves.toMatchObject({
      accessState: "active",
      planKey: "pro",
      renderEnabled: true,
      renderJobLimit: 100,
      sourceGeneration: 1n,
    });
  });
});
