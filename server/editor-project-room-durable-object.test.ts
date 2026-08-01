import { describe, expect, it, vi } from "vitest";

import { encodeEditorLiveClientMessageV1 } from "../src/collaboration/editor-live-contract";
import {
  type CloudflareRoomStateV1,
  type CloudflareRoomWebSocketPairV1,
  type CloudflareRoomWebSocketV1,
  createEditorProjectRoomV1,
  EDITOR_LIVE_INTERNAL_HEADERS_V1,
  EDITOR_LIVE_INTERNAL_ROUTE_V1,
  EditorProjectRoomDurableObjectV1,
} from "./editor-project-room-durable-object";

const identity = {
  documentKey: "a".repeat(64),
  epoch: "11111111-1111-4111-8111-111111111111",
  organizationId: "organization-a",
  projectId: "project-a",
} as const;
const subjectId = "22222222-2222-4222-8222-222222222222";

class FakeSocket implements CloudflareRoomWebSocketV1 {
  attachment: unknown = null;
  readonly close = vi.fn();
  readonly messages: string[] = [];

  deserializeAttachment() {
    return this.attachment;
  }

  send(message: string) {
    this.messages.push(message);
  }

  serializeAttachment(attachment: unknown) {
    this.attachment = structuredClone(attachment);
  }
}

function request(
  overrides: Readonly<{
    canWrite?: boolean;
    documentKey?: string;
    epoch?: string;
    organizationId?: string;
    projectId?: string;
  }> = {},
) {
  const value = { ...identity, ...overrides };
  const headers = EDITOR_LIVE_INTERNAL_HEADERS_V1;
  return new Request(`https://poietra-editor-room.internal${EDITOR_LIVE_INTERNAL_ROUTE_V1}`, {
    headers: {
      [headers.canWrite]: (overrides.canWrite ?? true) ? "1" : "0",
      [headers.documentKey]: value.documentKey,
      [headers.epoch]: value.epoch,
      [headers.organizationId]: value.organizationId,
      [headers.projectId]: value.projectId,
      [headers.subjectId]: subjectId,
      upgrade: "websocket",
    },
  });
}

function harness() {
  const accepted: FakeSocket[] = [];
  const clients: FakeSocket[] = [];
  const state: CloudflareRoomStateV1 = {
    acceptWebSocket: (socket) => accepted.push(socket as FakeSocket),
    getWebSockets: () => accepted,
  };
  let nextConnection = 1;
  const room = () =>
    createEditorProjectRoomV1(state, {
      createPair: () => {
        const pair: CloudflareRoomWebSocketPairV1 = { client: new FakeSocket(), server: new FakeSocket() };
        clients.push(pair.client as FakeSocket);
        return pair;
      },
      createUpgradeResponse: () => new Response(null, { status: 200 }),
      randomUuid: () => `33333333-3333-4333-8333-${String(nextConnection++).padStart(12, "0")}`,
    });
  return { accepted, clients, room, state };
}

async function connect(value: ReturnType<typeof harness>, input = request()) {
  const response = await value.room().fetch(input);
  expect(response.status).toBe(200);
  return value.accepted.at(-1)!;
}

describe("Editor project Durable Object room", () => {
  it("broadcasts a bounded head to another exact-room socket without storing document state", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value);
    sender.messages.length = 0;
    peer.messages.length = 0;

    await value
      .room()
      .webSocketMessage(sender, encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "9" }));

    expect(sender.messages).toEqual([]);
    expect(peer.messages).toHaveLength(1);
    expect(JSON.parse(peer.messages[0]!)).toMatchObject({
      identity,
      kind: "head",
      publisherConnectionId: "33333333-3333-4333-8333-000000000001",
      revision: "9",
    });
    expect(Object.keys(value.state)).toEqual(["acceptWebSocket", "getWebSockets"]);
  });

  it("restores routing only from hibernated socket attachments", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value);
    peer.messages.length = 0;
    const rehydratedRoom = value.room();

    await rehydratedRoom.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "10" }),
    );

    expect(JSON.parse(peer.messages[0]!)).toMatchObject({ kind: "head", revision: "10" });
  });

  it("never broadcasts across a document, epoch, project, or organization identity", async () => {
    const mismatches = [
      { documentKey: "b".repeat(64) },
      { epoch: "44444444-4444-4444-8444-444444444444" },
      { projectId: "project-b" },
      { organizationId: "organization-b" },
    ];
    for (const mismatch of mismatches) {
      const value = harness();
      const sender = await connect(value);
      const peer = await connect(value, request(mismatch));
      peer.messages.length = 0;
      await value
        .room()
        .webSocketMessage(sender, encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "1" }));
      expect(peer.messages, JSON.stringify(mismatch)).toEqual([]);
    }
  });

  it("rejects malformed and read-only publishers without affecting peers", async () => {
    const value = harness();
    const readOnly = await connect(value, request({ canWrite: false }));
    const peer = await connect(value);
    peer.messages.length = 0;

    await value
      .room()
      .webSocketMessage(readOnly, encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "1" }));
    expect(readOnly.close).toHaveBeenCalledWith(1008, "read-only");
    expect(peer.messages).toEqual([]);

    await value.room().webSocketMessage(peer, "not-json");
    expect(peer.close).toHaveBeenCalledWith(1008, "invalid-message");
  });

  it("rejects a malformed internal upgrade before accepting a socket", async () => {
    const value = harness();
    const response = await value.room().fetch(new Request("https://poietra.internal/wrong"));

    expect(response.status).toBe(400);
    expect(value.accepted).toEqual([]);
  });

  it("closes a publisher when the head limiter denies or fails", async () => {
    const denied = harness();
    const deniedSender = await connect(denied);
    const deniedRoom = createEditorProjectRoomV1(denied.state, { allowPublish: async () => false });
    await deniedRoom.webSocketMessage(
      deniedSender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "1" }),
    );
    expect(deniedSender.close).toHaveBeenCalledWith(1008, "rate-limited");

    const failed = harness();
    const failedSender = await connect(failed);
    const failedRoom = createEditorProjectRoomV1(failed.state, {
      allowPublish: async () => Promise.reject(new Error("limiter unavailable")),
    });
    await failedRoom.webSocketMessage(
      failedSender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "1" }),
    );
    expect(failedSender.close).toHaveBeenCalledWith(1008, "unavailable");
  });

  it("uses the runtime head binding before broadcasting", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value);
    peer.messages.length = 0;
    const limit = vi.fn(async () => ({ success: true }));
    const runtime = new EditorProjectRoomDurableObjectV1(value.state, {
      EDITOR_HEAD_RATE_LIMITER: { limit },
    });

    await runtime.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "2" }),
    );

    expect(limit).toHaveBeenCalledWith({ key: `editor-head:${identity.organizationId}:${subjectId}` });
    expect(peer.messages).toHaveLength(1);
  });
});
