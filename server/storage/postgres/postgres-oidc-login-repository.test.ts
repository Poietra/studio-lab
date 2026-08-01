import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
  OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
} from "../../accounts/oidc-login-repository";
import { ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM } from "./account-invitation-schema";
import { PostgresOidcLoginRepositoryV1 } from "./postgres-oidc-login-repository";
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

const stateHash = Buffer.alloc(32, 1);
const browserBindingHash = Buffer.alloc(32, 2);
const sessionTokenHash = Buffer.alloc(32, 3);
const codeVerifier = "v".repeat(43);
const nonce = "n".repeat(43);
const identity = { issuer: "https://identity.example/tenant", subject: "oidc-user-a" } as const;

describe("PostgresOidcLoginRepositoryV1", () => {
  it("requires the exact account-invitation migration", async () => {
    const fixture = fakePool((text, values) => {
      expect(text).toContain("version = 22");
      expect(values).toEqual([]);
      return { rowCount: 1, rows: [{ checksum: ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM, version: 22 }] };
    });
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(repository.ready()).resolves.toBe(true);
  });

  it("creates a bounded attempt without persisting raw state or browser binding", async () => {
    const expiresAt = new Date("2026-08-01T00:10:00.000Z");
    const fixture = fakePool((text, values) => {
      expect(text).toContain("INSERT INTO public.oidc_login_attempts");
      expect(text).toContain("LIMIT 128");
      expect(text).toContain("FOR UPDATE SKIP LOCKED");
      expect(text).toContain("DELETE FROM public.oidc_login_attempts");
      expect(text).toContain("clock_timestamp()");
      expect(text).toContain("$5::bigint * interval '1 millisecond'");
      expect(values).toHaveLength(6);
      expect(Buffer.compare(values[0] as Buffer, stateHash)).toBe(0);
      expect(Buffer.compare(values[1] as Buffer, browserBindingHash)).toBe(0);
      expect(values.slice(2)).toEqual([codeVerifier, nonce, OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1, null]);
      return { rowCount: 1, rows: [{ expires_at: expiresAt }] };
    });
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.createLoginAttempt({
        browserBindingHash,
        codeVerifier,
        lifetimeMs: OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
        nonce,
        stateHash,
      }),
    ).resolves.toEqual({ expiresAt });
  });

  it("atomically deletes and returns one live attempt so replay returns null", async () => {
    let available = true;
    const fixture = fakePool((text, values) => {
      expect(text).toContain("DELETE FROM public.oidc_login_attempts");
      expect(text).toContain("browser_binding_hash = $2");
      expect(text).toContain("expires_at > clock_timestamp() AS active");
      expect(text).toContain("SELECT code_verifier, nonce, invitation_token_digest FROM removed WHERE active");
      expect(Buffer.compare(values[0] as Buffer, stateHash)).toBe(0);
      expect(Buffer.compare(values[1] as Buffer, browserBindingHash)).toBe(0);
      if (!available) return { rowCount: 0, rows: [] };
      available = false;
      return { rowCount: 1, rows: [{ code_verifier: codeVerifier, invitation_token_digest: null, nonce }] };
    });
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(repository.consumeLoginAttempt({ browserBindingHash, stateHash })).resolves.toEqual({
      codeVerifier,
      invitationTokenDigest: null,
      nonce,
    });
    await expect(repository.consumeLoginAttempt({ browserBindingHash, stateHash })).resolves.toBeNull();
  });

  it("issues a session only through a deterministic active identity membership", async () => {
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    const fixture = fakePool((text, values) => {
      expect(text).toContain("account.oidc_issuer = $1");
      expect(text).toContain("account.oidc_subject = $2");
      expect(text).toContain("account.status = 'active'");
      expect(text).toContain("membership.status = 'active'");
      expect(text).toContain("organization.status = 'active'");
      expect(text).toContain("ORDER BY membership.created_at, membership.tenant_id");
      expect(text).toContain("LIMIT 1");
      expect(text).not.toContain("email");
      expect(values.slice(0, 2)).toEqual([identity.issuer, identity.subject]);
      expect(Buffer.compare(values[2] as Buffer, sessionTokenHash)).toBe(0);
      expect(values[3]).toBe(ACCOUNT_SESSION_MAX_LIFETIME_MS_V1);
      return {
        rowCount: 1,
        rows: [
          {
            expires_at: expiresAt,
          },
        ],
      };
    });
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.issueAccountSession({
        identity,
        lifetimeMs: ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
        sessionTokenHash,
      }),
    ).resolves.toEqual({
      expiresAt,
    });
  });

  it("returns null instead of provisioning an unknown identity or membership", async () => {
    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.issueAccountSession({ identity, lifetimeMs: 60_000, sessionTokenHash }),
    ).resolves.toBeNull();
  });

  it("rechecks invitation tenant and expiry at final consume inside the provisioning transaction", async () => {
    const invitationTokenDigest = Buffer.alloc(32, 4);
    const expiresAt = new Date("2026-08-31T00:00:00.000Z");
    const fixture = fakePool((text, values) => {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.organization_invitations invitation")) {
        expect(text).toContain("FOR UPDATE OF invitation, organization");
        return {
          rowCount: 1,
          rows: [{ invited_role: "member", normalized_email: "invited@example.com", tenant_id: "tenant-a" }],
        };
      }
      if (text.includes("FROM public.users")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM public.organization_memberships")) return { rowCount: 0, rows: [] };
      if (text.includes("UPDATE public.organization_invitations")) {
        expect(text).toContain("tenant_id = $3");
        expect(text).toContain("expires_at > clock_timestamp()");
        expect(values[2]).toBe("tenant-a");
        return { rowCount: 1, rows: [{ invitation_id: "00000000-0000-4000-8000-000000000001" }] };
      }
      if (text.includes("INSERT INTO public.account_sessions")) {
        return { rowCount: 1, rows: [{ expires_at: expiresAt }] };
      }
      return { rowCount: 1, rows: [{}] };
    });
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });

    await expect(
      repository.issueInvitedAccountSession({
        identity: { issuer: "https://identity.example", subject: "new-user" },
        invitationTokenDigest,
        lifetimeMs: 60_000,
        newUserDisplayName: "New member",
        newUserId: "00000000-0000-4000-8000-000000000001",
        sessionTokenHash,
        verifiedEmail: "invited@example.com",
      }),
    ).resolves.toEqual({ expiresAt });
  });

  it("rejects malformed secrets, identities, and lifetimes before acquiring a connection", async () => {
    const invalidAttempts = [
      { browserBindingHash, codeVerifier, lifetimeMs: 60_000, nonce, stateHash: Buffer.alloc(31) },
      { browserBindingHash, codeVerifier: "v".repeat(42), lifetimeMs: 60_000, nonce, stateHash },
      { browserBindingHash, codeVerifier, lifetimeMs: 60_000, nonce: "short", stateHash },
      {
        browserBindingHash,
        codeVerifier,
        lifetimeMs: OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1 + 1,
        nonce,
        stateHash,
      },
    ];
    for (const attempt of invalidAttempts) {
      const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
      const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });
      await expect(repository.createLoginAttempt(attempt)).rejects.toThrow();
      expect(fixture.pool.connect).not.toHaveBeenCalled();
    }

    const fixture = fakePool(() => ({ rowCount: 0, rows: [] }));
    const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });
    await expect(
      repository.issueAccountSession({
        identity: { issuer: "http://identity.example/", subject: "subject" },
        lifetimeMs: 60_000,
        sessionTokenHash,
      }),
    ).rejects.toThrow(/identity is invalid/i);
    await expect(
      repository.issueAccountSession({
        identity,
        lifetimeMs: ACCOUNT_SESSION_MAX_LIFETIME_MS_V1 + 1,
        sessionTokenHash,
      }),
    ).rejects.toThrow(/lifetimeMs/i);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("fails closed on duplicate or malformed persisted results", async () => {
    for (const rows of [
      [
        { code_verifier: codeVerifier, invitation_token_digest: null, nonce },
        { code_verifier: codeVerifier, invitation_token_digest: null, nonce },
      ],
      [{ code_verifier: "invalid", invitation_token_digest: null, nonce }],
      [{ code_verifier: codeVerifier, invitation_token_digest: null, nonce: "invalid" }],
    ]) {
      const fixture = fakePool(() => ({ rowCount: rows.length, rows }));
      const repository = new PostgresOidcLoginRepositoryV1({ pool: fixture.pool });
      await expect(repository.consumeLoginAttempt({ browserBindingHash, stateHash })).rejects.toThrow();
    }
  });
});
