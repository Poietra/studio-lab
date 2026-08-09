import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM } from "./account-organization-switch-mutation-schema";
import { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
import { PostgresAccountSessionRepositoryV1 } from "./postgres-account-session-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;
const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";

function fakePool(handle: (text: string, values: readonly unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config(")) {
      return { rowCount: null, rows: [] };
    }
    if (text.startsWith("SELECT 1") && text.includes("FOR UPDATE OF session")) {
      return { rowCount: 1, rows: [{ locked: 1 }] };
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

describe("PostgresAccountSessionRepositoryV1", () => {
  it("requires the exact account-session migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version IN (12, 28)");
      expect(values).toEqual([]);
      return {
        rowCount: 2,
        rows: [
          { checksum: ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM, version: 12 },
          { checksum: ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM, version: 28 },
        ],
      };
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
      expect(text).toContain("session.version::text AS session_version");
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
            session_version: "7",
            switch_mutation_id: mutationId,
            switch_organization_id: "organization-b",
            switch_version: "7",
          },
          {
            active_organization_id: "organization-b",
            organization_display_name: "Organization B",
            organization_id: "organization-b",
            organization_role: "owner",
            user_display_name: "Ada Lovelace",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
            session_version: "7",
            switch_mutation_id: mutationId,
            switch_organization_id: "organization-b",
            switch_version: "7",
          },
        ],
      };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveAccountSession(hash)).resolves.toEqual({
      activeOrganizationId: "organization-b",
      organizationSwitch: { mutationId, organizationId: "organization-b", version: 7 },
      organizations: [
        { displayName: "Organization A", id: "organization-a", role: "billing" },
        { displayName: "Organization B", id: "organization-b", role: "owner" },
      ],
      user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
      version: 7,
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
          session_version: "8",
        },
      ],
    }));
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveAccountSession(Buffer.alloc(32))).resolves.toMatchObject({
      activeOrganizationId: "organization-b",
      organizations: [{ id: "organization-a" }],
    });
  });

  it("switches the active organization and returns one bounded account snapshot", async () => {
    const hash = Buffer.alloc(32, 12);
    const fixture = fakePool((text, values) => {
      expect(text).toContain("membership.tenant_id = $2");
      expect(text).toContain("membership.status = 'active'");
      expect(text).toContain("organization.status = 'active'");
      expect(text).toContain("SET active_tenant_id = target.organization_id");
      expect(text).toContain("session.version = $3::bigint");
      expect(text).toContain("WHEN existing.mutation_id IS NOT NULL THEN 'updated'");
      expect(text).toContain("selected.session_version <> $3::bigint THEN 'conflict'");
      expect(text).toContain("LIMIT 257");
      expect(text).toContain("account_organization_switch_mutations");
      expect(text).toContain("mutation.session_token_hash = $1");
      expect(text).toContain("mutation.mutation_id = $4::uuid");
      expect(text).toContain("existing.organization_id <> $2");
      expect(text).toContain("existing.expected_version <> $3::bigint");
      expect(text).toContain("NOT EXISTS (SELECT 1 FROM existing_mutation)");
      expect(text).toContain("confirmed.organization_id = $2");
      expect(text).toContain("confirmed.expected_version = $3::bigint");
      expect(values).toHaveLength(4);
      expect(Buffer.compare(values[0] as Buffer, hash)).toBe(0);
      expect(values[1]).toBe("organization-b");
      expect(values[2]).toBe(7);
      expect(values[3]).toBe(mutationId);
      return {
        rowCount: 2,
        rows: [
          {
            active_organization_id: "organization-b",
            confirmed_mutation_id: mutationId,
            confirmed_organization_id: "organization-b",
            confirmed_version: "8",
            mutation_status: "updated",
            organization_display_name: "Organization A",
            organization_id: "organization-a",
            organization_role: "member",
            user_display_name: "Ada Lovelace",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
            session_version: "8",
          },
          {
            active_organization_id: "organization-b",
            confirmed_mutation_id: mutationId,
            confirmed_organization_id: "organization-b",
            confirmed_version: "8",
            mutation_status: "updated",
            organization_display_name: "Organization B",
            organization_id: "organization-b",
            organization_role: "owner",
            user_display_name: "Ada Lovelace",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
            session_version: "8",
          },
        ],
      };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.switchActiveOrganization(hash, "organization-b", 7, mutationId)).resolves.toEqual({
      account: {
        activeOrganizationId: "organization-b",
        organizationSwitch: null,
        organizations: [
          { displayName: "Organization A", id: "organization-a", role: "member" },
          { displayName: "Organization B", id: "organization-b", role: "owner" },
        ],
        user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
        version: 8,
      },
      kind: "updated",
      mutation: { mutationId, organizationId: "organization-b", version: 8 },
    });
    const statements = fixture.query.mock.calls.map(([text]) => text);
    const lockIndex = statements.findIndex(
      (text) => text.startsWith("SELECT 1") && text.includes("FOR UPDATE OF session"),
    );
    const mutationIndex = statements.findIndex((text) => text.includes("WITH selected_session AS MATERIALIZED"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(mutationIndex).toBeGreaterThan(lockIndex);
  });

  it("distinguishes invalid sessions from unavailable organization memberships", async () => {
    for (const mutationStatus of ["invalid-session", "organization-unavailable", "conflict"] as const) {
      const repository = new PostgresAccountSessionRepositoryV1({
        pool: fakePool(() => ({
          rowCount: 1,
          rows: [
            {
              active_organization_id: null,
              mutation_status: mutationStatus,
              organization_display_name: null,
              organization_id: null,
              organization_role: null,
              user_display_name: mutationStatus === "invalid-session" ? null : "Ada Lovelace",
              user_id: mutationStatus === "invalid-session" ? null : "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
              session_version: mutationStatus === "invalid-session" ? null : "7",
            },
          ],
        })).pool,
      });

      await expect(
        repository.switchActiveOrganization(Buffer.alloc(32), "organization-b", 7, mutationId),
      ).resolves.toEqual({
        kind: mutationStatus,
      });
    }
  });

  it("revokes only the selected session and treats an absent row as idempotent", async () => {
    const hash = Buffer.alloc(32, 13);
    let invocation = 0;
    const fixture = fakePool((text, values) => {
      expect(text).toContain("WHERE session_token_hash = $1");
      expect(text).toContain("AND revoked_at IS NULL");
      expect(values).toHaveLength(1);
      expect(Buffer.compare(values[0] as Buffer, hash)).toBe(0);
      invocation += 1;
      return invocation === 1 ? { rowCount: 1, rows: [{ revoked: 1 }] } : { rowCount: 0, rows: [] };
    });
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(repository.revokeAccountSession(hash)).resolves.toBeUndefined();
    await expect(repository.revokeAccountSession(hash)).resolves.toBeUndefined();
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
          session_version: "1",
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
          session_version: "1",
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
        session_version: "1",
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
    await expect(
      repository.switchActiveOrganization(Buffer.alloc(31), "organization-a", 1, mutationId),
    ).rejects.toThrow(/exactly 32 bytes/i);
    await expect(repository.revokeAccountSession(Buffer.alloc(31))).rejects.toThrow(/exactly 32 bytes/i);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects an invalid expected session version before acquiring a connection", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresAccountSessionRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.switchActiveOrganization(Buffer.alloc(32), "organization-a", 0, mutationId),
    ).rejects.toThrow(/version/i);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
