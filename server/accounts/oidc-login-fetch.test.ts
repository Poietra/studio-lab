import { describe, expect, it, vi } from "vitest";

import {
  createOidcLoginFetchHandlerV1,
  OIDC_LOGIN_BINDING_COOKIE_NAME_V1,
  OIDC_LOGIN_CALLBACK_ROUTE_V1,
  OIDC_LOGIN_START_ROUTE_V1,
} from "./oidc-login-fetch";
import { OidcLoginErrorV1, type OidcLoginServiceV1 } from "./oidc-login-service";

const origin = "https://studio.example";
const token = Buffer.alloc(32, 7).toString("base64url");
const state = Buffer.alloc(32, 8).toString("base64url");

function fixture(overrides: Partial<OidcLoginServiceV1> = {}) {
  const service: OidcLoginServiceV1 = {
    close: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ sessionToken: token, sessionTtlSeconds: 600 })),
    ready: vi.fn(async () => true),
    start: vi.fn(async () => ({
      authorizationUrl: new URL("https://identity.example/authorize?request=fixed"),
      browserBindingToken: token,
      browserBindingTtlSeconds: 600,
    })),
    ...overrides,
  };
  return { handler: createOidcLoginFetchHandlerV1(service, origin), service };
}

describe("OIDC login Fetch handler", () => {
  it("starts login with a short-lived host-only binding cookie", async () => {
    const { handler, service } = fixture();
    const response = await handler.fetch(
      new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, { headers: { "sec-fetch-site": "same-origin" } }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://identity.example/authorize?request=fixed");
    expect(response.headers.getSetCookie()).toEqual([
      `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    ]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.start).toHaveBeenCalledOnce();
  });

  it("starts an invitation with 303 and never forwards the raw token to the provider URL", async () => {
    const { handler, service } = fixture();
    const invitationToken = Buffer.alloc(32, 9).toString("base64url");
    const response = await handler.fetch(
      new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, {
        body: JSON.stringify({ invitationToken }),
        headers: {
          "content-type": "application/json",
          origin,
          "sec-fetch-site": "same-origin",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://identity.example/authorize?request=fixed");
    expect(response.headers.get("location")).not.toContain(invitationToken);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(service.start).toHaveBeenCalledWith({ invitationToken }, expect.any(AbortSignal));
  });

  it("completes the callback with a new session and clears the binding", async () => {
    const { handler, service } = fixture();
    const callback = `${OIDC_LOGIN_CALLBACK_ROUTE_V1}?code=provider-code&state=${state}`;
    const response = await handler.fetch(
      new Request(`${origin}${callback}`, {
        headers: { cookie: `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${token}` },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.getSetCookie()).toEqual([
      `__Host-poietra_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    expect(service.complete).toHaveBeenCalledWith(
      { browserBindingToken: token, callbackUrl: new URL(`${origin}${callback}`), state },
      expect.any(AbortSignal),
    );
  });

  it("rejects cross-origin, cross-site, malformed, and non-GET requests before the service", async () => {
    const { handler, service } = fixture();
    const responses = await Promise.all([
      handler.fetch(new Request(`https://attacker.example${OIDC_LOGIN_START_ROUTE_V1}`)),
      handler.fetch(
        new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, { headers: { "sec-fetch-site": "cross-site" } }),
      ),
      handler.fetch(new Request(`${origin}${OIDC_LOGIN_CALLBACK_ROUTE_V1}?code=one&state=${state}&state=${state}`)),
      handler.fetch(new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, { method: "PUT" })),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([404, 403, 400, 405]);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
  });

  it("rejects malformed, cross-origin, query-carried, and oversized invitation starts", async () => {
    const { handler, service } = fixture();
    const responses = await Promise.all([
      handler.fetch(
        new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, {
          body: JSON.stringify({ invitationToken: "invalid" }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        }),
      ),
      handler.fetch(
        new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, {
          body: JSON.stringify({ invitationToken: token }),
          headers: { "content-type": "application/json", origin: "https://attacker.example" },
          method: "POST",
        }),
      ),
      handler.fetch(
        new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}?invitationToken=${token}`, {
          headers: { "sec-fetch-site": "same-origin" },
        }),
      ),
      handler.fetch(
        new Request(`${origin}${OIDC_LOGIN_START_ROUTE_V1}`, {
          body: JSON.stringify({ invitationToken: token, padding: "x".repeat(256) }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
        }),
      ),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([400, 403, 400, 413]);
    expect(service.start).not.toHaveBeenCalled();
  });

  it("does not reflect provider failures and clears callback binding", async () => {
    const secret = "SECRET_PROVIDER_RESPONSE";
    const { handler } = fixture({
      complete: vi.fn(async () => {
        throw new OidcLoginErrorV1("temporarily-unavailable", new Error(secret));
      }),
    });
    const response = await handler.fetch(
      new Request(`${origin}${OIDC_LOGIN_CALLBACK_ROUTE_V1}?code=${secret}&state=${state}`, {
        headers: { cookie: `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${token}` },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(secret);
    expect(response.headers.getSetCookie()).toEqual([
      `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
  });
});
