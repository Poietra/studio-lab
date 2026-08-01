import { editorRevisionStringSchemaV1 } from "./editor-document-http-contract";
import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
  type EditorLiveParticipantV1,
  type EditorLivePresenceV1,
  editorLiveIdentityMatchesV1,
  editorLiveIdentitySchemaV1,
  editorLivePresenceSchemaV1,
  encodeEditorLiveClientMessageV1,
  MAX_EDITOR_LIVE_PARTICIPANTS_V1,
  parseEditorLiveServerMessageV1,
} from "./editor-live-contract";

export type EditorLiveConnectionPhaseV1 = "connected" | "connecting" | "exhausted";

export type EditorLiveConnectionCallbacksV1 = Readonly<{
  onHead: (revision: string) => void;
  onParticipants: (participants: readonly EditorLiveParticipantV1[], selfMemberId: string) => void;
  onPhase?: (phase: EditorLiveConnectionPhaseV1) => void;
}>;

export interface EditorLiveConnectionV1 {
  close(): void;
  publishHead(revision: string): void;
  publishPresence(presence: EditorLivePresenceV1): void;
}

export interface EditorLiveClientV1 {
  connect(identity: EditorLiveIdentityV1, callbacks: EditorLiveConnectionCallbacksV1): EditorLiveConnectionV1;
}

type LiveSocketEventMapV1 = Readonly<{
  close: Event;
  error: Event;
  message: MessageEvent<unknown>;
  open: Event;
}>;

export interface EditorLiveSocketV1 {
  readonly readyState: number;
  addEventListener<Type extends keyof LiveSocketEventMapV1>(
    type: Type,
    listener: (event: LiveSocketEventMapV1[Type]) => void,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

type TimerHandleV1 = ReturnType<typeof globalThis.setTimeout>;

export type BrowserEditorLiveClientOptionsV1 = Readonly<{
  createSocket?: (url: string) => EditorLiveSocketV1;
  maximumReconnectAttempts?: number;
  origin?: string;
  schedule?: (callback: () => void, delayMs: number) => TimerHandleV1;
  unschedule?: (handle: TimerHandleV1) => void;
}>;

const SOCKET_OPEN_V1 = 1;
const INITIAL_RECONNECT_DELAY_MS_V1 = 250;
const MAX_RECONNECT_DELAY_MS_V1 = 10_000;
const DEFAULT_MAXIMUM_RECONNECT_ATTEMPTS_V1 = 8;
const PRESENCE_THROTTLE_MS_V1 = 80;
const STABLE_CONNECTION_MS_V1 = 30_000;
// Browsers only permit 1000 or application-defined 3000-4999 codes when the
// client initiates close(). Registered server codes such as 1008/1011 throw.
const CLIENT_PROTOCOL_CLOSE_V1 = 4000;
const CLIENT_ROOM_MISMATCH_CLOSE_V1 = 4001;
const CLIENT_TRANSPORT_CLOSE_V1 = 4002;

function liveUrlV1(originValue: string, identity: EditorLiveIdentityV1) {
  const origin = new URL(originValue);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.origin !== originValue ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new TypeError("Editor live client requires an exact HTTP origin.");
  }
  origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  origin.pathname = `/api/collaboration/projects/${encodeURIComponent(identity.projectId)}/documents/${encodeURIComponent(identity.documentKey)}`;
  origin.searchParams.set("epoch", identity.epoch);
  origin.searchParams.set("protocolVersion", String(EDITOR_LIVE_PROTOCOL_VERSION_V1));
  return origin.href;
}

function defaultOriginV1() {
  if (typeof window === "undefined") throw new TypeError("Editor live client requires a browser origin.");
  return window.location.origin;
}

function defaultSocketV1(url: string): EditorLiveSocketV1 {
  return new WebSocket(url);
}

/**
 * A lossy notification channel by design. Only the authenticated HTTP tail is
 * authoritative; WebSocket heads merely wake that reconciler.
 */
export class BrowserEditorLiveClientV1 implements EditorLiveClientV1 {
  readonly #createSocket: (url: string) => EditorLiveSocketV1;
  readonly #maximumReconnectAttempts: number;
  readonly #origin: string;
  readonly #schedule: (callback: () => void, delayMs: number) => TimerHandleV1;
  readonly #unschedule: (handle: TimerHandleV1) => void;

  constructor(options: BrowserEditorLiveClientOptionsV1 = {}) {
    const maximumReconnectAttempts = options.maximumReconnectAttempts ?? DEFAULT_MAXIMUM_RECONNECT_ATTEMPTS_V1;
    if (
      !Number.isSafeInteger(maximumReconnectAttempts) ||
      maximumReconnectAttempts < 0 ||
      maximumReconnectAttempts > 32
    ) {
      throw new RangeError("Editor live reconnect attempts must be an integer from zero through 32.");
    }
    this.#createSocket = options.createSocket ?? defaultSocketV1;
    this.#maximumReconnectAttempts = maximumReconnectAttempts;
    this.#origin = options.origin ?? defaultOriginV1();
    this.#schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#unschedule = options.unschedule ?? ((handle) => globalThis.clearTimeout(handle));
  }

  connect(identityValue: EditorLiveIdentityV1, callbacks: EditorLiveConnectionCallbacksV1): EditorLiveConnectionV1 {
    const identity = editorLiveIdentitySchemaV1.parse(identityValue);
    if (typeof callbacks?.onHead !== "function") throw new TypeError("Editor live client requires a head callback.");
    if (typeof callbacks.onParticipants !== "function") {
      throw new TypeError("Editor live client requires a participant callback.");
    }
    const url = liveUrlV1(this.#origin, identity);
    let stopped = false;
    let handshake: "awaiting-ready" | "awaiting-snapshot" | "connected" = "awaiting-ready";
    let ownConnectionId: string | null = null;
    let selfMemberId: string | null = null;
    let socket: EditorLiveSocketV1 | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: TimerHandleV1 | null = null;
    let stabilityTimer: TimerHandleV1 | null = null;
    let presenceTimer: TimerHandleV1 | null = null;
    let participantTimer: TimerHandleV1 | null = null;
    let pendingHead: string | null = null;
    let latestPresence: EditorLivePresenceV1 | null = null;
    let presenceDirty = false;
    const participants = new Map<string, EditorLiveParticipantV1>();

    const send = (value: string) => {
      if (handshake !== "connected" || socket?.readyState !== SOCKET_OPEN_V1) return false;
      try {
        socket.send(value);
        return true;
      } catch {
        socket.close(CLIENT_TRANSPORT_CLOSE_V1, "transport error");
        return false;
      }
    };

    const flushHead = () => {
      if (pendingHead === null) return;
      const message = encodeEditorLiveClientMessageV1({
        kind: "head",
        protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
        revision: pendingHead,
      });
      if (send(message)) pendingHead = null;
    };

    const participantSnapshot = () =>
      Object.freeze(
        [...participants.values()].sort((left, right) =>
          left.member.id < right.member.id ? -1 : left.member.id > right.member.id ? 1 : 0,
        ),
      );

    const publishParticipants = () => {
      if (handshake !== "connected" || selfMemberId === null) return;
      callbacks.onParticipants(participantSnapshot(), selfMemberId);
    };

    const scheduleParticipants = () => {
      if (handshake !== "connected" || participantTimer !== null) return;
      participantTimer = this.#schedule(() => {
        participantTimer = null;
        publishParticipants();
      }, PRESENCE_THROTTLE_MS_V1);
    };

    const flushPresence = () => {
      if (!presenceDirty || latestPresence === null) return;
      const message = encodeEditorLiveClientMessageV1({
        kind: "presence-update",
        presence: latestPresence,
        protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
      });
      if (send(message)) presenceDirty = false;
    };

    const schedulePresence = () => {
      if (handshake !== "connected" || presenceTimer !== null) return;
      presenceTimer = this.#schedule(() => {
        presenceTimer = null;
        flushPresence();
      }, PRESENCE_THROTTLE_MS_V1);
    };

    const scheduleReconnect = (open: () => void) => {
      if (stopped || reconnectTimer !== null) return;
      if (reconnectAttempts >= this.#maximumReconnectAttempts) {
        callbacks.onPhase?.("exhausted");
        return;
      }
      const delay = Math.min(INITIAL_RECONNECT_DELAY_MS_V1 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS_V1);
      reconnectAttempts += 1;
      callbacks.onPhase?.("connecting");
      reconnectTimer = this.#schedule(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };

    const open = () => {
      if (stopped) return;
      handshake = "awaiting-ready";
      ownConnectionId = null;
      selfMemberId = null;
      participants.clear();
      presenceDirty = latestPresence !== null;
      if (presenceTimer !== null) this.#unschedule(presenceTimer);
      if (participantTimer !== null) this.#unschedule(participantTimer);
      presenceTimer = null;
      participantTimer = null;
      callbacks.onPhase?.("connecting");
      let nextSocket: EditorLiveSocketV1;
      try {
        nextSocket = this.#createSocket(url);
      } catch {
        scheduleReconnect(open);
        return;
      }
      socket = nextSocket;
      nextSocket.addEventListener("message", (event) => {
        if (stopped || socket !== nextSocket) return;
        const message = parseEditorLiveServerMessageV1(event.data);
        if (!message) {
          nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "invalid message");
          return;
        }
        if (message.kind === "ready") {
          if (handshake !== "awaiting-ready" || !editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          handshake = "awaiting-snapshot";
          ownConnectionId = message.connectionId;
          selfMemberId = message.memberId;
          return;
        }
        if (message.kind === "presence-snapshot") {
          if (handshake !== "awaiting-snapshot") {
            nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "invalid presence order");
            return;
          }
          if (!editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          const memberId = selfMemberId;
          if (memberId === null || !message.participants.some((participant) => participant.member.id === memberId)) {
            nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "self participant required");
            return;
          }
          participants.clear();
          for (const participant of message.participants) participants.set(participant.member.id, participant);
          handshake = "connected";
          if (stabilityTimer !== null) this.#unschedule(stabilityTimer);
          stabilityTimer = this.#schedule(() => {
            stabilityTimer = null;
            if (handshake === "connected" && socket === nextSocket) reconnectAttempts = 0;
          }, STABLE_CONNECTION_MS_V1);
          publishParticipants();
          callbacks.onPhase?.("connected");
          flushHead();
          flushPresence();
          return;
        }
        if (handshake !== "connected") {
          nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "presence snapshot required");
          return;
        }
        if (message.kind === "head") {
          if (!editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          if (message.publisherConnectionId !== ownConnectionId) callbacks.onHead(message.revision);
          return;
        }
        if (message.kind === "presence-update") {
          if (!editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          if (
            !participants.has(message.participant.member.id) &&
            participants.size >= MAX_EDITOR_LIVE_PARTICIPANTS_V1
          ) {
            nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "participant limit exceeded");
            return;
          }
          participants.set(message.participant.member.id, message.participant);
          scheduleParticipants();
          return;
        }
        if (message.kind === "presence-leave") {
          if (!editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          if (message.memberId === selfMemberId || !participants.delete(message.memberId)) {
            nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "invalid participant leave");
            return;
          }
          scheduleParticipants();
          return;
        }
        nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, message.code);
      });
      nextSocket.addEventListener("error", () => {
        if (!stopped && socket === nextSocket) nextSocket.close(CLIENT_TRANSPORT_CLOSE_V1, "transport error");
      });
      nextSocket.addEventListener("close", () => {
        if (socket !== nextSocket) return;
        socket = null;
        handshake = "awaiting-ready";
        ownConnectionId = null;
        selfMemberId = null;
        participants.clear();
        presenceDirty = latestPresence !== null;
        if (presenceTimer !== null) this.#unschedule(presenceTimer);
        if (participantTimer !== null) this.#unschedule(participantTimer);
        presenceTimer = null;
        participantTimer = null;
        if (stabilityTimer !== null) this.#unschedule(stabilityTimer);
        stabilityTimer = null;
        scheduleReconnect(open);
      });
    };

    open();
    return Object.freeze({
      close: () => {
        if (stopped) return;
        stopped = true;
        handshake = "awaiting-ready";
        if (reconnectTimer !== null) this.#unschedule(reconnectTimer);
        if (stabilityTimer !== null) this.#unschedule(stabilityTimer);
        if (presenceTimer !== null) this.#unschedule(presenceTimer);
        if (participantTimer !== null) this.#unschedule(participantTimer);
        reconnectTimer = null;
        stabilityTimer = null;
        presenceTimer = null;
        participantTimer = null;
        participants.clear();
        const active = socket;
        socket = null;
        active?.close(1000, "identity changed");
      },
      publishHead: (revision: string) => {
        const parsed = editorRevisionStringSchemaV1.parse(revision);
        pendingHead = pendingHead === null || BigInt(parsed) > BigInt(pendingHead) ? parsed : pendingHead;
        flushHead();
      },
      publishPresence: (presenceValue: EditorLivePresenceV1) => {
        latestPresence = editorLivePresenceSchemaV1.parse(presenceValue);
        presenceDirty = true;
        schedulePresence();
      },
    });
  }
}
