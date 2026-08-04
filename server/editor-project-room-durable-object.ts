import { z } from "zod";

import {
  EDITOR_LIVE_PROTOCOL_VERSION_V1,
  type EditorLiveIdentityV1,
  type EditorLiveParticipantV1,
  type EditorLivePresenceV1,
  editorLiveIdentityMatchesV1,
  editorLivePresenceSchemaV1,
  encodeEditorLiveServerMessageV1,
  MAX_EDITOR_LIVE_PARTICIPANTS_V1,
  parseEditorLiveClientMessageV1,
} from "../src/collaboration/editor-live-contract";
import {
  type EditorCollaborationAuthorizationGrantV1,
  type EditorCollaborationAuthorizationLeaseV1,
  editorCollaborationAuthorizationLeaseSchemaV1,
  editorCollaborationAuthorizationLeaseV1,
} from "./editor-collaboration-authorization";
import { PostgresEditorCollaborationAuthorizationRepositoryV1 } from "./storage/postgres/postgres-editor-collaboration-authorization-repository";

export const EDITOR_LIVE_INTERNAL_ROUTE_V1 = "/internal/editor-live/connect";
export const EDITOR_LIVE_INTERNAL_ORIGIN_V1 = "https://poietra-editor-room.internal";
export const EDITOR_LIVE_INTERNAL_HEADERS_V1 = Object.freeze({
  authorizationId: "x-poietra-internal-authorization-id",
  canWrite: "x-poietra-internal-can-write",
  documentKey: "x-poietra-internal-document-key",
  epoch: "x-poietra-internal-epoch",
  leaseExpiresAtMs: "x-poietra-internal-lease-expires-at-ms",
  membershipVersion: "x-poietra-internal-membership-version",
  organizationId: "x-poietra-internal-organization-id",
  projectId: "x-poietra-internal-project-id",
  sessionVersion: "x-poietra-internal-session-version",
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
  storage: Readonly<{
    deleteAlarm(): Promise<void>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }>;
}

export type CloudflareRoomWebSocketPairV1 = Readonly<{
  client: CloudflareRoomWebSocketV1;
  server: CloudflareRoomWebSocketV1;
}>;

export type EditorProjectRoomOptionsV1 = Readonly<{
  allowPublish?: (attachment: EditorRoomAttachmentV1) => Promise<boolean>;
  allowPresence?: (attachment: EditorRoomAttachmentV1) => Promise<boolean>;
  createPair?: () => CloudflareRoomWebSocketPairV1;
  createUpgradeResponse?: (client: CloudflareRoomWebSocketV1) => Response;
  now?: () => number;
  randomUuid?: () => string;
  revalidateAuthorizations?: (
    leases: readonly EditorCollaborationAuthorizationLeaseV1[],
  ) => Promise<readonly (EditorCollaborationAuthorizationGrantV1 | null)[]>;
}>;

export const MAX_EDITOR_LIVE_ROOM_CONNECTIONS_V1 = 64;

const attachmentSchemaV1 = editorCollaborationAuthorizationLeaseSchemaV1
  .safeExtend({
    connectionId: z.uuid(),
    presence: editorLivePresenceSchemaV1,
    presenceIngressOrder: z.number().int().safe().nonnegative(),
    presenceOrder: z.number().int().safe().nonnegative(),
  })
  .strict();

type EditorRoomAttachmentV1 = Readonly<z.infer<typeof attachmentSchemaV1>>;
const roomAdmissionSchemaV1 = editorCollaborationAuthorizationLeaseSchemaV1;

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
  } catch {
    // The policy close still has to run when a failed transport cannot receive
    // the bounded error message.
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

function canonicalPresenceV1(value: EditorLivePresenceV1): EditorLivePresenceV1 {
  return editorLivePresenceSchemaV1.parse({
    ...value,
    selectedEntityIds: [...value.selectedEntityIds].sort(),
  });
}

function participantV1(attachment: EditorRoomAttachmentV1): EditorLiveParticipantV1 {
  return {
    member: { id: attachment.subjectId },
    presence: attachment.presence,
  };
}

function newerRepresentativeV1(left: EditorRoomAttachmentV1, right: EditorRoomAttachmentV1) {
  if (left.presenceOrder !== right.presenceOrder) {
    return left.presenceOrder > right.presenceOrder ? left : right;
  }
  return left.connectionId > right.connectionId ? left : right;
}

function nextPresenceIngressOrderV1(sockets: readonly AttachedSocketV1[]) {
  let order = 0;
  for (const { attachment } of sockets) {
    if (attachment.presenceIngressOrder >= order) order = attachment.presenceIngressOrder + 1;
  }
  if (!Number.isSafeInteger(order)) throw new TypeError("Editor room presence order is exhausted.");
  return order;
}

type AttachedSocketV1 = Readonly<{ attachment: EditorRoomAttachmentV1; socket: CloudflareRoomWebSocketV1 }>;

function exactRoomSocketsV1(
  state: CloudflareRoomStateV1,
  identity: EditorLiveIdentityV1,
  excluded?: CloudflareRoomWebSocketV1,
  closedSockets?: WeakSet<CloudflareRoomWebSocketV1>,
) {
  const sockets: AttachedSocketV1[] = [];
  for (const socket of state.getWebSockets()) {
    if (socket === excluded || closedSockets?.has(socket)) continue;
    const candidate = attachmentV1(socket);
    if (!candidate) continue;
    if (!editorLiveIdentityMatchesV1(identity, candidate)) {
      closeInvalidV1(socket, "room-mismatch");
      continue;
    }
    sockets.push({ attachment: candidate, socket });
  }
  return sockets;
}

function admissionRoomSocketsV1(
  state: CloudflareRoomStateV1,
  incoming: EditorLiveIdentityV1,
  closedSockets?: WeakSet<CloudflareRoomWebSocketV1>,
) {
  const sockets: AttachedSocketV1[] = [];
  let roomIdentity: EditorLiveIdentityV1 | null = null;
  for (const socket of state.getWebSockets()) {
    if (closedSockets?.has(socket)) continue;
    const candidate = attachmentV1(socket);
    if (!candidate) return null;
    const candidateIdentity = identityV1(candidate);
    if (roomIdentity && !editorLiveIdentityMatchesV1(roomIdentity, candidateIdentity)) {
      for (const attached of [...sockets, { attachment: candidate, socket }]) {
        closeInvalidV1(attached.socket, "room-mismatch");
      }
      return null;
    }
    roomIdentity = candidateIdentity;
    sockets.push({ attachment: candidate, socket });
  }
  return roomIdentity && !editorLiveIdentityMatchesV1(roomIdentity, incoming) ? null : sockets;
}

function representativesV1(sockets: readonly AttachedSocketV1[]) {
  const representatives = new Map<string, EditorRoomAttachmentV1>();
  for (const { attachment } of sockets) {
    const current = representatives.get(attachment.subjectId);
    representatives.set(attachment.subjectId, current ? newerRepresentativeV1(current, attachment) : attachment);
  }
  return representatives;
}

function rosterV1(sockets: readonly AttachedSocketV1[]) {
  return [...representativesV1(sockets).values()]
    .sort((left, right) => (left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0))
    .map(participantV1);
}

function broadcastV1(sockets: readonly AttachedSocketV1[], message: string) {
  for (const peer of sockets) {
    try {
      peer.socket.send(message);
    } catch {
      peer.socket.close(1011, "transport error");
    }
  }
}

function roomUnavailableResponseV1(status: 400 | 503) {
  return new Response(JSON.stringify({ error: "Editor live room is unavailable." }), {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function exactPositiveIntegerHeaderV1(request: Request, name: string) {
  const value = request.headers.get(name);
  if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
  const canWrite = request.headers.get(headers.canWrite);
  if (canWrite !== "0" && canWrite !== "1") return null;
  const leaseExpiresAtMs = exactPositiveIntegerHeaderV1(request, headers.leaseExpiresAtMs);
  const membershipVersion = exactPositiveIntegerHeaderV1(request, headers.membershipVersion);
  const sessionVersion = exactPositiveIntegerHeaderV1(request, headers.sessionVersion);
  if (leaseExpiresAtMs === null || membershipVersion === null || sessionVersion === null) return null;
  const parsed = roomAdmissionSchemaV1.safeParse({
    authorizationId: request.headers.get(headers.authorizationId),
    canWrite: canWrite === "1",
    documentKey: request.headers.get(headers.documentKey),
    epoch: request.headers.get(headers.epoch),
    leaseExpiresAtMs,
    membershipVersion,
    organizationId: request.headers.get(headers.organizationId),
    projectId: request.headers.get(headers.projectId),
    sessionVersion,
    subjectId: request.headers.get(headers.subjectId),
  });
  return parsed.success ? parsed.data : null;
}

/** Hibernatable room: sockets carry identity; the DO stores no edit revision. */
export function createEditorProjectRoomV1(state: CloudflareRoomStateV1, options: EditorProjectRoomOptionsV1 = {}) {
  if (
    typeof state?.acceptWebSocket !== "function" ||
    typeof state.getWebSockets !== "function" ||
    typeof state.storage?.deleteAlarm !== "function" ||
    typeof state.storage.setAlarm !== "function"
  ) {
    throw new TypeError("Editor project room requires a complete Durable Object state.");
  }
  const createPair = options.createPair ?? defaultPairV1;
  const createUpgradeResponse = options.createUpgradeResponse ?? defaultUpgradeResponseV1;
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const revalidateAuthorizations =
    options.revalidateAuthorizations ??
    (async () => {
      throw new TypeError("Editor collaboration authorization revalidation is unavailable.");
    });
  const allowPublish = options.allowPublish ?? (async () => true);
  const allowPresence = options.allowPresence ?? (async () => true);
  const closedSockets = new WeakSet<CloudflareRoomWebSocketV1>();
  const socketMessageTurns = new WeakMap<CloudflareRoomWebSocketV1, Promise<void>>();
  let activeAuthorizationSweep: Promise<void> | null = null;
  // Hibernation clears this cache. The first resumed event safely reasserts
  // the persisted alarm; hot presence traffic does not rewrite it per event.
  let scheduledAlarmAt: number | null | undefined;
  const rejectSocket = (socket: CloudflareRoomWebSocketV1, code: Parameters<typeof errorMessageV1>[0]) => {
    closedSockets.add(socket);
    closeInvalidV1(socket, code);
  };

  const exactNow = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Editor room clock is invalid.");
    return value;
  };

  const leaseFromAttachment = (attachment: EditorRoomAttachmentV1) =>
    editorCollaborationAuthorizationLeaseSchemaV1.parse({
      authorizationId: attachment.authorizationId,
      canWrite: attachment.canWrite,
      documentKey: attachment.documentKey,
      epoch: attachment.epoch,
      leaseExpiresAtMs: attachment.leaseExpiresAtMs,
      membershipVersion: attachment.membershipVersion,
      organizationId: attachment.organizationId,
      projectId: attachment.projectId,
      sessionVersion: attachment.sessionVersion,
      subjectId: attachment.subjectId,
    });

  const allAttachedSockets = () => {
    const sockets: AttachedSocketV1[] = [];
    for (const socket of state.getWebSockets()) {
      if (closedSockets.has(socket)) continue;
      const candidate = attachmentV1(socket);
      if (!candidate) {
        closedSockets.add(socket);
        continue;
      }
      sockets.push({ attachment: candidate, socket });
    }
    return sockets;
  };

  const rejectAllOpenSockets = () => {
    for (const { socket } of allAttachedSockets()) rejectSocket(socket, "unavailable");
  };

  const scheduleNextAlarm = async () => {
    let earliest: number | null = null;
    for (const { attachment } of allAttachedSockets()) {
      earliest = earliest === null ? attachment.leaseExpiresAtMs : Math.min(earliest, attachment.leaseExpiresAtMs);
    }
    if (earliest === scheduledAlarmAt) return;
    if (earliest === null) await state.storage.deleteAlarm();
    else await state.storage.setAlarm(earliest);
    scheduledAlarmAt = earliest;
  };

  const correlationMatches = (attachment: EditorRoomAttachmentV1, grant: EditorCollaborationAuthorizationGrantV1) =>
    attachment.authorizationId === grant.authorizationId &&
    attachment.subjectId === grant.subjectId &&
    grant.membershipVersion >= attachment.membershipVersion &&
    // Any session mutation is a revocation fence. In particular, switching
    // away from and back to this Organization before the next lease check must
    // not silently revive the old socket.
    grant.sessionVersion === attachment.sessionVersion &&
    editorLiveIdentityMatchesV1(attachment, grant);

  const refreshExpiredAuthorizations = () => {
    if (activeAuthorizationSweep) return activeAuthorizationSweep;
    const sweep = async () => {
      const sweepNow = exactNow();
      const expired = allAttachedSockets().filter(({ attachment }) => attachment.leaseExpiresAtMs <= sweepNow);
      if (expired.length > 0) {
        try {
          const results = await revalidateAuthorizations(
            expired.map(({ attachment }) => leaseFromAttachment(attachment)),
          );
          if (!Array.isArray(results) || results.length !== expired.length) {
            throw new TypeError("Editor collaboration authorization revalidation returned an invalid batch.");
          }
          const renewedAt = exactNow();
          for (const [index, previous] of expired.entries()) {
            if (closedSockets.has(previous.socket)) continue;
            const current = attachmentV1(previous.socket);
            if (
              !current ||
              current.connectionId !== previous.attachment.connectionId ||
              current.authorizationId !== previous.attachment.authorizationId
            ) {
              rejectSocket(previous.socket, "unavailable");
              continue;
            }
            const grant = results[index];
            const lease =
              grant && correlationMatches(current, grant)
                ? editorCollaborationAuthorizationLeaseV1(grant, renewedAt)
                : null;
            if (!lease) {
              rejectSocket(previous.socket, "unavailable");
              continue;
            }
            previous.socket.serializeAttachment(attachmentSchemaV1.parse({ ...current, ...lease }));
          }
        } catch {
          for (const { socket } of expired) {
            if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
          }
        }
      }
      try {
        await scheduleNextAlarm();
      } catch (error) {
        rejectAllOpenSockets();
        throw error;
      }
    };
    activeAuthorizationSweep = sweep().finally(() => {
      activeAuthorizationSweep = null;
    });
    return activeAuthorizationSweep;
  };

  const currentAuthorization = async (socket: CloudflareRoomWebSocketV1) => {
    try {
      await refreshExpiredAuthorizations();
    } catch {
      if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
      return null;
    }
    if (closedSockets.has(socket)) return null;
    let current = attachmentV1(socket);
    if (!current) {
      closedSockets.add(socket);
      return null;
    }
    if (current.leaseExpiresAtMs <= exactNow()) {
      try {
        await refreshExpiredAuthorizations();
      } catch {
        if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
        return null;
      }
      current = closedSockets.has(socket) ? null : attachmentV1(socket);
    }
    if (!current || current.leaseExpiresAtMs <= exactNow()) {
      if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
      return null;
    }
    return current;
  };

  const freshRoomSockets = (identity: EditorLiveIdentityV1, excluded?: CloudflareRoomWebSocketV1) => {
    const checkedAt = exactNow();
    const fresh: AttachedSocketV1[] = [];
    for (const attached of exactRoomSocketsV1(state, identity, excluded, closedSockets)) {
      if (attached.attachment.leaseExpiresAtMs <= checkedAt) {
        rejectSocket(attached.socket, "unavailable");
        continue;
      }
      fresh.push(attached);
    }
    return fresh;
  };

  const runInSocketMessageOrder = async (socket: CloudflareRoomWebSocketV1, task: () => Promise<void>) => {
    const previous = socketMessageTurns.get(socket) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    socketMessageTurns.set(socket, current);
    await previous;
    try {
      if (!closedSockets.has(socket)) await task();
    } finally {
      release();
      if (socketMessageTurns.get(socket) === current) socketMessageTurns.delete(socket);
    }
  };

  const roomAttachment = (request: Request) => {
    const parsed = internalAttachmentV1(request);
    if (!parsed) return null;
    const connectionId = randomUuid();
    const finalAttachment = attachmentSchemaV1.safeParse({
      ...parsed,
      connectionId,
      presence: { cursor: null, playheadSeconds: 0, selectedEntityIds: [] },
      presenceIngressOrder: 0,
      presenceOrder: 0,
      subjectId: parsed.subjectId,
    });
    return finalAttachment.success ? finalAttachment.data : null;
  };

  return Object.freeze({
    async fetch(request: Request) {
      const initialAttachment = roomAttachment(request);
      if (!initialAttachment) return roomUnavailableResponseV1(400);
      if (initialAttachment.leaseExpiresAtMs <= exactNow()) return roomUnavailableResponseV1(503);
      const identity = identityV1(initialAttachment);
      if (!admissionRoomSocketsV1(state, identity, closedSockets)) return roomUnavailableResponseV1(503);
      try {
        await refreshExpiredAuthorizations();
      } catch {
        return roomUnavailableResponseV1(503);
      }
      const existing = admissionRoomSocketsV1(state, identity, closedSockets);
      if (!existing) {
        return roomUnavailableResponseV1(503);
      }
      const existingMembers = representativesV1(existing);
      if (
        existing.length >= MAX_EDITOR_LIVE_ROOM_CONNECTIONS_V1 ||
        (!existingMembers.has(initialAttachment.subjectId) && existingMembers.size >= MAX_EDITOR_LIVE_PARTICIPANTS_V1)
      ) {
        return roomUnavailableResponseV1(503);
      }
      const presenceIngressOrder = nextPresenceIngressOrderV1(existing);
      const attachment = attachmentSchemaV1.parse({
        ...initialAttachment,
        presenceIngressOrder,
        presenceOrder: presenceIngressOrder,
      });
      let pair: CloudflareRoomWebSocketPairV1 | null = null;
      try {
        pair = createPair();
        const response = createUpgradeResponse(pair.client);
        pair.server.serializeAttachment(attachment);
        state.acceptWebSocket(pair.server);
        await scheduleNextAlarm();
        if (attachment.leaseExpiresAtMs <= exactNow()) throw new TypeError("Editor room authorization expired.");
        pair.server.send(
          encodeEditorLiveServerMessageV1({
            connectionId: attachment.connectionId,
            identity,
            kind: "ready",
            memberId: attachment.subjectId,
            protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
          }),
        );
        const current = freshRoomSockets(identity);
        pair.server.send(
          encodeEditorLiveServerMessageV1({
            identity,
            kind: "presence-snapshot",
            participants: rosterV1(current),
            protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
          }),
        );
        broadcastV1(
          current.filter(({ socket }) => socket !== pair!.server),
          encodeEditorLiveServerMessageV1({
            identity,
            kind: "presence-update",
            participant: participantV1(representativesV1(current).get(attachment.subjectId)!),
            protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
          }),
        );
        return response;
      } catch {
        if (pair) rejectSocket(pair.server, "unavailable");
        return roomUnavailableResponseV1(503);
      }
    },

    async webSocketClose(socket: CloudflareRoomWebSocketV1) {
      closedSockets.add(socket);
      const sender = attachmentV1(socket);
      if (!sender) return;
      const identity = identityV1(sender);
      const peers = freshRoomSockets(identity, socket);
      const representative = representativesV1(peers).get(sender.subjectId);
      broadcastV1(
        peers,
        encodeEditorLiveServerMessageV1(
          representative
            ? {
                identity,
                kind: "presence-update",
                participant: participantV1(representative),
                protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
              }
            : {
                identity,
                kind: "presence-leave",
                memberId: sender.subjectId,
                protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
              },
        ),
      );
      try {
        await scheduleNextAlarm();
      } catch {
        rejectAllOpenSockets();
      }
    },

    async webSocketError(socket: CloudflareRoomWebSocketV1) {
      closedSockets.add(socket);
      socket.close(1011, "transport error");
      try {
        await scheduleNextAlarm();
      } catch {
        rejectAllOpenSockets();
      }
    },

    webSocketMessage(socket: CloudflareRoomWebSocketV1, messageValue: unknown) {
      return runInSocketMessageOrder(socket, async () => {
        const sender = await currentAuthorization(socket);
        if (!sender) return;
        const message = parseEditorLiveClientMessageV1(messageValue);
        if (!message) {
          rejectSocket(socket, "invalid-message");
          return;
        }
        if (message.kind === "presence-update") {
          try {
            // A non-storage limiter await opens the Durable Object input gate.
            // Reserve room-wide ingress synchronously first; keep it separate
            // from the accepted order so a denied update never becomes the
            // representative tab and reversed completions cannot roll back it.
            const reservedOrder = nextPresenceIngressOrderV1(freshRoomSockets(identityV1(sender)));
            const reserved = attachmentSchemaV1.parse({
              ...sender,
              presenceIngressOrder: reservedOrder,
            });
            socket.serializeAttachment(reserved);
            const allowed = await allowPresence(reserved);
            if (closedSockets.has(socket)) return;
            if (!allowed) {
              rejectSocket(socket, "rate-limited");
              return;
            }
            const current = await currentAuthorization(socket);
            if (!current || current.connectionId !== reserved.connectionId) return;
            const updated = attachmentSchemaV1.parse({
              ...current,
              presence: canonicalPresenceV1(message.presence),
              presenceOrder: reservedOrder,
            });
            socket.serializeAttachment(updated);
            const identity = identityV1(updated);
            const peers = freshRoomSockets(identity);
            const representative = representativesV1(peers).get(updated.subjectId);
            if (!representative) throw new TypeError("Editor room lost the presence publisher.");
            broadcastV1(
              peers,
              encodeEditorLiveServerMessageV1({
                identity,
                kind: "presence-update",
                participant: participantV1(representative),
                protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
              }),
            );
          } catch {
            if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
          }
          return;
        }
        if (!sender.canWrite) {
          rejectSocket(socket, "read-only");
          return;
        }
        try {
          const allowed = await allowPublish(sender);
          if (closedSockets.has(socket)) return;
          if (!allowed) {
            rejectSocket(socket, "rate-limited");
            return;
          }
        } catch {
          if (!closedSockets.has(socket)) rejectSocket(socket, "unavailable");
          return;
        }
        const current = await currentAuthorization(socket);
        if (!current) return;
        if (!current.canWrite) {
          rejectSocket(socket, "read-only");
          return;
        }
        const identity = identityV1(current);
        const outbound = encodeEditorLiveServerMessageV1({
          identity,
          kind: "head",
          protocolVersion: EDITOR_LIVE_PROTOCOL_VERSION_V1,
          publisherConnectionId: current.connectionId,
          revision: message.revision,
        });
        broadcastV1(freshRoomSockets(identity, socket), outbound);
      });
    },

    alarm() {
      // The platform consumes the alarm before invoking this handler.
      scheduledAlarmAt = undefined;
      return refreshExpiredAuthorizations();
    },
  });
}

/** Wrangler Durable Object entry. */
export class EditorProjectRoomDurableObjectV1 {
  readonly #room: ReturnType<typeof createEditorProjectRoomV1>;

  constructor(
    state: CloudflareRoomStateV1,
    environment: Readonly<{
      EDITOR_HEAD_RATE_LIMITER: Readonly<{ limit(input: { key: string }): Promise<unknown> }>;
      EDITOR_PRESENCE_RATE_LIMITER: Readonly<{ limit(input: { key: string }): Promise<unknown> }>;
      HYPERDRIVE: Readonly<{ connectionString: string }>;
    }>,
  ) {
    const headLimiter = environment?.EDITOR_HEAD_RATE_LIMITER;
    const presenceLimiter = environment?.EDITOR_PRESENCE_RATE_LIMITER;
    if (typeof headLimiter?.limit !== "function") throw new TypeError("Editor head rate limiter is unavailable.");
    if (typeof presenceLimiter?.limit !== "function") {
      throw new TypeError("Editor presence rate limiter is unavailable.");
    }
    const connectionString = environment?.HYPERDRIVE?.connectionString;
    if (typeof connectionString !== "string" || connectionString.length < 1 || connectionString.length > 8 * 1_024) {
      throw new TypeError("Editor collaboration Hyperdrive binding is unavailable.");
    }
    const parsedConnectionString = new URL(connectionString);
    if (
      (parsedConnectionString.protocol !== "postgres:" && parsedConnectionString.protocol !== "postgresql:") ||
      !parsedConnectionString.hostname ||
      parsedConnectionString.hash
    ) {
      throw new TypeError("Editor collaboration Hyperdrive binding is unavailable.");
    }
    const allow = async (limiter: typeof headLimiter, key: string) => {
      const result = await limiter.limit({ key });
      if (
        typeof result !== "object" ||
        result === null ||
        typeof (result as { success?: unknown }).success !== "boolean"
      ) {
        throw new TypeError("Cloudflare rate limiter returned an invalid result.");
      }
      return (result as { success: boolean }).success;
    };
    this.#room = createEditorProjectRoomV1(state, {
      allowPresence: (attachment) =>
        allow(
          presenceLimiter,
          `editor-presence:${attachment.organizationId}:${attachment.subjectId}:${attachment.connectionId}`,
        ),
      allowPublish: (attachment) =>
        allow(headLimiter, `editor-head:${attachment.organizationId}:${attachment.subjectId}`),
      revalidateAuthorizations: async (leases) => {
        const repository = new PostgresEditorCollaborationAuthorizationRepositoryV1({
          poolConfig: { connectionString, max: 1 },
          statementTimeoutMs: 5_000,
        });
        try {
          return await repository.revalidateAuthorizations(leases);
        } finally {
          await repository.close();
        }
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

  alarm() {
    return this.#room.alarm();
  }
}
