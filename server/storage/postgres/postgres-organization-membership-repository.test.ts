import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
import { PostgresOrganizationMembershipRepositoryV1 } from "./postgres-organization-membership-repository";
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

const identity = { issuer: "https://identity.example/", subject: "oidc-user-a" };

describe("PostgresOrganizationMembershipRepositoryV1", () => {
  it("requires the exact account and organization migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 11");
      expect(values).toEqual([]);
      return {
        rowCount: 1,
        rows: [{ checksum: ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM, version: 11 }],
      };
    });
    const repository = new PostgresOrganizationMembershipRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("resolves only an active identity, organization, and membership", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("account.status = 'active'");
      expect(text).toContain("membership.status = 'active'");
      expect(text).toContain("organization.status = 'active'");
      expect(values).toEqual([identity.issuer, identity.subject, "organization-a"]);
      return {
        rowCount: 1,
        rows: [
          {
            organization_id: "organization-a",
            role: "member",
            user_id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
            version: "4",
          },
        ],
      };
    });
    const repository = new PostgresOrganizationMembershipRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveMembership(identity, "organization-a")).resolves.toEqual({
      organizationId: "organization-a",
      role: "member",
      userId: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
      version: 4n,
    });
  });

  it("returns null when the selected organization has no active membership", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresOrganizationMembershipRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveMembership(identity, "organization-b")).resolves.toBeNull();
  });

  it("fails closed on duplicate or malformed persisted membership rows", async () => {
    for (const rows of [
      [
        { organization_id: "organization-a", role: "member", user_id: "user-a", version: "1" },
        { organization_id: "organization-a", role: "member", user_id: "user-a", version: "1" },
      ],
      [{ organization_id: "organization-a", role: "super-admin", user_id: "user-a", version: "1" }],
      [{ organization_id: "organization-b", role: "member", user_id: "user-a", version: "1" }],
    ]) {
      const fixture = fakePool(() => ({ rowCount: rows.length, rows }));
      const repository = new PostgresOrganizationMembershipRepositoryV1({ pool: fixture.pool });
      await expect(repository.resolveActiveMembership(identity, "organization-a")).rejects.toThrow();
    }
  });

  it("rejects invalid selectors before acquiring a connection", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresOrganizationMembershipRepositoryV1({ pool: fixture.pool });

    await expect(repository.resolveActiveMembership(identity, "../organization")).rejects.toThrow(
      /organization id is invalid/i,
    );
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
