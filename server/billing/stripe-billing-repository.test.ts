import { describe, expect, it } from "vitest";

import {
  MAX_STRIPE_EVENT_PAYLOAD_BYTES_V1,
  parseIngestStripeEventInputV1,
  parseReconcileBillingSubscriptionInputV1,
  parseReserveCanonicalObservationInputV1,
  parseReserveBillingCheckoutAttemptInputV1,
} from "./stripe-billing-repository";

const tenantId = "organization-a";
const periodStart = new Date("2026-08-01T00:00:00.000Z");
const periodEnd = new Date("2026-09-01T00:00:00.000Z");

function reconciliation() {
  return {
    cancelAtPeriodEnd: false,
    canonicalDigest: "a".repeat(64),
    canonicalRetrievedAt: new Date("2026-08-01T00:00:10.000Z"),
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
      snapshotId: "20000000-0000-4000-8000-000000000001",
      sourceGeneration: 1n,
      tenantId,
      usagePeriodKey: "stripe:sub_subscription_a:2026-08",
    },
    expectedObservationGeneration: 1n,
    expectedReconcileGeneration: 0n,
    livemode: false,
    planKey: "pro",
    sourceEventId: "evt_event_a",
    status: "active",
    stripeCustomerId: "cus_customer_a",
    stripeSubscriptionId: "sub_subscription_a",
    tenantId,
  } as const;
}

describe("Stripe billing repository contracts", () => {
  it("allows an initial Checkout correlation before Stripe assigns a customer", () => {
    expect(
      parseReserveBillingCheckoutAttemptInputV1({
        attemptId: "10000000-0000-4000-8000-000000000001",
        livemode: false,
        planKey: "pro",
        stripeCustomerId: null,
        stripePriceId: "price_checkout_a",
        tenantId,
      }),
    ).toMatchObject({ stripeCustomerId: null, tenantId });
  });

  it("owns one bounded verified webhook body", () => {
    const payloadBytes = Uint8Array.of(1, 2, 3);
    const parsed = parseIngestStripeEventInputV1({
      checkoutAttemptId: null,
      eventCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
      eventType: "customer.subscription.updated",
      livemode: false,
      payloadBytes,
      payloadDigest: "b".repeat(64),
      sourceObjectId: "sub_subscription_a",
      stripeCustomerId: "cus_customer_a",
      stripeEventId: "evt_event_a",
      stripeSubscriptionId: "sub_subscription_a",
      tenantId,
    });
    payloadBytes[0] = 9;
    expect([...parsed.payloadBytes]).toEqual([1, 2, 3]);

    expect(() =>
      parseIngestStripeEventInputV1({ ...parsed, payloadBytes: new Uint8Array(MAX_STRIPE_EVENT_PAYLOAD_BYTES_V1 + 1) }),
    ).toThrow();
  });

  it("validates the canonical observation reservation correlation", () => {
    expect(
      parseReserveCanonicalObservationInputV1({
        livemode: false,
        stripeCustomerId: "cus_customer_a",
        stripeEventId: "evt_event_a",
        tenantId,
      }),
    ).toEqual({
      livemode: false,
      stripeCustomerId: "cus_customer_a",
      stripeEventId: "evt_event_a",
      tenantId,
    });
    expect(() =>
      parseReserveCanonicalObservationInputV1({
        livemode: false,
        stripeCustomerId: "cus_customer_a",
        stripeEventId: "not-an-event-id",
        tenantId,
      }),
    ).toThrow();
  });

  it("requires the entitlement to describe the same tenant, plan, and canonical period", () => {
    expect(parseReconcileBillingSubscriptionInputV1(reconciliation())).toMatchObject({
      entitlement: { planKey: "pro", sourceGeneration: 1n },
      expectedObservationGeneration: 1n,
      expectedReconcileGeneration: 0n,
    });
    expect(() =>
      parseReconcileBillingSubscriptionInputV1({
        ...reconciliation(),
        entitlement: { ...reconciliation().entitlement, planKey: "other" },
      }),
    ).toThrow(/does not describe/i);
    expect(() =>
      parseReconcileBillingSubscriptionInputV1({
        ...reconciliation(),
        entitlement: { ...reconciliation().entitlement, periodEnd: new Date("2026-10-01T00:00:00.000Z") },
      }),
    ).toThrow(/does not describe/i);
  });
});
