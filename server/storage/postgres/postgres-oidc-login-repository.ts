import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
  type ConsumedOidcLoginAttemptV1,
  type CreateOidcLoginAttemptV1,
  type IssueAccountSessionV1,
  type IssuedAccountSessionV1,
  OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
  type OidcLoginRepositoryV1,
} from "../../accounts/oidc-login-repository";
import type { ExternalAccountIdentityV1 } from "../../accounts/organization-membership-repository";
import { OIDC_LOGIN_MIGRATION_V13_CHECKSUM } from "./oidc-login-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type AttemptExpiryRow = QueryResultRow & { expires_at: Date };
type ConsumedAttemptRow = QueryResultRow & {
  code_verifier: string;
  nonce: string;
};
type IssuedSessionRow = QueryResultRow & {
  expires_at: Date;
};

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactHash(value: Uint8Array, name: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${name} must contain exactly 32 bytes.`);
  }
  return Buffer.from(value);
}

function boundedLifetime(value: number, name: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function exactCodeVerifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) {
    throw new TypeError("OIDC PKCE code verifier is invalid.");
  }
  return value;
}

function exactNonce(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,255}$/u.test(value)) {
    throw new TypeError("OIDC nonce is invalid.");
  }
  return value;
}

function exactIdentity(value: ExternalAccountIdentityV1) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.issuer !== "string" ||
    value.issuer.length < 1 ||
    value.issuer.length > 2_048 ||
    value.issuer.trim() !== value.issuer ||
    /[\u0000-\u001f\u007f]/u.test(value.issuer) ||
    typeof value.subject !== "string" ||
    value.subject.length < 1 ||
    value.subject.length > 255 ||
    value.subject.trim() !== value.subject ||
    /[\u0000-\u001f\u007f]/u.test(value.subject)
  ) {
    throw new TypeError("External account identity is invalid.");
  }
  let issuer: URL;
  try {
    issuer = new URL(value.issuer);
  } catch {
    throw new TypeError("External account identity is invalid.");
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new TypeError("External account identity is invalid.");
  }
  return value;
}

function exactDate(value: Date, name: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  }
  return new Date(value.getTime());
}

function attemptFromRow(row: ConsumedAttemptRow): ConsumedOidcLoginAttemptV1 {
  return {
    codeVerifier: exactCodeVerifier(row.code_verifier),
    nonce: exactNonce(row.nonce),
  };
}

function sessionFromRow(row: IssuedSessionRow): IssuedAccountSessionV1 {
  return {
    expiresAt: exactDate(row.expires_at, "account-session expiry"),
  };
}

export class PostgresOidcLoginRepositoryV1 implements OidcLoginRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 13",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 13 &&
        result.rows[0]?.checksum === OIDC_LOGIN_MIGRATION_V13_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async createLoginAttempt(input: CreateOidcLoginAttemptV1, signal?: AbortSignal) {
    const stateHash = exactHash(input.stateHash, "OIDC state hash");
    const browserBindingHash = exactHash(input.browserBindingHash, "OIDC browser-binding hash");
    const codeVerifier = exactCodeVerifier(input.codeVerifier);
    const nonce = exactNonce(input.nonce);
    const lifetimeMs = boundedLifetime(
      input.lifetimeMs,
      "OIDC login-attempt lifetimeMs",
      OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
    );
    throwIfAborted(signal);
    const result = await this.#connection.query<AttemptExpiryRow>(
      `WITH expired AS MATERIALIZED (
         SELECT state_hash
           FROM public.oidc_login_attempts
          WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at, state_hash
          LIMIT 128
            FOR UPDATE SKIP LOCKED
       ), pruned AS (
         DELETE FROM public.oidc_login_attempts attempt
          USING expired
          WHERE attempt.state_hash = expired.state_hash
       ), issued_at AS (SELECT clock_timestamp() AS value)
       INSERT INTO public.oidc_login_attempts
         (state_hash, browser_binding_hash, code_verifier, nonce, created_at, expires_at)
       SELECT $1, $2, $3, $4, issued_at.value,
              issued_at.value + ($5::bigint * interval '1 millisecond')
         FROM issued_at
       RETURNING expires_at`,
      [stateHash, browserBindingHash, codeVerifier, nonce, lifetimeMs],
      signal,
    );
    throwIfAborted(signal);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw new TypeError("PostgreSQL did not create one OIDC login attempt.");
    return { expiresAt: exactDate(row.expires_at, "OIDC login-attempt expiry") };
  }

  async consumeLoginAttempt(
    selector: Readonly<{ browserBindingHash: Uint8Array; stateHash: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const stateHash = exactHash(selector.stateHash, "OIDC state hash");
    const browserBindingHash = exactHash(selector.browserBindingHash, "OIDC browser-binding hash");
    throwIfAborted(signal);
    const result = await this.#connection.query<ConsumedAttemptRow>(
      `WITH removed AS (
         DELETE FROM public.oidc_login_attempts
          WHERE state_hash = $1
            AND browser_binding_hash = $2
        RETURNING code_verifier, nonce, expires_at > clock_timestamp() AS active
       )
       SELECT code_verifier, nonce FROM removed WHERE active`,
      [stateHash, browserBindingHash],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL consumed duplicate OIDC login attempts.");
    const row = result.rows[0];
    return row ? attemptFromRow(row) : null;
  }

  async issueAccountSession(input: IssueAccountSessionV1, signal?: AbortSignal) {
    const sessionTokenHash = exactHash(input.sessionTokenHash, "Account session token hash");
    const identity = exactIdentity(input.identity);
    const lifetimeMs = boundedLifetime(
      input.lifetimeMs,
      "Account session lifetimeMs",
      ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
    );
    throwIfAborted(signal);
    const result = await this.#connection.query<IssuedSessionRow>(
      `WITH selected_membership AS MATERIALIZED (
         SELECT account.user_id, membership.tenant_id
           FROM public.users account
           JOIN public.organization_memberships membership ON membership.user_id = account.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE account.oidc_issuer = $1
            AND account.oidc_subject = $2
            AND account.status = 'active'
            AND membership.status = 'active'
            AND organization.status = 'active'
          ORDER BY membership.created_at, membership.tenant_id
          LIMIT 1
       ), issued_at AS (SELECT clock_timestamp() AS value)
       INSERT INTO public.account_sessions
         (session_token_hash, user_id, active_tenant_id, created_at, expires_at)
       SELECT $3, selected_membership.user_id, selected_membership.tenant_id,
              issued_at.value, issued_at.value + ($4::bigint * interval '1 millisecond')
         FROM selected_membership CROSS JOIN issued_at
       RETURNING expires_at`,
      [identity.issuer, identity.subject, sessionTokenHash, lifetimeMs],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL issued duplicate account sessions.");
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  close() {
    return this.#connection.close();
  }
}
