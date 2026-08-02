import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AccountInvitationRepositoryV1 } from "./account-invitation-repository";
import { createAccountInvitationServiceV1 } from "./account-invitation-service";

const invitationId = "00000000-0000-4000-8000-000000000001";
const sessionTokenHash = Buffer.alloc(32, 9);

function fixture(overrides: Partial<AccountInvitationRepositoryV1> = {}) {
  const createInvitation = vi.fn(async () => ({
    expiresAt: new Date("2026-08-05T00:00:00.000Z"),
    invitationId,
  }));
  const repository: AccountInvitationRepositoryV1 = {
    close: vi.fn(async () => undefined),
    createInvitation,
    ready: vi.fn(async () => true),
    revokeInvitation: vi.fn(async () => true),
    ...overrides,
  };
  return {
    createInvitation,
    repository,
    service: createAccountInvitationServiceV1(repository, {
      randomBytes: () => Buffer.alloc(32, 7),
      randomUuid: () => invitationId,
    }),
  };
}

describe("account invitation service", () => {
  it("returns the raw token once while storing only its digest and normalized authority", async () => {
    const { createInvitation, service } = fixture();

    await expect(
      service.create({ email: "  Invited.User@Example.COM ", role: "admin", sessionTokenHash }),
    ).resolves.toEqual({
      expiresAt: "2026-08-05T00:00:00.000Z",
      invitationId,
      invitationToken: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(createInvitation).toHaveBeenCalledWith(
      {
        invitationId,
        lifetimeMs: 72 * 60 * 60_000,
        normalizedEmail: "invited.user@example.com",
        role: "admin",
        sessionTokenHash,
        tokenDigest: new Uint8Array(createHash("sha256").update(Buffer.alloc(32, 7)).digest()),
      },
      undefined,
    );
  });

  it("does not disclose a token when the repository denies the actor", async () => {
    const createInvitation = vi.fn(async () => null);
    const { service } = fixture({ createInvitation });

    await expect(service.create({ email: "member@example.com", role: "member", sessionTokenHash })).resolves.toBeNull();
  });

  it("rejects owner invitations, malformed email, and out-of-range lifetimes before storage", async () => {
    const { createInvitation, service } = fixture();

    await expect(
      service.create({ email: "owner@example.com", role: "owner" as "admin", sessionTokenHash }),
    ).rejects.toThrow();
    await expect(service.create({ email: "invalid", role: "member", sessionTokenHash })).rejects.toThrow();
    await expect(
      service.create({ email: "member@example.com", lifetimeMs: 299_999, role: "member", sessionTokenHash }),
    ).rejects.toThrow();
    expect(createInvitation).not.toHaveBeenCalled();
  });

  it("delegates revocation and closes storage idempotently", async () => {
    const { repository, service } = fixture();

    await expect(service.revoke({ invitationId, sessionTokenHash })).resolves.toBe(true);
    await service.close();
    await service.close();
    expect(repository.revokeInvitation).toHaveBeenCalledWith({ invitationId, sessionTokenHash }, undefined);
    expect(repository.close).toHaveBeenCalledOnce();
  });
});
