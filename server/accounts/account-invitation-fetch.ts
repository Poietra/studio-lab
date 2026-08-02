import { accountInvitationCreateResponseSchemaV1 } from "../../src/accounts/account-invitation-contract";
import { normalizeAccountEmailV1, organizationInvitationRoleSchemaV1 } from "./account-domain";
import type { AccountInvitationServiceV1 } from "./account-invitation-service";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";

export const ACCOUNT_INVITATIONS_ROUTE_V1 = "/api/account/invitations";

const MAX_ACCOUNT_INVITATION_TARGET_BYTES_V1 = 8 * 1_024;
const MAX_ACCOUNT_INVITATION_BODY_BYTES_V1 = 1_024;
const INVITATION_ID_PATH_V1 =
  /^\/api\/account\/invitations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

export interface AccountInvitationFetchRequestGuardV1 {
  reject(request: Request): Response | null;
}

function responseHeaders() {
  return new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  });
}

function jsonResponse(status: 201 | 400 | 401 | 403 | 404 | 405 | 413 | 415 | 503, body: unknown, allow?: string) {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(body), { headers, status });
}

function errorResponse(status: 400 | 401 | 403 | 404 | 405 | 413 | 415 | 503, message: string, allow?: string) {
  return jsonResponse(status, { error: message }, allow);
}

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Account invitation handler requires an exact HTTPS public origin.");
  }
  return url.origin;
}

function contentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  return Number(value);
}

function exactMutationOrigin(request: Request, publicOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return request.headers.get("origin") === publicOrigin && (fetchSite === undefined || fetchSite === "same-origin");
}

function invitationId(pathname: string) {
  return pathname.match(INVITATION_ID_PATH_V1)?.[1] ?? null;
}

/** Rejects malformed invitation mutations before request-scoped PostgreSQL is opened. */
export function createAccountInvitationFetchRequestGuardV1(
  publicOriginValue: string,
): AccountInvitationFetchRequestGuardV1 {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_ACCOUNT_INVITATION_TARGET_BYTES_V1) {
        return errorResponse(400, "Account invitation request is invalid.");
      }
      const url = new URL(request.url);
      const isCreate = url.pathname === ACCOUNT_INVITATIONS_ROUTE_V1;
      const isRevoke = invitationId(url.pathname) !== null;
      if (url.origin !== publicOrigin || (!isCreate && !isRevoke)) {
        return errorResponse(404, "Account invitation endpoint not found.");
      }
      const expectedMethod = isCreate ? "POST" : "DELETE";
      if (request.method !== expectedMethod) return errorResponse(405, "Method not allowed.", expectedMethod);
      if (url.search || url.hash) return errorResponse(400, "Account invitation request is invalid.");
      if (!exactMutationOrigin(request, publicOrigin)) {
        return errorResponse(403, "Account invitation action is not available.");
      }
      const length = contentLength(request);
      if (isRevoke) {
        if (
          request.body !== null ||
          (length !== null && length !== 0) ||
          request.headers.has("content-type") ||
          request.headers.has("transfer-encoding")
        ) {
          return errorResponse(400, "Account invitation request is invalid.");
        }
        return null;
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return errorResponse(415, "Account invitation content type must be application/json.");
      }
      if (
        request.body === null ||
        request.headers.has("transfer-encoding") ||
        (length !== null && (!Number.isSafeInteger(length) || length < 1))
      ) {
        return errorResponse(400, "Account invitation request is invalid.");
      }
      if (length !== null && length > MAX_ACCOUNT_INVITATION_BODY_BYTES_V1) {
        return errorResponse(413, "Account invitation request is too large.");
      }
      return null;
    },
  });
}

async function readCreateRequest(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return { kind: "invalid" } as const;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_ACCOUNT_INVITATION_BODY_BYTES_V1) {
        await reader.cancel();
        return { kind: "too-large" } as const;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return { kind: "invalid" } as const;
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== "email,lifetimeSeconds,role" && keys.join(",") !== "email,role") {
      return { kind: "invalid" } as const;
    }
    const value = parsed as { email?: unknown; lifetimeSeconds?: unknown; role?: unknown };
    const role = organizationInvitationRoleSchemaV1.safeParse(value.role);
    const lifetimeSeconds = value.lifetimeSeconds;
    if (
      !role.success ||
      typeof value.email !== "string" ||
      (lifetimeSeconds !== undefined &&
        (typeof lifetimeSeconds !== "number" ||
          !Number.isSafeInteger(lifetimeSeconds) ||
          lifetimeSeconds < 300 ||
          lifetimeSeconds > 604_800))
    ) {
      return { kind: "invalid" } as const;
    }
    let email: string;
    try {
      email = normalizeAccountEmailV1(value.email);
    } catch {
      return { kind: "invalid" } as const;
    }
    return {
      input: {
        email,
        ...(lifetimeSeconds === undefined ? {} : { lifetimeMs: lifetimeSeconds * 1_000 }),
        role: role.data,
      },
      kind: "valid",
    } as const;
  } catch {
    return { kind: "invalid" } as const;
  }
}

export function createAccountInvitationFetchHandlerV1(service: AccountInvitationServiceV1, publicOriginValue: string) {
  if (typeof service?.create !== "function" || typeof service.revoke !== "function") {
    throw new TypeError("Account invitation handler requires a complete service.");
  }
  const guard = createAccountInvitationFetchRequestGuardV1(publicOriginValue);
  return Object.freeze({
    async fetch(request: Request) {
      const rejected = guard.reject(request);
      if (rejected) return rejected;
      const sessionTokenHash = accountSessionTokenHashV1(request.headers.get("cookie"));
      if (sessionTokenHash === null) return errorResponse(401, "Authentication is required.");
      const url = new URL(request.url);
      if (url.pathname === ACCOUNT_INVITATIONS_ROUTE_V1) {
        const parsed = await readCreateRequest(request);
        if (parsed.kind === "too-large") return errorResponse(413, "Account invitation request is too large.");
        if (parsed.kind !== "valid") return errorResponse(400, "Account invitation request is invalid.");
        try {
          const created = await service.create({ ...parsed.input, sessionTokenHash }, request.signal);
          request.signal.throwIfAborted();
          return created
            ? jsonResponse(201, accountInvitationCreateResponseSchemaV1.parse(created))
            : errorResponse(403, "Account invitation action is not available.");
        } catch {
          request.signal.throwIfAborted();
          return errorResponse(503, "Account invitation service is temporarily unavailable.");
        }
      }
      const id = invitationId(url.pathname);
      if (!id) return errorResponse(404, "Account invitation endpoint not found.");
      try {
        const revoked = await service.revoke({ invitationId: id, sessionTokenHash }, request.signal);
        request.signal.throwIfAborted();
        if (!revoked) return errorResponse(404, "Account invitation was not found.");
        return new Response(null, { headers: responseHeaders(), status: 204 });
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, "Account invitation service is temporarily unavailable.");
      }
    },
  });
}
