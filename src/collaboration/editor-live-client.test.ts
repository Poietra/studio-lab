import { describe, expect, it, vi } from "vitest";
import { BrowserEditorLiveClientV1, type EditorLiveSocketV1 } from "./editor-live-client";
import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
  type EditorLiveParticipantV1,
  type EditorLivePresenceV1,
  encodeEditorLiveServerMessageV1,
} from "./editor-live-contract";

const identity = {
  documentKey: "a".repeat(64),
  epoch: "11111111-1111-4111-8111-111111111111",
  organizationId: "organization-a",
  projectId: "project-a",
} as const;
const ownConnection = "22222222-2222-4222-8222-222222222222";
const peerConnection = "33333333-3333-4333-8333-333333333333";
const ownMember = "44444444-4444-4444-8444-444444444444";
const peerMember = "55555555-5555-4555-8555-555555555555";
const defaultPresence: EditorLivePresenceV1 = {
  cursor: null,
  playheadSeconds: 0,
  selectedEntityIds: [],
};

class FakeSocket implements EditorLiveSocketV1 {
  readonly listeners = new Map<string, ((event: never) => void)[]>();
  readonly sent: string[] = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = 3;
    void code;
    void reason;
  });
  readyState = 0;

  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
  }

  emit(type: "close" | "error" | "message" | "open", data?: unknown) {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    const event = type === "message" ? new MessageEvent("message", { data }) : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function ready(overrides: Record<string, unknown> = {}) {
  return encodeEditorLiveServerMessageV1({
    connectionId: ownConnection,
    identity,
    kind: "ready",
    memberId: ownMember,
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
    ...overrides,
  });
}

function participant(memberId: string, presence: EditorLivePresenceV1 = defaultPresence): EditorLiveParticipantV1 {
  return { member: { id: memberId }, presence };
}

function presenceSnapshot(
  participants: readonly EditorLiveParticipantV1[] = [participant(ownMember)],
  identityValue: EditorLiveIdentityV1 = identity,
) {
  return encodeEditorLiveServerMessageV1({
    identity: identityValue,
    kind: "presence-snapshot",
    participants: [...participants],
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
  });
}

function presenceUpdate(value: EditorLiveParticipantV1, identityValue: EditorLiveIdentityV1 = identity) {
  return encodeEditorLiveServerMessageV1({
    identity: identityValue,
    kind: "presence-update",
    participant: value,
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
  });
}

function presenceLeave(memberId: string, identityValue: EditorLiveIdentityV1 = identity) {
  return encodeEditorLiveServerMessageV1({
    identity: identityValue,
    kind: "presence-leave",
    memberId,
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
  });
}

function head(
  revision: string,
  publisherConnectionId = peerConnection,
  identityValue: EditorLiveIdentityV1 = identity,
) {
  return encodeEditorLiveServerMessageV1({
    identity: identityValue,
    kind: "head",
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
    publisherConnectionId,
    revision,
  });
}

function harness(maximumReconnectAttempts = 8) {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: Readonly<{ callback: () => void; delay: number }>[] = [];
  const phases: string[] = [];
  const client = new BrowserEditorLiveClientV1({
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    maximumReconnectAttempts,
    origin: "https://studio.example",
    schedule: ((callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length as never;
    }) as never,
    unschedule: vi.fn(),
  });
  const onHead = vi.fn();
  const onParticipants = vi.fn();
  const connection = client.connect(identity, {
    onHead,
    onParticipants,
    onPhase: (phase) => phases.push(phase),
  });
  return { connection, onHead, onParticipants, phases, sockets, timers, urls };
}

describe("Browser Editor live client", () => {
  it("binds a same-origin socket to the exact document and forwards only peer heads", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    expect(value.urls[0]).toBe(
      `wss://studio.example/api/collaboration/projects/project-a/documents/${identity.documentKey}?epoch=${identity.epoch}&protocolVersion=1`,
    );

    socket.emit("open");
    socket.emit("message", ready());
    expect(value.phases).toEqual(["connecting"]);
    socket.emit("message", presenceSnapshot());
    socket.emit("message", head("1", ownConnection));
    socket.emit("message", head("2"));
    socket.emit("message", head("1"));

    expect(value.phases).toEqual(["connecting", "connected"]);
    expect(value.onHead.mock.calls).toEqual([["2"], ["1"]]);
    expect(value.onParticipants).toHaveBeenCalledWith([participant(ownMember)], ownMember);
  });

  it("coalesces offline local heads and sends only the highest revision after ready", () => {
    const value = harness();
    value.connection.publishHead("3");
    value.connection.publishHead("5");
    value.connection.publishHead("4");
    const socket = value.sockets[0]!;
    socket.emit("open");
    socket.emit("message", ready());
    expect(socket.sent).toHaveLength(0);
    socket.emit("message", presenceSnapshot());

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: "head", protocolVersion: 1, revision: "5" });
  });

  it("rejects a ready or head for another room", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    socket.emit("open");
    socket.emit("message", ready({ identity: { ...identity, organizationId: "organization-b" } }));
    expect(socket.close).toHaveBeenCalledWith(4001, "room mismatch");

    const second = harness();
    const secondSocket = second.sockets[0]!;
    secondSocket.emit("open");
    secondSocket.emit("message", ready());
    secondSocket.emit("message", presenceSnapshot());
    secondSocket.emit(
      "message",
      head("1", peerConnection, { ...identity, epoch: "44444444-4444-4444-8444-444444444444" }),
    );
    expect(secondSocket.close).toHaveBeenCalledWith(4001, "room mismatch");
    expect(second.onHead).not.toHaveBeenCalled();
  });

  it("reconnects with a bounded backoff and preserves an unsent head", () => {
    const value = harness(2);
    const first = value.sockets[0]!;
    value.connection.publishHead("7");
    first.emit("close");
    expect(value.timers.map(({ delay }) => delay)).toEqual([250]);
    value.timers[0]!.callback();

    const second = value.sockets[1]!;
    second.emit("open");
    second.emit("message", ready());
    second.emit("message", presenceSnapshot());
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ kind: "head", revision: "7" });
  });

  it("requires an exact initial presence snapshot before becoming connected", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    socket.emit("open");
    socket.emit("message", ready());
    socket.emit("message", head("1"));

    expect(socket.close).toHaveBeenCalledWith(4000, "presence snapshot required");
    expect(value.phases).toEqual(["connecting"]);
    expect(value.onHead).not.toHaveBeenCalled();

    const wrongRoom = harness();
    const wrongSocket = wrongRoom.sockets[0]!;
    wrongSocket.emit("open");
    wrongSocket.emit("message", ready());
    wrongSocket.emit(
      "message",
      presenceSnapshot([participant(ownMember)], {
        ...identity,
        epoch: "66666666-6666-4666-8666-666666666666",
      }),
    );
    expect(wrongSocket.close).toHaveBeenCalledWith(4001, "room mismatch");

    const missingSelf = harness();
    const missingSelfSocket = missingSelf.sockets[0]!;
    missingSelfSocket.emit("open");
    missingSelfSocket.emit("message", ready());
    missingSelfSocket.emit("message", presenceSnapshot([participant(peerMember)]));
    expect(missingSelfSocket.close).toHaveBeenCalledWith(4000, "self participant required");
  });

  it("maintains a deterministic participant map without waking the HTTP head reconciler", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    const peerPresence: EditorLivePresenceV1 = {
      cursor: { x: 0.25, y: 0.75 },
      playheadSeconds: 2,
      selectedEntityIds: ["equation"],
    };
    const latestPeerPresence: EditorLivePresenceV1 = {
      cursor: { x: 0.5, y: 0.5 },
      playheadSeconds: 3,
      selectedEntityIds: ["equation", "label"],
    };
    socket.emit("open");
    socket.emit("message", ready());
    socket.emit("message", presenceSnapshot([participant(ownMember)]));
    socket.emit("message", presenceUpdate(participant(peerMember, peerPresence)));
    socket.emit("message", presenceUpdate(participant(peerMember, latestPeerPresence)));

    expect(value.onParticipants).toHaveBeenCalledOnce();
    value.timers.find(({ delay }) => delay === 80)!.callback();

    expect(value.onParticipants).toHaveBeenLastCalledWith(
      [participant(ownMember), participant(peerMember, latestPeerPresence)],
      ownMember,
    );
    expect(value.onHead).not.toHaveBeenCalled();

    socket.emit("message", presenceLeave(peerMember));
    value.timers
      .filter(({ delay }) => delay === 80)
      .at(-1)!
      .callback();
    expect(value.onParticipants).toHaveBeenLastCalledWith([participant(ownMember)], ownMember);
    expect(value.onHead).not.toHaveBeenCalled();
  });

  it("fails closed on presence updates for another room or impossible leave order", () => {
    const wrongRoom = harness();
    const wrongSocket = wrongRoom.sockets[0]!;
    wrongSocket.emit("open");
    wrongSocket.emit("message", ready());
    wrongSocket.emit("message", presenceSnapshot());
    wrongSocket.emit(
      "message",
      presenceUpdate(participant(peerMember), { ...identity, organizationId: "organization-b" }),
    );
    expect(wrongSocket.close).toHaveBeenCalledWith(4001, "room mismatch");

    const impossibleLeave = harness();
    const leaveSocket = impossibleLeave.sockets[0]!;
    leaveSocket.emit("open");
    leaveSocket.emit("message", ready());
    leaveSocket.emit("message", presenceSnapshot());
    leaveSocket.emit("message", presenceLeave(peerMember));
    expect(leaveSocket.close).toHaveBeenCalledWith(4000, "invalid participant leave");
  });

  it("throttles and coalesces presence to the latest update", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    socket.emit("open");
    socket.emit("message", ready());
    socket.emit("message", presenceSnapshot());
    const first: EditorLivePresenceV1 = { cursor: null, playheadSeconds: 1, selectedEntityIds: [] };
    const latest: EditorLivePresenceV1 = {
      cursor: { x: 0.4, y: 0.6 },
      playheadSeconds: 2,
      selectedEntityIds: ["equation"],
    };

    value.connection.publishPresence(first);
    value.connection.publishPresence(latest);
    expect(socket.sent).toHaveLength(0);
    const throttle = value.timers.find(({ delay }) => delay === 80);
    expect(throttle).toBeDefined();
    throttle!.callback();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      kind: "presence-update",
      presence: latest,
      protocolVersion: 1,
    });
  });

  it("keeps only the latest offline presence and flushes it after the mandatory snapshot", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    const latest: EditorLivePresenceV1 = {
      cursor: { x: 0.1, y: 0.9 },
      playheadSeconds: 4,
      selectedEntityIds: ["offline-label"],
    };
    value.connection.publishPresence({ cursor: null, playheadSeconds: 1, selectedEntityIds: [] });
    value.connection.publishPresence(latest);

    socket.emit("open");
    socket.emit("message", ready());
    expect(socket.sent).toHaveLength(0);
    socket.emit("message", presenceSnapshot());

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ kind: "presence-update", presence: latest });
    expect(value.timers.some(({ delay }) => delay === 80)).toBe(false);
  });

  it("retains only the latest presence and resends it after a reconnect snapshot", () => {
    const value = harness();
    const first = value.sockets[0]!;
    const latest: EditorLivePresenceV1 = {
      cursor: { x: 0.2, y: 0.8 },
      playheadSeconds: 3,
      selectedEntityIds: ["label"],
    };
    first.emit("open");
    first.emit("message", ready());
    first.emit("message", presenceSnapshot());
    value.connection.publishPresence(latest);
    value.timers.find(({ delay }) => delay === 80)!.callback();
    expect(first.sent).toHaveLength(1);

    first.emit("close");
    value.timers.find(({ delay }) => delay === 250)!.callback();
    const second = value.sockets[1]!;
    second.emit("open");
    second.emit("message", ready());
    expect(second.sent).toHaveLength(0);
    second.emit("message", presenceSnapshot());

    expect(second.sent).toHaveLength(1);
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ kind: "presence-update", presence: latest });
  });

  it("stops reconnecting after the configured attempt budget", () => {
    const value = harness(1);
    value.sockets[0]!.emit("close");
    value.timers[0]!.callback();
    value.sockets[1]!.emit("close");

    expect(value.timers).toHaveLength(1);
    expect(value.phases.at(-1)).toBe("exhausted");
  });

  it("closes the active socket and cancels future reconnects when identity changes", () => {
    const value = harness();
    const socket = value.sockets[0]!;
    value.connection.close();
    socket.emit("close");

    expect(socket.close).toHaveBeenCalledWith(1000, "identity changed");
    expect(value.timers).toHaveLength(0);
  });
});
