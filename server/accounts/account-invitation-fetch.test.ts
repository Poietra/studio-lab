import { describe, expect, it, vi } from "vitest";

import { createAccountInvitationFetchHandlerV1 } from "./account-invitation-fetch";
import type { AccountInvitationServiceV1 } from "./account-invitation-service";

const origin = "https://studio.example";
const invitationId = "00000000-0000-4000-8000-000000000001";
const sessionToken = Buffer.alloc(32, 3).toString("base64url");

function fixture(overrides: Partial<AccountInvitationServiceV1> = {}) {
  const service: AccountInvitationServiceV1 = {
    close: vi.fn(async () => undefined),
    create: vi.fn(async () => ({
      expiresAt: "2026-08-05T00:00:00.000Z",
      invitationId,
      invitationToken: Buffer.alloc(32, 4).toString("base64url"),
    })),
    ready: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
    ...overrides,
  };
  return { handler: createAccountInvitationFetchHandlerV1(service, origin), service };
}

function mutationHeaders() {
  return {
    "content-type": "application/json",
    cookie: `__Host-poietra_session=${sessionToken}`,
    origin,
    "sec-fetch-site": "same-origin",
  };
}

describe("account invitation Fetch handler", () => {
  it("creates a bounded invitation for an authenticated same-origin request", async () => {
    const { handler, service } = fixture();
    const response = await handler.fetch(
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: " Invited@Example.COM ", lifetimeSeconds: 600, role: "billing" }),
        headers: mutationHeaders(),
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ invitationId });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: "invited@example.com", lifetimeMs: 600_000, role: "billing" }),
      expect.any(AbortSignal),
    );
  });

  it("revokes only through an authenticated same-origin empty DELETE", async () => {
    const { handler, service } = fixture();
    const response = await handler.fetch(
      new Request(`${origin}/api/account/invitations/${invitationId}`, {
        headers: { cookie: `__Host-poietra_session=${sessionToken}`, origin, "sec-fetch-site": "same-origin" },
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(204);
    expect(service.revoke).toHaveBeenCalledWith(expect.objectContaining({ invitationId }), expect.any(AbortSignal));
  });

  it("rejects missing sessions, foreign origins, invalid email, owner role, and oversized bodies", async () => {
    const { handler, service } = fixture();
    const requests = [
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
        headers: { "content-type": "application/json", origin },
        method: "POST",
      }),
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
        headers: { ...mutationHeaders(), origin: "https://attacker.example" },
        method: "POST",
      }),
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "not-an-email", role: "member" }),
        headers: mutationHeaders(),
        method: "POST",
      }),
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "owner@example.com", role: "owner" }),
        headers: mutationHeaders(),
        method: "POST",
      }),
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: `${"x".repeat(1_024)}@example.com`, role: "member" }),
        headers: mutationHeaders(),
        method: "POST",
      }),
    ];

    const responses = await Promise.all(requests.map((request) => handler.fetch(request)));
    expect(responses.map(({ status }) => status)).toEqual([401, 403, 400, 400, 413]);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("does not disclose whether storage denied the actor or invitation", async () => {
    const create = vi.fn(async () => null);
    const revoke = vi.fn(async () => false);
    const { handler } = fixture({ create, revoke });
    const created = await handler.fetch(
      new Request(`${origin}/api/account/invitations`, {
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
        headers: mutationHeaders(),
        method: "POST",
      }),
    );
    const revoked = await handler.fetch(
      new Request(`${origin}/api/account/invitations/${invitationId}`, {
        headers: { cookie: `__Host-poietra_session=${sessionToken}`, origin },
        method: "DELETE",
      }),
    );

    expect(created.status).toBe(403);
    expect(revoked.status).toBe(404);
    expect(await created.text()).not.toContain("member@example.com");
  });
});
