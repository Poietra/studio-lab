import { describe, expect, it, vi } from "vitest";

import { FakeStripeBillingGatewayV1 } from "./fake-stripe-gateway";
import { createStripeCheckoutPlanCatalogV1 } from "./plan-catalog";
import { canonicalStripeSubscriptionBytesV1, STRIPE_API_VERSION_V1, StripeGatewayErrorV1 } from "./stripe-gateway";
import { createStripeHttpBillingGatewayV1 } from "./stripe-http-gateway";

const attemptId = "00000000-0000-4000-8000-000000000325";
const secretKey = "sk_test_1234567890abcdef";
const plan = createStripeCheckoutPlanCatalogV1({
  pro: { renderJobLimit: 250, stripePriceId: "price_1234567890" },
}).byPlanKey("pro")!;

const checkoutInput = {
  attemptId,
  cancelUrl: "https://studio.example/settings/billing?checkout=cancelled",
  customerId: null,
  plan,
  successUrl: "https://studio.example/settings/billing?checkout=returned",
  tenantId: "tenant-one",
} as const;

const portalInput = {
  configurationId: "bpc_1234567890",
  customerId: "cus_1234567890",
  requestId: "00000000-0000-4000-8000-000000000327",
  returnUrl: "https://studio.example/?billing=portal-return",
} as const;

function subscriptionResponse(overrides: Record<string, unknown> = {}) {
  return {
    cancel_at_period_end: false,
    customer: "cus_1234567890",
    id: "sub_1234567890",
    items: {
      data: [
        {
          current_period_end: 1_785_628_800,
          current_period_start: 1_782_950_400,
          price: { id: "price_1234567890" },
        },
      ],
      has_more: false,
    },
    livemode: false,
    object: "subscription",
    status: "active",
    ...overrides,
  };
}

describe("Stripe HTTP billing gateway", () => {
  it("creates hosted subscription Checkout from the server-selected price without granting authority", async () => {
    let requestedInit: RequestInit | undefined;
    let requestedUrl: RequestInfo | URL | undefined;
    const fetchRequest = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return Response.json({
        expires_at: 1_782_952_200,
        id: "cs_test_1234567890",
        livemode: false,
        object: "checkout.session",
        status: "open",
        url: "https://checkout.stripe.com/c/pay/cs_test_1234567890",
      });
    });
    const gateway = createStripeHttpBillingGatewayV1({ fetch: fetchRequest, secretKey });

    const session = await gateway.createCheckoutSession(checkoutInput);

    expect(Object.keys(session).sort()).toEqual(["expiresAt", "id", "livemode", "url"]);
    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1234567890");
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(requestedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(requestedInit?.method).toBe("POST");
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION_V1);
    expect(headers.get("idempotency-key")).toBe(`checkout-${attemptId}`);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${secretKey}:`)}`);
    const parameters = new URLSearchParams(requestedInit?.body as URLSearchParams);
    expect(Object.fromEntries(parameters)).toMatchObject({
      client_reference_id: attemptId,
      "line_items[0][price]": plan.stripePriceId,
      "line_items[0][quantity]": "1",
      mode: "subscription",
      "subscription_data[metadata][poietra_tenant_id]": "tenant-one",
      ui_mode: "hosted_page",
    });
    expect(parameters.has("customer")).toBe(false);
  });

  it("retrieves and normalizes the one fixed-price subscription using item billing periods", async () => {
    const fetchRequest = vi.fn(async () => Response.json(subscriptionResponse()));
    const gateway = createStripeHttpBillingGatewayV1({ fetch: fetchRequest, secretKey });

    await expect(gateway.retrieveSubscription("sub_1234567890")).resolves.toEqual({
      cancelAtPeriodEnd: false,
      customerId: "cus_1234567890",
      id: "sub_1234567890",
      livemode: false,
      periodEnd: new Date(1_785_628_800_000),
      periodStart: new Date(1_782_950_400_000),
      priceId: "price_1234567890",
      status: "active",
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/subscriptions/sub_1234567890",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("creates a correlated Customer Portal Session with only server-selected parameters", async () => {
    let requestedInit: RequestInit | undefined;
    let requestedUrl: RequestInfo | URL | undefined;
    const fetchRequest = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return Response.json({
        configuration: portalInput.configurationId,
        customer: portalInput.customerId,
        id: "bps_1234567890",
        livemode: false,
        object: "billing_portal.session",
        return_url: portalInput.returnUrl,
        url: "https://billing.stripe.com/p/session/bps_1234567890",
      });
    });
    const gateway = createStripeHttpBillingGatewayV1({ fetch: fetchRequest, secretKey });

    await expect(gateway.createPortalSession(portalInput)).resolves.toEqual({
      configurationId: portalInput.configurationId,
      customerId: portalInput.customerId,
      id: "bps_1234567890",
      livemode: false,
      returnUrl: portalInput.returnUrl,
      url: "https://billing.stripe.com/p/session/bps_1234567890",
    });
    expect(requestedUrl).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(requestedInit?.method).toBe("POST");
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get("idempotency-key")).toBe(`portal-${portalInput.requestId}`);
    expect(Object.fromEntries(new URLSearchParams(requestedInit?.body as URLSearchParams))).toEqual({
      configuration: portalInput.configurationId,
      customer: portalInput.customerId,
      return_url: portalInput.returnUrl,
    });
  });

  it("rejects a Customer Portal Session that does not match the requested binding", async () => {
    const gateway = createStripeHttpBillingGatewayV1({
      fetch: vi.fn(async () =>
        Response.json({
          configuration: portalInput.configurationId,
          customer: "cus_other_customer",
          id: "bps_1234567890",
          livemode: false,
          object: "billing_portal.session",
          return_url: portalInput.returnUrl,
          url: "https://billing.stripe.com/p/session/bps_1234567890",
        }),
      ),
      secretKey,
    });

    await expect(gateway.createPortalSession(portalInput)).rejects.toBeInstanceOf(StripeGatewayErrorV1);
  });

  it("fails closed for multiple items and unknown subscription statuses", async () => {
    const secondItem = {
      current_period_end: 1_785_628_800,
      current_period_start: 1_782_950_400,
      price: { id: "price_second_123" },
    };
    const responses = [
      subscriptionResponse({
        items: { data: [...subscriptionResponse().items.data, secondItem], has_more: false },
      }),
      subscriptionResponse({ status: "future_status_with_secret_VALUE" }),
    ];
    const gateway = createStripeHttpBillingGatewayV1({
      fetch: vi.fn(async () => Response.json(responses.shift())),
      secretKey,
    });

    await expect(gateway.retrieveSubscription("sub_1234567890")).rejects.toBeInstanceOf(StripeGatewayErrorV1);
    const error = await gateway.retrieveSubscription("sub_1234567890").catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("future_status_with_secret_VALUE");
  });

  it("does not expose Stripe error bodies or credentials", async () => {
    const providerSecret = "PROVIDER_PRIVATE_DIAGNOSTIC";
    const gateway = createStripeHttpBillingGatewayV1({
      fetch: vi.fn(async () => Response.json({ error: { message: providerSecret } }, { status: 402 })),
      secretKey,
    });

    const error = await gateway.createCheckoutSession(checkoutInput).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StripeGatewayErrorV1);
    expect(String(error)).not.toContain(providerSecret);
    expect(String(error)).not.toContain(secretKey);

    const thrownGateway = createStripeHttpBillingGatewayV1({
      fetch: vi.fn(async () => {
        throw new Error(providerSecret);
      }),
      secretKey,
    });
    const thrownError = await thrownGateway.createCheckoutSession(checkoutInput).catch((caught: unknown) => caught);
    expect(thrownError).not.toHaveProperty("cause");
    expect(String(thrownError)).not.toContain(providerSecret);
  });
});

describe("fake Stripe billing gateway", () => {
  it("records Checkout intent and serves explicitly seeded canonical subscriptions", async () => {
    const subscription = {
      cancelAtPeriodEnd: false,
      customerId: "cus_1234567890",
      id: "sub_1234567890",
      livemode: false,
      periodEnd: new Date("2026-09-01T00:00:00.000Z"),
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      priceId: "price_1234567890",
      status: "trialing" as const,
    };
    const gateway = new FakeStripeBillingGatewayV1({ subscriptions: [subscription] });

    await gateway.createCheckoutSession(checkoutInput);
    expect(gateway.checkoutRequests()).toEqual([checkoutInput]);
    await expect(gateway.retrieveSubscription(subscription.id)).resolves.toEqual(subscription);
    await expect(gateway.retrieveSubscription("sub_missing_123")).rejects.toMatchObject({
      retryable: false,
      status: 404,
    });
  });

  it("serializes parsed canonical subscription evidence in one fixed field and instant representation", () => {
    const bytes = canonicalStripeSubscriptionBytesV1({
      cancelAtPeriodEnd: false,
      customerId: "cus_1234567890",
      id: "sub_1234567890",
      livemode: false,
      periodEnd: new Date("2026-09-01T00:00:00.000Z"),
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      priceId: "price_1234567890",
      status: "active",
    });

    expect(new TextDecoder().decode(bytes)).toBe(
      '{"cancelAtPeriodEnd":false,"customerId":"cus_1234567890","id":"sub_1234567890","livemode":false,"periodEnd":"2026-09-01T00:00:00.000Z","periodStart":"2026-08-01T00:00:00.000Z","priceId":"price_1234567890","status":"active"}',
    );
  });
});
