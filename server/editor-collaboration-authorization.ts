import { z } from "zod";

import { editorLiveIdentitySchemaV1 } from "../src/collaboration/editor-live-contract";
import { accountUserIdSchemaV1 } from "./accounts/account-domain";

/** Maximum time a live socket may trust one PostgreSQL authorization read. */
export const EDITOR_COLLABORATION_AUTHORIZATION_LEASE_MS_V1 = 60_000;
export const MAX_EDITOR_COLLABORATION_AUTHORIZATIONS_PER_ROOM_V1 = 64;

export const editorCollaborationAuthorizationGrantSchemaV1 = editorLiveIdentitySchemaV1
  .safeExtend({
    authorizationId: z.uuid(),
    canWrite: z.boolean(),
    membershipVersion: z.number().int().safe().positive(),
    sessionExpiresAtMs: z.number().int().safe().positive(),
    sessionVersion: z.number().int().safe().positive(),
    subjectId: accountUserIdSchemaV1,
  })
  .strict();

export type EditorCollaborationAuthorizationGrantV1 = Readonly<
  z.infer<typeof editorCollaborationAuthorizationGrantSchemaV1>
>;

export const editorCollaborationAuthorizationLeaseSchemaV1 = editorCollaborationAuthorizationGrantSchemaV1
  .omit({ sessionExpiresAtMs: true })
  .safeExtend({ leaseExpiresAtMs: z.number().int().safe().positive() })
  .strict();

export type EditorCollaborationAuthorizationLeaseV1 = Readonly<
  z.infer<typeof editorCollaborationAuthorizationLeaseSchemaV1>
>;

export function editorCollaborationAuthorizationLeaseV1(
  grantValue: EditorCollaborationAuthorizationGrantV1,
  nowValue: number,
): EditorCollaborationAuthorizationLeaseV1 | null {
  const grant = editorCollaborationAuthorizationGrantSchemaV1.safeParse(grantValue);
  if (!grant.success || !Number.isSafeInteger(nowValue) || nowValue < 0 || grant.data.sessionExpiresAtMs <= nowValue) {
    return null;
  }
  const { sessionExpiresAtMs, ...leaseIdentity } = grant.data;
  const lease = editorCollaborationAuthorizationLeaseSchemaV1.safeParse({
    ...leaseIdentity,
    leaseExpiresAtMs: Math.min(sessionExpiresAtMs, nowValue + EDITOR_COLLABORATION_AUTHORIZATION_LEASE_MS_V1),
  });
  return lease.success ? lease.data : null;
}
