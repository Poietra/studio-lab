import { describe, expect, it } from "vitest";

import {
  createStripeCheckoutPlanCatalogV1,
  DEFAULT_PRO_AI_SUGGESTION_LIMIT_V1,
  DEFAULT_PRO_EXPORT_PUBLICATION_LIMIT_V1,
  DEFAULT_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT_V1,
} from "./plan-catalog";

describe("fixed Stripe Checkout plan catalog", () => {
  it("maps the public pro key and configured Stripe price in both directions", () => {
    const catalog = createStripeCheckoutPlanCatalogV1({
      pro: { renderJobLimit: 250, stripePriceId: "price_1234567890" },
    });

    expect(catalog.byPlanKey("pro")).toEqual({
      aiSuggestionLimit: DEFAULT_PRO_AI_SUGGESTION_LIMIT_V1,
      exportPublicationLimit: DEFAULT_PRO_EXPORT_PUBLICATION_LIMIT_V1,
      planKey: "pro",
      publishedArtifactBytesLimit: DEFAULT_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT_V1,
      renderJobLimit: 250,
      stripePriceId: "price_1234567890",
    });
    expect(catalog.byStripePriceId("price_1234567890")).toEqual(catalog.byPlanKey("pro"));
    expect(catalog.byPlanKey("client-selected-enterprise")).toBeNull();
    expect(catalog.byStripePriceId("price_attacker_supplied")).toBeNull();
  });

  it("accepts explicit billing v2 grant limits, including a disabling zero", () => {
    const catalog = createStripeCheckoutPlanCatalogV1({
      pro: {
        aiSuggestionLimit: 25,
        exportPublicationLimit: 0,
        publishedArtifactBytesLimit: 1_073_741_824,
        renderJobLimit: 10,
        stripePriceId: "price_1234567890",
      },
    });

    expect(catalog.byPlanKey("pro")).toMatchObject({
      aiSuggestionLimit: 25,
      exportPublicationLimit: 0,
      publishedArtifactBytesLimit: 1_073_741_824,
    });
  });

  it.each([
    { pro: { renderJobLimit: 0, stripePriceId: "price_1234567890" } },
    { pro: { renderJobLimit: 1_000_001, stripePriceId: "price_1234567890" } },
    { pro: { renderJobLimit: 10, stripePriceId: "prod_not_a_price" } },
    { pro: { renderJobLimit: 10, stripePriceId: "price_1234567890" }, starter: {} },
    { pro: { aiSuggestionLimit: -1, renderJobLimit: 10, stripePriceId: "price_1234567890" } },
    { pro: { exportPublicationLimit: 1_000_001, renderJobLimit: 10, stripePriceId: "price_1234567890" } },
    { pro: { publishedArtifactBytesLimit: 0.5, renderJobLimit: 10, stripePriceId: "price_1234567890" } },
  ])("rejects an invalid or expanded startup catalog", (value) => {
    expect(() => createStripeCheckoutPlanCatalogV1(value)).toThrow();
  });
});
