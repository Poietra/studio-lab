import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  accountDisplayNameSchemaV1,
  accountOrganizationSwitchMutationIdSchemaV1,
} from "../../../src/accounts/account-session-contract";
import { accountUserIdSchemaV1, organizationIdSchemaV1, organizationRoleSchemaV1 } from "../../accounts/account-domain";
import type {
  AccountSessionControlRepositoryV1,
  AccountSessionRepositoryV1,
  ResolvedAccountSessionAccountV1,
  ResolvedAccountSessionV1,
  SwitchActiveOrganizationResultV1,
} from "../../accounts/account-session-repository";
import { ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM } from "./account-organization-switch-mutation-schema";
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
  session_version: string;
  switch_mutation_id?: string | null;
  switch_organization_id?: string | null;
  switch_version?: string | null;
};

type AccountSessionSwitchRow = AccountSessionAccountRow & {
  confirmed_mutation_id: string | null;
  confirmed_organization_id: string | null;
  confirmed_version: string | null;
  mutation_status: string;
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

function exactSessionVersion(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError("PostgreSQL returned an invalid account session version.");
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new TypeError("PostgreSQL returned an account session version outside the API range.");
  }
  return version;
}

function organizationSwitchFromRow(row: AccountSessionAccountRow) {
  const values = [row.switch_mutation_id, row.switch_organization_id, row.switch_version];
  if (values.every((value) => value === null || value === undefined)) return null;
  if (values.some((value) => value === null || value === undefined)) {
    throw new TypeError("PostgreSQL returned an incomplete account organization switch.");
  }
  const mutationId = accountOrganizationSwitchMutationIdSchemaV1.safeParse(row.switch_mutation_id);
  const organizationId = organizationIdSchemaV1.safeParse(row.switch_organization_id);
  if (!mutationId.success || !organizationId.success) {
    throw new TypeError("PostgreSQL returned an invalid account organization switch.");
  }
  return {
    mutationId: mutationId.data,
    organizationId: organizationId.data,
    version: exactSessionVersion(row.switch_version),
  };
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
  const version = exactSessionVersion(first.session_version);
  const organizationSwitch = organizationSwitchFromRow(first);
  const organizations: ResolvedAccountSessionAccountV1["organizations"] = [];
  for (const row of rows) {
    if (
      row.user_id !== user.id ||
      row.user_display_name !== user.displayName ||
      row.active_organization_id !== activeOrganizationId.data ||
      row.session_version !== first.session_version ||
      row.switch_mutation_id !== first.switch_mutation_id ||
      row.switch_organization_id !== first.switch_organization_id ||
      row.switch_version !== first.switch_version
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
  return { activeOrganizationId: activeOrganizationId.data, organizations, organizationSwitch, user, version };
}

function switchResultFromRows(rows: readonly AccountSessionSwitchRow[]): SwitchActiveOrganizationResultV1 {
  const first = rows[0];
  if (
    !first ||
    rows.some(
      (row) =>
        row.mutation_status !== first.mutation_status ||
        row.confirmed_mutation_id !== first.confirmed_mutation_id ||
        row.confirmed_organization_id !== first.confirmed_organization_id ||
        row.confirmed_version !== first.confirmed_version,
    )
  ) {
    throw new TypeError("PostgreSQL returned an invalid account organization switch.");
  }
  if (first.mutation_status === "invalid-session") {
    if (rows.length !== 1) throw new TypeError("PostgreSQL returned duplicate invalid account sessions.");
    return { kind: "invalid-session" };
  }
  if (first.mutation_status === "organization-unavailable") {
    if (rows.length !== 1) throw new TypeError("PostgreSQL returned duplicate unavailable organizations.");
    return { kind: "organization-unavailable" };
  }
  if (first.mutation_status === "conflict") {
    if (rows.length !== 1) throw new TypeError("PostgreSQL returned duplicate account session conflicts.");
    return { kind: "conflict" };
  }
  if (first.mutation_status !== "updated") {
    throw new TypeError("PostgreSQL returned an unknown account organization switch status.");
  }
  const account = accountFromRows(rows);
  if (!account) throw new TypeError("PostgreSQL omitted the updated account session.");
  const mutationId = accountOrganizationSwitchMutationIdSchemaV1.safeParse(first.confirmed_mutation_id);
  const organizationId = organizationIdSchemaV1.safeParse(first.confirmed_organization_id);
  if (!mutationId.success || !organizationId.success) {
    throw new TypeError("PostgreSQL returned an invalid confirmed account organization switch.");
  }
  return {
    account,
    kind: "updated",
    mutation: {
      mutationId: mutationId.data,
      organizationId: organizationId.data,
      version: exactSessionVersion(first.confirmed_version),
    },
  };
}

export class PostgresAccountSessionRepositoryV1
  implements AccountSessionRepositoryV1, AccountSessionControlRepositoryV1
{
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (12, 28) ORDER BY version",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 2 &&
        result.rows[0]?.version === 12 &&
        result.rows[0]?.checksum === ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM &&
        result.rows[1]?.version === 28 &&
        result.rows[1]?.checksum === ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM
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
                session.active_tenant_id AS active_organization_id,
                session.version::text AS session_version
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
              selected.session_version,
              latest.mutation_id::text AS switch_mutation_id,
              latest.organization_id AS switch_organization_id,
              latest.resulting_version::text AS switch_version,
              organization.organization_id,
              organization.organization_display_name,
              organization.organization_role
         FROM selected_session selected
         LEFT JOIN LATERAL (
           SELECT mutation.mutation_id, mutation.organization_id, mutation.resulting_version
             FROM public.account_organization_switch_mutations mutation
            WHERE mutation.session_token_hash = $1
            ORDER BY mutation.resulting_version DESC
            LIMIT 1
         ) latest ON true
         LEFT JOIN active_organizations organization ON true
        ORDER BY organization.organization_id COLLATE "C" NULLS LAST`,
      [sessionTokenHash],
      signal,
    );
    throwIfAborted(signal);
    const account = accountFromRows(result.rows);
    return account;
  }

  async switchActiveOrganization(
    sessionTokenHashValue: Uint8Array,
    organizationIdValue: string,
    expectedVersionValue: number,
    mutationIdValue: string,
    signal?: AbortSignal,
  ) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    const organizationId = organizationIdSchemaV1.parse(organizationIdValue);
    const mutationId = accountOrganizationSwitchMutationIdSchemaV1.parse(mutationIdValue);
    if (!Number.isSafeInteger(expectedVersionValue) || expectedVersionValue < 1) {
      throw new TypeError("The expected account session version is invalid.");
    }
    throwIfAborted(signal);
    const result = await this.#connection.query<AccountSessionSwitchRow>(
      `WITH selected_session AS MATERIALIZED (
         SELECT session.user_id,
                account.display_name AS user_display_name,
                session.active_tenant_id AS active_organization_id,
                session.version AS session_version
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
          LIMIT 1
          FOR UPDATE OF session
       ), existing_mutation AS MATERIALIZED (
         SELECT mutation.mutation_id,
                mutation.organization_id,
                mutation.expected_version,
                mutation.resulting_version
           FROM public.account_organization_switch_mutations mutation
          WHERE mutation.session_token_hash = $1
            AND mutation.mutation_id = $4::uuid
       ), target_access AS MATERIALIZED (
         SELECT selected.user_id,
                membership.tenant_id AS organization_id
           FROM selected_session selected
           JOIN public.organization_memberships membership ON membership.user_id = selected.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE membership.tenant_id = $2
            AND membership.status = 'active'
            AND organization.status = 'active'
          FOR SHARE OF membership, organization
       ), updated_session AS (
         UPDATE public.account_sessions session
            SET active_tenant_id = target.organization_id
           FROM target_access target
         WHERE session.session_token_hash = $1
            AND session.user_id = target.user_id
            AND session.version = $3::bigint
            AND NOT EXISTS (SELECT 1 FROM existing_mutation)
          RETURNING session.active_tenant_id AS active_organization_id,
                    session.user_id,
                    session.version AS session_version
       ), inserted_mutation AS (
         INSERT INTO public.account_organization_switch_mutations
           (session_token_hash, mutation_id, organization_id, expected_version, resulting_version)
         SELECT $1, $4::uuid, updated.active_organization_id, $3::bigint, updated.session_version
           FROM updated_session updated
         RETURNING mutation_id, organization_id, expected_version, resulting_version
       ), confirmed_mutation AS MATERIALIZED (
         SELECT mutation_id, organization_id, expected_version, resulting_version FROM existing_mutation
         UNION ALL
         SELECT mutation_id, organization_id, expected_version, resulting_version FROM inserted_mutation
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
       SELECT CASE
                WHEN selected.user_id IS NULL THEN 'invalid-session'
                WHEN existing.mutation_id IS NOT NULL
                 AND (existing.organization_id <> $2 OR existing.expected_version <> $3::bigint) THEN 'conflict'
                WHEN existing.mutation_id IS NOT NULL THEN 'updated'
                WHEN target.user_id IS NULL THEN 'organization-unavailable'
                WHEN selected.session_version <> $3::bigint THEN 'conflict'
                WHEN updated.user_id IS NULL THEN 'conflict'
                ELSE 'updated'
              END AS mutation_status,
              COALESCE(updated.active_organization_id, selected.active_organization_id) AS active_organization_id,
              organization.organization_display_name,
              organization.organization_id,
              organization.organization_role,
              selected.user_display_name,
              selected.user_id,
              COALESCE(updated.session_version, selected.session_version)::text AS session_version,
              latest.mutation_id::text AS switch_mutation_id,
              latest.organization_id AS switch_organization_id,
              latest.resulting_version::text AS switch_version,
              confirmed.mutation_id::text AS confirmed_mutation_id,
              confirmed.organization_id AS confirmed_organization_id,
              confirmed.resulting_version::text AS confirmed_version
         FROM (VALUES (1)) AS request_anchor(value)
         LEFT JOIN selected_session selected ON true
         LEFT JOIN existing_mutation existing ON true
         LEFT JOIN target_access target ON target.user_id = selected.user_id
         LEFT JOIN updated_session updated ON updated.user_id = selected.user_id
         LEFT JOIN confirmed_mutation confirmed ON true
         LEFT JOIN LATERAL (
           SELECT mutation.mutation_id, mutation.organization_id, mutation.resulting_version
             FROM public.account_organization_switch_mutations mutation
            WHERE mutation.session_token_hash = $1
            ORDER BY mutation.resulting_version DESC
            LIMIT 1
         ) latest ON true
         LEFT JOIN active_organizations organization
           ON confirmed.mutation_id IS NOT NULL
        ORDER BY organization.organization_id COLLATE "C" NULLS LAST`,
      [sessionTokenHash, organizationId, expectedVersionValue, mutationId],
      signal,
    );
    throwIfAborted(signal);
    return switchResultFromRows(result.rows);
  }

  async revokeAccountSession(sessionTokenHashValue: Uint8Array, signal?: AbortSignal) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<{ revoked: number }>(
      `UPDATE public.account_sessions
          SET revoked_at = clock_timestamp()
        WHERE session_token_hash = $1
          AND revoked_at IS NULL
      RETURNING 1 AS revoked`,
      [sessionTokenHash],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1 || (result.rows[0] !== undefined && result.rows[0].revoked !== 1)) {
      throw new TypeError("PostgreSQL returned an invalid account logout result.");
    }
  }

  close() {
    return this.#connection.close();
  }
}
