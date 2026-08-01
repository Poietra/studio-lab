import { describe, expect, it } from "vitest";

import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  editorLiveClientMessageSchemaV1,
  editorLiveServerMessageSchemaV1,
  MAX_EDITOR_LIVE_MESSAGE_BYTES_V1,
  parseEditorLiveClientMessageV1,
  parseEditorLiveServerMessageV1,
} from "./editor-live-contract";

const identity = {
  documentKey: "a".repeat(64),
  epoch: "11111111-1111-4111-8111-111111111111",
  organizationId: "organization-a",
  projectId: "project-a",
} as const;

describe("Editor live protocol", () => {
  it("accepts strict bounded head and ready messages", () => {
    expect(
      editorLiveClientMessageSchemaV1.parse({
        kind: "head",
        protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
        revision: "42",
      }),
    ).toEqual({ kind: "head", protocolVersion: 1, revision: "42" });
    expect(
      editorLiveServerMessageSchemaV1.parse({
        connectionId: "22222222-2222-4222-8222-222222222222",
        identity,
        kind: "ready",
        protocolVersion: 1,
      }),
    ).toMatchObject({ identity, kind: "ready" });
  });

  it.each([
    ["future protocol", { kind: "head", protocolVersion: 2, revision: "1" }],
    ["unknown field", { extra: true, kind: "head", protocolVersion: 1, revision: "1" }],
    ["noncanonical revision", { kind: "head", protocolVersion: 1, revision: "01" }],
    ["unrelated message", { kind: "presence", protocolVersion: 1, sequence: 1 }],
  ])("rejects %s", (_label, value) => {
    expect(editorLiveClientMessageSchemaV1.safeParse(value).success).toBe(false);
  });

  it("rejects malformed, binary, and oversized wire messages", () => {
    expect(parseEditorLiveClientMessageV1("{")).toBeNull();
    expect(parseEditorLiveClientMessageV1(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(parseEditorLiveServerMessageV1("x".repeat(MAX_EDITOR_LIVE_MESSAGE_BYTES_V1 + 1))).toBeNull();
  });

  it("does not accept a server head without its exact room identity", () => {
    expect(
      editorLiveServerMessageSchemaV1.safeParse({
        kind: "head",
        protocolVersion: 1,
        publisherConnectionId: "22222222-2222-4222-8222-222222222222",
        revision: "1",
      }).success,
    ).toBe(false);
  });
});
