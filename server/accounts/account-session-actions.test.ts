import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LOGOUT_ROUTE_V1,
  ACCOUNT_SESSION_ROUTE_V1,
  createAccountSessionActionFetchHandlerV1,
} from "./account-session-fetch";
import type { AccountSessionControlRepositoryV1 } from "./account-session-repository";

const origin = "https://studio.example";
const tokenBytes = Buffer.alloc(32, 17);
const token = tokenBytes.toString("base64url");
const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";
const mutation = { mutationId, organizationId: "organization-b", version: 4 };
const account = {
  activeOrganizationId: "organization-b",
  organizationSwitch: null,
  organizations: [
    { displayName: "Organization A", id: "organization-a", role: "member" as const },
    { displayName: "Organization B", id: "organization-b", role: "owner" as const },
  ],
  user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
  version: 4,
};

function fixture() {
  const repository: AccountSessionControlRepositoryV1 = {
    close: vi.fn(async () => undefined),
    listActiveOrganizationMembers: vi.fn(async () => ({ kind: "listed" as const, members: [] })),
    resolveAccountSession: vi.fn(async () => account),
    revokeAccountSession: vi.fn(async () => undefined),
    switchActiveOrganization: vi.fn(async () => ({ account, kind: "updated" as const, mutation })),
  };
  return { handler: createAccountSessionActionFetchHandlerV1(repository, origin), repository };
}

function patch(
  body = JSON.stringify({ expectedVersion: 3, mutationId, organizationId: "organization-b" }),
  headers: HeadersInit = {},
) {
  return new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, {
    body,
    headers: {
      "content-type": "application/json",
      cookie: `__Host-poietra_session=${token}`,
      origin,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    method: "PATCH",
  });
}

function logout(cookie = `__Host-poietra_session=${token}`, headers: HeadersInit = {}) {
  return new Request(`${origin}${ACCOUNT_LOGOUT_ROUTE_V1}`, {
    headers: { cookie, origin, "sec-fetch-site": "same-origin", ...headers },
    method: "POST",
  });
}

describe("account session action Fetch handler", () => {
  it("switches only through the authenticated JSON selector and returns the strict account view", async () => {
    const { handler, repository } = fixture();

    const response = await handler.fetch(patch());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeOrganization: { displayName: "Organization B", id: "organization-b", role: "owner" },
      organizations: account.organizations,
      organizationSwitch: mutation,
      user: account.user,
      version: account.version,
    });
    expect(repository.switchActiveOrganization).toHaveBeenCalledWith(
      createHash("sha256").update(tokenBytes).digest(),
      "organization-b",
      3,
      mutationId,
      expect.any(AbortSignal),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("preserves authentication and membership failure boundaries", async () => {
    const missing = fixture();
    const invalid = fixture();
    const unavailable = fixture();
    const conflict = fixture();
    vi.mocked(invalid.repository.switchActiveOrganization).mockResolvedValueOnce({ kind: "invalid-session" });
    vi.mocked(unavailable.repository.switchActiveOrganization).mockResolvedValueOnce({
      kind: "organization-unavailable",
    });
    vi.mocked(conflict.repository.switchActiveOrganization).mockResolvedValueOnce({ kind: "conflict" });

    const missingResponse = await missing.handler.fetch(
      patch(JSON.stringify({ expectedVersion: 3, mutationId, organizationId: "organization-b" }), { cookie: "" }),
    );
    const invalidResponse = await invalid.handler.fetch(patch());
    const unavailableResponse = await unavailable.handler.fetch(patch());
    const conflictResponse = await conflict.handler.fetch(patch());

    expect([
      missingResponse.status,
      invalidResponse.status,
      unavailableResponse.status,
      conflictResponse.status,
    ]).toEqual([401, 401, 403, 409]);
    expect(missing.repository.switchActiveOrganization).not.toHaveBeenCalled();
  });

  it("rejects cross-site, untyped, oversized, malformed, and ambiguous PATCH requests", async () => {
    const { handler, repository } = fixture();
    const requests = [
      patch(undefined, { origin: "https://attacker.example" }),
      patch(undefined, { "sec-fetch-site": "cross-site" }),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, {
        body: JSON.stringify({ expectedVersion: 3, mutationId, organizationId: "organization-b" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
      patch(undefined, { "content-type": "text/plain" }),
      patch("{"),
      patch(
        JSON.stringify({
          expectedVersion: 3,
          mutationId,
          organizationId: "organization-b",
          tenantId: "organization-a",
        }),
      ),
      patch(JSON.stringify({ expectedVersion: 3, mutationId, organizationId: "organization-b" }), {
        "content-length": "513",
      }),
      new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}?organizationId=organization-b`, {
        body: JSON.stringify({ expectedVersion: 3, mutationId, organizationId: "organization-b" }),
        headers: { "content-type": "application/json", origin },
        method: "PATCH",
      }),
    ];

    const responses = [];
    for (const request of requests) responses.push(await handler.fetch(request));

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 415, 400, 400, 413, 400]);
    expect(repository.switchActiveOrganization).not.toHaveBeenCalled();
  });

  it("advertises only the methods supported by each exact account route", async () => {
    const { handler } = fixture();

    const session = await handler.fetch(new Request(`${origin}${ACCOUNT_SESSION_ROUTE_V1}`, { method: "POST" }));
    const logoutResponse = await handler.fetch(new Request(`${origin}${ACCOUNT_LOGOUT_ROUTE_V1}`));

    expect(session.status).toBe(405);
    expect(session.headers.get("allow")).toBe("GET, PATCH");
    expect(logoutResponse.status).toBe(405);
    expect(logoutResponse.headers.get("allow")).toBe("POST");
  });

  it("logs out idempotently without revealing token validity", async () => {
    for (const cookie of [`__Host-poietra_session=${token}`, "", "__Host-poietra_session=malformed"]) {
      const { handler, repository } = fixture();
      const response = await handler.fetch(logout(cookie, { "content-length": "0" }));

      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toBe(
        "__Host-poietra_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      expect(repository.revokeAccountSession).toHaveBeenCalledTimes(
        cookie === `__Host-poietra_session=${token}` ? 1 : 0,
      );
    }
  });

  it("keeps the cookie retryable when storage fails and maps malformed output to 503", async () => {
    const logoutFixture = fixture();
    vi.mocked(logoutFixture.repository.revokeAccountSession).mockRejectedValueOnce(new Error("secret database detail"));
    const switchFixture = fixture();
    vi.mocked(switchFixture.repository.switchActiveOrganization).mockResolvedValueOnce({
      account: { ...account, activeOrganizationId: "organization-c" },
      kind: "updated",
      mutation,
    });

    const logoutResponse = await logoutFixture.handler.fetch(logout());
    const switchResponse = await switchFixture.handler.fetch(patch());

    expect(logoutResponse.status).toBe(503);
    expect(logoutResponse.headers.get("set-cookie")).toBeNull();
    expect(switchResponse.status).toBe(503);
    await expect(logoutResponse.text()).resolves.not.toContain("secret database detail");
  });
});
