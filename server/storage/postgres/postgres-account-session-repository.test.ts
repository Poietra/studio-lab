import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
import { PostgresAccountSessionRepositoryV1 } from "./postgres-account-session-repository";
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

describe("PostgresAccountSessionRepositoryV1", () => {
  it("requires the exact account-session migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 12");
      expect(values).toEqual([]);
      return { rowCount: 1, rows: [{ checksum: ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM, version: 12 }] };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("resolves only an unexpired, unrevoked session for an active user", async () => {
    const hash = Buffer.alloc(32, 9);
    const fixture = fakePool((text, values) => {
      expect(text).toContain("session.revoked_at IS NULL");
      expect(text).toContain("session.expires_at > clock_timestamp()");
      expect(text).toContain("account.status = 'active'");
      expect(values).toHaveLength(1);
      expect(Buffer.compare(values[0] as Buffer, hash)).toBe(0);
      return {
        rowCount: 1,
        rows: [
          {
            active_tenant_id: "organization-a",
            oidc_issuer: "https://identity.example/",
            oidc_subject: "external-user",
          },
        ],
      };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveSession(hash)).resolves.toEqual({
      issuer: "https://identity.example/",
      sessionOrganizationId: "organization-a",
      subject: "external-user",
    });
  });

  it("returns null for an unknown, expired, revoked, or inactive-user session", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveSession(Buffer.alloc(32))).resolves.toBeNull();
  });

  it("reads one bounded, deterministic account bootstrap snapshot", async () => {
    const hash = Buffer.alloc(32, 10);
    const fixture = fakePool((text, values) => {
      expect(text).toContain("session.revoked_at IS NULL");
      expect(text).toContain("session.expires_at > clock_timestamp()");
      expect(text).toContain("account.status = 'active'");
      expect(text).toContain("membership.status = 'active'");
      expect(text).toContain("organization.status = 'active'");
      expect(text).toContain('ORDER BY membership.tenant_id COLLATE "C"');
      expect(text).toContain("LIMIT 257");
      expect(values).toHaveLength(1);
      expect(Buffer.compare(values[0] as Buffer, hash)).toBe(0);
      return {
        rowCount: 2,
        rows: [
          {
            active_organization_id: "organization-b",
            organization_display_name: "Organization A",
            organization_id: "organization-a",
            organization_role: "billing",
            user_display_name: "Ada Lovelace",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
          },
          {
            active_organization_id: "organization-b",
            organization_display_name: "Organization B",
            organization_id: "organization-b",
            organization_role: "owner",
            user_display_name: "Ada Lovelace",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
          },
        ],
      };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveAccountSession(hash)).resolves.toEqual({
      activeOrganizationId: "organization-b",
      organizations: [
        { displayName: "Organization A", id: "organization-a", role: "billing" },
        { displayName: "Organization B", id: "organization-b", role: "owner" },
      ],
      user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
    });
  });

  it("keeps a valid session visible when its selected membership is inactive", async () => {
    const fixture = fakePool(() => ({
      rowCount: 1,
      rows: [
        {
          active_organization_id: "organization-b",
          organization_display_name: "Organization A",
          organization_id: "organization-a",
          organization_role: "member",
          user_display_name: "Ada Lovelace",
          user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
        },
      ],
    }));
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveAccountSession(Buffer.alloc(32))).resolves.toMatchObject({
      activeOrganizationId: "organization-b",
      organizations: [{ id: "organization-a" }],
    });
  });

  it("returns null for an invalid session and rejects malformed bootstrap rows", async () => {
    const missing = new PostgresAccountSessionRepositoryV1({
      pool: fakePool(() => ({ rowCount: 0, rows: [] })).pool,
    });
    await expect(missing.resolveAccountSession(Buffer.alloc(32))).resolves.toBeNull();

    for (const rows of [
      [
        {
          active_organization_id: "organization-a",
          organization_display_name: null,
          organization_id: "organization-a",
          organization_role: "owner",
          user_display_name: "Ada Lovelace",
          user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
        },
      ],
      [
        {
          active_organization_id: "organization-a",
          organization_display_name: "Organization B",
          organization_id: "organization-b",
          organization_role: "future-role",
          user_display_name: "Ada Lovelace",
          user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
        },
      ],
    ]) {
      const repository = new PostgresAccountSessionRepositoryV1({
        pool: fakePool(() => ({ rowCount: rows.length, rows })).pool,
      });
      await expect(repository.resolveAccountSession(Buffer.alloc(32))).rejects.toThrow();
    }
  });

  it("fails closed when the bounded query returns a 257th active organization", async () => {
    const rows = Array.from({ length: 257 }, (_, index) => {
      const organizationId = `organization-${index.toString().padStart(3, "0")}`;
      return {
        active_organization_id: "organization-000",
        organization_display_name: `Organization ${index}`,
        organization_id: organizationId,
        organization_role: "member",
        user_display_name: "Ada Lovelace",
        user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
      };
    });
    const repository = new PostgresAccountSessionRepositoryV1({
      pool: fakePool(() => ({ rowCount: rows.length, rows })).pool,
    });

    await expect(repository.resolveAccountSession(Buffer.alloc(32))).rejects.toThrow(/too many/i);
  });

  it("fails closed on duplicate or malformed persisted sessions", async () => {
    for (const rows of [
      [
        { active_tenant_id: "organization-a", oidc_issuer: "https://identity.example/", oidc_subject: "user" },
        { active_tenant_id: "organization-a", oidc_issuer: "https://identity.example/", oidc_subject: "user" },
      ],
      [{ active_tenant_id: "../organization", oidc_issuer: "https://identity.example/", oidc_subject: "user" }],
      [{ active_tenant_id: "organization-a", oidc_issuer: "", oidc_subject: "user" }],
      [{ active_tenant_id: "organization-a", oidc_issuer: "http://identity.example/", oidc_subject: "user" }],
      [{ active_tenant_id: "organization-a", oidc_issuer: "https://identity.example/", oidc_subject: "bad\nuser" }],
    ]) {
      const fixture = fakePool(() => ({ rowCount: rows.length, rows }));
      const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });
      await expect(repository.resolveActiveSession(Buffer.alloc(32))).rejects.toThrow();
    }
  });

  it("rejects non-32-byte hashes before acquiring a connection", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveSession(Buffer.alloc(31))).rejects.toThrow(/exactly 32 bytes/i);
    await expect(repository.resolveAccountSession(Buffer.alloc(31))).rejects.toThrow(/exactly 32 bytes/i);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
