import type { Pool, PoolConfig, QueryResultRow } from "pg";

import {
  editorLiveIdentityMatchesV1,
  editorLiveIdentitySchemaV1,
} from "../../../src/collaboration/editor-live-contract";
import { accountUserIdSchemaV1, organizationRoleAllowsV1 } from "../../accounts/account-domain";
import {
  editorCollaborationAuthorizationGrantSchemaV1,
  editorCollaborationAuthorizationLeaseSchemaV1,
  MAX_EDITOR_COLLABORATION_AUTHORIZATIONS_PER_ROOM_V1,
  type EditorCollaborationAuthorizationGrantV1,
  type EditorCollaborationAuthorizationLeaseV1,
} from "../../editor-collaboration-authorization";
import type {
  EditorCollaborationAuthorizationRepositoryV1,
  EditorCollaborationRequestedRoomV1,
  EditorCollaborationRoomIdentityV1,
  EditorCollaborationSessionAuthorizationV1,
} from "../../editor-collaboration-authorization-repository";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type AuthorizationRow = QueryResultRow & {
  authorization_id: string;
  membership_version: string;
  organization_id: string;
  role: string;
  session_expires_at_ms: string;
  session_version: string;
  subject_id: string;
};

type InitialAuthorizationRow = QueryResultRow & {
  authorization_id: string;
  document_authorized: boolean;
  membership_version: string | null;
  organization_id: string;
  role: string | null;
  session_expires_at_ms: string;
  session_version: string;
  subject_id: string;
};

const ACTIVE_AUTHORIZATION_SELECT_V1 = `SELECT session.authorization_id::text AS authorization_id,
       membership.version::text AS membership_version,
       session.active_tenant_id AS organization_id,
       membership.role,
       floor(extract(epoch FROM session.expires_at) * 1000)::bigint::text AS session_expires_at_ms,
       session.version::text AS session_version,
       session.user_id::text AS subject_id
  FROM public.account_sessions session
  JOIN public.users account ON account.user_id = session.user_id AND account.status = 'active'
  JOIN public.organization_memberships membership
    ON membership.tenant_id = session.active_tenant_id
   AND membership.user_id = session.user_id
   AND membership.status = 'active'
  JOIN public.organizations organization
    ON organization.tenant_id = membership.tenant_id
   AND organization.status = 'active'
  JOIN public.workspace_projects project
    ON project.tenant_id = membership.tenant_id
   AND project.project_id = $ROOM_PROJECT
   AND project.deleted_at IS NULL
  JOIN public.editor_documents document
    ON document.tenant_id = project.tenant_id
   AND document.project_id = project.project_id
   AND document.document_key = $ROOM_DOCUMENT
   AND document.epoch = $ROOM_EPOCH::uuid
   AND document.sealed_at IS NULL
 WHERE session.revoked_at IS NULL
   AND session.expires_at > clock_timestamp()
   AND session.active_tenant_id = $ROOM_ORGANIZATION`;

function throwIfAborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

function exactSessionTokenHash(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("Editor collaboration session hash must contain exactly 32 bytes.");
  }
  return Buffer.from(value);
}

function exactPositiveVersion(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`PostgreSQL returned an invalid ${name}.`);
  return parsed;
}

function exactSessionExpiry(value: unknown) {
  const parsed = exactPositiveVersion(value, "collaboration session expiry");
  if (parsed > 8_640_000_000_000_000) {
    throw new TypeError("PostgreSQL returned an invalid collaboration session expiry.");
  }
  return parsed;
}

function exactRoom(value: EditorCollaborationRoomIdentityV1) {
  return editorLiveIdentitySchemaV1.parse({
    documentKey: value.documentKey,
    epoch: value.epoch,
    organizationId: value.organizationId,
    projectId: value.projectId,
  });
}

function exactRequestedRoom(value: EditorCollaborationRequestedRoomV1) {
  return editorLiveIdentitySchemaV1.omit({ organizationId: true }).parse(value);
}

function documentKeyBytes(value: string) {
  return Buffer.from(value, "hex");
}

function grantFromRow(row: AuthorizationRow, room: EditorCollaborationRequestedRoomV1) {
  const subjectId = accountUserIdSchemaV1.safeParse(row.subject_id);
  if (!subjectId.success || !organizationRoleAllowsV1(row.role, "manim:read")) {
    throw new TypeError("PostgreSQL returned an invalid collaboration authorization.");
  }
  return editorCollaborationAuthorizationGrantSchemaV1.parse({
    ...room,
    authorizationId: row.authorization_id,
    canWrite: organizationRoleAllowsV1(row.role, "manim:write"),
    membershipVersion: exactPositiveVersion(row.membership_version, "collaboration membership version"),
    organizationId: row.organization_id,
    sessionExpiresAtMs: exactSessionExpiry(row.session_expires_at_ms),
    sessionVersion: exactPositiveVersion(row.session_version, "collaboration session version"),
    subjectId: subjectId.data,
  });
}

function initialAuthorizationSqlV1() {
  return `WITH selected_session AS MATERIALIZED (
  SELECT session.authorization_id,
         session.active_tenant_id AS organization_id,
         session.expires_at,
         session.version,
         session.user_id
    FROM public.account_sessions session
    JOIN public.users account ON account.user_id = session.user_id AND account.status = 'active'
   WHERE session.session_token_hash = $1
     AND session.revoked_at IS NULL
     AND session.expires_at > clock_timestamp()
   LIMIT 2
)
SELECT session.authorization_id::text AS authorization_id,
       (document.epoch IS NOT NULL) AS document_authorized,
       membership.version::text AS membership_version,
       session.organization_id,
       membership.role,
       floor(extract(epoch FROM session.expires_at) * 1000)::bigint::text AS session_expires_at_ms,
       session.version::text AS session_version,
       session.user_id::text AS subject_id
  FROM selected_session session
  LEFT JOIN public.organization_memberships membership
    ON membership.tenant_id = session.organization_id
   AND membership.user_id = session.user_id
   AND membership.status = 'active'
  LEFT JOIN public.organizations organization
    ON organization.tenant_id = membership.tenant_id
   AND organization.status = 'active'
  LEFT JOIN public.workspace_projects project
    ON project.tenant_id = organization.tenant_id
   AND project.project_id = $2
   AND project.deleted_at IS NULL
  LEFT JOIN public.editor_documents document
    ON document.tenant_id = project.tenant_id
   AND document.project_id = project.project_id
   AND document.document_key = $3
   AND document.epoch = $4::uuid
   AND document.sealed_at IS NULL`;
}

function revalidationSqlV1() {
  return `${ACTIVE_AUTHORIZATION_SELECT_V1.replaceAll("$ROOM_PROJECT", "$3")
    .replaceAll("$ROOM_DOCUMENT", "$4")
    .replaceAll("$ROOM_EPOCH", "$5")
    .replaceAll("$ROOM_ORGANIZATION", "$2")}
   AND session.authorization_id = ANY($1::uuid[])
 ORDER BY session.authorization_id`;
}

export class PostgresEditorCollaborationAuthorizationRepositoryV1
  implements EditorCollaborationAuthorizationRepositoryV1
{
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async authorizeSession(
    sessionTokenHashValue: Uint8Array,
    roomValue: EditorCollaborationRequestedRoomV1,
    signal?: AbortSignal,
  ): Promise<EditorCollaborationSessionAuthorizationV1> {
    const sessionTokenHash = exactSessionTokenHash(sessionTokenHashValue);
    const room = exactRequestedRoom(roomValue);
    throwIfAborted(signal);
    const result = await this.#connection.query<InitialAuthorizationRow>(
      initialAuthorizationSqlV1(),
      [sessionTokenHash, room.projectId, documentKeyBytes(room.documentKey), room.epoch],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate collaboration authorizations.");
    const row = result.rows[0];
    if (!row) return { kind: "invalid-session" };
    if (
      row.document_authorized !== true ||
      row.membership_version === null ||
      row.role === null ||
      !organizationRoleAllowsV1(row.role, "manim:read")
    ) {
      return { kind: "denied" };
    }
    return { grant: grantFromRow(row as AuthorizationRow, room), kind: "authorized" };
  }

  async revalidateAuthorizations(
    leasesValue: readonly EditorCollaborationAuthorizationLeaseV1[],
    signal?: AbortSignal,
  ) {
    if (!Array.isArray(leasesValue) || leasesValue.length > MAX_EDITOR_COLLABORATION_AUTHORIZATIONS_PER_ROOM_V1) {
      throw new TypeError("Editor collaboration authorization batch is invalid.");
    }
    if (leasesValue.length === 0) return [];
    const leases = leasesValue.map((value) => editorCollaborationAuthorizationLeaseSchemaV1.parse(value));
    const room = exactRoom(leases[0]!);
    if (leases.some((lease) => !editorLiveIdentityMatchesV1(room, lease))) {
      throw new TypeError("Editor collaboration authorization batch crosses rooms.");
    }
    const authorizationIds = [...new Set(leases.map(({ authorizationId }) => authorizationId))];
    const subjectsByAuthorization = new Map<string, string>();
    for (const lease of leases) {
      const previous = subjectsByAuthorization.get(lease.authorizationId);
      if (previous && previous !== lease.subjectId) {
        throw new TypeError("Editor collaboration authorization batch has conflicting subjects.");
      }
      subjectsByAuthorization.set(lease.authorizationId, lease.subjectId);
    }
    throwIfAborted(signal);
    const result = await this.#connection.query<AuthorizationRow>(
      revalidationSqlV1(),
      [authorizationIds, room.organizationId, room.projectId, documentKeyBytes(room.documentKey), room.epoch],
      signal,
    );
    throwIfAborted(signal);
    if (result.rows.length > authorizationIds.length) {
      throw new TypeError("PostgreSQL returned duplicate collaboration authorizations.");
    }
    const grants = new Map<string, EditorCollaborationAuthorizationGrantV1>();
    for (const row of result.rows) {
      // A legitimate role downgrade that removes Manim read authority revokes
      // only this authorization instead of poisoning the whole room batch.
      if (!organizationRoleAllowsV1(row.role, "manim:read")) continue;
      const grant = grantFromRow(row, room);
      if (
        !authorizationIds.includes(grant.authorizationId) ||
        grants.has(grant.authorizationId) ||
        subjectsByAuthorization.get(grant.authorizationId) !== grant.subjectId ||
        !editorLiveIdentityMatchesV1(room, grant)
      ) {
        throw new TypeError("PostgreSQL returned an uncorrelated collaboration authorization.");
      }
      grants.set(grant.authorizationId, grant);
    }
    return leases.map(({ authorizationId }) => grants.get(authorizationId) ?? null);
  }

  close() {
    return this.#connection.close();
  }
}
