import { createHash } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createAccountInvitationFetchHandlerV1 } from "../accounts/account-invitation-fetch";
import { createAccountInvitationServiceV1 } from "../accounts/account-invitation-service";
import { createAccountSessionIdentityAuthenticatorV1 } from "../accounts/account-session-authenticator";
import { createOidcLoginFetchHandlerV1, OIDC_LOGIN_BINDING_COOKIE_NAME_V1 } from "../accounts/oidc-login-fetch";
import { createOidcLoginServiceV1 } from "../accounts/oidc-login-service";
import type { OidcIdentityProviderV1 } from "../accounts/openid-client-provider";
import { createOrganizationMembershipProductionAdmissionV1 } from "../accounts/organization-membership-admission";
import { authenticateManimPrincipal } from "../manim-request-principal";
import { ManimTenantRegistry } from "../manim-tenant-registry";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresAccountInvitationRepositoryV1 } from "./postgres/postgres-account-invitation-repository";
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

function opaqueToken(byte: number) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function opaqueTokenHash(token: string) {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest();
}

function responseCookie(response: Response, name: string) {
  const prefix = `${name}=`;
  const pair = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .find((value) => value.startsWith(prefix));
  if (!pair) throw new TypeError(`Response did not set ${name}.`);
  return pair.slice(prefix.length);
}

function uuid(sequence: number) {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

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
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 23 });
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
                  ('organization-secondary', $1, 'member', 'active'),
                  ('organization-secondary', $2, 'owner', 'active')`,
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
      await expect(sessions.switchActiveOrganization(activeHash, "organization-user-suspended", 3)).resolves.toEqual({
        kind: "organization-unavailable",
      });
      await expect(sessions.resolveActiveSession(activeHash)).resolves.toMatchObject({
        sessionOrganizationId: "organization-active",
      });
      await expect(sessions.resolveActiveSession(expiredHash)).resolves.toBeNull();
      await expect(sessions.resolveActiveSession(revokedHash)).resolves.toBeNull();
      await expect(sessions.resolveActiveSession(cascadeHash)).resolves.toBeNull();
      await expect(sessions.revokeAccountSession(activeHash)).resolves.toBeUndefined();
      await expect(sessions.resolveActiveSession(activeHash)).resolves.toBeNull();
      await expect(sessions.switchActiveOrganization(activeHash, "organization-active", 3)).resolves.toEqual({
        kind: "invalid-session",
      });
      await expect(sessions.revokeAccountSession(activeHash)).resolves.toBeUndefined();

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
        { codeVerifier: "v".repeat(43), invitationTokenDigest: null, nonce: "n".repeat(43) },
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

  it("onboards invited members atomically through fake OIDC and real PostgreSQL", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 6 });
    const invitations = new PostgresAccountInvitationRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const oidc = new PostgresOidcLoginRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const memberships = new PostgresOrganizationMembershipRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const sessions = new PostgresAccountSessionRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 2 },
    });
    const publicOrigin = "https://studio.example";
    const tenantId = "invitation-organization";
    const foreignTenantId = "invitation-foreign-organization";
    const ownerId = uuid(100);
    const memberId = uuid(101);
    const billingId = uuid(102);
    const foreignOwnerId = uuid(103);
    const ownerToken = opaqueToken(40);
    const memberToken = opaqueToken(41);
    const billingToken = opaqueToken(42);
    const foreignOwnerToken = opaqueToken(43);
    let invitationSecret = 50;
    let invitationSequence = 200;
    const invitationService = createAccountInvitationServiceV1(invitations, {
      randomBytes: () => Buffer.alloc(32, invitationSecret++),
      randomUuid: () => uuid(invitationSequence++),
    });
    const invitationHandler = createAccountInvitationFetchHandlerV1(invitationService, publicOrigin);
    const mutationHeaders = (token: string, json = true) => ({
      ...(json ? { "content-type": "application/json" } : {}),
      cookie: `__Host-poietra_session=${token}`,
      origin: publicOrigin,
      "sec-fetch-site": "same-origin",
    });
    const createInvitation = (token: string, email: string, role: "admin" | "billing" | "member" = "member") =>
      invitationHandler.fetch(
        new Request(`${publicOrigin}/api/account/invitations`, {
          body: JSON.stringify({ email, role }),
          headers: mutationHeaders(token),
          method: "POST",
        }),
      );
    let nextIdentity = {
      issuer: IDENTITY_ISSUER,
      subject: "invited-admin",
      verifiedEmail: "invited.admin@example.com",
    };
    const provider: OidcIdentityProviderV1 = {
      authorizationUrl: async ({ codeChallenge, nonce, state }) => {
        const url = new URL("https://identity.example/authorize");
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("nonce", nonce);
        url.searchParams.set("state", state);
        return url;
      },
      exchange: async () => nextIdentity,
    };
    let oidcSecret = 70;
    let oidcUserSequence = 300;
    const oidcService = createOidcLoginServiceV1({
      provider,
      randomBytes: () => Buffer.alloc(32, oidcSecret++),
      randomUuid: () => uuid(oidcUserSequence++),
      repository: oidc,
    });
    const oidcHandler = createOidcLoginFetchHandlerV1(oidcService, publicOrigin);

    try {
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toMatchObject({ version: 23 });
      await pool.query(
        `INSERT INTO public.workspace_tenants (tenant_id)
         VALUES ($1), ($2)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, foreignTenantId],
      );
      const setup = await pool.connect();
      try {
        await setup.query("BEGIN");
        await setup.query(
          `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
         VALUES ($1, $5, 'invitation-owner', 'Invitation owner'),
                ($2, $5, 'invitation-member', 'Invitation member'),
                ($3, $5, 'invitation-billing', 'Invitation billing'),
                ($4, $5, 'invitation-foreign-owner', 'Foreign owner')`,
          [ownerId, memberId, billingId, foreignOwnerId, IDENTITY_ISSUER],
        );
        await setup.query(
          `INSERT INTO public.organizations (tenant_id, display_name)
         VALUES ($1, 'Invitation organization'), ($2, 'Foreign invitation organization')`,
          [tenantId, foreignTenantId],
        );
        await setup.query(
          `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
         VALUES ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $5, 'billing'), ($2, $6, 'owner')`,
          [tenantId, foreignTenantId, ownerId, memberId, billingId, foreignOwnerId],
        );
        await setup.query(
          `INSERT INTO public.account_sessions
           (session_token_hash, user_id, active_tenant_id, created_at, expires_at)
         VALUES ($1, $5, $9, clock_timestamp(), clock_timestamp() + interval '1 hour'),
                ($2, $6, $9, clock_timestamp(), clock_timestamp() + interval '1 hour'),
                ($3, $7, $9, clock_timestamp(), clock_timestamp() + interval '1 hour'),
                ($4, $8, $10, clock_timestamp(), clock_timestamp() + interval '1 hour')`,
          [
            opaqueTokenHash(ownerToken),
            opaqueTokenHash(memberToken),
            opaqueTokenHash(billingToken),
            opaqueTokenHash(foreignOwnerToken),
            ownerId,
            memberId,
            billingId,
            foreignOwnerId,
            tenantId,
            foreignTenantId,
          ],
        );
        await setup.query("COMMIT");
      } catch (error) {
        await setup.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        setup.release();
      }

      await expect(createInvitation(memberToken, "denied.member@example.com")).resolves.toMatchObject({ status: 403 });
      await expect(createInvitation(billingToken, "denied.billing@example.com")).resolves.toMatchObject({
        status: 403,
      });

      const createdResponse = await createInvitation(ownerToken, " Invited.Admin@Example.COM ", "admin");
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as {
        expiresAt: string;
        invitationId: string;
        invitationToken: string;
      };
      expect(created.invitationToken).toHaveLength(43);
      const persistedInvitation = await pool.query<{
        digest: string;
        normalized_email: string;
        role: string;
      }>(
        `SELECT encode(token_digest, 'hex') AS digest, normalized_email, invited_role AS role
           FROM public.organization_invitations
          WHERE invitation_id = $1`,
        [created.invitationId],
      );
      expect(persistedInvitation.rows).toEqual([
        {
          digest: opaqueTokenHash(created.invitationToken).toString("hex"),
          normalized_email: "invited.admin@example.com",
          role: "admin",
        },
      ]);
      expect(JSON.stringify(persistedInvitation.rows)).not.toContain(created.invitationToken);

      const startResponse = await oidcHandler.fetch(
        new Request(`${publicOrigin}/auth/oidc/start`, {
          body: JSON.stringify({ invitationToken: created.invitationToken }),
          headers: { "content-type": "application/json", origin: publicOrigin, "sec-fetch-site": "same-origin" },
          method: "POST",
        }),
      );
      expect(startResponse.status).toBe(303);
      expect(startResponse.headers.get("location")).not.toContain(created.invitationToken);
      const authorizationUrl = new URL(startResponse.headers.get("location") ?? "");
      const state = authorizationUrl.searchParams.get("state");
      expect(state).toHaveLength(43);
      const binding = responseCookie(startResponse, OIDC_LOGIN_BINDING_COOKIE_NAME_V1);
      const callbackResponse = await oidcHandler.fetch(
        new Request(`${publicOrigin}/auth/oidc/callback?code=fake-code&state=${state}`, {
          headers: { cookie: `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${binding}` },
        }),
      );
      expect(callbackResponse.status).toBe(303);
      const invitedSessionToken = responseCookie(callbackResponse, "__Host-poietra_session");
      const invitedSessionHash = opaqueTokenHash(invitedSessionToken);
      await expect(sessions.resolveActiveSession(invitedSessionHash)).resolves.toEqual({
        issuer: IDENTITY_ISSUER,
        sessionOrganizationId: tenantId,
        subject: "invited-admin",
      });
      await expect(memberships.resolveActiveMembership(identity("invited-admin"), tenantId)).resolves.toMatchObject({
        organizationId: tenantId,
        role: "admin",
      });
      await expect(sessions.resolveAccountSession(invitedSessionHash)).resolves.toMatchObject({
        activeOrganizationId: tenantId,
        organizations: [{ displayName: "Invitation organization", id: tenantId, role: "admin" }],
        user: { displayName: "New member" },
      });
      const admissionSignal = new AbortController().signal;
      const admission = createOrganizationMembershipProductionAdmissionV1({
        identities: createAccountSessionIdentityAuthenticatorV1(sessions),
        memberships,
      });
      const principal = await authenticateManimPrincipal(
        admission,
        {
          credentials: { cookie: `__Host-poietra_session=${invitedSessionToken}` },
          directPeerAddress: "127.0.0.1",
          forwardedHeaders: { immediatePeerTrusted: false, present: false },
          method: "GET",
          pathname: "/api/manim/projects",
        },
        admissionSignal,
      );
      expect(principal).toMatchObject({ subjectId: expect.any(String), tenantId });
      const workspaceApi = {
        storageBoundary: { kind: "shared-durable" as const, namespace: "invitation-e2e" },
        tenantId,
      };
      expect(new ManimTenantRegistry([workspaceApi]).forPrincipal(principal)).toBe(workspaceApi);
      await expect(
        authenticateManimPrincipal(
          admission,
          {
            credentials: { cookie: `__Host-poietra_session=${invitedSessionToken}` },
            directPeerAddress: "127.0.0.1",
            forwardedHeaders: { immediatePeerTrusted: false, present: false },
            method: "GET",
            pathname: "/api/manim/projects",
            requestedOrganizationId: foreignTenantId,
          },
          admissionSignal,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        oidcHandler.fetch(
          new Request(`${publicOrigin}/auth/oidc/callback?code=fake-code&state=${state}`, {
            headers: { cookie: `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${binding}` },
          }),
        ),
      ).resolves.toMatchObject({ status: 400 });

      const adminCreated = await createInvitation(invitedSessionToken, "created.by.admin@example.com", "billing");
      expect(adminCreated.status).toBe(201);

      const mismatchCreated = (await (await createInvitation(ownerToken, "expected@example.com")).json()) as {
        invitationId: string;
        invitationToken: string;
      };
      nextIdentity = {
        issuer: IDENTITY_ISSUER,
        subject: "mismatched-invite",
        verifiedEmail: "different@example.com",
      };
      const mismatchStart = await oidcHandler.fetch(
        new Request(`${publicOrigin}/auth/oidc/start`, {
          body: JSON.stringify({ invitationToken: mismatchCreated.invitationToken }),
          headers: { "content-type": "application/json", origin: publicOrigin },
          method: "POST",
        }),
      );
      const mismatchAuthorization = new URL(mismatchStart.headers.get("location") ?? "");
      const mismatchState = mismatchAuthorization.searchParams.get("state");
      const mismatchBinding = responseCookie(mismatchStart, OIDC_LOGIN_BINDING_COOKIE_NAME_V1);
      await expect(
        oidcHandler.fetch(
          new Request(`${publicOrigin}/auth/oidc/callback?code=fake-code&state=${mismatchState}`, {
            headers: { cookie: `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=${mismatchBinding}` },
          }),
        ),
      ).resolves.toMatchObject({ status: 403 });
      await expect(
        pool.query("SELECT status FROM public.organization_invitations WHERE invitation_id = $1", [
          mismatchCreated.invitationId,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: "pending" }] });
      await expect(
        pool.query("SELECT 1 FROM public.users WHERE oidc_subject = 'mismatched-invite'"),
      ).resolves.toMatchObject({ rowCount: 0 });

      const revokedCreated = (await (await createInvitation(ownerToken, "revoked@example.com")).json()) as {
        invitationId: string;
        invitationToken: string;
      };
      await expect(
        invitationHandler.fetch(
          new Request(`${publicOrigin}/api/account/invitations/${revokedCreated.invitationId}`, {
            headers: mutationHeaders(foreignOwnerToken, false),
            method: "DELETE",
          }),
        ),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        invitationHandler.fetch(
          new Request(`${publicOrigin}/api/account/invitations/${revokedCreated.invitationId}`, {
            headers: mutationHeaders(ownerToken, false),
            method: "DELETE",
          }),
        ),
      ).resolves.toMatchObject({ status: 204 });
      await expect(
        oidcHandler.fetch(
          new Request(`${publicOrigin}/auth/oidc/start`, {
            body: JSON.stringify({ invitationToken: revokedCreated.invitationToken }),
            headers: { "content-type": "application/json", origin: publicOrigin },
            method: "POST",
          }),
        ),
      ).resolves.toMatchObject({ status: 403 });

      const expiredToken = opaqueToken(120);
      await pool.query(
        `INSERT INTO public.organization_invitations
           (invitation_id, tenant_id, token_digest, normalized_email, invited_role, created_by,
            created_at, expires_at, updated_at)
         VALUES ($1, $2, $3, 'expired@example.com', 'member', $4,
                 clock_timestamp() - interval '10 minutes',
                 clock_timestamp() - interval '4 minutes',
                 clock_timestamp() - interval '10 minutes')`,
        [uuid(400), tenantId, opaqueTokenHash(expiredToken), ownerId],
      );
      await expect(
        oidcHandler.fetch(
          new Request(`${publicOrigin}/auth/oidc/start`, {
            body: JSON.stringify({ invitationToken: expiredToken }),
            headers: { "content-type": "application/json", origin: publicOrigin },
            method: "POST",
          }),
        ),
      ).resolves.toMatchObject({ status: 403 });

      const concurrentCreated = (await (await createInvitation(ownerToken, "concurrent@example.com")).json()) as {
        invitationToken: string;
      };
      const concurrentDigest = opaqueTokenHash(concurrentCreated.invitationToken);
      const concurrentResults = await Promise.all([
        oidc.issueInvitedAccountSession({
          identity: identity("concurrent-invite"),
          invitationTokenDigest: concurrentDigest,
          lifetimeMs: 60_000,
          newUserDisplayName: "New member",
          newUserId: uuid(500),
          sessionTokenHash: Buffer.alloc(32, 121),
          verifiedEmail: "concurrent@example.com",
        }),
        oidc.issueInvitedAccountSession({
          identity: identity("concurrent-invite"),
          invitationTokenDigest: concurrentDigest,
          lifetimeMs: 60_000,
          newUserDisplayName: "New member",
          newUserId: uuid(501),
          sessionTokenHash: Buffer.alloc(32, 122),
          verifiedEmail: "concurrent@example.com",
        }),
      ]);
      expect(concurrentResults.filter((result) => result !== null)).toHaveLength(1);
      expect(concurrentResults.filter((result) => result === null)).toHaveLength(1);

      const rollbackCreated = (await (await createInvitation(ownerToken, "rollback@example.com")).json()) as {
        invitationId: string;
        invitationToken: string;
      };
      await expect(
        oidc.issueInvitedAccountSession({
          identity: identity("rollback-invite"),
          invitationTokenDigest: opaqueTokenHash(rollbackCreated.invitationToken),
          lifetimeMs: 60_000,
          newUserDisplayName: "New member",
          newUserId: uuid(600),
          sessionTokenHash: opaqueTokenHash(ownerToken),
          verifiedEmail: "rollback@example.com",
        }),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query("SELECT 1 FROM public.users WHERE oidc_subject = 'rollback-invite'"),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        pool.query("SELECT status FROM public.organization_invitations WHERE invitation_id = $1", [
          rollbackCreated.invitationId,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: "pending" }] });
    } finally {
      await oidcService.close();
      await invitationService.close();
      await sessions.close();
      await memberships.close();
      await pool.end();
    }
  });
});
