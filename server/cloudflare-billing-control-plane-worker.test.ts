import { describe, expect, it, vi } from "vitest";

import {
  type CloudflareBillingControlPlaneEnvironmentV1,
  type CloudflareBillingRateLimitBindingV1,
  createCloudflareBillingControlPlaneWorkerV1,
} from "./cloudflare-billing-control-plane-worker";

const origin = "https://studio.example";

function limiter(success = true) {
  const limit = vi.fn(async () => ({ success }));
  return { binding: { limit } satisfies CloudflareBillingRateLimitBindingV1, limit };
}

function environment() {
  const checkout = limiter();
  const webhook = limiter();
  return {
    checkout,
    value: {
      BILLING_CHECKOUT_RATE_LIMITER: checkout.binding,
      BILLING_WEBHOOK_RATE_LIMITER: webhook.binding,
      HYPERDRIVE: { connectionString: "postgresql://user:password@database.example:5432/poietra" },
      POIETRA_PUBLIC_ORIGIN: origin,
      POIETRA_STRIPE_EXPECTED_MODE: "test",
      POIETRA_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_poietra_portal",
      POIETRA_STRIPE_PRO_PRICE_ID: "price_poietra_pro",
      POIETRA_STRIPE_PRO_RENDER_JOB_LIMIT: "1000",
      POIETRA_STRIPE_SECRET_KEY: `sk_test_${"A".repeat(24)}`,
      POIETRA_STRIPE_WEBHOOK_SECRET: `whsec_${"B".repeat(24)}`,
    } satisfies CloudflareBillingControlPlaneEnvironmentV1,
    webhook,
  };
}

function request(pathname: string, method = "GET", ip?: string) {
  const headers = new Headers(ip ? { "cf-connecting-ip": ip } : undefined);
  if ((pathname === "/api/billing/checkout" || pathname === "/api/billing/portal") && method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("origin", origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (pathname === "/api/billing/stripe/webhook" && method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("stripe-signature", `t=1785546000,v1=${"a".repeat(64)}`);
  }
  return new Request(`${origin}${pathname}`, {
    headers,
    method,
  });
}

function harness(fetch = vi.fn(async () => new Response(null, { status: 204 }))) {
  const close = vi.fn(async () => undefined);
  const createRequestScope = vi.fn(async () => ({ close, fetch }));
  return {
    close,
    createRequestScope,
    fetch,
    worker: createCloudflareBillingControlPlaneWorkerV1({ createRequestScope }),
  };
}

describe("Cloudflare billing control-plane Worker", () => {
  it("rejects requests outside the four exact routes before rate limiting or database scope creation", async () => {
    const env = environment();
    const { createRequestScope, worker } = harness();
    const requests = [
      request("/api/billing"),
      request("/api/billing/status?probe=1"),
      request("/api/billing/status", "POST"),
      new Request(`${origin}/api/billing/checkout`, { method: "POST" }),
      new Request(`${origin}/api/billing/stripe/webhook`, { method: "POST" }),
      new Request("https://attacker.example/api/billing/status"),
    ];

    const responses = await Promise.all(requests.map((candidate) => worker.fetch(candidate, env.value)));

    expect(responses.map((response) => response.status)).toEqual([404, 400, 405, 403, 415, 404]);
    expect(env.checkout.limit).not.toHaveBeenCalled();
    expect(env.webhook.limit).not.toHaveBeenCalled();
    expect(createRequestScope).not.toHaveBeenCalled();
  });

  it("rate-limits Checkout, Portal, and webhook with distinct keys before opening a request scope", async () => {
    const env = environment();
    const { close, createRequestScope, worker } = harness();
    const checkout = request("/api/billing/checkout", "POST", "203.0.113.8");
    const portal = request("/api/billing/portal", "POST", "203.0.113.8");
    const webhook = request("/api/billing/stripe/webhook", "POST", "2001:db8::8");

    await expect(worker.fetch(checkout, env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(portal, env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(webhook, env.value)).resolves.toMatchObject({ status: 204 });

    expect(env.checkout.limit).toHaveBeenCalledWith({ key: "billing:checkout:203.0.113.8" });
    expect(env.checkout.limit).toHaveBeenCalledWith({ key: "billing:portal:203.0.113.8" });
    expect(env.webhook.limit).toHaveBeenCalledWith({ key: "billing:webhook:2001:db8::8" });
    expect(createRequestScope).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("does not apply the mutation limits to an authenticated status read", async () => {
    const env = environment();
    const { close, createRequestScope, worker } = harness();

    await expect(worker.fetch(request("/api/billing/status"), env.value)).resolves.toMatchObject({ status: 204 });

    expect(env.checkout.limit).not.toHaveBeenCalled();
    expect(env.webhook.limit).not.toHaveBeenCalled();
    expect(createRequestScope).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns a non-cacheable 429 without opening PostgreSQL when a limiter rejects", async () => {
    const env = environment();
    env.value.BILLING_CHECKOUT_RATE_LIMITER = limiter(false).binding;
    const { createRequestScope, worker } = harness();

    const response = await worker.fetch(request("/api/billing/checkout", "POST", "203.0.113.8"), env.value);

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(createRequestScope).not.toHaveBeenCalled();
  });

  it("closes request-scoped resources and hides failures from responses", async () => {
    const env = environment();
    const fetch = vi.fn(async () => {
      throw new Error(`never expose ${env.value.POIETRA_STRIPE_SECRET_KEY}`);
    });
    const { close, worker } = harness(fetch);

    const response = await worker.fetch(request("/api/billing/status"), env.value);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.not.toContain(env.value.POIETRA_STRIPE_SECRET_KEY);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed before rate limiting when Stripe mode and secret disagree", async () => {
    const env = environment();
    const invalidEnvironment: CloudflareBillingControlPlaneEnvironmentV1 = {
      ...env.value,
      POIETRA_STRIPE_EXPECTED_MODE: "live",
    };
    const { createRequestScope, worker } = harness();

    const response = await worker.fetch(request("/api/billing/checkout", "POST", "203.0.113.8"), invalidEnvironment);

    expect(response.status).toBe(503);
    expect(env.checkout.limit).not.toHaveBeenCalled();
    expect(createRequestScope).not.toHaveBeenCalled();
  });

  it("fails closed before rate limiting when the fixed Portal configuration is missing", async () => {
    const env = environment();
    const invalidEnvironment = {
      ...env.value,
      POIETRA_STRIPE_PORTAL_CONFIGURATION_ID: "",
    };
    const { createRequestScope, worker } = harness();

    const response = await worker.fetch(request("/api/billing/portal", "POST", "203.0.113.8"), invalidEnvironment);

    expect(response.status).toBe(503);
    expect(env.checkout.limit).not.toHaveBeenCalled();
    expect(createRequestScope).not.toHaveBeenCalled();
  });
});
