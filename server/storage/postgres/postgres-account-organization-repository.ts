import type { QueryResultRow } from "pg";

import { accountOrganizationBootstrapRequestSchemaV1 } from "../../../src/accounts/account-organization-contract";
import { accountUserIdSchemaV1 } from "../../accounts/account-domain";
import type {
  AccountOrganizationBootstrapInputV1,
  AccountOrganizationBootstrapResultV1,
  AccountOrganizationRepositoryV1,
} from "../../accounts/account-organization-repository";
import { ACCOUNT_ORGANIZATION_BOOTSTRAP_MIGRATION_V30_CHECKSUM } from "./account-organization-bootstrap-schema";
import {
  type PostgresRepositoryConnectionOptionsV1,
  PostgresRepositoryConnectionV1,
} from "./postgres-repository-connection";

type ActorRowV1 = QueryResultRow & { session_version: string; user_id: string };
type CountRowV1 = QueryResultRow & { membership_count: string };
type MutationRowV1 = QueryResultRow & {
  actor_user_id: string;
  display_name: string;
  expected_session_version: string;
  mutation_id: string;
  organization_id: string;
  resulting_session_version: string;
};

const MAX_ACCOUNT_ORGANIZATIONS_V1 = 256;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactHash(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("Account session token hash must contain exactly 32 bytes.");
  }
  return Buffer.from(value);
}

function exactPositiveInteger(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  return parsed;
}

function exactNonnegativeInteger(value: unknown, name: string) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  return parsed;
}

function persistedMutation(row: MutationRowV1) {
  const parsed = accountOrganizationBootstrapRequestSchemaV1.safeParse({
    displayName: row.display_name,
    expectedVersion: exactPositiveInteger(row.expected_session_version, "expected session version"),
    mutationId: row.mutation_id,
    organizationId: row.organization_id,
  });
  const actorUserId = accountUserIdSchemaV1.safeParse(row.actor_user_id);
  if (!parsed.success || !actorUserId.success) {
    throw new TypeError("PostgreSQL returned an invalid organization bootstrap mutation.");
  }
  const version = exactPositiveInteger(row.resulting_session_version, "resulting session version");
  if (version !== parsed.data.expectedVersion + 1) {
    throw new TypeError("PostgreSQL returned an inconsistent organization bootstrap mutation.");
  }
  return { actorUserId: actorUserId.data, request: parsed.data, version };
}

export class PostgresAccountOrganizationRepositoryV1 implements AccountOrganizationRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: PostgresRepositoryConnectionOptionsV1) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 30",
        [],
        signal,
      );
      throwIfAborted(signal);
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 30 &&
        result.rows[0]?.checksum === ACCOUNT_ORGANIZATION_BOOTSTRAP_MIGRATION_V30_CHECKSUM
      );
    } catch {
      throwIfAborted(signal);
      return false;
    }
  }

  async createOrganization(inputValue: AccountOrganizationBootstrapInputV1, signal?: AbortSignal) {
    const { sessionTokenHash: sessionTokenHashValue, ...requestValue } = inputValue;
    const request = accountOrganizationBootstrapRequestSchemaV1.parse(requestValue);
    const sessionTokenHash = exactHash(sessionTokenHashValue);
    throwIfAborted(signal);
    return this.#connection.transaction(async (client): Promise<AccountOrganizationBootstrapResultV1> => {
      const actors = await client.query<ActorRowV1>(
        `SELECT session.user_id::text, session.version::text AS session_version
           FROM public.account_sessions session
           JOIN public.users account ON account.user_id = session.user_id
          WHERE session.session_token_hash = $1
            AND session.revoked_at IS NULL
            AND session.expires_at > clock_timestamp()
            AND account.status = 'active'
          FOR UPDATE OF session, account`,
        [sessionTokenHash],
      );
      throwIfAborted(signal);
      if (actors.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate account sessions.");
      const actor = actors.rows[0];
      if (!actor) return { kind: "invalid-session" };
      const actorUserId = accountUserIdSchemaV1.parse(actor.user_id);
      const currentVersion = exactPositiveInteger(actor.session_version, "account session version");

      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 424))", [request.organizationId]);
      throwIfAborted(signal);
      const mutations = await client.query<MutationRowV1>(
        `SELECT mutation_id::text, actor_user_id::text, organization_id, display_name,
                expected_session_version::text, resulting_session_version::text
           FROM public.account_organization_bootstrap_mutations
          WHERE session_token_hash = $1 AND mutation_id = $2::uuid`,
        [sessionTokenHash, request.mutationId],
      );
      throwIfAborted(signal);
      if (mutations.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate bootstrap mutations.");
      const existing = mutations.rows[0];
      if (existing) {
        const persisted = persistedMutation(existing);
        if (
          persisted.actorUserId !== actorUserId ||
          persisted.request.displayName !== request.displayName ||
          persisted.request.expectedVersion !== request.expectedVersion ||
          persisted.request.mutationId !== request.mutationId ||
          persisted.request.organizationId !== request.organizationId
        ) {
          return { kind: "conflict" };
        }
        return {
          kind: "applied",
          mutationId: request.mutationId,
          organization: { displayName: request.displayName, id: request.organizationId, role: "owner" },
          replayed: true,
          version: persisted.version,
        };
      }
      if (currentVersion !== request.expectedVersion || currentVersion >= Number.MAX_SAFE_INTEGER) {
        return { kind: "conflict" };
      }

      const counts = await client.query<CountRowV1>(
        `SELECT count(*)::text AS membership_count
           FROM public.organization_memberships membership
           JOIN public.organizations organization ON organization.tenant_id = membership.tenant_id
          WHERE membership.user_id = $1
            AND membership.status = 'active'
            AND organization.status = 'active'`,
        [actorUserId],
      );
      const countRow = counts.rows[0];
      if (counts.rowCount !== 1 || !countRow) throw new TypeError("PostgreSQL did not return a membership count.");
      const membershipCount = exactNonnegativeInteger(countRow.membership_count, "membership count");
      if (membershipCount >= MAX_ACCOUNT_ORGANIZATIONS_V1) {
        return { kind: "organization-unavailable" };
      }

      const collision = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM public.workspace_tenants WHERE tenant_id = $1",
        [request.organizationId],
      );
      if (collision.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate workspace tenants.");
      if (collision.rows.length !== 0) return { kind: "organization-unavailable" };

      await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [request.organizationId]);
      await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, $2)", [
        request.organizationId,
        request.displayName,
      ]);
      await client.query(
        "INSERT INTO public.organization_memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
        [request.organizationId, actorUserId],
      );
      const updated = await client.query<{ session_version: string }>(
        `UPDATE public.account_sessions
            SET active_tenant_id = $2
          WHERE session_token_hash = $1 AND version = $3::bigint
        RETURNING version::text AS session_version`,
        [sessionTokenHash, request.organizationId, request.expectedVersion],
      );
      const updatedRow = updated.rows[0];
      if (updated.rowCount !== 1 || !updatedRow || updated.rows.length !== 1) {
        throw new TypeError("PostgreSQL did not update one account session.");
      }
      const resultingVersion = exactPositiveInteger(updatedRow.session_version, "resulting session version");
      if (resultingVersion !== request.expectedVersion + 1) {
        throw new TypeError("PostgreSQL returned an inconsistent resulting session version.");
      }
      await client.query(
        `INSERT INTO public.account_organization_bootstrap_mutations
           (session_token_hash, mutation_id, actor_user_id, organization_id, display_name,
            expected_session_version, resulting_session_version)
         VALUES ($1, $2::uuid, $3, $4, $5, $6::bigint, $7::bigint)`,
        [
          sessionTokenHash,
          request.mutationId,
          actorUserId,
          request.organizationId,
          request.displayName,
          request.expectedVersion,
          resultingVersion,
        ],
      );
      throwIfAborted(signal);
      return {
        kind: "applied",
        mutationId: request.mutationId,
        organization: { displayName: request.displayName, id: request.organizationId, role: "owner" },
        replayed: false,
        version: resultingVersion,
      };
    }, signal);
  }

  close() {
    return this.#connection.close();
  }
}
