import { z } from "zod";

import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
  editorLiveIdentityMatchesV1,
  editorLiveIdentitySchemaV1,
  encodeEditorLiveServerMessageV1,
  parseEditorLiveClientMessageV1,
} from "../src/collaboration/editor-live-contract";
import { accountUserIdSchemaV1 } from "./accounts/account-domain";

export const EDITOR_LIVE_INTERNAL_ROUTE_V1 = "/internal/editor-live/connect";
export const EDITOR_LIVE_INTERNAL_ORIGIN_V1 = "https://poietra-editor-room.internal";
export const EDITOR_LIVE_INTERNAL_HEADERS_V1 = Object.freeze({
  canWrite: "x-poietra-internal-can-write",
  documentKey: "x-poietra-internal-document-key",
  epoch: "x-poietra-internal-epoch",
  organizationId: "x-poietra-internal-organization-id",
  projectId: "x-poietra-internal-project-id",
  subjectId: "x-poietra-internal-subject-id",
});

export interface CloudflareRoomWebSocketV1 {
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
  send(message: string): void;
  serializeAttachment(attachment: unknown): void;
}

export interface CloudflareRoomStateV1 {
  acceptWebSocket(socket: CloudflareRoomWebSocketV1): void;
  getWebSockets(): readonly CloudflareRoomWebSocketV1[];
}

export type CloudflareRoomWebSocketPairV1 = Readonly<{
  client: CloudflareRoomWebSocketV1;
  server: CloudflareRoomWebSocketV1;
}>;

export type EditorProjectRoomOptionsV1 = Readonly<{
  allowPublish?: (attachment: EditorRoomAttachmentV1) => Promise<boolean>;
  createPair?: () => CloudflareRoomWebSocketPairV1;
  createUpgradeResponse?: (client: CloudflareRoomWebSocketV1) => Response;
  randomUuid?: () => string;
}>;

const attachmentSchemaV1 = editorLiveIdentitySchemaV1
  .safeExtend({
    canWrite: z.boolean(),
    connectionId: z.uuid(),
    subjectId: accountUserIdSchemaV1,
  })
  .strict();

type EditorRoomAttachmentV1 = Readonly<z.infer<typeof attachmentSchemaV1>>;
const roomAdmissionSchemaV1 = editorLiveIdentitySchemaV1
  .safeExtend({ canWrite: z.boolean(), subjectId: accountUserIdSchemaV1 })
  .strict();

type WebSocketPairConstructorV1 = new () => {
  0: CloudflareRoomWebSocketV1;
  1: CloudflareRoomWebSocketV1;
};

function defaultPairV1(): CloudflareRoomWebSocketPairV1 {
  const constructor = (globalThis as typeof globalThis & { WebSocketPair?: WebSocketPairConstructorV1 }).WebSocketPair;
  if (!constructor) throw new TypeError("Cloudflare WebSocketPair is unavailable.");
  const pair = new constructor();
  return { client: pair[0], server: pair[1] };
}

function defaultUpgradeResponseV1(client: CloudflareRoomWebSocketV1) {
  return new Response(null, { status: 101, webSocket: client } as ResponseInit & {
    webSocket: CloudflareRoomWebSocketV1;
  });
}

function errorMessageV1(code: "invalid-message" | "rate-limited" | "read-only" | "room-mismatch" | "unavailable") {
  return encodeEditorLiveServerMessageV1({
    code,
    kind: "error",
    protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
  });
}

function closeInvalidV1(socket: CloudflareRoomWebSocketV1, code: Parameters<typeof errorMessageV1>[0]) {
  try {
    socket.send(errorMessageV1(code));
  } finally {
    socket.close(1008, code);
  }
}

function attachmentV1(socket: CloudflareRoomWebSocketV1) {
  const parsed = attachmentSchemaV1.safeParse(socket.deserializeAttachment());
  if (!parsed.success) {
    closeInvalidV1(socket, "room-mismatch");
    return null;
  }
  return parsed.data;
}

function identityV1(attachment: EditorRoomAttachmentV1): EditorLiveIdentityV1 {
  return {
    documentKey: attachment.documentKey,
    epoch: attachment.epoch,
    organizationId: attachment.organizationId,
    projectId: attachment.projectId,
  };
}

function internalAttachmentV1(request: Request) {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== EDITOR_LIVE_INTERNAL_ORIGIN_V1 ||
    url.pathname !== EDITOR_LIVE_INTERNAL_ROUTE_V1 ||
    url.search ||
    url.hash ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.body !== null
  ) {
    return null;
  }
  const headers = EDITOR_LIVE_INTERNAL_HEADERS_V1;
  const parsed = roomAdmissionSchemaV1.safeParse({
    canWrite: request.headers.get(headers.canWrite) === "1",
    documentKey: request.headers.get(headers.documentKey),
    epoch: request.headers.get(headers.epoch),
    organizationId: request.headers.get(headers.organizationId),
    projectId: request.headers.get(headers.projectId),
    subjectId: request.headers.get(headers.subjectId),
  });
  return parsed.success ? parsed.data : null;
}

/** Hibernatable room: sockets carry identity; the DO stores no edit revision. */
export function createEditorProjectRoomV1(state: CloudflareRoomStateV1, options: EditorProjectRoomOptionsV1 = {}) {
  if (typeof state?.acceptWebSocket !== "function" || typeof state.getWebSockets !== "function") {
    throw new TypeError("Editor project room requires a complete Durable Object state.");
  }
  const createPair = options.createPair ?? defaultPairV1;
  const createUpgradeResponse = options.createUpgradeResponse ?? defaultUpgradeResponseV1;
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const allowPublish = options.allowPublish ?? (async () => true);

  const roomAttachment = (request: Request) => {
    const parsed = internalAttachmentV1(request);
    if (!parsed) return null;
    const connectionId = randomUuid();
    const finalAttachment = attachmentSchemaV1.safeParse({
      ...parsed,
      connectionId,
      subjectId: parsed.subjectId,
    });
    return finalAttachment.success ? finalAttachment.data : null;
  };

  return Object.freeze({
    async fetch(request: Request) {
      const attachment = roomAttachment(request);
      if (!attachment) return Response.json({ error: "Editor live room is unavailable." }, { status: 400 });
      let pair: CloudflareRoomWebSocketPairV1;
      try {
        pair = createPair();
        pair.server.serializeAttachment(attachment);
        state.acceptWebSocket(pair.server);
        pair.server.send(
          encodeEditorLiveServerMessageV1({
            connectionId: attachment.connectionId,
            identity: identityV1(attachment),
            kind: "ready",
            protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
          }),
        );
        return createUpgradeResponse(pair.client);
      } catch {
        return Response.json({ error: "Editor live room is unavailable." }, { status: 503 });
      }
    },

    webSocketClose(_socket: CloudflareRoomWebSocketV1) {},

    webSocketError(socket: CloudflareRoomWebSocketV1) {
      socket.close(1011, "transport error");
    },

    async webSocketMessage(socket: CloudflareRoomWebSocketV1, messageValue: unknown) {
      const sender = attachmentV1(socket);
      if (!sender) return;
      const message = parseEditorLiveClientMessageV1(messageValue);
      if (!message) {
        closeInvalidV1(socket, "invalid-message");
        return;
      }
      if (!sender.canWrite) {
        closeInvalidV1(socket, "read-only");
        return;
      }
      try {
        if (!(await allowPublish(sender))) {
          closeInvalidV1(socket, "rate-limited");
          return;
        }
      } catch {
        closeInvalidV1(socket, "unavailable");
        return;
      }
      const outbound = encodeEditorLiveServerMessageV1({
        identity: identityV1(sender),
        kind: "head",
        protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
        publisherConnectionId: sender.connectionId,
        revision: message.revision,
      });
      for (const peer of state.getWebSockets()) {
        if (peer === socket) continue;
        const candidate = attachmentV1(peer);
        if (!candidate) continue;
        if (!editorLiveIdentityMatchesV1(sender, candidate)) continue;
        try {
          peer.send(outbound);
        } catch {
          peer.close(1011, "transport error");
        }
      }
    },
  });
}

/** Wrangler Durable Object entry. */
export class EditorProjectRoomDurableObjectV1 {
  readonly #room: ReturnType<typeof createEditorProjectRoomV1>;

  constructor(
    state: CloudflareRoomStateV1,
    environment: Readonly<{ EDITOR_HEAD_RATE_LIMITER: Readonly<{ limit(input: { key: string }): Promise<unknown> }> }>,
  ) {
    const limiter = environment?.EDITOR_HEAD_RATE_LIMITER;
    if (typeof limiter?.limit !== "function") throw new TypeError("Editor head rate limiter is unavailable.");
    this.#room = createEditorProjectRoomV1(state, {
      allowPublish: async (attachment) => {
        const result = await limiter.limit({
          key: `editor-head:${attachment.organizationId}:${attachment.subjectId}`,
        });
        if (
          typeof result !== "object" ||
          result === null ||
          typeof (result as { success?: unknown }).success !== "boolean"
        ) {
          throw new TypeError("Cloudflare rate limiter returned an invalid result.");
        }
        return (result as { success: boolean }).success;
      },
    });
  }

  fetch(request: Request) {
    return this.#room.fetch(request);
  }

  webSocketClose(socket: CloudflareRoomWebSocketV1) {
    return this.#room.webSocketClose(socket);
  }

  webSocketError(socket: CloudflareRoomWebSocketV1) {
    return this.#room.webSocketError(socket);
  }

  webSocketMessage(socket: CloudflareRoomWebSocketV1, message: unknown) {
    return this.#room.webSocketMessage(socket, message);
  }
}
