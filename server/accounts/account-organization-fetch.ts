import {
  accountOrganizationBootstrapRequestSchemaV1,
  accountOrganizationBootstrapResponseSchemaV1,
} from "../../src/accounts/account-organization-contract";
import type { AccountOrganizationRepositoryV1 } from "./account-organization-repository";
import { accountSessionTokenHashV1 } from "./account-session-authenticator";

export const ACCOUNT_ORGANIZATIONS_ROUTE_V1 = "/api/account/organizations";

const MAX_TARGET_BYTES_V1 = 8 * 1_024;
const MAX_BODY_BYTES_V1 = 1_024;

function responseHeaders() {
  return new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    vary: "Cookie",
    "x-content-type-options": "nosniff",
  });
}

function jsonResponse(status: 200 | 201 | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 503, body: unknown) {
  const headers = responseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (status === 405) headers.set("allow", "POST");
  return new Response(JSON.stringify(body), { headers, status });
}

function errorResponse(status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 503, message: string) {
  return jsonResponse(status, { error: message });
}

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Account organization handler requires an exact HTTPS public origin.");
  }
  return url.origin;
}

function contentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  return Number(value);
}

export function createAccountOrganizationFetchRequestGuardV1(publicOriginValue: string) {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_TARGET_BYTES_V1) {
        return errorResponse(400, "Account organization request is invalid.");
      }
      const url = new URL(request.url);
      if (url.origin !== publicOrigin || url.pathname !== ACCOUNT_ORGANIZATIONS_ROUTE_V1) {
        return errorResponse(404, "Account organization endpoint not found.");
      }
      if (request.method !== "POST") return errorResponse(405, "Method not allowed.");
      const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
      if (
        url.search ||
        url.hash ||
        request.headers.get("origin") !== publicOrigin ||
        (fetchSite !== undefined && fetchSite !== "same-origin")
      ) {
        return errorResponse(url.search || url.hash ? 400 : 403, "Account organization action is not available.");
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return errorResponse(415, "Account organization content type must be application/json.");
      }
      const length = contentLength(request);
      if (
        request.body === null ||
        request.headers.has("transfer-encoding") ||
        (length !== null && (!Number.isSafeInteger(length) || length < 1))
      ) {
        return errorResponse(400, "Account organization request is invalid.");
      }
      if (length !== null && length > MAX_BODY_BYTES_V1) {
        return errorResponse(413, "Account organization request is too large.");
      }
      return null;
    },
  });
}

async function readRequest(request: Request) {
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
      if (total > MAX_BODY_BYTES_V1) {
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
    const parsed = accountOrganizationBootstrapRequestSchemaV1.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    return parsed.success ? ({ input: parsed.data, kind: "valid" } as const) : ({ kind: "invalid" } as const);
  } catch {
    return { kind: "invalid" } as const;
  }
}

export function createAccountOrganizationFetchHandlerV1(
  repository: AccountOrganizationRepositoryV1,
  publicOriginValue: string,
) {
  if (typeof repository?.createOrganization !== "function") {
    throw new TypeError("Account organization handler requires a complete repository.");
  }
  const guard = createAccountOrganizationFetchRequestGuardV1(publicOriginValue);
  return Object.freeze({
    async fetch(request: Request) {
      const rejected = guard.reject(request);
      if (rejected) return rejected;
      const sessionTokenHash = accountSessionTokenHashV1(request.headers.get("cookie"));
      if (sessionTokenHash === null) return errorResponse(401, "Authentication is required.");
      const parsed = await readRequest(request);
      if (parsed.kind === "too-large") return errorResponse(413, "Account organization request is too large.");
      if (parsed.kind !== "valid") return errorResponse(400, "Account organization request is invalid.");
      try {
        const result = await repository.createOrganization({ ...parsed.input, sessionTokenHash }, request.signal);
        request.signal.throwIfAborted();
        if (result.kind === "invalid-session") return errorResponse(401, "Authentication is required.");
        if (result.kind === "organization-unavailable") {
          return errorResponse(403, "Account organization action is not available.");
        }
        if (result.kind === "conflict") {
          return errorResponse(409, "The account session or organization changed. Refresh and try again.");
        }
        const body = accountOrganizationBootstrapResponseSchemaV1.parse({
          mutation: { mutationId: result.mutationId, replayed: result.replayed, version: result.version },
          organization: result.organization,
        });
        return jsonResponse(result.replayed ? 200 : 201, body);
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, "Account organization service is temporarily unavailable.");
      }
    },
  });
}
