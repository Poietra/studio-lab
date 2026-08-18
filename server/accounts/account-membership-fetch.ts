import {
  accountMembershipMutationRequestSchemaV1,
  accountMembershipMutationResponseSchemaV1,
  accountOrganizationMembersViewSchemaV1,
} from "../../src/accounts/account-membership-contract";
import { organizationRoleAllowsV1 } from "./account-domain";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";
import type {
  AccountMembershipMutationRepositoryV1,
  AccountMembershipViewRepositoryV1,
} from "./account-session-repository";

export const ACCOUNT_MEMBERS_ROUTE_V1 = "/api/account/members";

const MAX_ACCOUNT_MEMBERS_TARGET_BYTES_V1 = 8 * 1_024;
const MAX_ACCOUNT_MEMBERS_BODY_BYTES_V1 = 1_024;
const MEMBER_PATH_PATTERN_V1 =
  /^\/api\/account\/members\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

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
      const memberMatch = MEMBER_PATH_PATTERN_V1.exec(url.pathname);
      if (url.origin !== publicOrigin || (url.pathname !== ACCOUNT_MEMBERS_ROUTE_V1 && memberMatch === null)) {
        return errorResponse(404, "Account member endpoint not found.");
      }
      const expectedMethod = memberMatch
        ? request.method === "PATCH" || request.method === "DELETE"
        : request.method === "GET";
      if (!expectedMethod) return errorResponse(405, "Method not allowed.", memberMatch ? "PATCH, DELETE" : "GET");
      if (url.search || url.hash || request.headers.has("transfer-encoding")) {
        return errorResponse(400, "Account member request is invalid.");
      }
      const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
      const origin = request.headers.get("origin");
      if (
        (memberMatch && (origin !== publicOrigin || (fetchSite !== undefined && fetchSite !== "same-origin"))) ||
        (!memberMatch &&
          ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") ||
            (origin !== null && origin !== publicOrigin)))
      ) {
        return errorResponse(403, "Account member access is not available.");
      }
      if (!memberMatch) {
        if (request.body !== null || request.headers.has("content-length")) {
          return errorResponse(400, "Account member request is invalid.");
        }
        return null;
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return errorResponse(415, "Account member content type must be application/json.");
      }
      const length = request.headers.get("content-length");
      if (
        request.body === null ||
        (length !== null && (!/^[1-9][0-9]*$/u.test(length) || Number(length) > MAX_ACCOUNT_MEMBERS_BODY_BYTES_V1))
      ) {
        return errorResponse(
          length !== null && Number(length) > MAX_ACCOUNT_MEMBERS_BODY_BYTES_V1 ? 413 : 400,
          "Account member request is invalid.",
        );
      }
      return null;
    },
  });
}

function memberIdFromRequest(request: Request) {
  return MEMBER_PATH_PATTERN_V1.exec(new URL(request.url).pathname)?.[1]?.toLowerCase() ?? null;
}

async function readMutationRequest(request: Request) {
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
      if (total > MAX_ACCOUNT_MEMBERS_BODY_BYTES_V1) {
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
  try {
    const parsed = accountMembershipMutationRequestSchemaV1.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success || (request.method === "PATCH") !== (parsed.data.action === "set-role")) {
      return { kind: "invalid" } as const;
    }
    return { kind: "valid", request: parsed.data } as const;
  } catch {
    return { kind: "invalid" } as const;
  }
}

/** Lists only active members of the organization selected by the current session. */
export function createAccountMembershipFetchHandlerV1(
  repository: AccountMembershipViewRepositoryV1 & AccountMembershipMutationRepositoryV1,
  publicOriginValue: string,
) {
  if (
    typeof repository?.listActiveOrganizationMembers !== "function" ||
    typeof repository?.mutateActiveOrganizationMember !== "function"
  ) {
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
        const memberId = memberIdFromRequest(request);
        if (memberId !== null) {
          const parsed = await readMutationRequest(request);
          if (parsed.kind === "too-large") return errorResponse(413, "Account member request is too large.");
          if (parsed.kind !== "valid") return errorResponse(400, "Account member request is invalid.");
          const result = await repository.mutateActiveOrganizationMember(
            sessionTokenHash,
            memberId,
            parsed.request,
            request.signal,
          );
          request.signal.throwIfAborted();
          if (result.kind === "invalid-session") return errorResponse(401, "Authentication is required.");
          if (result.kind === "forbidden") return errorResponse(403, "Account member action is not available.");
          if (result.kind === "member-unavailable") return errorResponse(404, "Account member is not available.");
          if (result.kind === "conflict")
            return errorResponse(409, "The account member changed. Refresh and try again.");
          const response = accountMembershipMutationResponseSchemaV1.safeParse({
            member: result.member,
            mutation: { mutationId: result.mutationId, replayed: result.replayed },
          });
          return response.success
            ? jsonResponse(200, response.data)
            : errorResponse(503, "Account member access is temporarily unavailable.");
        }
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
