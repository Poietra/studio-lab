import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_ORGANIZATION_BOOTSTRAP_MIGRATION_V30_CHECKSUM } from "./account-organization-bootstrap-schema";
import { PostgresAccountOrganizationRepositoryV1 } from "./postgres-account-organization-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./postgres-repository-connection";

type QueryResult = Readonly<{ rowCount: number | null; rows: readonly unknown[] }>;
const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";
const userId = "6b0cd2da-7b88-4542-87ea-e48e73b33df3";

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
  return { client, pool, query };
}

function input(
  overrides: Partial<{
    displayName: string;
    expectedVersion: number;
    mutationId: string;
    organizationId: string;
    sessionTokenHash: Uint8Array;
  }> = {},
) {
  return {
    displayName: "Research Team",
    expectedVersion: 3,
    mutationId,
    organizationId: "research-team",
    sessionTokenHash: Buffer.alloc(32, 21),
    ...overrides,
  };
}

function actor(version = "3") {
  return { rowCount: 1, rows: [{ session_version: version, user_id: userId }] };
}

describe("PostgresAccountOrganizationRepositoryV1", () => {
  it("requires the exact bootstrap migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 30");
      expect(values).toEqual([]);
      return {
        rowCount: 1,
        rows: [{ checksum: ACCOUNT_ORGANIZATION_BOOTSTRAP_MIGRATION_V30_CHECKSUM, version: 30 }],
      };
    });
    const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("atomically creates the tenant, Organization, owner, active selection, and audit mutation", async () => {
    const fixture = fakePool((text, values) => {
      if (text.includes("FROM public.account_sessions session")) return actor();
      if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.account_organization_bootstrap_mutations")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("count(*)::text AS membership_count")) {
        return { rowCount: 1, rows: [{ membership_count: "2" }] };
      }
      if (text.startsWith("SELECT tenant_id FROM public.workspace_tenants")) return { rowCount: 0, rows: [] };
      if (text.startsWith("UPDATE public.account_sessions")) {
        expect(values[1]).toBe("research-team");
        expect(values[2]).toBe(3);
        return { rowCount: 1, rows: [{ session_version: "4" }] };
      }
      if (text.includes("INSERT INTO public.account_organization_bootstrap_mutations")) {
        expect(values.slice(1)).toEqual([mutationId, userId, "research-team", "Research Team", 3, 4]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.workspace_tenants")) {
        expect(values).toEqual(["research-team"]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.organizations")) {
        expect(values).toEqual(["research-team", "Research Team"]);
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO public.organization_memberships")) {
        expect(values).toEqual(["research-team", userId]);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.createOrganization(input())).resolves.toEqual({
      kind: "applied",
      mutationId,
      organization: { displayName: "Research Team", id: "research-team", role: "owner" },
      replayed: false,
      version: 4,
    });
    const statements = fixture.query.mock.calls.map(([text]) => text);
    expect(statements.findIndex((text) => text.includes("pg_advisory_xact_lock"))).toBeLessThan(
      statements.findIndex((text) => text.startsWith("SELECT tenant_id FROM public.workspace_tenants")),
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("returns an exact replay without creating or switching anything again", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.account_sessions session")) return actor("9");
      if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.account_organization_bootstrap_mutations")) {
        return {
          rowCount: 1,
          rows: [
            {
              actor_user_id: userId,
              display_name: "Research Team",
              expected_session_version: "3",
              mutation_id: mutationId,
              organization_id: "research-team",
              resulting_session_version: "4",
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.createOrganization(input())).resolves.toMatchObject({
      kind: "applied",
      replayed: true,
      version: 4,
    });
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("INSERT INTO"))).toBe(false);
    expect(fixture.query.mock.calls.some(([text]) => text.startsWith("UPDATE"))).toBe(false);
  });

  it("rejects a replay whose mutation ID is reused with another payload", async () => {
    const fixture = fakePool((text) => {
      if (text.includes("FROM public.account_sessions session")) return actor();
      if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
      if (text.includes("FROM public.account_organization_bootstrap_mutations")) {
        return {
          rowCount: 1,
          rows: [
            {
              actor_user_id: userId,
              display_name: "Original Team",
              expected_session_version: "3",
              mutation_id: mutationId,
              organization_id: "research-team",
              resulting_session_version: "4",
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.createOrganization(input())).resolves.toEqual({ kind: "conflict" });
  });

  it("distinguishes invalid sessions, stale versions, membership caps, and occupied IDs", async () => {
    const cases = [
      {
        expected: "invalid-session",
        handle: (text: string) =>
          text.includes("FROM public.account_sessions session") ? { rowCount: 0, rows: [] } : null,
      },
      {
        expected: "conflict",
        handle: (text: string) => {
          if (text.includes("FROM public.account_sessions session")) return actor("4");
          if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
          if (text.includes("FROM public.account_organization_bootstrap_mutations")) return { rowCount: 0, rows: [] };
          return null;
        },
      },
      {
        expected: "organization-unavailable",
        handle: (text: string) => {
          if (text.includes("FROM public.account_sessions session")) return actor();
          if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
          if (text.includes("FROM public.account_organization_bootstrap_mutations")) return { rowCount: 0, rows: [] };
          if (text.includes("count(*)::text AS membership_count")) {
            return { rowCount: 1, rows: [{ membership_count: "256" }] };
          }
          return null;
        },
      },
      {
        expected: "organization-unavailable",
        handle: (text: string) => {
          if (text.includes("FROM public.account_sessions session")) return actor();
          if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [{}] };
          if (text.includes("FROM public.account_organization_bootstrap_mutations")) return { rowCount: 0, rows: [] };
          if (text.includes("count(*)::text AS membership_count")) {
            return { rowCount: 1, rows: [{ membership_count: "2" }] };
          }
          if (text.startsWith("SELECT tenant_id FROM public.workspace_tenants")) {
            return { rowCount: 1, rows: [{ tenant_id: "research-team" }] };
          }
          return null;
        },
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = fakePool((text) => {
        const result = testCase.handle(text);
        if (result) return result;
        throw new Error(`Unexpected query: ${text}`);
      });
      const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });
      await expect(repository.createOrganization(input())).resolves.toEqual({ kind: testCase.expected });
    }
  });

  it("rejects malformed input before acquiring a connection", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresAccountOrganizationRepositoryV1({ pool: fixture.pool });

    await expect(repository.createOrganization(input({ sessionTokenHash: Buffer.alloc(31) }))).rejects.toThrow(
      /32 bytes/i,
    );
    await expect(repository.createOrganization(input({ organizationId: "studio-local" }))).rejects.toThrow();
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
