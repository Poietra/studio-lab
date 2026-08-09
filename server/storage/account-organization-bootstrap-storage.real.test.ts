import { createHash } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresAccountOrganizationRepositoryV1 } from "./postgres/postgres-account-organization-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const issuer = "https://identity.example/";
const userA = "00000000-0000-4000-8000-000000000071";
const userB = "00000000-0000-4000-8000-000000000072";
const mutationA = "00000000-0000-4000-8000-000000000073";
const mutationB = "00000000-0000-4000-8000-000000000074";

function sessionHash(byte: number) {
  return createHash("sha256").update(Buffer.alloc(32, byte)).digest();
}

describe.skipIf(!DATABASE_URL)("PostgreSQL account Organization bootstrap", () => {
  it("creates one owner atomically, replays exactly, and rejects cross-session ID claims", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const repository = new PostgresAccountOrganizationRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const hashA = sessionHash(71);
    const hashB = sessionHash(72);
    try {
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toEqual({ applied: true, version: 30 });
      await pool.query("BEGIN");
      await pool.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ('initial-a'), ('initial-b')");
      await pool.query(
        `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
         VALUES ($1, $3, 'owner-a', 'Owner A'), ($2, $3, 'owner-b', 'Owner B')`,
        [userA, userB, issuer],
      );
      await pool.query(
        "INSERT INTO public.organizations (tenant_id, display_name) VALUES ('initial-a', 'Initial A'), ('initial-b', 'Initial B')",
      );
      await pool.query(
        `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
         VALUES ('initial-a', $1, 'owner'), ('initial-b', $2, 'owner')`,
        [userA, userB],
      );
      await pool.query(
        `INSERT INTO public.account_sessions (session_token_hash, user_id, active_tenant_id, expires_at)
         VALUES ($1, $3, 'initial-a', clock_timestamp() + interval '1 hour'),
                ($2, $4, 'initial-b', clock_timestamp() + interval '1 hour')`,
        [hashA, hashB, userA, userB],
      );
      await pool.query("COMMIT");

      await expect(repository.ready()).resolves.toBe(true);
      const request = {
        displayName: "Research Team",
        expectedVersion: 1,
        mutationId: mutationA,
        organizationId: "research-team",
        sessionTokenHash: hashA,
      } as const;
      await expect(repository.createOrganization(request)).resolves.toEqual({
        kind: "applied",
        mutationId: mutationA,
        organization: { displayName: "Research Team", id: "research-team", role: "owner" },
        replayed: false,
        version: 2,
      });
      await expect(repository.createOrganization(request)).resolves.toMatchObject({
        kind: "applied",
        replayed: true,
        version: 2,
      });
      await expect(repository.createOrganization({ ...request, displayName: "Changed Name" })).resolves.toEqual({
        kind: "conflict",
      });
      await expect(
        repository.createOrganization({
          ...request,
          mutationId: mutationB,
          sessionTokenHash: hashB,
        }),
      ).resolves.toEqual({ kind: "organization-unavailable" });

      const projection = await pool.query(
        `SELECT organization.display_name, membership.role, session.active_tenant_id,
                session.version::text AS session_version
           FROM public.organizations organization
           JOIN public.organization_memberships membership
             ON membership.tenant_id = organization.tenant_id
           JOIN public.account_sessions session ON session.user_id = membership.user_id
          WHERE organization.tenant_id = 'research-team'`,
      );
      expect(projection.rows).toEqual([
        {
          active_tenant_id: "research-team",
          display_name: "Research Team",
          role: "owner",
          session_version: "2",
        },
      ]);
      const audit = await pool.query(
        "SELECT count(*)::text AS count FROM public.account_organization_bootstrap_mutations",
      );
      expect(audit.rows[0]?.count).toBe("1");
      await expect(
        pool.query(
          "UPDATE public.account_organization_bootstrap_mutations SET display_name = 'Changed' WHERE mutation_id = $1",
          [mutationA],
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await repository.close().catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });
});
