import { describe, expect, it, vi } from "vitest";
import { BrowserEditorLiveClientV1, type EditorLiveSocketV1 } from "./editor-live-client";
import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
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
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
    ...overrides,
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
  const connection = client.connect(identity, { onHead, onPhase: (phase) => phases.push(phase) });
  return { connection, onHead, phases, sockets, timers, urls };
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
    socket.emit("message", head("1", ownConnection));
    socket.emit("message", head("2"));

    expect(value.phases).toEqual(["connecting", "connected"]);
    expect(value.onHead).toHaveBeenCalledOnce();
    expect(value.onHead).toHaveBeenCalledWith("2");
  });

  it("coalesces offline local heads and sends only the highest revision after ready", () => {
    const value = harness();
    value.connection.publishHead("3");
    value.connection.publishHead("5");
    value.connection.publishHead("4");
    const socket = value.sockets[0]!;
    socket.emit("open");
    socket.emit("message", ready());

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
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ kind: "head", revision: "7" });
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
