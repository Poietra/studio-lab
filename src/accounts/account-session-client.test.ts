import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AccountSessionRequestError,
  loadAccountSessionV1,
  logoutAccountSessionV1,
  switchAccountOrganizationV1,
} from "./account-session-client";

const session = {
  activeOrganization: { displayName: "Poietra", id: "organization-a", role: "owner" },
  organizations: [
    { displayName: "Poietra", id: "organization-a", role: "owner" },
    { displayName: "Studio Team", id: "organization-b", role: "member" },
  ],
  user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
  version: 3,
};

afterEach(() => vi.unstubAllGlobals());

describe("account session client", () => {
  it("loads the strict same-origin cookie session without browser caching", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadAccountSessionV1()).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith("/api/account/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: undefined,
    });
  });

  it("surfaces an unauthenticated response without parsing an attacker-controlled body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 401 })),
    );

    await expect(loadAccountSessionV1()).rejects.toMatchObject({
      message: "Sign in is required.",
      name: "AccountSessionRequestError",
      status: 401,
    } satisfies Partial<AccountSessionRequestError>);
  });

  it("rejects malformed and open-ended successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...session, sessionToken: "must-not-cross" }), { status: 200 })),
    );

    await expect(loadAccountSessionV1()).rejects.toThrow("invalid session");
  });

  it("switches to one exact organization and requires the response to confirm it", async () => {
    const switched = {
      ...session,
      activeOrganization: { displayName: "Studio Team", id: "organization-b", role: "member" },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(switched), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(switchAccountOrganizationV1("organization-b", session.version)).resolves.toEqual(switched);
    expect(fetch).toHaveBeenCalledWith("/api/account/session", {
      body: JSON.stringify({ organizationId: "organization-b", expectedVersion: 3 }),
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "PATCH",
      signal: undefined,
    });

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }));
    await expect(switchAccountOrganizationV1("organization-b", session.version)).rejects.toThrow("did not confirm");
  });

  it("rejects an invalid expected version before issuing a switch request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(switchAccountOrganizationV1("organization-b", 0)).rejects.toThrow("account organization is invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a stale switch response for an authoritative refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 409 })),
    );

    await expect(switchAccountOrganizationV1("organization-b", session.version)).rejects.toMatchObject({
      name: "AccountSessionRequestError",
      status: 409,
    });
  });

  it("logs out without sending a request body or content type", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await expect(logoutAccountSessionV1()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/account/logout", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: "POST",
      signal: undefined,
    });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await expect(logoutAccountSessionV1()).rejects.toThrow("invalid logout response");
  });
});
