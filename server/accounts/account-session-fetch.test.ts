import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_SESSION_ROUTE_V1, createAccountSessionFetchHandlerV1 } from "./account-session-fetch";
import type { AccountSessionViewRepositoryV1 } from "./account-session-repository";

const origin = "https://studio.example";
const tokenBytes = Buffer.alloc(32, 11);
const token = tokenBytes.toString("base64url");
const account = {
  activeOrganizationId: "organization-b",
  organizationSwitch: null,
  organizations: [
    { displayName: "Organization A", id: "organization-a", role: "billing" as const },
    { displayName: "Organization B", id: "organization-b", role: "owner" as const },
  ],
  user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
  version: 7,
};

function fixture(resolved: unknown = account) {
  const resolveAccountSession = vi.fn(
    async () => resolved as Awaited<ReturnType<AccountSessionViewRepositoryV1["resolveAccountSession"]>>,
  );
  const repository: AccountSessionViewRepositoryV1 = {
    close: vi.fn(async () => undefined),
    resolveAccountSession,
  };
  return { handler: createAccountSessionFetchHandlerV1(repository, origin), resolveAccountSession };
}

function request(cookie = `__Host-poietra_session=${token}`) {
  return new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, {
    headers: { cookie, origin, "sec-fetch-site": "same-origin" },
  });
}

describe("account session Fetch handler", () => {
  it("returns a bounded active account view without authentication material", async () => {
    const { handler, resolveAccountSession } = fixture();

    const response = await handler.fetch(request());
    const payload = await response.clone().text();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeOrganization: { displayName: "Organization B", id: "organization-b", role: "owner" },
      organizations: account.organizations,
      organizationSwitch: null,
      user: account.user,
      version: account.version,
    });
    expect(resolveAccountSession).toHaveBeenCalledWith(
      createHash("sha256").update(tokenBytes).digest(),
      expect.any(AbortSignal),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(payload).not.toContain(token);
    expect(payload).not.toContain("issuer");
    expect(payload).not.toContain("subject");
    expect(payload).not.toContain("email");
  });

  it("returns 401 before storage for missing or malformed sessions", async () => {
    for (const cookie of [
      "",
      "__Host-poietra_session=invalid",
      `__Host-poietra_session=${token}; __Host-poietra_session=${token}`,
    ]) {
      const { handler, resolveAccountSession } = fixture();
      const response = await handler.fetch(request(cookie));
      expect(response.status).toBe(401);
      expect(resolveAccountSession).not.toHaveBeenCalled();
    }
    const { handler } = fixture(null);
    await expect(handler.fetch(request())).resolves.toMatchObject({ status: 401 });
  });

  it("returns 403 when the session's selected organization is no longer active", async () => {
    const { handler } = fixture({ ...account, activeOrganizationId: "organization-c" });

    const response = await handler.fetch(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Account access is not available." });
  });

  it("maps storage and malformed persisted output to one bounded 503", async () => {
    const unavailable = fixture(account);
    unavailable.resolveAccountSession.mockRejectedValueOnce(new Error("SECRET_DATABASE_DETAIL"));
    const malformed = fixture({ ...account, organizations: [account.organizations[1], account.organizations[1]] });

    for (const handler of [unavailable.handler, malformed.handler]) {
      const response = await handler.fetch(request());
      expect(response.status).toBe(503);
      await expect(response.text()).resolves.not.toContain("SECRET_DATABASE_DETAIL");
    }
  });

  it("rejects foreign origins, selectors, bodies, and methods before storage", async () => {
    const { handler, resolveAccountSession } = fixture();
    const requests = [
      new Request(`https://attacker.example${ACCOUNT_SESSION_ROUTE_V1}`),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, { headers: { origin: "https://attacker.example" } }),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}?organization=organization-b`),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, { headers: { "content-length": "1" } }),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, { method: "POST" }),
    ];

    const responses = await Promise.all(requests.map((value) => handler.fetch(value)));

    expect(responses.map(({ status }) => status)).toEqual([404, 403, 400, 400, 405]);
    expect(responses[4]?.headers.get("allow")).toBe("GET");
    expect(resolveAccountSession).not.toHaveBeenCalled();
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
