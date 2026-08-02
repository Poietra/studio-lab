import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  ACCOUNT_INVITATION_MAX_LIFETIME_MS_V1,
  ACCOUNT_INVITATION_MIN_LIFETIME_MS_V1,
  type AccountInvitationRepositoryV1,
  type CreateAccountInvitationV1,
  type CreatedAccountInvitationV1,
} from "../../accounts/account-invitation-repository";
import {
  accountUserIdSchemaV1,
  normalizeAccountEmailV1,
  organizationInvitationRoleSchemaV1,
} from "../../accounts/account-domain";
import { ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM } from "./account-invitation-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type InvitationRow = QueryResultRow & { expires_at: Date; invitation_id: string };

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactHash(value: Uint8Array, name: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError(`${name} must contain exactly 32 bytes.`);
  }
  return Buffer.from(value);
}

function invitationId(value: string) {
  const parsed = accountUserIdSchemaV1.safeParse(value);
  if (!parsed.success) throw new TypeError("Invitation ID is invalid.");
  return parsed.data;
}

function lifetimeMs(value: number) {
  if (
    !Number.isSafeInteger(value) ||
    value < ACCOUNT_INVITATION_MIN_LIFETIME_MS_V1 ||
    value > ACCOUNT_INVITATION_MAX_LIFETIME_MS_V1
  ) {
    throw new RangeError("Invitation lifetime is outside its allowed range.");
  }
  return value;
}

function invitationFromRow(row: InvitationRow): CreatedAccountInvitationV1 {
  const id = invitationId(row.invitation_id);
  if (!(row.expires_at instanceof Date) || !Number.isFinite(row.expires_at.getTime())) {
    throw new TypeError("PostgreSQL returned an invalid invitation expiry.");
  }
  return { expiresAt: new Date(row.expires_at.getTime()), invitationId: id };
}

export class PostgresAccountInvitationRepositoryV1 implements AccountInvitationRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 22",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 22 &&
        result.rows[0]?.checksum === ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async createInvitation(input: CreateAccountInvitationV1, signal?: AbortSignal) {
    const id = invitationId(input.invitationId);
    const sessionTokenHash = exactHash(input.sessionTokenHash, "Account session token hash");
    const tokenDigest = exactHash(input.tokenDigest, "Invitation token digest");
    const email = normalizeAccountEmailV1(input.normalizedEmail);
    if (email !== input.normalizedEmail) throw new TypeError("Invitation email is not normalized.");
    const role = organizationInvitationRoleSchemaV1.parse(input.role);
    const lifetime = lifetimeMs(input.lifetimeMs);
    throwIfAborted(signal);
    const result = await this.#connection.query<InvitationRow>(
      `WITH actor AS MATERIALIZED (
         SELECT session.user_id, session.active_tenant_id
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
           JOIN public.organization_memberships membership
             ON membership.tenant_id = session.active_tenant_id
            AND membership.user_id = session.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
            AND membership.status = 'active'
            AND membership.role IN ('owner', 'admin')
            AND organization.status = 'active'
          FOR UPDATE OF membership, organization
       ), issued_at AS (SELECT clock_timestamp() AS value)
       INSERT INTO public.organization_invitations
         (invitation_id, tenant_id, token_digest, normalized_email, invited_role,
          created_by, created_at, expires_at, updated_at)
       SELECT $2, actor.active_tenant_id, $3, $4, $5,
              actor.user_id, issued_at.value,
              issued_at.value + ($6::bigint * interval '1 millisecond'), issued_at.value
         FROM actor CROSS JOIN issued_at
       RETURNING invitation_id::text, expires_at`,
      [sessionTokenHash, id, tokenDigest, email, role, lifetime],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL created duplicate organization invitations.");
    const row = result.rows[0];
    return row ? invitationFromRow(row) : null;
  }

  async revokeInvitation(
    input: Readonly<{ invitationId: string; sessionTokenHash: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const id = invitationId(input.invitationId);
    const sessionTokenHash = exactHash(input.sessionTokenHash, "Account session token hash");
    throwIfAborted(signal);
    const result = await this.#connection.query<{ invitation_id: string }>(
      `WITH actor AS MATERIALIZED (
         SELECT session.user_id, session.active_tenant_id
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
           JOIN public.organization_memberships membership
             ON membership.tenant_id = session.active_tenant_id
            AND membership.user_id = session.user_id
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
            AND membership.status = 'active'
            AND membership.role IN ('owner', 'admin')
            AND organization.status = 'active'
          FOR UPDATE OF membership, organization
       )
       UPDATE public.organization_invitations invitation
          SET status = 'revoked', revoked_by = actor.user_id, revoked_at = clock_timestamp()
         FROM actor
        WHERE invitation.invitation_id = $2
          AND invitation.tenant_id = actor.active_tenant_id
          AND invitation.status = 'pending'
       RETURNING invitation.invitation_id::text`,
      [sessionTokenHash, id],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL revoked duplicate organization invitations.");
    return result.rows.length === 1;
  }

  close() {
    return this.#connection.close();
  }
}
