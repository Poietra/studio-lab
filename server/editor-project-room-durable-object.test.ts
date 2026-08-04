import { describe, expect, it, vi } from "vitest";

import {
  type EditorLivePresenceV1,
  encodeEditorLiveClientMessageV1,
  MAX_EDITOR_LIVE_PARTICIPANTS_V1,
  parseEditorLiveServerMessageV1,
} from "../src/collaboration/editor-live-contract";
import type { EditorCollaborationAuthorizationLeaseV1 } from "./editor-collaboration-authorization";
import {
  type CloudflareRoomStateV1,
  type CloudflareRoomWebSocketPairV1,
  type CloudflareRoomWebSocketV1,
  createEditorProjectRoomV1,
  EDITOR_LIVE_INTERNAL_HEADERS_V1,
  EDITOR_LIVE_INTERNAL_ROUTE_V1,
  EditorProjectRoomDurableObjectV1,
  MAX_EDITOR_LIVE_ROOM_CONNECTIONS_V1,
} from "./editor-project-room-durable-object";

const identity = {
  documentKey: "a".repeat(64),
  epoch: "11111111-1111-4111-8111-111111111111",
  organizationId: "organization-a",
  projectId: "project-a",
} as const;
const subjectId = "22222222-2222-4222-8222-222222222222";
const peerSubjectId = "44444444-4444-4444-8444-444444444444";
const authorizationId = "55555555-5555-4555-8555-555555555555";
const peerAuthorizationId = "66666666-6666-4666-8666-666666666666";
const initialNow = 2_000_000_000_000;
const presence: EditorLivePresenceV1 = {
  cursor: { x: 0.25, y: 0.75 },
  playheadSeconds: 12.5,
  selectedEntityIds: ["source:scene.py#Demo:circle"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function grantFromLease(
  value: EditorCollaborationAuthorizationLeaseV1,
  overrides: Readonly<{ canWrite?: boolean; membershipVersion?: number; sessionVersion?: number }> = {},
) {
  const { leaseExpiresAtMs: _leaseExpiresAtMs, ...grant } = value;
  return {
    ...grant,
    ...overrides,
    sessionExpiresAtMs: initialNow + 180_000,
  };
}

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
    authorizationId?: string;
    documentKey?: string;
    epoch?: string;
    organizationId?: string;
    projectId?: string;
    subjectId?: string;
    leaseExpiresAtMs?: number;
  }> = {},
) {
  const value = { ...identity, ...overrides };
  const requestSubjectId = overrides.subjectId ?? subjectId;
  const headers = EDITOR_LIVE_INTERNAL_HEADERS_V1;
  return new Request(`https://poietra-editor-room.internal${EDITOR_LIVE_INTERNAL_ROUTE_V1}`, {
    headers: {
      [headers.authorizationId]:
        overrides.authorizationId ?? (requestSubjectId === peerSubjectId ? peerAuthorizationId : authorizationId),
      [headers.canWrite]: (overrides.canWrite ?? true) ? "1" : "0",
      [headers.documentKey]: value.documentKey,
      [headers.epoch]: value.epoch,
      [headers.leaseExpiresAtMs]: String(overrides.leaseExpiresAtMs ?? initialNow + 60_000),
      [headers.membershipVersion]: "1",
      [headers.organizationId]: value.organizationId,
      [headers.projectId]: value.projectId,
      [headers.sessionVersion]: "1",
      [headers.subjectId]: requestSubjectId,
      upgrade: "websocket",
    },
  });
}

function harness() {
  const accepted: FakeSocket[] = [];
  const clients: FakeSocket[] = [];
  let clock = initialNow;
  let scheduledAlarm: number | null = null;
  const setAlarm = vi.fn(async (value: number | Date) => {
    scheduledAlarm = value instanceof Date ? value.valueOf() : value;
  });
  const deleteAlarm = vi.fn(async () => {
    scheduledAlarm = null;
  });
  const state: CloudflareRoomStateV1 = {
    acceptWebSocket: (socket) => accepted.push(socket as FakeSocket),
    getWebSockets: () => accepted,
    storage: { deleteAlarm, setAlarm },
  };
  let nextConnection = 1;
  const room = (options: Parameters<typeof createEditorProjectRoomV1>[1] = {}) =>
    createEditorProjectRoomV1(state, {
      createPair: () => {
        const pair: CloudflareRoomWebSocketPairV1 = { client: new FakeSocket(), server: new FakeSocket() };
        clients.push(pair.client as FakeSocket);
        return pair;
      },
      createUpgradeResponse: () => new Response(null, { status: 200 }),
      now: () => clock,
      randomUuid: () => `33333333-3333-4333-8333-${String(nextConnection++).padStart(12, "0")}`,
      revalidateAuthorizations: async (leases) =>
        leases.map(({ leaseExpiresAtMs: _leaseExpiresAtMs, ...lease }) => ({
          ...lease,
          sessionExpiresAtMs: clock + 120_000,
        })),
      ...options,
    });
  return {
    accepted,
    clients,
    deleteAlarm,
    get scheduledAlarm() {
      return scheduledAlarm;
    },
    room,
    setAlarm,
    setNow(value: number) {
      clock = value;
    },
    state,
  };
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
    expect(Object.keys(value.state)).toEqual(["acceptWebSocket", "getWebSockets", "storage"]);
    expect(Object.keys(value.state.storage)).toEqual(["deleteAlarm", "setAlarm"]);
  });

  it("sends a server-attested canonical roster and collapses duplicate tabs", async () => {
    const value = harness();
    const first = await connect(value);
    const second = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));

    const ready = parseEditorLiveServerMessageV1(peer.messages[0]);
    const snapshot = parseEditorLiveServerMessageV1(peer.messages[1]);
    expect(ready).toMatchObject({ kind: "ready", memberId: peerSubjectId });
    expect(snapshot).toMatchObject({
      identity,
      kind: "presence-snapshot",
      participants: [{ member: { id: subjectId } }, { member: { id: peerSubjectId } }],
    });
    expect(first.attachment).toMatchObject({ subjectId });
    expect(second.attachment).toMatchObject({ subjectId });
  });

  it("attests presence to the socket member and canonicalizes selected entities", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    sender.messages.length = 0;
    peer.messages.length = 0;

    await value.room().webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({
        kind: "presence-update",
        presence: { ...presence, selectedEntityIds: ["z", "a"] },
        protocolVersion: 1,
      }),
    );

    expect(parseEditorLiveServerMessageV1(peer.messages[0])).toMatchObject({
      identity,
      kind: "presence-update",
      participant: {
        member: { id: subjectId },
        presence: { ...presence, selectedEntityIds: ["a", "z"] },
      },
    });
    await value.room().webSocketMessage(
      sender,
      JSON.stringify({
        kind: "presence-update",
        memberId: peerSubjectId,
        presence,
        protocolVersion: 1,
      }),
    );
    expect(sender.close).toHaveBeenCalledWith(1008, "invalid-message");
  });

  it("rebuilds updated presence from hibernated socket attachments", async () => {
    const value = harness();
    const sender = await connect(value);
    await value
      .room()
      .webSocketMessage(
        sender,
        encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
      );

    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    const snapshot = parseEditorLiveServerMessageV1(peer.messages[1]);
    expect(snapshot).toMatchObject({
      kind: "presence-snapshot",
      participants: [{ member: { id: subjectId }, presence }, { member: { id: peerSubjectId } }],
    });
  });

  it("selects the latest tab deterministically and updates instead of leaving when another tab remains", async () => {
    const value = harness();
    const first = await connect(value);
    const second = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;

    await value
      .room()
      .webSocketMessage(
        first,
        encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
      );
    expect(parseEditorLiveServerMessageV1(peer.messages.at(-1))).toMatchObject({
      kind: "presence-update",
      participant: { member: { id: subjectId }, presence },
    });

    peer.messages.length = 0;
    await value.room().webSocketClose(first);
    expect(parseEditorLiveServerMessageV1(peer.messages[0])).toMatchObject({
      kind: "presence-update",
      participant: {
        member: { id: subjectId },
        presence: { cursor: null, playheadSeconds: 0, selectedEntityIds: [] },
      },
    });
    expect(peer.messages.some((message) => JSON.parse(message).kind === "presence-leave")).toBe(false);

    value.accepted.splice(value.accepted.indexOf(first), 1);
    peer.messages.length = 0;
    await value.room().webSocketClose(second);
    expect(parseEditorLiveServerMessageV1(peer.messages[0])).toMatchObject({
      kind: "presence-leave",
      memberId: subjectId,
    });
  });

  it("enforces bounded participant and connection counts", async () => {
    const value = harness();
    const memberIds = Array.from(
      { length: MAX_EDITOR_LIVE_PARTICIPANTS_V1 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    for (const memberId of memberIds) await connect(value, request({ subjectId: memberId }));

    const participantOverflow = await value
      .room()
      .fetch(request({ subjectId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }));
    expect(participantOverflow.status).toBe(503);
    expect(participantOverflow.headers.get("cache-control")).toBe("no-store");
    expect((await participantOverflow.text()).length).toBeLessThan(256);

    for (let index = value.accepted.length; index < MAX_EDITOR_LIVE_ROOM_CONNECTIONS_V1; index += 1) {
      await connect(value, request({ subjectId: memberIds[0] }));
    }
    const connectionOverflow = await value.room().fetch(request({ subjectId: memberIds[0] }));
    expect(connectionOverflow.status).toBe(503);
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

  it("persists only bounded non-secret authorization control data and schedules the earliest lease alarm", async () => {
    const value = harness();
    const socket = await connect(value);

    expect(socket.attachment).toMatchObject({
      authorizationId,
      leaseExpiresAtMs: initialNow + 60_000,
      membershipVersion: 1,
      sessionVersion: 1,
    });
    expect(value.scheduledAlarm).toBe(initialNow + 60_000);
    const serialized = JSON.stringify(socket.attachment);
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("sessionToken");
    expect(serialized).not.toContain("session_token_hash");
  });

  it("does not rewrite an unchanged authorization alarm during hot room traffic", async () => {
    const value = harness();
    const room = value.room();
    await expect(room.fetch(request())).resolves.toMatchObject({ status: 200 });
    await expect(room.fetch(request())).resolves.toMatchObject({ status: 200 });
    const sender = value.accepted[0]!;

    await room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
    );

    expect(value.setAlarm).toHaveBeenCalledOnce();
  });

  it("revokes a logged-out socket at the bounded lease alarm without affecting another member", async () => {
    const value = harness();
    const revoked = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    value.setNow(initialNow + 60_000);
    const revalidate = vi.fn(async (leases: readonly EditorCollaborationAuthorizationLeaseV1[]) =>
      leases.map((lease) => (lease.authorizationId === authorizationId ? null : grantFromLease(lease))),
    );
    const rehydrated = value.room({ revalidateAuthorizations: revalidate });

    await rehydrated.alarm();

    expect(revalidate).toHaveBeenCalledOnce();
    expect(revoked.close).toHaveBeenCalledWith(1008, "unavailable");
    expect(peer.close).not.toHaveBeenCalledWith(1008, "unavailable");
    expect(peer.attachment).toMatchObject({ leaseExpiresAtMs: initialNow + 120_000 });
  });

  it("revokes every tab bound to one session while leaving another session connected", async () => {
    const value = harness();
    const firstTab = await connect(value);
    const secondTab = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    value.setNow(initialNow + 60_000);
    const revalidate = vi.fn(async (leases: readonly EditorCollaborationAuthorizationLeaseV1[]) =>
      leases.map((lease) => (lease.authorizationId === authorizationId ? null : grantFromLease(lease))),
    );

    await value.room({ revalidateAuthorizations: revalidate }).alarm();

    expect(revalidate.mock.calls[0]![0]).toHaveLength(3);
    expect(firstTab.close).toHaveBeenCalledWith(1008, "unavailable");
    expect(secondTab.close).toHaveBeenCalledWith(1008, "unavailable");
    expect(peer.close).not.toHaveBeenCalledWith(1008, "unavailable");
  });

  it("revalidates after hibernation and removes write permission before a publisher resumes", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    value.setNow(initialNow + 60_000);
    const rehydrated = value.room({
      revalidateAuthorizations: async (leases) =>
        leases.map((lease) =>
          grantFromLease(lease, {
            canWrite: lease.authorizationId === authorizationId ? false : lease.canWrite,
            membershipVersion: lease.membershipVersion + 1,
          }),
        ),
    });

    await rehydrated.alarm();
    expect(sender.attachment).toMatchObject({ canWrite: false, membershipVersion: 2 });

    await rehydrated.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "11" }),
    );
    expect(sender.close).toHaveBeenCalledWith(1008, "read-only");
    expect(peer.messages).toEqual([]);
  });

  it("fails closed on revalidation outage, malformed output, or a changed session version", async () => {
    for (const revalidateAuthorizations of [
      async () => Promise.reject(new Error("PostgreSQL unavailable")),
      async () => [],
      async (leases: readonly EditorCollaborationAuthorizationLeaseV1[]) =>
        leases.map((lease) => grantFromLease(lease, { sessionVersion: lease.sessionVersion + 1 })),
    ]) {
      const value = harness();
      const sender = await connect(value);
      value.setNow(initialNow + 60_000);

      await value.room({ revalidateAuthorizations }).alarm();

      expect(sender.close).toHaveBeenCalledWith(1008, "unavailable");
    }
  });

  it("does not deliver a head to a recipient whose authorization expires before the sender", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ leaseExpiresAtMs: initialNow + 10, subjectId: peerSubjectId }));
    sender.messages.length = 0;
    peer.messages.length = 0;
    value.setNow(initialNow + 10);
    const room = value.room({
      revalidateAuthorizations: async (leases) =>
        leases.map((lease) => (lease.authorizationId === peerAuthorizationId ? null : grantFromLease(lease))),
    });

    await room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "12" }),
    );

    expect(peer.close).toHaveBeenCalledWith(1008, "unavailable");
    expect(peer.messages.filter((message) => JSON.parse(message).kind === "head")).toEqual([]);
  });

  it("coalesces concurrent revocation with an in-flight publish and never emits the stale head", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const limiter = deferred<boolean>();
    const room = value.room({
      allowPublish: () => limiter.promise,
      revalidateAuthorizations: async (leases) =>
        leases.map((lease) => (lease.authorizationId === authorizationId ? null : grantFromLease(lease))),
    });
    const pending = room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "13" }),
    );
    await vi.waitFor(() => expect(value.scheduledAlarm).toBe(initialNow + 60_000));
    value.setNow(initialNow + 60_000);

    await room.alarm();
    limiter.resolve(true);
    await pending;

    expect(sender.close).toHaveBeenCalledWith(1008, "unavailable");
    expect(peer.messages.filter((message) => JSON.parse(message).kind === "head")).toEqual([]);
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
      const response = await value.room().fetch(request(mismatch));
      expect(response.status, JSON.stringify(mismatch)).toBe(503);
      expect(sender.close, JSON.stringify(mismatch)).not.toHaveBeenCalled();
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

  it("fails closed when a hibernated socket attachment is malformed", async () => {
    const value = harness();
    const existing = await connect(value);
    existing.attachment = { connectionId: "not-an-attachment" };

    const response = await value.room().fetch(request());

    expect(response.status).toBe(503);
    expect(existing.close).toHaveBeenCalledWith(1008, "room-mismatch");
    expect(value.accepted).toHaveLength(1);
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

  it("uses a separate limiter for presence without requiring write access", async () => {
    const value = harness();
    const readOnly = await connect(value, request({ canWrite: false }));
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const allowPresence = vi.fn(async () => true);

    await value
      .room({ allowPresence })
      .webSocketMessage(
        readOnly,
        encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
      );

    expect(allowPresence).toHaveBeenCalledOnce();
    expect(readOnly.close).not.toHaveBeenCalledWith(1008, "read-only");
    expect(parseEditorLiveServerMessageV1(peer.messages[0])).toMatchObject({ kind: "presence-update" });

    await value
      .room({ allowPresence: async () => false })
      .webSocketMessage(
        readOnly,
        encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
      );
    expect(readOnly.close).toHaveBeenCalledWith(1008, "rate-limited");
  });

  it("preserves same-socket presence order across an asynchronous limiter", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const gates: ReturnType<typeof deferred<boolean>>[] = [];
    const room = value.room({
      allowPresence: () => {
        const gate = deferred<boolean>();
        gates.push(gate);
        return gate.promise;
      },
    });
    const firstPresence = { ...presence, playheadSeconds: 1 };
    const latestPresence = { ...presence, playheadSeconds: 2 };

    const first = room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence: firstPresence, protocolVersion: 1 }),
    );
    const latest = room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence: latestPresence, protocolVersion: 1 }),
    );
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    gates[0]!.resolve(true);
    await first;
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve(true);
    await latest;

    expect(sender.attachment).toMatchObject({ presence: latestPresence });
    expect(parseEditorLiveServerMessageV1(peer.messages.at(-1))).toMatchObject({
      kind: "presence-update",
      participant: { presence: latestPresence },
    });
  });

  it("preserves cross-tab ingress order when limiter completions reverse", async () => {
    const value = harness();
    const firstTab = await connect(value);
    const latestTab = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const gates: {
      connectionId: string;
      gate: ReturnType<typeof deferred<boolean>>;
    }[] = [];
    const room = value.room({
      allowPresence: (attachment) => {
        const gate = deferred<boolean>();
        gates.push({ connectionId: attachment.connectionId, gate });
        return gate.promise;
      },
    });
    const firstPresence = { ...presence, playheadSeconds: 10 };
    const latestPresence = { ...presence, playheadSeconds: 20 };

    const first = room.webSocketMessage(
      firstTab,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence: firstPresence, protocolVersion: 1 }),
    );
    const latest = room.webSocketMessage(
      latestTab,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence: latestPresence, protocolVersion: 1 }),
    );
    await vi.waitFor(() => expect(gates).toHaveLength(2));

    gates.find(({ connectionId }) => connectionId.endsWith("000000000002"))!.gate.resolve(true);
    await latest;
    gates.find(({ connectionId }) => connectionId.endsWith("000000000001"))!.gate.resolve(true);
    await first;

    expect(parseEditorLiveServerMessageV1(peer.messages.at(-1))).toMatchObject({
      kind: "presence-update",
      participant: { member: { id: subjectId }, presence: latestPresence },
    });
  });

  it("does not revive presence when a socket closes during limiter I/O", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const gate = deferred<boolean>();
    const room = value.room({ allowPresence: () => gate.promise });

    const pending = room.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
    );
    await room.webSocketClose(sender);
    gate.resolve(true);
    await pending;

    expect(peer.messages.map((message) => parseEditorLiveServerMessageV1(message)?.kind)).toEqual(["presence-leave"]);
    expect(sender.attachment).toMatchObject({
      presence: { cursor: null, playheadSeconds: 0, selectedEntityIds: [] },
    });
  });

  it("uses distinct runtime head and presence bindings before broadcasting", async () => {
    const value = harness();
    const sender = await connect(value);
    const peer = await connect(value, request({ subjectId: peerSubjectId }));
    peer.messages.length = 0;
    const headLimit = vi.fn(async () => ({ success: true }));
    const presenceLimit = vi.fn(async () => ({ success: true }));
    const runtime = new EditorProjectRoomDurableObjectV1(value.state, {
      EDITOR_HEAD_RATE_LIMITER: { limit: headLimit },
      EDITOR_PRESENCE_RATE_LIMITER: { limit: presenceLimit },
      HYPERDRIVE: { connectionString: "postgresql://user:password@database.example:5432/poietra" },
    });

    await runtime.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "head", protocolVersion: 1, revision: "2" }),
    );

    await runtime.webSocketMessage(
      sender,
      encodeEditorLiveClientMessageV1({ kind: "presence-update", presence, protocolVersion: 1 }),
    );

    expect(headLimit).toHaveBeenCalledWith({ key: `editor-head:${identity.organizationId}:${subjectId}` });
    expect(presenceLimit).toHaveBeenCalledWith({
      key: `editor-presence:${identity.organizationId}:${subjectId}:33333333-3333-4333-8333-000000000001`,
    });
    expect(peer.messages.map((message) => JSON.parse(message).kind)).toEqual(["head", "presence-update"]);
  });
});
