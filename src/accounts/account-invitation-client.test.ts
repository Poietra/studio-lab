import { afterEach, describe, expect, it, vi } from "vitest";

import { type AccountInvitationRequestError, createAccountInvitationV1 } from "./account-invitation-client";

const invitation = {
  expiresAt: "2026-08-05T00:00:00.000Z",
  invitationId: "00000000-0000-4000-8000-000000000001",
  invitationToken: Buffer.alloc(32, 4).toString("base64url"),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account invitation browser client", () => {
  it("normalizes and sends only the strict same-origin mutation", async () => {
    const fetch = vi.fn(async () => Response.json(invitation, { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createAccountInvitationV1({ email: " Member@Example.COM ", role: "member" })).resolves.toEqual(
      invitation,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/invitations",
      expect.objectContaining({
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
        cache: "no-store",
        credentials: "same-origin",
        method: "POST",
      }),
    );
  });

  it.each([
    [403, "The invitation could not be created."],
    [429, "Too many invitation attempts. Try again later."],
    [503, "Invitation service is temporarily unavailable."],
  ])("maps status %i to a bounded message", async (status, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "SECRET" }, { status })),
    );
    await expect(createAccountInvitationV1({ email: "member@example.com", role: "member" })).rejects.toMatchObject({
      message,
      name: "AccountInvitationRequestError",
      status,
    } satisfies Partial<AccountInvitationRequestError>);
  });

  it("rejects malformed success JSON and invalid local details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...invitation, invitationToken: "invalid" }, { status: 201 })),
    );
    await expect(createAccountInvitationV1({ email: "member@example.com", role: "member" })).rejects.toThrow(
      "invalid invitation",
    );
    await expect(createAccountInvitationV1({ email: "not-an-email", role: "member" })).rejects.toThrow(
      "invitation details",
    );
  });
});
