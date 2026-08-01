import { z } from "zod";

import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import { editorDocumentKeySchemaV1, editorRevisionStringSchemaV1 } from "./editor-document-http-contract";

export const EDITOR_LIVE_PROTOCOL_VERSION_V1 = 1 as const;
export const MAX_EDITOR_LIVE_MESSAGE_BYTES_V1 = 4 * 1_024;

const editorLiveUuidSchemaV1 = z.uuid();

export const editorLiveIdentitySchemaV1 = z
  .object({
    documentKey: editorDocumentKeySchemaV1,
    epoch: editorLiveUuidSchemaV1,
    organizationId: accountOrganizationIdSchemaV1,
    projectId: manimProjectIdSchema,
  })
  .strict();

const clientHeadSchemaV1 = z
  .object({
    kind: z.literal("head"),
    protocolVersion: z.literal(EDITOR_LIVE_PROTOCOL_VERSION_V1),
    revision: editorRevisionStringSchemaV1,
  })
  .strict();

export const editorLiveClientMessageSchemaV1 = clientHeadSchemaV1;

const serverReadySchemaV1 = z
  .object({
    connectionId: editorLiveUuidSchemaV1,
    identity: editorLiveIdentitySchemaV1,
    kind: z.literal("ready"),
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
  serverErrorSchemaV1,
]);

export type EditorLiveIdentityV1 = Readonly<z.infer<typeof editorLiveIdentitySchemaV1>>;
export type EditorLiveClientMessageV1 = Readonly<z.infer<typeof editorLiveClientMessageSchemaV1>>;
export type EditorLiveServerMessageV1 = Readonly<z.infer<typeof editorLiveServerMessageSchemaV1>>;

export function encodeEditorLiveClientMessageV1(value: EditorLiveClientMessageV1) {
  return JSON.stringify(editorLiveClientMessageSchemaV1.parse(value));
}

export function encodeEditorLiveServerMessageV1(value: EditorLiveServerMessageV1) {
  return JSON.stringify(editorLiveServerMessageSchemaV1.parse(value));
}

function parseWireJsonV1(value: unknown) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_EDITOR_LIVE_MESSAGE_BYTES_V1) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function parseEditorLiveClientMessageV1(value: unknown) {
  const json = parseWireJsonV1(value);
  if (json === null) return null;
  const parsed = editorLiveClientMessageSchemaV1.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function parseEditorLiveServerMessageV1(value: unknown) {
  const json = parseWireJsonV1(value);
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
