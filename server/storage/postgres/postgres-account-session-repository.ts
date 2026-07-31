import type { Pool, PoolConfig, QueryResultRow } from "pg";

import { organizationIdSchemaV1 } from "../../accounts/account-domain";
import type { AccountSessionRepositoryV1, ResolvedAccountSessionV1 } from "../../accounts/account-session-repository";
import { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type AccountSessionRow = QueryResultRow & {
  active_tenant_id: string;
  oidc_issuer: string;
  oidc_subject: string;
};

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactSessionTokenHash(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("Account session token hash must contain exactly 32 bytes.");
  }
  return Buffer.from(value);
}

function exactOidcIssuer(value: string) {
  if (value.length < 1 || value.length > 2_048 || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? value : null;
  } catch {
    return null;
  }
}

function sessionFromRow(row: AccountSessionRow): ResolvedAccountSessionV1 {
  const organizationId = organizationIdSchemaV1.safeParse(row.active_tenant_id);
  if (
    !organizationId.success ||
    typeof row.oidc_issuer !== "string" ||
    exactOidcIssuer(row.oidc_issuer) === null ||
    typeof row.oidc_subject !== "string" ||
    row.oidc_subject.length < 1 ||
    row.oidc_subject.length > 255 ||
    row.oidc_subject.trim() !== row.oidc_subject ||
    /[\u0000-\u001f\u007f]/u.test(row.oidc_issuer) ||
    /[\u0000-\u001f\u007f]/u.test(row.oidc_subject)
  ) {
    throw new TypeError("PostgreSQL returned an invalid account session.");
  }
  return {
    issuer: row.oidc_issuer,
    sessionOrganizationId: organizationId.data,
    subject: row.oidc_subject,
  };
}

export class PostgresAccountSessionRepositoryV1 implements AccountSessionRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 12",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 12 &&
        result.rows[0]?.checksum === ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async resolveActiveSession(sessionTokenHashValue: Uint8Array, signal?: AbortSignal) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<AccountSessionRow>(
      `SELECT account.oidc_issuer,
              account.oidc_subject,
              session.active_tenant_id
         FROM public.account_sessions session
         JOIN public.users account ON account.user_id = session.user_id
        WHERE session.session_token_hash = $1
          AND session.revoked_at IS NULL
          AND session.expires_at > clock_timestamp()
          AND account.status = 'active'
        LIMIT 2`,
      [sessionTokenHash],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate account sessions.");
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }

  close() {
    return this.#connection.close();
  }
}
