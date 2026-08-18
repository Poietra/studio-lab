import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  type AccountMembershipMutationRequestV1,
  accountMembershipMutationRequestSchemaV1,
  type AccountOrganizationMemberV1,
  accountOrganizationMemberSchemaV1,
} from "../../../src/accounts/account-membership-contract";
import {
  accountDisplayNameSchemaV1,
  accountOrganizationSwitchMutationIdSchemaV1,
} from "../../../src/accounts/account-session-contract";
import { accountUserIdSchemaV1, organizationIdSchemaV1, organizationRoleSchemaV1 } from "../../accounts/account-domain";
import type {
  AccountSessionControlRepositoryV1,
  AccountSessionRepositoryV1,
  ListActiveOrganizationMembersResultV1,
  MutateActiveOrganizationMemberResultV1,
  ResolvedAccountSessionAccountV1,
  ResolvedAccountSessionV1,
  SwitchActiveOrganizationResultV1,
} from "../../accounts/account-session-repository";
import { ACCOUNT_ORGANIZATION_LIFECYCLE_MIGRATION_V34_CHECKSUM } from "./account-organization-lifecycle-schema";
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

type AccountOrganizationMemberRow = QueryResultRow & {
  access_status: string;
  actor_role: string | null;
  member_display_name: string | null;
  member_id: string | null;
  member_role: string | null;
  member_version: string | null;
};

type AccountMembershipActorRow = QueryResultRow & {
  actor_role: string;
  organization_id: string;
  user_id: string;
};

type AccountMembershipTargetRow = QueryResultRow & {
  member_role: string;
  member_version: string;
};

type AccountMembershipMutationRow = QueryResultRow & {
  action: string;
  actor_user_id: string;
  expected_membership_version: string;
  member_user_id: string;
  mutation_id: string;
  organization_id: string;
  requested_role: string | null;
  resulting_membership_version: string;
};

const MAX_ACCOUNT_ORGANIZATIONS_V1 = 256;
const MAX_ACCOUNT_ORGANIZATION_MEMBERS_V1 = 256;

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

function membersFromRows(rows: readonly AccountOrganizationMemberRow[]): ListActiveOrganizationMembersResultV1 {
  const first = rows[0];
  if (!first || rows.some((row) => row.access_status !== first.access_status || row.actor_role !== first.actor_role)) {
    throw new TypeError("PostgreSQL returned an invalid organization member result.");
  }
  if (first.access_status === "invalid-session" || first.access_status === "forbidden") {
    if (
      rows.length !== 1 ||
      first.actor_role !== null ||
      first.member_id !== null ||
      first.member_display_name !== null ||
      first.member_role !== null ||
      first.member_version !== null
    ) {
      throw new TypeError("PostgreSQL returned members without organization access.");
    }
    return { kind: first.access_status };
  }
  if (first.access_status !== "listed") {
    throw new TypeError("PostgreSQL returned an unknown organization member access status.");
  }
  if (rows.length > MAX_ACCOUNT_ORGANIZATION_MEMBERS_V1) {
    throw new TypeError("PostgreSQL returned too many organization members.");
  }
  const actorRole = organizationRoleSchemaV1.safeParse(first.actor_role);
  if (!actorRole.success) throw new TypeError("PostgreSQL returned an invalid organization member actor role.");
  const members: AccountOrganizationMemberV1[] = rows.map((row) => {
    const parsed = accountOrganizationMemberSchemaV1.safeParse({
      displayName: row.member_display_name,
      id: row.member_id,
      role: row.member_role,
      version:
        typeof row.member_version === "string" && /^[1-9][0-9]*$/u.test(row.member_version)
          ? Number(row.member_version)
          : Number.NaN,
    });
    if (!parsed.success) throw new TypeError("PostgreSQL returned an invalid organization member.");
    return parsed.data;
  });
  for (let index = 1; index < members.length; index += 1) {
    if (members[index - 1]!.id >= members[index]!.id) {
      throw new TypeError("PostgreSQL returned non-canonical organization members.");
    }
  }
  return { actorRole: actorRole.data, kind: "listed", members };
}

function membershipMutationFromRow(row: AccountMembershipMutationRow) {
  const actorUserId = accountUserIdSchemaV1.safeParse(row.actor_user_id);
  const memberId = accountUserIdSchemaV1.safeParse(row.member_user_id);
  const organizationId = organizationIdSchemaV1.safeParse(row.organization_id);
  const request = accountMembershipMutationRequestSchemaV1.safeParse({
    action: row.action,
    expectedVersion: exactSessionVersion(row.expected_membership_version),
    mutationId: row.mutation_id,
    ...(row.requested_role === null ? {} : { role: row.requested_role }),
  });
  const resultingVersion = exactSessionVersion(row.resulting_membership_version);
  if (
    !actorUserId.success ||
    !memberId.success ||
    !organizationId.success ||
    !request.success ||
    resultingVersion !== request.data.expectedVersion + 1
  ) {
    throw new TypeError("PostgreSQL returned an invalid account membership mutation.");
  }
  return {
    actorUserId: actorUserId.data,
    memberId: memberId.data,
    organizationId: organizationId.data,
    request: request.data,
    resultingVersion,
  };
}

function membershipMutationAllowed(actorRole: string, targetRole: string, request: AccountMembershipMutationRequestV1) {
  if (actorRole === "owner") return true;
  if (actorRole !== "admin" || targetRole === "owner" || targetRole === "admin") return false;
  return request.action === "remove" || request.role === "member" || request.role === "billing";
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
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (12, 28, 34) ORDER BY version",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 3 &&
        result.rows[0]?.version === 12 &&
        result.rows[0]?.checksum === ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM &&
        result.rows[1]?.version === 28 &&
        result.rows[1]?.checksum === ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM &&
        result.rows[2]?.version === 34 &&
        result.rows[2]?.checksum === ACCOUNT_ORGANIZATION_LIFECYCLE_MIGRATION_V34_CHECKSUM
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

  async listActiveOrganizationMembers(sessionTokenHashValue: Uint8Array, signal?: AbortSignal) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<AccountOrganizationMemberRow>(
      `WITH selected_session AS MATERIALIZED (
         SELECT session.user_id, session.active_tenant_id
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
          LIMIT 1
       ), actor AS MATERIALIZED (
         SELECT selected.user_id, selected.active_tenant_id, membership.role AS actor_role
           FROM selected_session selected
           JOIN public.organization_memberships membership
             ON membership.tenant_id = selected.active_tenant_id
            AND membership.user_id = selected.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE membership.status = 'active'
            AND organization.status = 'active'
       ), active_members AS MATERIALIZED (
         SELECT membership.user_id::text AS member_id,
                account.display_name AS member_display_name,
                membership.role AS member_role,
                membership.version::text AS member_version
           FROM actor
           JOIN public.organization_memberships membership
             ON membership.tenant_id = actor.active_tenant_id
           JOIN public.users account ON account.user_id = membership.user_id
          WHERE membership.status = 'active'
            AND account.status = 'active'
          ORDER BY membership.user_id
          LIMIT ${MAX_ACCOUNT_ORGANIZATION_MEMBERS_V1 + 1}
       )
       SELECT CASE
                WHEN selected.user_id IS NULL THEN 'invalid-session'
                WHEN actor.user_id IS NULL THEN 'forbidden'
                ELSE 'listed'
              END AS access_status,
              actor.actor_role,
              member.member_id,
              member.member_display_name,
              member.member_role,
              member.member_version
         FROM (VALUES (1)) AS request_anchor(value)
         LEFT JOIN selected_session selected ON true
         LEFT JOIN actor ON actor.user_id = selected.user_id
         LEFT JOIN active_members member ON actor.user_id IS NOT NULL
        ORDER BY member.member_id COLLATE "C" NULLS LAST`,
      [sessionTokenHash],
      signal,
    );
    throwIfAborted(signal);
    return membersFromRows(result.rows);
  }

  async mutateActiveOrganizationMember(
    sessionTokenHashValue: Uint8Array,
    memberIdValue: string,
    requestValue: AccountMembershipMutationRequestV1,
    signal?: AbortSignal,
  ) {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    const memberId = accountUserIdSchemaV1.parse(memberIdValue);
    const request = accountMembershipMutationRequestSchemaV1.parse(requestValue);
    throwIfAborted(signal);
    return this.#connection.transaction(async (client): Promise<MutateActiveOrganizationMemberResultV1> => {
      const actors = await client.query<AccountMembershipActorRow>(
        `SELECT session.user_id::text,
                session.active_tenant_id AS organization_id,
                membership.role AS actor_role
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
           JOIN public.organizations organization ON organization.tenant_id = session.active_tenant_id
           JOIN public.organization_memberships membership
             ON membership.tenant_id = session.active_tenant_id
            AND membership.user_id = session.user_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
            AND organization.status = 'active'
            AND membership.status = 'active'
          FOR UPDATE OF session, organization, membership`,
        [sessionTokenHash],
      );
      throwIfAborted(signal);
      if (actors.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate account membership actors.");

      const sessionExists =
        actors.rows.length > 0
          ? true
          : (
              await client.query(
                `SELECT 1
                   FROM public.account_sessions session
                   JOIN public.users account ON account.user_id = session.user_id
                  WHERE session.session_token_hash = $1
                    AND session.revoked_at IS NULL
                    AND session.expires_at > clock_timestamp()
                    AND account.status = 'active'
                  LIMIT 1`,
                [sessionTokenHash],
              )
            ).rowCount === 1;
      const actor = actors.rows[0];
      if (!actor) return { kind: sessionExists ? "forbidden" : "invalid-session" };
      const actorUserId = accountUserIdSchemaV1.parse(actor.user_id);
      const organizationId = organizationIdSchemaV1.parse(actor.organization_id);
      const actorRole = organizationRoleSchemaV1.parse(actor.actor_role);
      // Changing the actor's own membership also changes the authority carried
      // by the current account view. Self-service role/leave flows must update
      // that session atomically, so the member-administration use case rejects it.
      if (memberId === actorUserId) return { kind: "forbidden" };

      const existingMutations = await client.query<AccountMembershipMutationRow>(
        `SELECT mutation_id::text,
                actor_user_id::text,
                organization_id,
                member_user_id::text,
                action,
                requested_role,
                expected_membership_version::text,
                resulting_membership_version::text
           FROM public.account_membership_mutations
          WHERE session_token_hash = $1 AND mutation_id = $2::uuid`,
        [sessionTokenHash, request.mutationId],
      );
      if (existingMutations.rows.length > 1) {
        throw new TypeError("PostgreSQL returned duplicate account membership mutations.");
      }
      const existingRow = existingMutations.rows[0];
      if (existingRow) {
        const existing = membershipMutationFromRow(existingRow);
        if (
          existing.actorUserId !== actorUserId ||
          existing.organizationId !== organizationId ||
          existing.memberId !== memberId ||
          JSON.stringify(existing.request) !== JSON.stringify(request)
        ) {
          return { kind: "conflict" };
        }
        return {
          kind: "applied",
          member:
            request.action === "set-role"
              ? { id: memberId, role: request.role, status: "active", version: existing.resultingVersion }
              : { id: memberId, status: "removed", version: existing.resultingVersion },
          mutationId: request.mutationId,
          replayed: true,
        };
      }

      const targets = await client.query<AccountMembershipTargetRow>(
        `SELECT membership.role AS member_role, membership.version::text AS member_version
           FROM public.organization_memberships membership
           JOIN public.users account ON account.user_id = membership.user_id
          WHERE membership.tenant_id = $1
            AND membership.user_id = $2::uuid
            AND membership.status = 'active'
            AND account.status = 'active'
          FOR UPDATE OF membership`,
        [organizationId, memberId],
      );
      if (targets.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate target memberships.");
      const target = targets.rows[0];
      if (!target) return { kind: "member-unavailable" };
      const targetRole = organizationRoleSchemaV1.parse(target.member_role);
      const targetVersion = exactSessionVersion(target.member_version);
      if (
        targetVersion !== request.expectedVersion ||
        !membershipMutationAllowed(actorRole, targetRole, request) ||
        (request.action === "set-role" && request.role === targetRole)
      ) {
        return targetVersion !== request.expectedVersion ||
          (request.action === "set-role" && request.role === targetRole)
          ? { kind: "conflict" }
          : { kind: "forbidden" };
      }

      if (targetRole === "owner" && (request.action === "remove" || request.role !== "owner")) {
        const owners = await client.query<{ owner_count: string }>(
          `SELECT count(*)::text AS owner_count
             FROM public.organization_memberships membership
             JOIN public.users account ON account.user_id = membership.user_id
            WHERE membership.tenant_id = $1
              AND membership.role = 'owner'
              AND membership.status = 'active'
              AND account.status = 'active'`,
          [organizationId],
        );
        if (owners.rows[0]?.owner_count === "1") return { kind: "conflict" };
      }

      const updated = await client.query<{ member_version: string }>(
        request.action === "set-role"
          ? `UPDATE public.organization_memberships
                SET role = $3
              WHERE tenant_id = $1 AND user_id = $2::uuid AND version = $4::bigint AND status = 'active'
            RETURNING version::text AS member_version`
          : `UPDATE public.organization_memberships
                SET status = 'suspended'
              WHERE tenant_id = $1 AND user_id = $2::uuid AND version = $3::bigint AND status = 'active'
            RETURNING version::text AS member_version`,
        request.action === "set-role"
          ? [organizationId, memberId, request.role, request.expectedVersion]
          : [organizationId, memberId, request.expectedVersion],
      );
      const updatedRow = updated.rows[0];
      if (updated.rows.length !== 1 || !updatedRow) return { kind: "conflict" };
      const resultingVersion = exactSessionVersion(updatedRow.member_version);
      if (resultingVersion !== request.expectedVersion + 1) {
        throw new TypeError("PostgreSQL returned an inconsistent account membership version.");
      }
      if (request.action === "remove") {
        await client.query(
          `UPDATE public.account_sessions
              SET revoked_at = clock_timestamp()
            WHERE user_id = $1::uuid
              AND active_tenant_id = $2
              AND revoked_at IS NULL`,
          [memberId, organizationId],
        );
      }
      await client.query(
        `INSERT INTO public.account_membership_mutations
           (session_token_hash, mutation_id, actor_user_id, organization_id, member_user_id,
            action, requested_role, expected_membership_version, resulting_membership_version)
         VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::bigint, $9::bigint)`,
        [
          sessionTokenHash,
          request.mutationId,
          actorUserId,
          organizationId,
          memberId,
          request.action,
          request.action === "set-role" ? request.role : null,
          request.expectedVersion,
          resultingVersion,
        ],
      );
      throwIfAborted(signal);
      return {
        kind: "applied",
        member:
          request.action === "set-role"
            ? { id: memberId, role: request.role, status: "active", version: resultingVersion }
            : { id: memberId, status: "removed", version: resultingVersion },
        mutationId: request.mutationId,
        replayed: false,
      };
    }, signal);
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
    const result = await this.#connection.transaction(async (client) => {
      // Lock in a separate statement so a retry that waited behind the first
      // mutation gets a fresh READ COMMITTED snapshot of its durable result.
      await client.query(
        `SELECT 1
           FROM public.account_sessions session
          WHERE session.session_token_hash = $1
          FOR UPDATE OF session`,
        [sessionTokenHash],
      );
      throwIfAborted(signal);
      return client.query<AccountSessionSwitchRow>(
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
          AND confirmed.organization_id = $2
          AND confirmed.expected_version = $3::bigint
        ORDER BY organization.organization_id COLLATE "C" NULLS LAST`,
        [sessionTokenHash, organizationId, expectedVersionValue, mutationId],
      );
    }, signal);
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
