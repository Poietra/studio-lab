import { describe, expect, it } from "vitest";

import {
  billingCheckoutRequestSchemaV1,
  billingCheckoutViewSchemaV1,
  billingPortalRequestSchemaV1,
  billingPortalViewSchemaV1,
  billingStatusViewSchemaV1,
} from "./billing-contract";

describe("billing browser contracts", () => {
  it("accepts the local status view and rejects unknown fields", () => {
    const status = {
      configured: true,
      entitlement: {
        accessState: "active",
        accessUntil: "2026-09-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        periodStart: "2026-08-01T00:00:00.000Z",
        planKey: "pro",
        renderEnabled: true,
        renderJobLimit: 100,
        sourceGeneration: "1",
      },
      subscription: {
        cancelAtPeriodEnd: false,
        periodEnd: "2026-09-01T00:00:00.000Z",
        periodStart: "2026-08-01T00:00:00.000Z",
        planKey: "pro",
        status: "active",
      },
    };

    expect(billingStatusViewSchemaV1.safeParse(status).success).toBe(true);
    expect(billingStatusViewSchemaV1.safeParse({ ...status, remainingRenders: 99 }).success).toBe(false);
  });

  it("keeps mutations and redirect responses minimal and strict", () => {
    expect(billingCheckoutRequestSchemaV1.parse({ planKey: "pro" })).toEqual({ planKey: "pro" });
    expect(billingPortalRequestSchemaV1.parse({})).toEqual({});
    expect(billingPortalRequestSchemaV1.safeParse({ customerId: "cus_client" }).success).toBe(false);
    expect(
      billingCheckoutViewSchemaV1.safeParse({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" }).success,
    ).toBe(true);
    expect(
      billingPortalViewSchemaV1.safeParse({ portalUrl: "https://billing.stripe.com/p/session/test" }).success,
    ).toBe(true);
    expect(billingPortalViewSchemaV1.safeParse({ portalUrl: "http://billing.stripe.com/test" }).success).toBe(false);
  });
});
