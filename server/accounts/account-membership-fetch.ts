import { accountOrganizationMembersViewSchemaV1 } from "../../src/accounts/account-membership-contract";
import { organizationRoleAllowsV1 } from "./account-domain";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";
import type { AccountMembershipViewRepositoryV1 } from "./account-session-repository";

export const ACCOUNT_MEMBERS_ROUTE_V1 = "/api/account/members";

const MAX_ACCOUNT_MEMBERS_TARGET_BYTES_V1 = 8 * 1_024;

function responseHeaders() {
  return new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  });
}

function jsonResponse(status: 200 | 400 | 401 | 403 | 404 | 405 | 503, body: unknown, allow?: string) {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(body), { headers, status });
}

function errorResponse(status: 400 | 401 | 403 | 404 | 405 | 503, message: string, allow?: string) {
  return jsonResponse(status, { error: message }, allow);
}

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Account member handler requires an exact HTTPS public origin.");
  }
  return url.origin;
}

export function createAccountMembershipFetchRequestGuardV1(publicOriginValue: string) {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_ACCOUNT_MEMBERS_TARGET_BYTES_V1) {
        return errorResponse(400, "Account member request is invalid.");
      }
      const url = new URL(request.url);
      if (url.origin !== publicOrigin || url.pathname !== ACCOUNT_MEMBERS_ROUTE_V1) {
        return errorResponse(404, "Account member endpoint not found.");
      }
      if (request.method !== "GET") return errorResponse(405, "Method not allowed.", "GET");
      if (
        url.search ||
        url.hash ||
        request.body !== null ||
        request.headers.has("content-length") ||
        request.headers.has("transfer-encoding")
      ) {
        return errorResponse(400, "Account member request is invalid.");
      }
      const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
      const origin = request.headers.get("origin");
      if (
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") ||
        (origin !== null && origin !== publicOrigin)
      ) {
        return errorResponse(403, "Account member access is not available.");
      }
      return null;
    },
  });
}

/** Lists only active members of the organization selected by the current session. */
export function createAccountMembershipFetchHandlerV1(
  repository: AccountMembershipViewRepositoryV1,
  publicOriginValue: string,
) {
  if (typeof repository?.listActiveOrganizationMembers !== "function") {
    throw new TypeError("Account member handler requires a complete repository.");
  }
  const guard = createAccountMembershipFetchRequestGuardV1(publicOriginValue);
  return Object.freeze({
    async fetch(request: Request) {
      const rejected = guard.reject(request);
      if (rejected) return rejected;
      const sessionTokenHash = accountSessionTokenHashV1(request.headers.get("cookie"));
      if (sessionTokenHash === null) return errorResponse(401, "Authentication is required.");
      try {
        const result = await repository.listActiveOrganizationMembers(sessionTokenHash, request.signal);
        request.signal.throwIfAborted();
        if (result.kind === "invalid-session") return errorResponse(401, "Authentication is required.");
        if (result.kind === "forbidden") return errorResponse(403, "Account member access is not available.");
        if (!organizationRoleAllowsV1(result.actorRole, "membership:read")) {
          return errorResponse(403, "Account member access is not available.");
        }
        const view = accountOrganizationMembersViewSchemaV1.safeParse({ members: result.members });
        return view.success
          ? jsonResponse(200, view.data)
          : errorResponse(503, "Account member access is temporarily unavailable.");
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, "Account member access is temporarily unavailable.");
      }
    },
  });
}
