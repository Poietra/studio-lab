import { afterEach, describe, expect, it, vi } from "vitest";

import { type AccountSessionRequestError, loadAccountSessionV1 } from "./account-session-client";

const session = {
  activeOrganization: { displayName: "Poietra", id: "organization-a", role: "owner" },
  organizations: [{ displayName: "Poietra", id: "organization-a", role: "owner" }],
  user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
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
});
