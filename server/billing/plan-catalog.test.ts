import { describe, expect, it } from "vitest";

import { createStripeCheckoutPlanCatalogV1 } from "./plan-catalog";

describe("fixed Stripe Checkout plan catalog", () => {
  it("maps the public pro key and configured Stripe price in both directions", () => {
    const catalog = createStripeCheckoutPlanCatalogV1({
      pro: { renderJobLimit: 250, stripePriceId: "price_1234567890" },
    });

    expect(catalog.byPlanKey("pro")).toEqual({
      planKey: "pro",
      renderJobLimit: 250,
      stripePriceId: "price_1234567890",
    });
    expect(catalog.byStripePriceId("price_1234567890")).toEqual(catalog.byPlanKey("pro"));
    expect(catalog.byPlanKey("client-selected-enterprise")).toBeNull();
    expect(catalog.byStripePriceId("price_attacker_supplied")).toBeNull();
  });

  it.each([
    { pro: { renderJobLimit: 0, stripePriceId: "price_1234567890" } },
    { pro: { renderJobLimit: 1_000_001, stripePriceId: "price_1234567890" } },
    { pro: { renderJobLimit: 10, stripePriceId: "prod_not_a_price" } },
    { pro: { renderJobLimit: 10, stripePriceId: "price_1234567890" }, starter: {} },
  ])("rejects an invalid or expanded startup catalog", (value) => {
    expect(() => createStripeCheckoutPlanCatalogV1(value)).toThrow();
  });
});
