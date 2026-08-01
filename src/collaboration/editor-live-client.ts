import { editorRevisionStringSchemaV1 } from "./editor-document-http-contract";
import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
  editorLiveIdentityMatchesV1,
  editorLiveIdentitySchemaV1,
  encodeEditorLiveClientMessageV1,
  parseEditorLiveServerMessageV1,
} from "./editor-live-contract";

export type EditorLiveConnectionPhaseV1 = "connected" | "connecting" | "exhausted";

export type EditorLiveConnectionCallbacksV1 = Readonly<{
  onHead: (revision: string) => void;
  onPhase?: (phase: EditorLiveConnectionPhaseV1) => void;
}>;

export interface EditorLiveConnectionV1 {
  close(): void;
  publishHead(revision: string): void;
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
    const url = liveUrlV1(this.#origin, identity);
    let stopped = false;
    let ready = false;
    let ownConnectionId: string | null = null;
    let socket: EditorLiveSocketV1 | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: TimerHandleV1 | null = null;
    let stabilityTimer: TimerHandleV1 | null = null;
    let pendingHead: string | null = null;

    const send = (value: string) => {
      if (!ready || socket?.readyState !== SOCKET_OPEN_V1) return false;
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
      ready = false;
      ownConnectionId = null;
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
          if (ready || !editorLiveIdentityMatchesV1(message.identity, identity)) {
            nextSocket.close(CLIENT_ROOM_MISMATCH_CLOSE_V1, "room mismatch");
            return;
          }
          ready = true;
          ownConnectionId = message.connectionId;
          if (stabilityTimer !== null) this.#unschedule(stabilityTimer);
          stabilityTimer = this.#schedule(() => {
            stabilityTimer = null;
            if (ready && socket === nextSocket) reconnectAttempts = 0;
          }, STABLE_CONNECTION_MS_V1);
          callbacks.onPhase?.("connected");
          flushHead();
          return;
        }
        if (!ready) {
          nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, "ready required");
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
        nextSocket.close(CLIENT_PROTOCOL_CLOSE_V1, message.code);
      });
      nextSocket.addEventListener("error", () => {
        if (!stopped && socket === nextSocket) nextSocket.close(CLIENT_TRANSPORT_CLOSE_V1, "transport error");
      });
      nextSocket.addEventListener("close", () => {
        if (socket !== nextSocket) return;
        socket = null;
        ready = false;
        ownConnectionId = null;
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
        ready = false;
        if (reconnectTimer !== null) this.#unschedule(reconnectTimer);
        if (stabilityTimer !== null) this.#unschedule(stabilityTimer);
        reconnectTimer = null;
        stabilityTimer = null;
        const active = socket;
        socket = null;
        active?.close(1000, "identity changed");
      },
      publishHead: (revision: string) => {
        const parsed = editorRevisionStringSchemaV1.parse(revision);
        pendingHead = pendingHead === null || BigInt(parsed) > BigInt(pendingHead) ? parsed : pendingHead;
        flushHead();
      },
    });
  }
}
