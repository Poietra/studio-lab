import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
  const invitation = limiter();
  const organization = limiter();
  return {
    callback,
    invitation,
    organization,
    start,
    value: {
      HYPERDRIVE: { connectionString: "postgresql://user:password@database.example:5432/poietra" },
      INVITATION_MUTATION_RATE_LIMITER: invitation.binding,
      ORGANIZATION_MUTATION_RATE_LIMITER: organization.binding,
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

function accountSwitchRequest() {
  return new Request(`${origin}/api/account/session`, {
    body: JSON.stringify({
      expectedVersion: 1,
      mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
      organizationId: "organization-a",
    }),
    headers: {
      "content-type": "application/json",
      cookie: `__Host-poietra_session=${opaqueToken}`,
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "PATCH",
  });
}

function logoutRequest() {
  return new Request(`${origin}/api/account/logout`, {
    headers: { cookie: `__Host-poietra_session=${opaqueToken}`, origin, "sec-fetch-site": "same-origin" },
    method: "POST",
  });
}

function invitationRequest() {
  return new Request(`${origin}/api/account/invitations`, {
    body: JSON.stringify({ email: "member@example.com", role: "member" }),
    headers: {
      "content-type": "application/json",
      cookie: `__Host-poietra_session=${opaqueToken}`,
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
  });
}

function invitationRevokeRequest() {
  return new Request(`${origin}/api/account/invitations/00000000-0000-4000-8000-000000000001`, {
    headers: {
      cookie: `__Host-poietra_session=${opaqueToken}`,
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "DELETE",
  });
}

function organizationRequest() {
  return new Request(`${origin}/api/account/organizations`, {
    body: JSON.stringify({
      displayName: "Research Team",
      expectedVersion: 1,
      mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
      organizationId: "research-team",
    }),
    headers: {
      "content-type": "application/json",
      cookie: `__Host-poietra_session=${opaqueToken}`,
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
  });
}

function invitationRateLimitKey(operation: "create" | "revoke") {
  const tokenHash = createHash("sha256").update(Buffer.from(opaqueToken, "base64url")).digest();
  const fingerprint = createHash("sha256")
    .update("poietra:account-invitation-mutation:v1\u0000", "utf8")
    .update(tokenHash)
    .digest("base64url");
  return `account-invitation:${operation}:${fingerprint}`;
}

function organizationRateLimitKey() {
  const tokenHash = createHash("sha256").update(Buffer.from(opaqueToken, "base64url")).digest();
  const fingerprint = createHash("sha256")
    .update("poietra:account-organization-mutation:v1\u0000", "utf8")
    .update(tokenHash)
    .digest("base64url");
  return `account-organization:create:${fingerprint}`;
}

function harness() {
  const forwarded = vi.fn(async () => new Response(null, { status: 204 }));
  const createControlPlane = vi.fn((_options: unknown) => ({ fetch: forwarded }));
  return {
    createControlPlane,
    forwarded,
    worker: createCloudflareAccountControlPlaneWorkerV1({ createControlPlane }),
  };
}

describe("Cloudflare OIDC account control-plane Worker", () => {
  it("routes account mutations through the production Worker template", async () => {
    const configuration = JSON.parse(
      await readFile(new URL("../wrangler.account-control-plane.example.jsonc", import.meta.url), "utf8"),
    ) as {
      ratelimits?: readonly {
        name?: unknown;
        namespace_id?: unknown;
        simple?: Readonly<{ limit?: unknown; period?: unknown }>;
      }[];
      routes?: readonly { pattern?: unknown }[];
    };

    expect(configuration.routes?.map(({ pattern }) => pattern)).toEqual(
      expect.arrayContaining([
        "https://studio.example.com/api/account/invitations",
        "https://studio.example.com/api/account/invitations/*",
        "https://studio.example.com/api/account/organizations",
      ]),
    );
    expect(configuration.ratelimits?.find(({ name }) => name === "INVITATION_MUTATION_RATE_LIMITER")).toEqual({
      name: "INVITATION_MUTATION_RATE_LIMITER",
      namespace_id: "31203",
      simple: { limit: 20, period: 60 },
    });
    expect(configuration.ratelimits?.find(({ name }) => name === "ORGANIZATION_MUTATION_RATE_LIMITER")).toEqual({
      name: "ORGANIZATION_MUTATION_RATE_LIMITER",
      namespace_id: "31204",
      simple: { limit: 5, period: 60 },
    });
  });

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
    await expect(worker.fetch(accountSwitchRequest(), env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(logoutRequest(), env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(invitationRequest(), env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(invitationRevokeRequest(), env.value)).resolves.toMatchObject({ status: 204 });
    await expect(worker.fetch(organizationRequest(), env.value)).resolves.toMatchObject({ status: 204 });

    expect(env.start.limit).toHaveBeenCalledWith({ key: "oidc:start:203.0.113.4" });
    expect(env.callback.limit).toHaveBeenCalledWith({ key: "oidc:callback:2001:db8::4" });
    expect(env.invitation.limit).toHaveBeenNthCalledWith(1, { key: invitationRateLimitKey("create") });
    expect(env.invitation.limit).toHaveBeenNthCalledWith(2, { key: invitationRateLimitKey("revoke") });
    expect(JSON.stringify(env.invitation.limit.mock.calls)).not.toContain(opaqueToken);
    expect(JSON.stringify(env.invitation.limit.mock.calls)).not.toContain("member@example.com");
    expect(env.organization.limit).toHaveBeenCalledWith({ key: organizationRateLimitKey() });
    expect(JSON.stringify(env.organization.limit.mock.calls)).not.toContain(opaqueToken);
    expect(JSON.stringify(env.organization.limit.mock.calls)).not.toContain("Research Team");
    expect(createControlPlane).toHaveBeenCalledOnce();
    expect(createControlPlane.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        invitationRepository: expect.any(Function),
        organizationRepository: expect.any(Function),
      }),
    );
    expect(forwarded).toHaveBeenNthCalledWith(1, start, env.value);
    expect(forwarded).toHaveBeenNthCalledWith(2, callback, env.value);
    expect(forwarded).toHaveBeenCalledTimes(8);
  });

  it("keeps existing account and OIDC session paths independent from the invitation limiter", async () => {
    const env = environment();
    env.value.INVITATION_MUTATION_RATE_LIMITER.limit = vi.fn(async () => {
      throw new Error("invitation limiter unavailable");
    });
    const accountOnlyEnvironment = {
      HYPERDRIVE: env.value.HYPERDRIVE,
      POIETRA_PUBLIC_ORIGIN: env.value.POIETRA_PUBLIC_ORIGIN,
    } as CloudflareAccountControlPlaneEnvironmentV1;
    const { createControlPlane, forwarded, worker } = harness();

    const responses = await Promise.all(
      [accountRequest(), accountSwitchRequest(), logoutRequest()].map((request) =>
        worker.fetch(request, accountOnlyEnvironment),
      ),
    );
    const invitation = await worker.fetch(invitationRequest(), accountOnlyEnvironment);
    const oidc = await worker.fetch(startRequest(), env.value);

    expect(responses.map(({ status }) => status)).toEqual([204, 204, 204]);
    expect(invitation.status).toBe(503);
    expect(oidc.status).toBe(204);
    expect(createControlPlane).toHaveBeenCalledOnce();
    expect(forwarded).toHaveBeenCalledTimes(4);
    expect(env.start.limit).toHaveBeenCalledOnce();
    expect(env.callback.limit).not.toHaveBeenCalled();
  });

  it("rejects malformed account requests before creating request-scoped storage", async () => {
    const env = environment();
    const { createControlPlane, worker } = harness();
    const requests = [
      new Request(`${origin}/api/account/session?organization=organization-a`),
      new Request(`${origin}/api/account/session`, { method: "POST" }),
      new Request(`${origin}/api/account/session`, { headers: { origin: "https://attacker.example" } }),
      new Request(`${origin}/api/account/logout`, {
        body: "{}",
        headers: { origin, "sec-fetch-site": "same-origin" },
        method: "POST",
      }),
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        method: "POST",
      }),
      new Request(`${origin}/api/account/organizations`, {
        body: JSON.stringify({
          displayName: "Research Team",
          expectedVersion: 1,
          mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
          organizationId: "research-team",
        }),
        headers: { "content-type": "application/json", origin: "https://attacker.example" },
        method: "POST",
      }),
    ];

    const responses = await Promise.all(requests.map((request) => worker.fetch(request, env.value)));

    expect(responses.map(({ status }) => status)).toEqual([400, 405, 403, 400, 403, 403]);
    expect(createControlPlane).not.toHaveBeenCalled();
    expect(env.start.limit).not.toHaveBeenCalled();
    expect(env.callback.limit).not.toHaveBeenCalled();
    expect(env.invitation.limit).not.toHaveBeenCalled();
    expect(env.organization.limit).not.toHaveBeenCalled();
  });

  it("rate-limits Organization creation independently and fails closed without a session", async () => {
    const env = environment();
    env.organization.limit.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const { forwarded, worker } = harness();

    const limited = await worker.fetch(organizationRequest(), env.value);
    const recovered = await worker.fetch(organizationRequest(), env.value);
    const missingSession = organizationRequest();
    missingSession.headers.delete("cookie");
    const rejected = await worker.fetch(missingSession, env.value);

    expect([limited.status, recovered.status, rejected.status]).toEqual([429, 204, 403]);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({ error: "Account organization action is not available." });
    await expect(rejected.json()).resolves.toEqual({ error: "Account organization action is not available." });
    expect(forwarded).toHaveBeenCalledOnce();
    expect(env.organization.limit).toHaveBeenCalledTimes(2);
  });

  it("fails invitation mutations closed before control-plane storage opens", async () => {
    const env = environment();
    const { createControlPlane, forwarded, worker } = harness();
    const missing = {
      ...env.value,
      INVITATION_MUTATION_RATE_LIMITER: undefined,
    } as unknown as CloudflareAccountControlPlaneEnvironmentV1;

    const missingResponse = await worker.fetch(invitationRequest(), missing);
    env.value.INVITATION_MUTATION_RATE_LIMITER.limit = vi.fn(async () => {
      throw new Error("binding unavailable");
    });
    const outageResponse = await worker.fetch(invitationRequest(), env.value);
    const malformedBindingResponse = await worker.fetch(invitationRequest(), {
      ...env.value,
      INVITATION_MUTATION_RATE_LIMITER: { limit: "not-a-function" },
    } as unknown as CloudflareAccountControlPlaneEnvironmentV1);
    const malformedResultResponse = await worker.fetch(invitationRequest(), {
      ...env.value,
      INVITATION_MUTATION_RATE_LIMITER: { limit: vi.fn(async () => ({ allowed: true })) },
    } as unknown as CloudflareAccountControlPlaneEnvironmentV1);

    expect([
      missingResponse.status,
      outageResponse.status,
      malformedBindingResponse.status,
      malformedResultResponse.status,
    ]).toEqual([503, 503, 503, 503]);
    for (const response of [missingResponse, outageResponse, malformedBindingResponse, malformedResultResponse]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: "Account invitation action is not available." });
    }
    expect(createControlPlane).not.toHaveBeenCalled();
    expect(forwarded).not.toHaveBeenCalled();
  });

  it("returns generic non-cacheable invitation denials and recovers after the edge window", async () => {
    const env = environment();
    env.invitation.limit.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const { forwarded, worker } = harness();

    const limited = await worker.fetch(invitationRequest(), env.value);
    const recovered = await worker.fetch(invitationRequest(), env.value);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    expect(limited.headers.get("vary")).toBe("Cookie");
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Account invitation action is not available." });
    expect(recovered.status).toBe(204);
    expect(forwarded).toHaveBeenCalledOnce();
  });

  it("rejects a missing invitation session before consuming the limiter", async () => {
    const env = environment();
    const { createControlPlane, worker } = harness();
    const request = invitationRequest();
    request.headers.delete("cookie");

    const response = await worker.fetch(request, env.value);

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(env.invitation.limit).not.toHaveBeenCalled();
    expect(createControlPlane).not.toHaveBeenCalled();
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
        value.OIDC_START_RATE_LIMITER.limit = vi.fn(async () => ({
          allowed: true,
        })) as unknown as CloudflareRateLimitBindingV1["limit"];
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
