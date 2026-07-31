import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresOrganizationMembershipRepositoryV1 } from "./postgres/postgres-organization-membership-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const IDENTITY_ISSUER = "https://identity.example/";

const users = {
  activeOwner: "00000000-0000-4000-8000-000000000001",
  supportingOwner: "00000000-0000-4000-8000-000000000002",
  suspendedUser: "00000000-0000-4000-8000-000000000003",
  suspendedOrganizationMember: "00000000-0000-4000-8000-000000000004",
  suspendedMembership: "00000000-0000-4000-8000-000000000005",
} as const;

const identity = (subject: string) => ({ issuer: IDENTITY_ISSUER, subject });

describe.skipIf(!DATABASE_URL)("PostgreSQL account and organization membership", () => {
  it("resolves only active membership boundaries and preserves the last active owner", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const repository = new PostgresOrganizationMembershipRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    try {
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 11 });
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          `INSERT INTO public.workspace_tenants (tenant_id)
           VALUES ('organization-active'), ('organization-user-suspended'),
                  ('organization-suspended'), ('organization-membership-suspended')`,
        );
        await setup.query(
          `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name, status)
           VALUES ($1, $6, 'active-owner', 'Active owner', 'active'),
                  ($2, $6, 'supporting-owner', 'Supporting owner', 'active'),
                  ($3, $6, 'suspended-user', 'Suspended user', 'suspended'),
                  ($4, $6, 'suspended-organization-member', 'Suspended organization member', 'active'),
                  ($5, $6, 'suspended-membership', 'Suspended membership', 'active')`,
          [...Object.values(users), IDENTITY_ISSUER],
        );
        await setup.query(
          `INSERT INTO public.organizations (tenant_id, display_name, status)
           VALUES ('organization-active', 'Active organization', 'active'),
                  ('organization-user-suspended', 'Suspended user organization', 'active'),
                  ('organization-suspended', 'Suspended organization', 'suspended'),
                  ('organization-membership-suspended', 'Suspended membership organization', 'active')`,
        );
        await setup.query(
          `INSERT INTO public.organization_memberships (tenant_id, user_id, role, status)
           VALUES ('organization-active', $1, 'owner', 'active'),
                  ('organization-user-suspended', $2, 'owner', 'active'),
                  ('organization-user-suspended', $3, 'member', 'active'),
                  ('organization-suspended', $2, 'owner', 'active'),
                  ('organization-suspended', $4, 'member', 'active'),
                  ('organization-membership-suspended', $2, 'owner', 'active'),
                  ('organization-membership-suspended', $5, 'member', 'suspended')`,
          Object.values(users),
        );
        await setup.query("COMMIT");
      } catch (error) {
        await setup.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        setup.release();
      }

      await expect(repository.ready()).resolves.toBe(true);
      await expect(
        repository.resolveActiveMembership(identity("active-owner"), "organization-active"),
      ).resolves.toMatchObject({ organizationId: "organization-active", role: "owner", userId: users.activeOwner });
      await expect(
        repository.resolveActiveMembership(identity("supporting-owner"), "organization-active"),
      ).resolves.toBeNull();
      await expect(
        repository.resolveActiveMembership(identity("active-owner"), "organization-user-suspended"),
      ).resolves.toBeNull();
      await expect(
        repository.resolveActiveMembership(identity("suspended-user"), "organization-user-suspended"),
      ).resolves.toBeNull();
      await expect(
        repository.resolveActiveMembership(identity("suspended-organization-member"), "organization-suspended"),
      ).resolves.toBeNull();
      await expect(
        repository.resolveActiveMembership(identity("suspended-membership"), "organization-membership-suspended"),
      ).resolves.toBeNull();

      await expect(
        pool.query("DELETE FROM public.organization_memberships WHERE tenant_id = 'organization-active'"),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "UPDATE public.organization_memberships SET status = 'suspended' WHERE tenant_id = 'organization-active'",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE public.users SET status = 'suspended' WHERE user_id = $1", [users.activeOwner]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("DELETE FROM public.organizations WHERE tenant_id = 'organization-active'"),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await repository.close();
      await pool.end();
    }
  });
});
