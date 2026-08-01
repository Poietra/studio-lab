import { describe, expect, it, vi } from "vitest";

import {
  BILLING_CHECKOUT_ROUTE_V1,
  BILLING_PORTAL_ROUTE_V1,
  BILLING_STATUS_ROUTE_V1,
  type BillingControlPlaneServiceV1,
  createBillingControlPlaneV1,
  STRIPE_BILLING_WEBHOOK_ROUTE_V1,
} from "./billing-control-plane";
import type { ProductionRequestAdmission } from "./manim-production-server";

const ORIGIN = "https://studio.example";
const COOKIE = "__Host-poietra_session=opaque-session";
const ORGANIZATION_ID = "tenant-a";

function harness(overrides: Partial<BillingControlPlaneServiceV1> = {}) {
  const authenticate = vi.fn<ProductionRequestAdmission["authenticate"]>(async () => ({
    subjectId: "billing-user",
    tenantId: ORGANIZATION_ID,
  }));
  const admission: ProductionRequestAdmission = {
    authenticate,
    ready: async () => true,
  };
  const acceptWebhook = vi.fn<BillingControlPlaneServiceV1["acceptWebhook"]>(async () => undefined);
  const readStatus = vi.fn<BillingControlPlaneServiceV1["readStatus"]>(async () => ({
    configured: true,
    entitlement: null,
    subscription: null,
  }));
  const openPortal = vi.fn<BillingControlPlaneServiceV1["openPortal"]>(async () => ({
    portalUrl: "https://billing.stripe.com/p/session/test_portal",
  }));
  const startCheckout = vi.fn<BillingControlPlaneServiceV1["startCheckout"]>(async () => ({
    checkoutUrl: "https://checkout.stripe.com/c/pay_test",
  }));
  const service: BillingControlPlaneServiceV1 = {
    acceptWebhook,
    openPortal,
    readStatus,
    startCheckout,
    ...overrides,
  };
  return {
    acceptWebhook,
    admission,
    authenticate,
    handler: createBillingControlPlaneV1(admission, service, ORIGIN),
    openPortal,
    readStatus,
    startCheckout,
  };
}

function authenticatedHeaders(extra: Readonly<Record<string, string>> = {}) {
  return {
    cookie: COOKIE,
    "x-poietra-organization-id": ORGANIZATION_ID,
    ...extra,
  };
}

describe("billing control-plane Fetch boundary", () => {
  it("authenticates status with the session cookie and an optional exact organization selector", async () => {
    const { authenticate, handler, readStatus } = harness();
    const response = await handler.fetch(
      new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}`, {
        headers: authenticatedHeaders({ authorization: "Bearer must-not-cross-the-boundary" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ configured: true, entitlement: null, subscription: null });
    expect(authenticate).toHaveBeenCalledWith(
      {
        credentials: { cookie: COOKIE },
        directPeerAddress: null,
        forwardedHeaders: { immediatePeerTrusted: false, present: false },
        method: "GET",
        pathname: BILLING_STATUS_ROUTE_V1,
        requestedOrganizationId: ORGANIZATION_ID,
      },
      expect.any(AbortSignal),
    );
    expect(readStatus).toHaveBeenCalledWith(
      { principal: expect.objectContaining({ subjectId: "billing-user", tenantId: ORGANIZATION_ID }) },
      expect.any(AbortSignal),
    );

    expect(
      (
        await handler.fetch(
          new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}`, {
            headers: { cookie: COOKIE },
          }),
        )
      ).status,
    ).toBe(200);
    expect(authenticate.mock.calls[1]?.[0]).not.toHaveProperty("requestedOrganizationId");
  });

  it("fails closed when the service expands the public status view", async () => {
    const { handler } = harness({
      readStatus: async () =>
        ({ configured: true, entitlement: null, stripeCustomerId: "cus_must_not_leak", subscription: null }) as never,
    });
    const response = await handler.fetch(
      new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}`, { headers: authenticatedHeaders() }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Billing is temporarily unavailable." });
  });

  it("starts Checkout only for an exact same-origin strict plan request", async () => {
    const { authenticate, handler, startCheckout } = harness();
    const valid = await handler.fetch(
      new Request(`${ORIGIN}${BILLING_CHECKOUT_ROUTE_V1}`, {
        body: JSON.stringify({ planKey: "starter" }),
        headers: authenticatedHeaders({
          "content-type": "application/json; charset=utf-8",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        }),
        method: "POST",
      }),
    );

    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({ checkoutUrl: "https://checkout.stripe.com/c/pay_test" });
    expect(startCheckout).toHaveBeenCalledWith(
      {
        planKey: "starter",
        principal: expect.objectContaining({ subjectId: "billing-user", tenantId: ORGANIZATION_ID }),
      },
      expect.any(AbortSignal),
    );

    for (const request of [
      new Request(`${ORIGIN}${BILLING_CHECKOUT_ROUTE_V1}`, {
        body: JSON.stringify({ planKey: "starter" }),
        headers: authenticatedHeaders({
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }),
        method: "POST",
      }),
      new Request(`${ORIGIN}${BILLING_CHECKOUT_ROUTE_V1}`, {
        body: JSON.stringify({ planKey: "starter", priceId: "price_client_controlled" }),
        headers: authenticatedHeaders({
          "content-type": "application/json",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        }),
        method: "POST",
      }),
    ]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(request.headers.get("origin") === ORIGIN ? 400 : 403);
    }
    expect(startCheckout).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("opens Customer Portal only for an exact same-origin empty request", async () => {
    const { authenticate, handler, openPortal } = harness();
    const valid = await handler.fetch(
      new Request(`${ORIGIN}${BILLING_PORTAL_ROUTE_V1}`, {
        body: "{}",
        headers: authenticatedHeaders({
          "content-type": "application/json; charset=utf-8",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        }),
        method: "POST",
      }),
    );

    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({
      portalUrl: "https://billing.stripe.com/p/session/test_portal",
    });
    expect(openPortal).toHaveBeenCalledWith(
      { principal: expect.objectContaining({ subjectId: "billing-user", tenantId: ORGANIZATION_ID }) },
      expect.any(AbortSignal),
    );
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", pathname: BILLING_PORTAL_ROUTE_V1 }),
      expect.any(AbortSignal),
    );

    for (const request of [
      new Request(`${ORIGIN}${BILLING_PORTAL_ROUTE_V1}`, {
        body: "{}",
        headers: authenticatedHeaders({
          "content-type": "application/json",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }),
        method: "POST",
      }),
      new Request(`${ORIGIN}${BILLING_PORTAL_ROUTE_V1}`, {
        body: JSON.stringify({ customerId: "cus_client_controlled" }),
        headers: authenticatedHeaders({
          "content-type": "application/json",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        }),
        method: "POST",
      }),
    ]) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(request.headers.get("origin") === ORIGIN ? 400 : 403);
    }
    expect(openPortal).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("passes the signed webhook body byte-for-byte without session admission", async () => {
    const { acceptWebhook, authenticate, handler } = harness();
    const rawBody = new Uint8Array([0x7b, 0x22, 0x80, 0xff, 0x22, 0x7d]);
    const response = await handler.fetch(
      new Request(`${ORIGIN}${STRIPE_BILLING_WEBHOOK_ROUTE_V1}`, {
        body: rawBody,
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1722470400,v1=signature",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(authenticate).not.toHaveBeenCalled();
    expect(acceptWebhook).toHaveBeenCalledWith(
      {
        rawBody: expect.any(Uint8Array),
        stripeSignature: "t=1722470400,v1=signature",
      },
      expect.any(AbortSignal),
    );
    expect([...acceptWebhook.mock.calls[0]![0].rawBody]).toEqual([...rawBody]);
  });

  it("rejects malformed boundaries before service work and never reflects provider failures", async () => {
    const secret = "whsec_do_not_echo";
    const failed = harness({
      readStatus: async () => {
        throw new Error(secret);
      },
    });
    const failedResponse = await failed.handler.fetch(
      new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}`, { headers: authenticatedHeaders() }),
    );
    expect(failedResponse.status).toBe(503);
    expect(await failedResponse.text()).not.toContain(secret);

    const rejected = harness();
    const requests = [
      new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}?tenant=${ORGANIZATION_ID}`, {
        headers: authenticatedHeaders(),
      }),
      new Request(`${ORIGIN}${BILLING_STATUS_ROUTE_V1}`, {
        headers: authenticatedHeaders({ "x-poietra-organization-id": "tenant-a, tenant-b" }),
      }),
      new Request(`${ORIGIN}${STRIPE_BILLING_WEBHOOK_ROUTE_V1}`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      new Request(`${ORIGIN}${STRIPE_BILLING_WEBHOOK_ROUTE_V1}`, {
        body: "{}",
        headers: { "content-type": "text/plain", "stripe-signature": "t=1,v1=value" },
        method: "POST",
      }),
    ];
    for (const request of requests) expect((await rejected.handler.fetch(request)).status).toBeGreaterThanOrEqual(400);
    expect(rejected.readStatus).not.toHaveBeenCalled();
    expect(rejected.startCheckout).not.toHaveBeenCalled();
    expect(rejected.openPortal).not.toHaveBeenCalled();
    expect(rejected.acceptWebhook).not.toHaveBeenCalled();
  });
});
