import { Pool } from "pg";

import { EDITOR_LIVE_PROTOCOL_VERSION_V1, editorLiveIdentitySchemaV1 } from "../src/collaboration/editor-live-contract";
import { accountUserIdSchemaV1, organizationRoleAllowsV1 } from "./accounts/account-domain";
import { accountSessionTokenHashV1 } from "./accounts/account-session-authenticator";
import {
  EDITOR_LIVE_INTERNAL_HEADERS_V1,
  EDITOR_LIVE_INTERNAL_ORIGIN_V1,
  EDITOR_LIVE_INTERNAL_ROUTE_V1,
  EditorProjectRoomDurableObjectV1,
} from "./editor-project-room-durable-object";
import { MAX_EDITOR_REVISION_V1 } from "./storage/editor-document-repository";
import { PostgresAccountSessionRepositoryV1 } from "./storage/postgres/postgres-account-session-repository";
import { PostgresEditorDocumentRepositoryV1 } from "./storage/postgres/postgres-editor-document-repository";
import { PostgresOrganizationMembershipRepositoryV1 } from "./storage/postgres/postgres-organization-membership-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./storage/postgres/postgres-repository-connection";

export { EditorProjectRoomDurableObjectV1 };

export const EDITOR_LIVE_PUBLIC_ROUTE_V1 = /^\/api\/collaboration\/projects\/([^/]+)\/documents\/([^/]+)$/u;

export interface CloudflareEditorRoomStubV1 {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareEditorRoomNamespaceV1 {
  get(id: unknown): CloudflareEditorRoomStubV1;
  idFromName(name: string): unknown;
}

export interface CloudflareEditorHyperdriveBindingV1 {
  readonly connectionString: string;
}

export interface CloudflareEditorRateLimitBindingV1 {
  limit(input: Readonly<{ key: string }>): Promise<unknown>;
}

export type CloudflareEditorCollaborationEnvironmentV1 = Readonly<{
  EDITOR_CONNECT_RATE_LIMITER: CloudflareEditorRateLimitBindingV1;
  EDITOR_HEAD_RATE_LIMITER: CloudflareEditorRateLimitBindingV1;
  EDITOR_PRESENCE_RATE_LIMITER: CloudflareEditorRateLimitBindingV1;
  EDITOR_ROOMS: CloudflareEditorRoomNamespaceV1;
  HYPERDRIVE: CloudflareEditorHyperdriveBindingV1;
  POIETRA_PUBLIC_ORIGIN: string;
}>;

export type EditorCollaborationAdmissionV1 =
  | Readonly<{
      canWrite: boolean;
      kind: "authorized";
      organizationId: string;
      subjectId: string;
    }>
  | Readonly<{ kind: "denied"; status: 401 | 403 | 503 }>;

export type EditorCollaborationAuthorizeV1 = (
  request: Request,
  room: Readonly<{ documentKey: string; epoch: string; projectId: string }>,
  environment: CloudflareEditorCollaborationEnvironmentV1,
) => Promise<EditorCollaborationAdmissionV1>;

export type CloudflareEditorCollaborationWorkerOptionsV1 = Readonly<{
  authorize?: EditorCollaborationAuthorizeV1;
}>;

const MAX_POSTGRES_CONNECTION_STRING_BYTES_V1 = 8 * 1_024;
const POSTGRES_STATEMENT_TIMEOUT_MS_V1 = 5_000;
const CONNECTING_IP_PATTERN_V1 = /^[0-9A-Fa-f:.]{2,64}$/u;

function safeJsonResponse(status: number, message: string, allow?: string) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify({ error: message }), { headers, status });
}

function rateLimitedResponseV1() {
  const response = safeJsonResponse(429, "Editor live access is temporarily limited.");
  response.headers.set("retry-after", "60");
  return response;
}

function boundedStringV1(value: unknown, name: string, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function exactPublicOriginV1(value: unknown) {
  const configured = boundedStringV1(value, "Public origin", 2_048);
  const parsed = new URL(configured);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== configured ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Public origin is invalid.");
  }
  return parsed.origin;
}

function postgresConnectionStringV1(environment: CloudflareEditorCollaborationEnvironmentV1) {
  const value = boundedStringV1(
    environment.HYPERDRIVE?.connectionString,
    "Hyperdrive connection string",
    MAX_POSTGRES_CONNECTION_STRING_BYTES_V1,
  );
  const parsed = new URL(value);
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || parsed.hash) {
    throw new TypeError("Hyperdrive connection string is invalid.");
  }
  return value;
}

function roomNamespaceV1(value: unknown): CloudflareEditorRoomNamespaceV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as CloudflareEditorRoomNamespaceV1).idFromName !== "function" ||
    typeof (value as CloudflareEditorRoomNamespaceV1).get !== "function"
  ) {
    throw new TypeError("Editor room binding is unavailable.");
  }
  return value as CloudflareEditorRoomNamespaceV1;
}

function rateLimitBindingV1(value: unknown, name: string): CloudflareEditorRateLimitBindingV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as CloudflareEditorRateLimitBindingV1).limit !== "function"
  ) {
    throw new TypeError(`${name} is unavailable.`);
  }
  return value as CloudflareEditorRateLimitBindingV1;
}

function connectingIpV1(request: Request) {
  const value = request.headers.get("cf-connecting-ip");
  if (!value || !CONNECTING_IP_PATTERN_V1.test(value)) {
    throw new TypeError("Cloudflare connecting IP is unavailable.");
  }
  return value;
}

async function isAllowedV1(binding: CloudflareEditorRateLimitBindingV1, key: string) {
  const result = await binding.limit({ key });
  if (typeof result !== "object" || result === null || typeof (result as { success?: unknown }).success !== "boolean") {
    throw new TypeError("Cloudflare rate limiter returned an invalid result.");
  }
  return (result as { success: boolean }).success;
}

function parseRoomRequestV1(request: Request, publicOrigin: string) {
  const url = new URL(request.url);
  const match = EDITOR_LIVE_PUBLIC_ROUTE_V1.exec(url.pathname);
  if (url.origin !== publicOrigin || !match) return { error: safeJsonResponse(404, "Editor live endpoint not found.") };
  if (request.method !== "GET") {
    return { error: safeJsonResponse(405, "Method not allowed.", "GET") };
  }
  const entries = Array.from(url.searchParams.entries());
  if (
    entries.length !== 2 ||
    url.searchParams.getAll("epoch").length !== 1 ||
    url.searchParams.getAll("protocolVersion").length !== 1 ||
    url.searchParams.get("protocolVersion") !== String(EDITOR_LIVE_PROTOCOL_VERSION_V1)
  ) {
    return { error: safeJsonResponse(400, "Editor live request is invalid.") };
  }
  if (
    request.body !== null ||
    request.headers.has("content-length") ||
    request.headers.has("transfer-encoding") ||
    request.headers.has("sec-websocket-protocol")
  ) {
    return { error: safeJsonResponse(400, "Editor live request is invalid.") };
  }
  if (
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== publicOrigin ||
    ![null, "same-origin", "none"].includes(request.headers.get("sec-fetch-site"))
  ) {
    return { error: safeJsonResponse(403, "Editor live access is not available.") };
  }
  let projectValue: string;
  let documentValue: string;
  try {
    projectValue = decodeURIComponent(match[1]!);
    documentValue = decodeURIComponent(match[2]!);
  } catch {
    return { error: safeJsonResponse(400, "Editor live request is invalid.") };
  }
  const parsed = editorLiveIdentitySchemaV1.pick({ documentKey: true, epoch: true, projectId: true }).safeParse({
    documentKey: documentValue,
    epoch: url.searchParams.get("epoch"),
    projectId: projectValue,
  });
  return parsed.success
    ? ({ error: null, room: parsed.data } as const)
    : ({ error: safeJsonResponse(400, "Editor live request is invalid.") } as const);
}

function requestPoolV1(connectionString: string) {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    max: 1,
    options: POSTGRES_REPOSITORY_OPTIONS_V1,
    query_timeout: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
  });
}

async function authorizeWithPostgresV1(
  request: Request,
  room: Readonly<{ documentKey: string; epoch: string; projectId: string }>,
  environment: CloudflareEditorCollaborationEnvironmentV1,
): Promise<EditorCollaborationAdmissionV1> {
  const sessionHash = accountSessionTokenHashV1(request.headers.get("cookie"));
  if (!sessionHash) return { kind: "denied", status: 401 };
  let pool: Pool;
  try {
    pool = requestPoolV1(postgresConnectionStringV1(environment));
  } catch {
    return { kind: "denied", status: 503 };
  }
  const sessions = new PostgresAccountSessionRepositoryV1({ pool });
  const memberships = new PostgresOrganizationMembershipRepositoryV1({ pool });
  const documents = new PostgresEditorDocumentRepositoryV1({ pool });
  try {
    const session = await sessions.resolveActiveSession(sessionHash, request.signal);
    if (!session) return { kind: "denied", status: 401 };
    const membership = await memberships.resolveActiveMembership(
      { issuer: session.issuer, subject: session.subject },
      session.sessionOrganizationId,
      request.signal,
    );
    if (
      !membership ||
      membership.organizationId !== session.sessionOrganizationId ||
      !accountUserIdSchemaV1.safeParse(membership.userId).success ||
      !organizationRoleAllowsV1(membership.role, "manim:read")
    ) {
      return { kind: "denied", status: 403 };
    }
    const document = await documents.readEventTail(
      {
        afterRevision: MAX_EDITOR_REVISION_V1,
        documentKey: room.documentKey,
        epoch: room.epoch,
        limit: 1,
        projectId: room.projectId,
        tenantId: membership.organizationId,
      },
      request.signal,
    );
    if (
      !document ||
      document.document.tenantId !== membership.organizationId ||
      document.document.projectId !== room.projectId ||
      document.document.documentKey !== room.documentKey ||
      document.document.epoch !== room.epoch ||
      document.document.sealedAt !== null
    ) {
      return { kind: "denied", status: 403 };
    }
    return {
      canWrite: organizationRoleAllowsV1(membership.role, "manim:write"),
      kind: "authorized",
      organizationId: membership.organizationId,
      subjectId: membership.userId,
    };
  } finally {
    await pool.end();
  }
}

function internalRoomRequestV1(
  room: Readonly<{ documentKey: string; epoch: string; projectId: string }>,
  admission: Extract<EditorCollaborationAdmissionV1, { kind: "authorized" }>,
  signal: AbortSignal,
) {
  const headers = EDITOR_LIVE_INTERNAL_HEADERS_V1;
  return new Request(`${EDITOR_LIVE_INTERNAL_ORIGIN_V1}${EDITOR_LIVE_INTERNAL_ROUTE_V1}`, {
    headers: {
      [headers.canWrite]: admission.canWrite ? "1" : "0",
      [headers.documentKey]: room.documentKey,
      [headers.epoch]: room.epoch,
      [headers.organizationId]: admission.organizationId,
      [headers.projectId]: room.projectId,
      [headers.subjectId]: admission.subjectId,
      upgrade: "websocket",
    },
    signal,
  });
}

/** Same-origin authenticated edge that routes one exact document epoch to a DO room. */
export function createCloudflareEditorCollaborationWorkerV1(
  options: CloudflareEditorCollaborationWorkerOptionsV1 = {},
) {
  const authorize = options.authorize ?? authorizeWithPostgresV1;
  return Object.freeze({
    async fetch(request: Request, environment: CloudflareEditorCollaborationEnvironmentV1) {
      let publicOrigin: string;
      let rooms: CloudflareEditorRoomNamespaceV1;
      let connectLimiter: CloudflareEditorRateLimitBindingV1;
      try {
        publicOrigin = exactPublicOriginV1(environment.POIETRA_PUBLIC_ORIGIN);
        rooms = roomNamespaceV1(environment.EDITOR_ROOMS);
        connectLimiter = rateLimitBindingV1(environment.EDITOR_CONNECT_RATE_LIMITER, "Editor connect rate limiter");
        rateLimitBindingV1(environment.EDITOR_HEAD_RATE_LIMITER, "Editor head rate limiter");
        rateLimitBindingV1(environment.EDITOR_PRESENCE_RATE_LIMITER, "Editor presence rate limiter");
      } catch {
        return safeJsonResponse(503, "Editor live access is temporarily unavailable.");
      }
      const parsed = parseRoomRequestV1(request, publicOrigin);
      if (parsed.error) return parsed.error;
      try {
        if (!(await isAllowedV1(connectLimiter, `editor-connect:ip:${connectingIpV1(request)}`))) {
          return rateLimitedResponseV1();
        }
      } catch {
        return safeJsonResponse(503, "Editor live access is temporarily unavailable.");
      }
      let admission: EditorCollaborationAdmissionV1;
      try {
        admission = await authorize(request, parsed.room, environment);
      } catch {
        request.signal.throwIfAborted();
        return safeJsonResponse(503, "Editor live access is temporarily unavailable.");
      }
      if (admission.kind === "denied") {
        return safeJsonResponse(
          admission.status,
          admission.status === 401
            ? "Authentication is required."
            : admission.status === 403
              ? "Editor live access is not available."
              : "Editor live access is temporarily unavailable.",
        );
      }
      const identity = editorLiveIdentitySchemaV1.safeParse({
        ...parsed.room,
        organizationId: admission.organizationId,
      });
      if (!identity.success || !accountUserIdSchemaV1.safeParse(admission.subjectId).success) {
        return safeJsonResponse(503, "Editor live access is temporarily unavailable.");
      }
      try {
        if (
          !(await isAllowedV1(
            connectLimiter,
            `editor-connect:subject:${identity.data.organizationId}:${admission.subjectId}`,
          ))
        ) {
          return rateLimitedResponseV1();
        }
        const roomName = [
          identity.data.organizationId,
          identity.data.projectId,
          identity.data.documentKey,
          identity.data.epoch,
        ].join("\0");
        const stub = rooms.get(rooms.idFromName(roomName));
        if (typeof stub?.fetch !== "function") throw new TypeError("Editor room stub is unavailable.");
        return await stub.fetch(internalRoomRequestV1(parsed.room, admission, request.signal));
      } catch {
        request.signal.throwIfAborted();
        return safeJsonResponse(503, "Editor live access is temporarily unavailable.");
      }
    },
  });
}

export default createCloudflareEditorCollaborationWorkerV1();
