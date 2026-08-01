import { type AccountSessionViewV1, accountSessionViewSchemaV1 } from "../../src/accounts/account-session-contract";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";
import type { AccountSessionViewRepositoryV1 } from "./account-session-repository";

export const ACCOUNT_SESSION_ROUTE_V1 = "/api/account/session";

const MAX_ACCOUNT_REQUEST_TARGET_BYTES_V1 = 8 * 1_024;

export interface AccountSessionFetchHandlerV1 {
  fetch(request: Request): Promise<Response>;
}

export interface AccountSessionFetchRequestGuardV1 {
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

function jsonResponse(status: 200 | 400 | 401 | 403 | 404 | 405 | 503, body: unknown) {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (status === 405) headers.set("allow", "GET");
  return new Response(JSON.stringify(body), { headers, status });
}

function errorResponse(status: 400 | 401 | 403 | 404 | 405 | 503, message: string) {
  return jsonResponse(status, { error: message });
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
      if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
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
      const activeOrganization = account.organizations.find(
        (organization) => organization.id === account.activeOrganizationId,
      );
      if (!activeOrganization) return errorResponse(403, "Account access is not available.");
      const parsed = accountSessionViewSchemaV1.safeParse({
        activeOrganization,
        organizations: account.organizations,
        user: account.user,
      } satisfies AccountSessionViewV1);
      if (!parsed.success) return errorResponse(503, "Account access is temporarily unavailable.");
      return jsonResponse(200, parsed.data);
    },
  } satisfies AccountSessionFetchHandlerV1);
}
