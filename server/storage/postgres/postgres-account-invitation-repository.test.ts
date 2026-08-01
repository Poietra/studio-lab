import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM } from "./account-invitation-schema";
import { PostgresAccountInvitationRepositoryV1 } from "./postgres-account-invitation-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => handle(text, values));
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
    options: {
      connectionTimeoutMillis: 5_000,
      options: POSTGRES_REPOSITORY_OPTIONS_V1,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    },
  } as unknown as Pool;
  return { pool, query };
}

const invitationId = "00000000-0000-4000-8000-000000000001";
const sessionTokenHash = Buffer.alloc(32, 1);
const tokenDigest = Buffer.alloc(32, 2);

describe("PostgresAccountInvitationRepositoryV1", () => {
  it("requires the exact account-invitation migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 22");
      expect(values).toEqual([]);
      return { rowCount: 1, rows: [{ checksum: ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM, version: 22 }] };
    });

    await expect(new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool }).ready()).resolves.toBe(true);
  });

  it("derives tenant and owner/admin authority only from the active session", async () => {
    const expiresAt = new Date("2026-08-05T00:00:00.000Z");
    const fixture = fakePool((text, values) => {
      expect(text).toContain("session.active_tenant_id");
      expect(text).toContain("session.revoked_at IS NULL");
      expect(text).toContain("membership.role IN ('owner', 'admin')");
      expect(text).toContain("organization.status = 'active'");
      expect(text).toContain("FOR UPDATE OF membership, organization");
      expect(text).not.toContain("$7");
      expect(Buffer.compare(values[0] as Buffer, sessionTokenHash)).toBe(0);
      expect(values.slice(1, 6)).toEqual([invitationId, tokenDigest, "invited@example.com", "billing", 300_000]);
      return { rowCount: 1, rows: [{ expires_at: expiresAt, invitation_id: invitationId }] };
    });
    const repository = new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createInvitation({
        invitationId,
        lifetimeMs: 300_000,
        normalizedEmail: "invited@example.com",
        role: "billing",
        sessionTokenHash,
        tokenDigest,
      }),
    ).resolves.toEqual({ expiresAt, invitationId });
  });

  it("scopes revocation to the actor's active tenant and pending state", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("invitation.tenant_id = actor.active_tenant_id");
      expect(text).toContain("invitation.status = 'pending'");
      expect(text).toContain("status = 'revoked'");
      expect(values[1]).toBe(invitationId);
      return { rowCount: 1, rows: [{ invitation_id: invitationId }] };
    });
    const repository = new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool });

    await expect(repository.revokeInvitation({ invitationId, sessionTokenHash })).resolves.toBe(true);
  });

  it("rejects malformed secrets, unnormalized email, owner role, and lifetime before storage", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool });
    const base = {
      invitationId,
      lifetimeMs: 300_000,
      normalizedEmail: "invited@example.com",
      role: "member" as const,
      sessionTokenHash,
      tokenDigest,
    };

    await expect(repository.createInvitation({ ...base, tokenDigest: Buffer.alloc(31) })).rejects.toThrow();
    await expect(repository.createInvitation({ ...base, normalizedEmail: "Invited@example.com" })).rejects.toThrow();
    await expect(repository.createInvitation({ ...base, role: "owner" as "member" })).rejects.toThrow();
    await expect(repository.createInvitation({ ...base, lifetimeMs: 299_999 })).rejects.toThrow();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
