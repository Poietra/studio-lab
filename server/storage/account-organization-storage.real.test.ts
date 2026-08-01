import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresAccountSessionRepositoryV1 } from "./postgres/postgres-account-session-repository";
import { PostgresOidcLoginRepositoryV1 } from "./postgres/postgres-oidc-login-repository";
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
    const sessions = new PostgresAccountSessionRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const oidc = new PostgresOidcLoginRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    try {
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 16 });
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          `INSERT INTO public.workspace_tenants (tenant_id)
           VALUES ('organization-active'), ('organization-user-suspended'),
                  ('organization-suspended'), ('organization-membership-suspended'),
                  ('organization-secondary')`,
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
                  ('organization-membership-suspended', 'Suspended membership organization', 'active'),
                  ('organization-secondary', 'Secondary organization', 'active')`,
        );
        await setup.query(
          `INSERT INTO public.organization_memberships (tenant_id, user_id, role, status)
           VALUES ('organization-active', $1, 'owner', 'active'),
                  ('organization-user-suspended', $2, 'owner', 'active'),
                  ('organization-user-suspended', $3, 'member', 'active'),
                  ('organization-suspended', $2, 'owner', 'active'),
                  ('organization-suspended', $4, 'member', 'active'),
                  ('organization-membership-suspended', $2, 'owner', 'active'),
                  ('organization-membership-suspended', $5, 'member', 'suspended'),
                  ('organization-secondary', $1, 'member', 'active')`,
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

      const activeHash = Buffer.alloc(32, 1);
      const expiredHash = Buffer.alloc(32, 2);
      const revokedHash = Buffer.alloc(32, 3);
      const cascadeHash = Buffer.alloc(32, 4);
      await pool.query(
        `INSERT INTO public.account_sessions
           (session_token_hash, user_id, active_tenant_id, created_at, expires_at, revoked_at)
         VALUES ($1, $5, 'organization-active', clock_timestamp(), clock_timestamp() + interval '1 hour', NULL),
                ($2, $5, 'organization-active', clock_timestamp() - interval '2 hours',
                 clock_timestamp() - interval '1 hour', NULL),
                ($3, $5, 'organization-active', clock_timestamp(), clock_timestamp() + interval '1 hour',
                 clock_timestamp()),
                ($4, $6, 'organization-user-suspended', clock_timestamp(),
                 clock_timestamp() + interval '1 hour', NULL)`,
        [activeHash, expiredHash, revokedHash, cascadeHash, users.activeOwner, users.suspendedUser],
      );
      await expect(sessions.ready()).resolves.toBe(true);
      await expect(sessions.resolveActiveSession(activeHash)).resolves.toEqual({
        issuer: IDENTITY_ISSUER,
        sessionOrganizationId: "organization-active",
        subject: "active-owner",
      });
      await expect(sessions.resolveAccountSession(activeHash)).resolves.toEqual({
        activeOrganizationId: "organization-active",
        organizations: [
          { displayName: "Active organization", id: "organization-active", role: "owner" },
          { displayName: "Secondary organization", id: "organization-secondary", role: "member" },
        ],
        user: { displayName: "Active owner", id: users.activeOwner },
        version: 1,
      });
      await expect(sessions.switchActiveOrganization(activeHash, "organization-secondary", 1)).resolves.toMatchObject({
        account: { activeOrganizationId: "organization-secondary", version: 2 },
        kind: "updated",
      });
      await expect(sessions.switchActiveOrganization(activeHash, "organization-secondary", 1)).resolves.toMatchObject({
        account: { activeOrganizationId: "organization-secondary", version: 2 },
        kind: "updated",
      });
      await expect(sessions.switchActiveOrganization(activeHash, "organization-active", 1)).resolves.toEqual({
        kind: "conflict",
      });
      await expect(sessions.switchActiveOrganization(activeHash, "organization-active", 2)).resolves.toMatchObject({
        account: { activeOrganizationId: "organization-active", version: 3 },
        kind: "updated",
      });
      await expect(sessions.switchActiveOrganization(activeHash, "organization-secondary", 1)).resolves.toEqual({
        kind: "conflict",
      });
      await expect(sessions.resolveAccountSession(activeHash)).resolves.toMatchObject({
        activeOrganizationId: "organization-active",
        version: 3,
      });
      await expect(sessions.resolveActiveSession(expiredHash)).resolves.toBeNull();
      await expect(sessions.resolveActiveSession(revokedHash)).resolves.toBeNull();
      await expect(sessions.resolveActiveSession(cascadeHash)).resolves.toBeNull();

      const stateHash = Buffer.alloc(32, 6);
      const browserBindingHash = Buffer.alloc(32, 7);
      const issuedSessionHash = Buffer.alloc(32, 8);
      const expiredStateHash = Buffer.alloc(32, 9);
      await expect(oidc.ready()).resolves.toBe(true);
      await pool.query(
        `INSERT INTO public.oidc_login_attempts
           (state_hash, browser_binding_hash, code_verifier, nonce, created_at, expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() - interval '2 minutes',
                 clock_timestamp() - interval '1 minute')`,
        [expiredStateHash, Buffer.alloc(32, 10), "x".repeat(43), "y".repeat(43)],
      );
      await expect(
        oidc.createLoginAttempt({
          browserBindingHash,
          codeVerifier: "v".repeat(43),
          lifetimeMs: 10 * 60_000,
          nonce: "n".repeat(43),
          stateHash,
        }),
      ).resolves.toMatchObject({ expiresAt: expect.any(Date) });
      await expect(
        pool.query("SELECT 1 FROM public.oidc_login_attempts WHERE state_hash = $1", [expiredStateHash]),
      ).resolves.toMatchObject({ rowCount: 0 });
      const concurrentConsumption = await Promise.all([
        oidc.consumeLoginAttempt({ browserBindingHash, stateHash }),
        oidc.consumeLoginAttempt({ browserBindingHash, stateHash }),
      ]);
      expect(concurrentConsumption.filter((attempt) => attempt !== null)).toEqual([
        { codeVerifier: "v".repeat(43), nonce: "n".repeat(43) },
      ]);
      expect(concurrentConsumption.filter((attempt) => attempt === null)).toHaveLength(1);
      await expect(
        oidc.issueAccountSession({
          identity: identity("active-owner"),
          lifetimeMs: 7 * 24 * 60 * 60_000,
          sessionTokenHash: issuedSessionHash,
        }),
      ).resolves.toMatchObject({ expiresAt: expect.any(Date) });
      await expect(sessions.resolveActiveSession(issuedSessionHash)).resolves.toEqual({
        issuer: IDENTITY_ISSUER,
        sessionOrganizationId: "organization-active",
        subject: "active-owner",
      });
      await expect(
        oidc.issueAccountSession({
          identity: identity("unknown-user"),
          lifetimeMs: 60_000,
          sessionTokenHash: Buffer.alloc(32, 9),
        }),
      ).resolves.toBeNull();
      await expect(
        Promise.all(
          ["suspended-user", "suspended-organization-member", "suspended-membership"].map((subject, index) =>
            oidc.issueAccountSession({
              identity: identity(subject),
              lifetimeMs: 60_000,
              sessionTokenHash: Buffer.alloc(32, 20 + index),
            }),
          ),
        ),
      ).resolves.toEqual([null, null, null]);
      await expect(
        pool.query(
          `INSERT INTO public.account_sessions
             (session_token_hash, user_id, active_tenant_id, created_at, expires_at)
           VALUES ($1, $2, 'organization-active', clock_timestamp(), clock_timestamp() + interval '31 days')`,
          [Buffer.alloc(32, 30), users.activeOwner],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          `INSERT INTO public.account_sessions
             (session_token_hash, user_id, active_tenant_id, expires_at)
           VALUES ($1, $2, 'organization-active', clock_timestamp() + interval '1 hour')`,
          [activeHash, users.activeOwner],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await pool.query(
        `DELETE FROM public.organization_memberships
          WHERE tenant_id = 'organization-user-suspended' AND user_id = $1`,
        [users.suspendedUser],
      );
      await expect(
        pool.query("SELECT 1 FROM public.account_sessions WHERE session_token_hash = $1", [cascadeHash]),
      ).resolves.toMatchObject({ rowCount: 0 });

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
      await oidc.close();
      await sessions.close();
      await repository.close();
      await pool.end();
    }
  });
});
