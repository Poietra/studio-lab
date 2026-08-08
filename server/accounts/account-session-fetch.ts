import {
  accountOrganizationSwitchRequestSchemaV1,
  accountSessionViewSchemaV1,
} from "../../src/accounts/account-session-contract";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";
import { clearAccountSessionCookieV1 } from "./account-session-cookie";
import type {
  AccountSessionControlRepositoryV1,
  AccountSessionViewRepositoryV1,
  ResolvedAccountSessionAccountV1,
} from "./account-session-repository";

export const ACCOUNT_LOGOUT_ROUTE_V1 = "/api/account/logout";
export const ACCOUNT_SESSION_ROUTE_V1 = "/api/account/session";

const MAX_ACCOUNT_REQUEST_TARGET_BYTES_V1 = 8 * 1_024;
const MAX_ACCOUNT_PATCH_BODY_BYTES_V1 = 512;

export interface AccountSessionFetchHandlerV1 {
  fetch(request: Request): Promise<Response>;
}

export interface AccountSessionFetchRequestGuardV1 {
  reject(request: Request): Response | null;
}

export interface AccountSessionActionFetchRequestGuardV1 {
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

function jsonResponse(
  status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 503,
  body: unknown,
  allow?: string,
) {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(body), { headers, status });
}

function errorResponse(status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 503, message: string, allow?: string) {
  return jsonResponse(status, { error: message }, allow);
}

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Account session handler requires an exact HTTPS public origin.");
  }
  return url.origin;
}

function exactOriginRequest(request: Request, publicOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === publicOrigin;
}

/** Rejects malformed account bootstrap traffic before opening request-scoped storage. */
export function createAccountSessionFetchRequestGuardV1(publicOriginValue: string): AccountSessionFetchRequestGuardV1 {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_ACCOUNT_REQUEST_TARGET_BYTES_V1) {
        return errorResponse(400, "Account request is invalid.");
      }
      const url = new URL(request.url);
      if (url.origin !== publicOrigin || url.pathname !== ACCOUNT_SESSION_ROUTE_V1) {
        return errorResponse(404, "Account endpoint not found.");
      }
      if (request.method !== "GET") return errorResponse(405, "Method not allowed.", "GET");
      if (
        url.search.length > 0 ||
        request.body !== null ||
        request.headers.has("content-length") ||
        request.headers.has("transfer-encoding")
      ) {
        return errorResponse(400, "Account request is invalid.");
      }
      if (!exactOriginRequest(request, publicOrigin)) return errorResponse(403, "Account access is not available.");
      return null;
    },
  });
}

function accountView(
  account: ResolvedAccountSessionAccountV1,
  organizationSwitch: ResolvedAccountSessionAccountV1["organizationSwitch"] = account.organizationSwitch,
) {
  const activeOrganization = account.organizations.find(
    (organization) => organization.id === account.activeOrganizationId,
  );
  if (!activeOrganization) return null;
  const parsed = accountSessionViewSchemaV1.safeParse({
    activeOrganization,
    organizations: account.organizations,
    organizationSwitch,
    user: account.user,
    version: account.version,
  });
  return parsed.success ? parsed.data : null;
}

/** Fetch boundary for the browser's server-owned session bootstrap. */
export function createAccountSessionFetchHandlerV1(
  repository: AccountSessionViewRepositoryV1,
  publicOriginValue: string,
): AccountSessionFetchHandlerV1 {
  if (typeof repository?.resolveAccountSession !== "function") {
    throw new TypeError("Account session handler requires a complete session repository.");
  }
  const requestGuard = createAccountSessionFetchRequestGuardV1(publicOriginValue);
  return Object.freeze({
    async fetch(request: Request) {
      const rejected = requestGuard.reject(request);
      if (rejected) return rejected;
      const sessionTokenHash = accountSessionTokenHashV1(request.headers.get("cookie"));
      if (sessionTokenHash === null) return errorResponse(401, "Authentication is required.");

      let account: Awaited<ReturnType<AccountSessionViewRepositoryV1["resolveAccountSession"]>>;
      try {
        account = await repository.resolveAccountSession(sessionTokenHash, request.signal);
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, "Account access is temporarily unavailable.");
      }
      request.signal.throwIfAborted();
      if (account === null) return errorResponse(401, "Authentication is required.");
      if (!account.organizations.some((organization) => organization.id === account.activeOrganizationId)) {
        return errorResponse(403, "Account access is not available.");
      }
      const view = accountView(account);
      return view ? jsonResponse(200, view) : errorResponse(503, "Account access is temporarily unavailable.");
    },
  } satisfies AccountSessionFetchHandlerV1);
}

function exactMutationOrigin(request: Request, publicOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  return request.headers.get("origin") === publicOrigin && (fetchSite === undefined || fetchSite === "same-origin");
}

function contentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  return Number(value);
}

function isJsonContentType(request: Request) {
  const value = request.headers.get("content-type");
  return value !== null && value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/** Rejects malformed account mutations before request-scoped storage is opened. */
export function createAccountSessionActionFetchRequestGuardV1(
  publicOriginValue: string,
): AccountSessionActionFetchRequestGuardV1 {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_ACCOUNT_REQUEST_TARGET_BYTES_V1) {
        return errorResponse(400, "Account request is invalid.");
      }
      const url = new URL(request.url);
      if (
        url.origin !== publicOrigin ||
        (url.pathname !== ACCOUNT_SESSION_ROUTE_V1 && url.pathname !== ACCOUNT_LOGOUT_ROUTE_V1)
      ) {
        return errorResponse(404, "Account endpoint not found.");
      }
      const expectedMethod = url.pathname === ACCOUNT_SESSION_ROUTE_V1 ? "PATCH" : "POST";
      if (request.method !== expectedMethod) {
        return errorResponse(
          405,
          "Method not allowed.",
          url.pathname === ACCOUNT_SESSION_ROUTE_V1 ? "GET, PATCH" : "POST",
        );
      }
      if (url.search || !exactMutationOrigin(request, publicOrigin)) {
        return errorResponse(url.search ? 400 : 403, "Account action is not available.");
      }
      if (url.pathname === ACCOUNT_LOGOUT_ROUTE_V1) {
        const length = contentLength(request);
        if (
          request.body !== null ||
          (length !== null && length !== 0) ||
          request.headers.has("content-type") ||
          request.headers.has("transfer-encoding")
        ) {
          return errorResponse(400, "Account request is invalid.");
        }
        return null;
      }
      if (!isJsonContentType(request)) {
        return errorResponse(415, "Account request content type must be application/json.");
      }
      const length = contentLength(request);
      if (length !== null && (!Number.isSafeInteger(length) || length < 1)) {
        return errorResponse(400, "Account request is invalid.");
      }
      if (length !== null && length > MAX_ACCOUNT_PATCH_BODY_BYTES_V1) {
        return errorResponse(413, "Account request is too large.");
      }
      if (request.body === null || request.headers.has("transfer-encoding")) {
        return errorResponse(400, "Account request is invalid.");
      }
      return null;
    },
  });
}

async function readOrganizationSwitch(request: Request) {
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
      if (total > MAX_ACCOUNT_PATCH_BODY_BYTES_V1) {
        await reader.cancel();
        return { kind: "too-large" } as const;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) return { kind: "invalid" } as const;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "invalid" } as const;
  }
  const organization = accountOrganizationSwitchRequestSchemaV1.safeParse(parsed);
  return organization.success
    ? ({ kind: "valid", request: organization.data } as const)
    : ({ kind: "invalid" } as const);
}

/** Same-origin browser boundary for organization selection and current-session logout. */
export function createAccountSessionActionFetchHandlerV1(
  repository: AccountSessionControlRepositoryV1,
  publicOriginValue: string,
) {
  if (
    typeof repository?.switchActiveOrganization !== "function" ||
    typeof repository.revokeAccountSession !== "function"
  ) {
    throw new TypeError("Account action handler requires a complete session repository.");
  }
  const requestGuard = createAccountSessionActionFetchRequestGuardV1(publicOriginValue);
  return Object.freeze({
    async fetch(request: Request) {
      const rejected = requestGuard.reject(request);
      if (rejected) return rejected;
      const url = new URL(request.url);
      const sessionTokenHash = accountSessionTokenHashV1(request.headers.get("cookie"));
      if (url.pathname === ACCOUNT_LOGOUT_ROUTE_V1) {
        if (sessionTokenHash !== null) {
          try {
            await repository.revokeAccountSession(sessionTokenHash, request.signal);
          } catch {
            request.signal.throwIfAborted();
            return errorResponse(503, "Account access is temporarily unavailable.");
          }
          request.signal.throwIfAborted();
        }
        const headers = responseHeaders();
        headers.append("set-cookie", clearAccountSessionCookieV1());
        return new Response(null, { headers, status: 204 });
      }

      if (sessionTokenHash === null) return errorResponse(401, "Authentication is required.");
      const selected = await readOrganizationSwitch(request);
      if (selected.kind === "too-large") return errorResponse(413, "Account request is too large.");
      if (selected.kind !== "valid") return errorResponse(400, "Account request is invalid.");
      try {
        const result = await repository.switchActiveOrganization(
          sessionTokenHash,
          selected.request.organizationId,
          selected.request.expectedVersion,
          selected.request.mutationId,
          request.signal,
        );
        request.signal.throwIfAborted();
        if (result.kind === "invalid-session") return errorResponse(401, "Authentication is required.");
        if (result.kind === "organization-unavailable") {
          return errorResponse(403, "Account access is not available.");
        }
        if (result.kind === "conflict") {
          return errorResponse(409, "The account session changed. Refresh and try again.");
        }
        const view = accountView(result.account, result.mutation);
        return view ? jsonResponse(200, view) : errorResponse(503, "Account access is temporarily unavailable.");
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, "Account access is temporarily unavailable.");
      }
    },
  });
}
