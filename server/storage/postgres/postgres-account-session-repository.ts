import type { Pool, PoolConfig, QueryResultRow } from "pg";

import { accountDisplayNameSchemaV1 } from "../../../src/accounts/account-session-contract";
import { accountUserIdSchemaV1, organizationIdSchemaV1, organizationRoleSchemaV1 } from "../../accounts/account-domain";
import type {
  AccountSessionRepositoryV1,
  AccountSessionViewRepositoryV1,
  ResolvedAccountSessionAccountV1,
  ResolvedAccountSessionV1,
} from "../../accounts/account-session-repository";
import { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type AccountSessionRow = QueryResultRow & {
  active_tenant_id: string;
  oidc_issuer: string;
  oidc_subject: string;
};

type AccountSessionAccountRow = QueryResultRow & {
  active_organization_id: string;
  organization_display_name: string | null;
  organization_id: string | null;
  organization_role: string | null;
  user_display_name: string;
  user_id: string;
};

const MAX_ACCOUNT_ORGANIZATIONS_V1 = 256;

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

function exactDisplayName(value: unknown, name: string) {
  const parsed = accountDisplayNameSchemaV1.safeParse(value);
  if (!parsed.success) throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  return parsed.data;
}

function accountFromRows(rows: readonly AccountSessionAccountRow[]): ResolvedAccountSessionAccountV1 | null {
  const first = rows[0];
  if (!first) return null;
  const userId = accountUserIdSchemaV1.safeParse(first.user_id);
  const activeOrganizationId = organizationIdSchemaV1.safeParse(first.active_organization_id);
  if (!userId.success || !activeOrganizationId.success) {
    throw new TypeError("PostgreSQL returned an invalid account session identity.");
  }
  const user = {
    displayName: exactDisplayName(first.user_display_name, "account display name"),
    id: userId.data,
  };
  const organizations: ResolvedAccountSessionAccountV1["organizations"] = [];
  for (const row of rows) {
    if (
      row.user_id !== user.id ||
      row.user_display_name !== user.displayName ||
      row.active_organization_id !== activeOrganizationId.data
    ) {
      throw new TypeError("PostgreSQL returned inconsistent account session rows.");
    }
    if (row.organization_id === null || row.organization_display_name === null || row.organization_role === null) {
      if (
        row.organization_id !== null ||
        row.organization_display_name !== null ||
        row.organization_role !== null ||
        rows.length !== 1
      ) {
        throw new TypeError("PostgreSQL returned an incomplete organization membership.");
      }
      continue;
    }
    const organizationId = organizationIdSchemaV1.safeParse(row.organization_id);
    const role = organizationRoleSchemaV1.safeParse(row.organization_role);
    if (!organizationId.success || !role.success) {
      throw new TypeError("PostgreSQL returned an invalid organization membership.");
    }
    organizations.push({
      displayName: exactDisplayName(row.organization_display_name, "organization display name"),
      id: organizationId.data,
      role: role.data,
    });
  }
  if (organizations.length > MAX_ACCOUNT_ORGANIZATIONS_V1) {
    throw new TypeError("PostgreSQL returned too many organization memberships.");
  }
  for (let index = 1; index < organizations.length; index += 1) {
    if (organizations[index - 1]!.id >= organizations[index]!.id) {
      throw new TypeError("PostgreSQL returned non-canonical organization memberships.");
    }
  }
  return { activeOrganizationId: activeOrganizationId.data, organizations, user };
}

export class PostgresAccountSessionRepositoryV1 implements AccountSessionRepositoryV1, AccountSessionViewRepositoryV1 {
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

  async resolveAccountSession(sessionTokenHashValue: Uint8Array, signal?: AbortSignal) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<AccountSessionAccountRow>(
      `WITH selected_session AS MATERIALIZED (
         SELECT session.user_id AS user_id,
                account.display_name AS user_display_name,
                session.active_tenant_id AS active_organization_id
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
          LIMIT 1
       ), active_organizations AS MATERIALIZED (
         SELECT membership.tenant_id AS organization_id,
                organization.display_name AS organization_display_name,
                membership.role AS organization_role
           FROM selected_session selected
           JOIN public.organization_memberships membership ON membership.user_id = selected.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE membership.status = 'active'
            AND organization.status = 'active'
          ORDER BY membership.tenant_id COLLATE "C"
          LIMIT ${MAX_ACCOUNT_ORGANIZATIONS_V1 + 1}
       )
       SELECT selected.user_id,
              selected.user_display_name,
              selected.active_organization_id,
              organization.organization_id,
              organization.organization_display_name,
              organization.organization_role
         FROM selected_session selected
         LEFT JOIN active_organizations organization ON true
        ORDER BY organization.organization_id COLLATE "C" NULLS LAST`,
      [sessionTokenHash],
      signal,
    );
    throwIfAborted(signal);
    const account = accountFromRows(result.rows);
    return account;
  }

  close() {
    return this.#connection.close();
  }
}
