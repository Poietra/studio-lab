import { z } from "zod";

import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { normalizedNumberV1Schema, sourceIdentityV1Schema } from "../engine/primitives";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import { editorDocumentKeySchemaV1, editorRevisionStringSchemaV1 } from "./editor-document-http-contract";

export const EDITOR_LIVE_PROTOCOL_VERSION_V1 = 1 as const;
export const MAX_EDITOR_LIVE_CLIENT_MESSAGE_BYTES_V1 = 16 * 1_024;
export const MAX_EDITOR_LIVE_SERVER_MESSAGE_BYTES_V1 = 384 * 1_024;
export const MAX_EDITOR_LIVE_PARTICIPANTS_V1 = 32;
export const MAX_EDITOR_LIVE_SELECTED_ENTITY_IDS_V1 = 32;
export const MAX_EDITOR_LIVE_PLAYHEAD_SECONDS_V1 = 24 * 60 * 60;

const editorLiveUuidSchemaV1 = z.uuid();

export const editorLiveIdentitySchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorLiveUuidSchemaV1,
    organizationId: accountOrganizationIdSchemaV1,
    projectId: manimProjectIdSchema,
  })
  .strict();

export const editorLivePresenceSchemaV1 = z
  .object({
    cursor: z.object({ x: normalizedNumberV1Schema, y: normalizedNumberV1Schema }).strict().nullable(),
    playheadSeconds: z.number().finite().min(0).max(MAX_EDITOR_LIVE_PLAYHEAD_SECONDS_V1),
    selectedEntityIds: z
      .array(sourceIdentityV1Schema)
      .max(MAX_EDITOR_LIVE_SELECTED_ENTITY_IDS_V1)
      .superRefine((entityIds, context) => {
        const seen = new Set<string>();
        entityIds.forEach((entityId, index) => {
          if (seen.has(entityId)) {
            context.addIssue({ code: "custom", message: "Selected entity IDs must be unique.", path: [index] });
          }
          seen.add(entityId);
        });
      }),
  })
  .strict();

export const editorLiveMemberSchemaV1 = z.object({ id: editorLiveUuidSchemaV1 }).strict();

export const editorLiveParticipantSchemaV1 = z
  .object({
    member: editorLiveMemberSchemaV1,
    presence: editorLivePresenceSchemaV1,
  })
  .strict();

const clientHeadSchemaV1 = z
  .object({
    kind: z.literal("head"),
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
    revision: editorRevisionStringSchemaV1,
  })
  .strict();

const clientPresenceUpdateSchemaV1 = z
  .object({
    kind: z.literal("presence-update"),
    presence: editorLivePresenceSchemaV1,
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

export const editorLiveClientMessageSchemaV1 = z.discriminatedUnion("kind", [
  clientHeadSchemaV1,
  clientPresenceUpdateSchemaV1,
]);

const serverReadySchemaV1 = z
  .object({
    connectionId: editorLiveUuidSchemaV1,
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("ready"),
    memberId: editorLiveUuidSchemaV1,
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

const serverHeadSchemaV1 = z
  .object({
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("head"),
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
    publisherConnectionId: editorLiveUuidSchemaV1,
    revision: editorRevisionStringSchemaV1,
  })
  .strict();

const serverPresenceSnapshotSchemaV1 = z
  .object({
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("presence-snapshot"),
    participants: z
      .array(editorLiveParticipantSchemaV1)
      .max(MAX_EDITOR_LIVE_PARTICIPANTS_V1)
      .superRefine((participants, context) => {
        for (let index = 1; index < participants.length; index += 1) {
          if (participants[index - 1]!.member.id >= participants[index]!.member.id) {
            context.addIssue({
              code: "custom",
              message: "Participants must be unique and sorted by member ID.",
              path: [index, "member", "id"],
            });
          }
        }
      }),
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

const serverPresenceUpdateSchemaV1 = z
  .object({
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("presence-update"),
    participant: editorLiveParticipantSchemaV1,
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

const serverPresenceLeaveSchemaV1 = z
  .object({
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("presence-leave"),
    memberId: editorLiveUuidSchemaV1,
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

const serverErrorSchemaV1 = z
  .object({
    code: z.enum(["invalid-message", "rate-limited", "read-only", "room-mismatch", "unavailable"]),
    kind: z.literal("error"),
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
  })
  .strict();

export const editorLiveServerMessageSchemaV1 = z.discriminatedUnion("kind", [
  serverReadySchemaV1,
  serverHeadSchemaV1,
  serverPresenceSnapshotSchemaV1,
  serverPresenceUpdateSchemaV1,
  serverPresenceLeaveSchemaV1,
  serverErrorSchemaV1,
]);

export type EditorLiveIdentityV1 = Readonly<z.infer<typeof editorLiveIdentitySchemaV1>>;
export type EditorLiveMemberV1 = Readonly<z.infer<typeof editorLiveMemberSchemaV1>>;
export type EditorLiveParticipantV1 = Readonly<z.infer<typeof editorLiveParticipantSchemaV1>>;
export type EditorLivePresenceV1 = Readonly<z.infer<typeof editorLivePresenceSchemaV1>>;
export type EditorLiveClientMessageV1 = Readonly<z.infer<typeof editorLiveClientMessageSchemaV1>>;
export type EditorLiveServerMessageV1 = Readonly<z.infer<typeof editorLiveServerMessageSchemaV1>>;

export function encodeEditorLiveClientMessageV1(value: EditorLiveClientMessageV1) {
  return JSON.stringify(editorLiveClientMessageSchemaV1.parse(value));
}

export function encodeEditorLiveServerMessageV1(value: EditorLiveServerMessageV1) {
  return JSON.stringify(editorLiveServerMessageSchemaV1.parse(value));
}

function parseWireJsonV1(value: unknown, maximumBytes: number) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maximumBytes) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseEditorLiveClientMessageV1(value: unknown) {
  const json = parseWireJsonV1(value, MAX_EDITOR_LIVE_CLIENT_MESSAGE_BYTES_V1);
  if (json === null) return null;
  const parsed = editorLiveClientMessageSchemaV1.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function parseEditorLiveServerMessageV1(value: unknown) {
  const json = parseWireJsonV1(value, MAX_EDITOR_LIVE_SERVER_MESSAGE_BYTES_V1);
  if (json === null) return null;
  const parsed = editorLiveServerMessageSchemaV1.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function editorLiveIdentityMatchesV1(left: EditorLiveIdentityV1, right: EditorLiveIdentityV1) {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.documentKey === right.documentKey &&
    left.epoch === right.epoch
  );
}
