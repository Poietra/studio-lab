import type { Pool, PoolConfig, QueryResultRow } from "pg";

import { accountUserIdSchemaV1, organizationIdSchemaV1, organizationRoleSchemaV1 } from "../../accounts/account-domain";
import type {
  ExternalAccountIdentityV1,
  OrganizationMembershipRepositoryV1,
  ResolvedOrganizationMembershipV1,
} from "../../accounts/organization-membership-repository";
import { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type MembershipRow = QueryResultRow & {
  organization_id: string;
  role: string;
  user_id: string;
  version: string;
};

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function externalIdentity(value: ExternalAccountIdentityV1) {
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
  return value;
}

function organizationId(value: string) {
  const parsed = organizationIdSchemaV1.safeParse(value);
  if (!parsed.success) throw new TypeError("Organization ID is invalid.");
  return parsed.data;
}

function membershipFromRow(row: MembershipRow): ResolvedOrganizationMembershipV1 {
  const userId = accountUserIdSchemaV1.safeParse(row.user_id);
  const organization = organizationIdSchemaV1.safeParse(row.organization_id);
  const role = organizationRoleSchemaV1.safeParse(row.role);
  if (!userId.success || !organization.success || !role.success || !/^[1-9][0-9]*$/u.test(row.version)) {
    throw new TypeError("PostgreSQL returned an invalid organization membership.");
  }
  const version = BigInt(row.version);
  if (version > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("PostgreSQL returned an invalid organization membership version.");
  }
  return {
    organizationId: organization.data,
    role: role.data,
    userId: userId.data,
    version,
  };
}

export class PostgresOrganizationMembershipRepositoryV1 implements OrganizationMembershipRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 11",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 11 &&
        result.rows[0]?.checksum === ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async resolveActiveMembership(
    identityValue: ExternalAccountIdentityV1,
    organizationIdValue: string,
    signal?: AbortSignal,
  ) {
    const identity = externalIdentity(identityValue);
    const selectedOrganizationId = organizationId(organizationIdValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<MembershipRow>(
      `SELECT membership.tenant_id AS organization_id,
              membership.user_id::text AS user_id,
              membership.role,
              membership.version::text AS version
         FROM public.users account
         JOIN public.organization_memberships membership ON membership.user_id = account.user_id
         JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
        WHERE account.oidc_issuer = $1
          AND account.oidc_subject = $2
          AND account.status = 'active'
          AND membership.tenant_id = $3
          AND membership.status = 'active'
          AND organization.status = 'active'`,
      [identity.issuer, identity.subject, selectedOrganizationId],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate organization memberships.");
    const row = result.rows[0];
    if (!row) return null;
    const membership = membershipFromRow(row);
    if (membership.organizationId !== selectedOrganizationId) {
      throw new TypeError("PostgreSQL returned a membership for another organization.");
    }
    return membership;
  }

  close() {
    return this.#connection.close();
  }
}
