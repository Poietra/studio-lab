import { describe, expect, it, vi } from "vitest";
import {
  type CloudflareAccountControlPlaneEnvironmentV1,
  type CloudflareRateLimitBindingV1,
  createCloudflareAccountControlPlaneWorkerV1,
} from "./cloudflare-account-control-plane-worker";

const origin = "https://studio.example";
const opaqueToken = "A".repeat(43);

function limiter(success = true) {
  const limit = vi.fn(async () => ({ success }));
  return { binding: { limit } satisfies CloudflareRateLimitBindingV1, limit };
}

function environment() {
  const start = limiter();
  const callback = limiter();
  return {
    callback,
    start,
    value: {
      HYPERDRIVE: { connectionString: "postgresql://user:password@database.example:5432/poietra" },
      OIDC_CALLBACK_RATE_LIMITER: callback.binding,
      OIDC_START_RATE_LIMITER: start.binding,
      POIETRA_OIDC_CLIENT_AUTHENTICATION: "client_secret_post",
      POIETRA_OIDC_CLIENT_ID: "poietra-studio",
      POIETRA_OIDC_CLIENT_SECRET: "worker-secret",
      POIETRA_OIDC_ISSUER: "https://identity.example",
      POIETRA_PUBLIC_ORIGIN: origin,
    } satisfies CloudflareAccountControlPlaneEnvironmentV1,
  };
}

function startRequest(ip = "203.0.113.4") {
  return new Request(`${origin}/auth/oidc/start`, {
    headers: { "cf-connecting-ip": ip, "sec-fetch-site": "same-origin" },
  });
}

function callbackRequest(ip = "2001:db8::4") {
  return new Request(`${origin}/auth/oidc/callback?state=${opaqueToken}&code=authorization-code`, {
    headers: {
      "cf-connecting-ip": ip,
      cookie: `__Host-poietra_oidc_login=${opaqueToken}`,
    },
  });
}

function accountRequest() {
  return new Request(`${origin}/api/account/session`, {
    headers: { cookie: `__Host-poietra_session=${opaqueToken}`, origin, "sec-fetch-site": "same-origin" },
  });
}

function harness() {
  const forwarded = vi.fn(async () => new Response(null, { status: 204 }));
  const createControlPlane = vi.fn(() => ({ fetch: forwarded }));
  return {
    createControlPlane,
    forwarded,
    worker: createCloudflareAccountControlPlaneWorkerV1({ createControlPlane }),
  };
}

describe("Cloudflare OIDC account control-plane Worker", () => {
  it("rejects invalid requests before rate limiting or control-plane creation", async () => {
    const env = environment();
    const { createControlPlane, worker } = harness();
    const requests = [
      new Request("https://attacker.example/auth/oidc/start"),
      new Request(`${origin}/auth/oidc/start`, { method: "POST" }),
      new Request(`${origin}/auth/oidc/callback?state=invalid`),
    ];

    for (const request of requests) await worker.fetch(request, env.value);

    expect(env.start.limit).not.toHaveBeenCalled();
    expect(env.callback.limit).not.toHaveBeenCalled();
    expect(createControlPlane).not.toHaveBeenCalled();
  });

  it("uses independent route limits before forwarding accepted requests", async () => {
    const env = environment();
    const { createControlPlane, forwarded, worker } = harness();
    const start = startRequest();
    const callback = callbackRequest();

    await expect(worker.fetch(start, env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(callback, env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(accountRequest(), env.value)).resolves.toMatchObject({ status: 204 });

    expect(env.start.limit).toHaveBeenCalledWith({ key: "oidc:start:203.0.113.4" });
    expect(env.callback.limit).toHaveBeenCalledWith({ key: "oidc:callback:2001:db8::4" });
    expect(createControlPlane).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenNthCalledWith(1, start, env.value);
    expect(forwarded).toHaveBeenNthCalledWith(2, callback, env.value);
    expect(forwarded).toHaveBeenNthCalledWith(3, expect.any(Request), env.value);
  });

  it("keeps an existing account session independent from OIDC and connecting-IP bindings", async () => {
    const env = environment();
    const accountOnlyEnvironment = {
      HYPERDRIVE: env.value.HYPERDRIVE,
      POIETRA_PUBLIC_ORIGIN: env.value.POIETRA_PUBLIC_ORIGIN,
    } as CloudflareAccountControlPlaneEnvironmentV1;
    const { createControlPlane, forwarded, worker } = harness();

    const response = await worker.fetch(accountRequest(), accountOnlyEnvironment);

    expect(response.status).toBe(204);
    expect(createControlPlane).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenCalledOnce();
    expect(env.start.limit).not.toHaveBeenCalled();
    expect(env.callback.limit).not.toHaveBeenCalled();
  });

  it("rejects malformed account requests before creating request-scoped storage", async () => {
    const env = environment();
    const { createControlPlane, worker } = harness();
    const requests = [
      new Request(`${origin}/api/account/session?organization=organization-a`),
      new Request(`${origin}/api/account/session`, { method: "POST" }),
      new Request(`${origin}/api/account/session`, { headers: { origin: "https://attacker.example" } }),
    ];

    const responses = await Promise.all(requests.map((request) => worker.fetch(request, env.value)));

    expect(responses.map(({ status }) => status)).toEqual([400, 405, 403]);
    expect(createControlPlane).not.toHaveBeenCalled();
    expect(env.start.limit).not.toHaveBeenCalled();
    expect(env.callback.limit).not.toHaveBeenCalled();
  });

  it("returns a non-cacheable 429 without consuming a rejected callback", async () => {
    const env = environment();
    env.value.OIDC_CALLBACK_RATE_LIMITER = limiter(false).binding;
    const { createControlPlane, worker } = harness();

    const response = await worker.fetch(callbackRequest(), env.value);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(createControlPlane).not.toHaveBeenCalled();
  });

  it.each([
    ["missing connecting IP", (value: CloudflareAccountControlPlaneEnvironmentV1) => value, startRequest("")],
    [
      "rate limiter failure",
      (value: CloudflareAccountControlPlaneEnvironmentV1) => {
        value.OIDC_START_RATE_LIMITER.limit = vi.fn(async () => {
          throw new Error("binding unavailable");
        });
        return value;
      },
      startRequest(),
    ],
    [
      "malformed rate limiter result",
      (value: CloudflareAccountControlPlaneEnvironmentV1) => {
        value.OIDC_START_RATE_LIMITER.limit = vi.fn(async () => ({ allowed: true }));
        return value;
      },
      startRequest(),
    ],
  ])("fails closed on %s", async (_label, configure, request) => {
    const env = environment();
    const { createControlPlane, worker } = harness();

    const response = await worker.fetch(request, configure(env.value));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createControlPlane).not.toHaveBeenCalled();
  });

  it("requires both limiter bindings and deployment configuration", async () => {
    const env = environment();
    const { createControlPlane, worker } = harness();
    const missingCallbackLimiter = {
      ...env.value,
      OIDC_CALLBACK_RATE_LIMITER: undefined,
    } as unknown as CloudflareAccountControlPlaneEnvironmentV1;

    const response = await worker.fetch(startRequest(), missingCallbackLimiter);

    expect(response.status).toBe(503);
    expect(env.start.limit).not.toHaveBeenCalled();
    expect(createControlPlane).not.toHaveBeenCalled();
  });

  it("converts control-plane failures into a generic response", async () => {
    const env = environment();
    const worker = createCloudflareAccountControlPlaneWorkerV1({
      createControlPlane: () => ({
        fetch: async () => {
          throw new Error("secret provider details");
        },
      }),
    });

    const response = await worker.fetch(startRequest(), env.value);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Authentication is temporarily unavailable." });
  });
});
