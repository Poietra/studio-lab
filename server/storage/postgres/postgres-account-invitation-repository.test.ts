import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_INVITATION_ISSUANCE_WINDOW_MS_V1,
  ACCOUNT_INVITATION_MAX_ACTOR_ISSUANCE_PER_WINDOW_V1,
  ACCOUNT_INVITATION_MAX_PENDING_PER_TENANT_V1,
  ACCOUNT_INVITATION_MAX_TENANT_ISSUANCE_PER_WINDOW_V1,
} from "../../accounts/account-invitation-repository";
import { ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_CHECKSUM } from "./account-invitation-quota-schema";
import { PostgresAccountInvitationRepositoryV1 } from "./postgres-account-invitation-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    return handle(text, values);
  });
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
const actorId = "00000000-0000-4000-8000-000000000002";
const tenantId = "tenant-a";
const sessionTokenHash = Buffer.alloc(32, 1);
const tokenDigest = Buffer.alloc(32, 2);

function actorRow() {
  return { active_tenant_id: tenantId, user_id: actorId };
}

function quotaRow(
  overrides: Partial<Record<"actor_window_count" | "pending_count" | "tenant_window_count", string>> = {},
) {
  return { actor_window_count: "0", pending_count: "0", tenant_window_count: "0", ...overrides };
}

describe("PostgresAccountInvitationRepositoryV1", () => {
  it("requires the exact account-invitation quota migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 24");
      expect(values).toEqual([]);
      return { rowCount: 1, rows: [{ checksum: ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_CHECKSUM, version: 24 }] };
    });

    await expect(new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool }).ready()).resolves.toBe(true);
  });

  it("derives tenant and owner/admin authority only from the active session", async () => {
    const expiresAt = new Date("2026-08-05T00:00:00.000Z");
    const operations: string[] = [];
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.account_sessions")) {
        operations.push("lock-actor");
        expect(text).toContain("session.active_tenant_id");
        expect(text).toContain("session.revoked_at IS NULL");
        expect(text).toContain("membership.role IN ('owner', 'admin')");
        expect(text).toContain("organization.status = 'active'");
        expect(text).toContain("FOR UPDATE OF account, session, membership, organization");
        expect(Buffer.compare(values[0] as Buffer, sessionTokenHash)).toBe(0);
        return { rowCount: 1, rows: [actorRow()] };
      }
      if (text.includes("AS pending_count")) {
        operations.push("check-quota");
        expect(values).toEqual([tenantId, ACCOUNT_INVITATION_ISSUANCE_WINDOW_MS_V1, actorId]);
        return { rowCount: 1, rows: [quotaRow()] };
      }
      if (text.includes("INSERT INTO public.organization_invitations")) {
        operations.push("insert");
        expect(values).toEqual([
          invitationId,
          tenantId,
          tokenDigest,
          "invited@example.com",
          "billing",
          actorId,
          300_000,
        ]);
        return { rowCount: 1, rows: [{ expires_at: expiresAt, invitation_id: invitationId }] };
      }
      throw new Error(`Unexpected query: ${text}`);
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
    expect(operations).toEqual(["lock-actor", "check-quota", "insert"]);
  });

  it.each([
    ["pending tenant", { pending_count: String(ACCOUNT_INVITATION_MAX_PENDING_PER_TENANT_V1) }],
    ["tenant issuance window", { tenant_window_count: String(ACCOUNT_INVITATION_MAX_TENANT_ISSUANCE_PER_WINDOW_V1) }],
    ["actor issuance window", { actor_window_count: String(ACCOUNT_INVITATION_MAX_ACTOR_ISSUANCE_PER_WINDOW_V1) }],
  ])("denies an exhausted %s quota without appending an audit row", async (_label, quota) => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.account_sessions")) return { rowCount: 1, rows: [actorRow()] };
      if (text.includes("AS pending_count")) return { rowCount: 1, rows: [quotaRow(quota)] };
      throw new Error(`Invitation quota denial must not insert: ${text}`);
    });
    const repository = new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createInvitation({
        invitationId,
        lifetimeMs: 300_000,
        normalizedEmail: "invited@example.com",
        role: "member",
        sessionTokenHash,
        tokenDigest,
      }),
    ).resolves.toBeNull();
    expect(
      fixture.query.mock.calls.some(([text]) => text.includes("INSERT INTO public.organization_invitations")),
    ).toBe(false);
  });

  it("releases revoked or expired invitations from pending quota and recovers below both windows", async () => {
    const expiresAt = new Date("2026-08-05T00:00:00.000Z");
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.account_sessions")) return { rowCount: 1, rows: [actorRow()] };
      if (text.includes("AS pending_count")) {
        expect(text).toContain("invitation.status = 'pending'");
        expect(text).toContain("invitation.expires_at > quota_clock.value");
        expect(text.match(/invitation\.created_at >/gu)).toHaveLength(2);
        return {
          rowCount: 1,
          rows: [
            quotaRow({
              actor_window_count: String(ACCOUNT_INVITATION_MAX_ACTOR_ISSUANCE_PER_WINDOW_V1 - 1),
              pending_count: String(ACCOUNT_INVITATION_MAX_PENDING_PER_TENANT_V1 - 1),
              tenant_window_count: String(ACCOUNT_INVITATION_MAX_TENANT_ISSUANCE_PER_WINDOW_V1 - 1),
            }),
          ],
        };
      }
      if (text.includes("INSERT INTO public.organization_invitations")) {
        return { rowCount: 1, rows: [{ expires_at: expiresAt, invitation_id: invitationId }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresAccountInvitationRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createInvitation({
        invitationId,
        lifetimeMs: 300_000,
        normalizedEmail: "invited@example.com",
        role: "member",
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
