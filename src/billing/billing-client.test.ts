import { afterEach, describe, expect, it, vi } from "vitest";

import { loadBillingStatusV1, startBillingPortalV1, startProCheckoutV1 } from "./billing-client";

const emptyStatus = { configured: false, entitlement: null, subscription: null };

afterEach(() => vi.unstubAllGlobals());

describe("billing browser client", () => {
  it("strictly reads local status for the selected organization", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(emptyStatus));
    vi.stubGlobal("fetch", fetch);

    await expect(loadBillingStatusV1("organization-a")).resolves.toEqual(emptyStatus);

    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/billing/status");
    expect(new Headers(init?.headers).get("x-poietra-organization-id")).toBe("organization-a");
  });

  it("starts only the fixed Pro Checkout plan", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test" }),
    );
    vi.stubGlobal("fetch", fetch);

    await startProCheckoutV1("organization-a");

    expect(fetch.mock.calls[0]![0]).toBe("/api/billing/checkout");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ body: '{"planKey":"pro"}', method: "POST" });
  });

  it("opens the portal without accepting customer or configuration input", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ portalUrl: "https://billing.stripe.com/p/session/test" }),
    );
    vi.stubGlobal("fetch", fetch);

    await startBillingPortalV1("organization-a");

    expect(fetch.mock.calls[0]![0]).toBe("/api/billing/portal");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ body: "{}", method: "POST" });
  });

  it("rejects extra fields and oversized responses", async () => {
    const fetch = vi
      .fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => Response.json(emptyStatus))
      .mockResolvedValueOnce(Response.json({ ...emptyStatus, remainingRenders: 20 }))
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "32769" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadBillingStatusV1("organization-a")).rejects.toThrow("invalid response");
    await expect(loadBillingStatusV1("organization-a")).rejects.toThrow("oversized response");
  });
});
