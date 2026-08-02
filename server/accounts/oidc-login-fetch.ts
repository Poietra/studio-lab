import { ACCOUNT_SESSION_COOKIE_NAME_V1 } from "./account-session-cookie";
import { OidcLoginErrorV1, type OidcLoginServiceV1 } from "./oidc-login-service";

export const OIDC_LOGIN_START_ROUTE_V1 = "/auth/oidc/start";
export const OIDC_LOGIN_CALLBACK_ROUTE_V1 = "/auth/oidc/callback";
export const OIDC_LOGIN_BINDING_COOKIE_NAME_V1 = "__Host-poietra_oidc_login";

const MAX_AUTH_REQUEST_TARGET_BYTES_V1 = 8 * 1_024;
const MAX_INVITATION_START_BODY_BYTES_V1 = 256;
const MAX_COOKIE_HEADER_BYTES_V1 = 8 * 1_024;
const MAX_COOKIES_V1 = 64;
const OPAQUE_TOKEN_PATTERN_V1 = /^[A-Za-z0-9_-]{43}$/u;

export interface OidcLoginFetchHandlerV1 {
  fetch(request: Request): Promise<Response>;
}

export interface OidcLoginFetchRequestGuardV1 {
  reject(request: Request): Response | null;
}

function baseHeaders() {
  return new Headers({
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function redirect(status: 302 | 303, location: string, cookies: readonly string[] = []) {
  const headers = baseHeaders();
  headers.set("location", location);
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { headers, status });
}

function errorResponse(status: 400 | 403 | 404 | 405 | 413 | 415 | 503, message: string, clear = false, allow = "GET") {
  const headers = baseHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  if (status === 405) headers.set("allow", allow);
  if (clear) headers.append("set-cookie", clearLoginBindingCookie());
  return new Response(JSON.stringify({ error: message }), { headers, status });
}

function cookie(name: string, value: string, maxAgeSeconds: number) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new TypeError("OIDC cookie lifetime is invalid.");
  }
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearLoginBindingCookie() {
  return `${OIDC_LOGIN_BINDING_COOKIE_NAME_V1}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function browserBindingToken(cookieHeader: string | null) {
  if (cookieHeader === null || new TextEncoder().encode(cookieHeader).byteLength > MAX_COOKIE_HEADER_BYTES_V1) {
    return null;
  }
  const cookies = cookieHeader.split(";");
  if (cookies.length > MAX_COOKIES_V1) return null;
  let token: string | null = null;
  for (const rawCookie of cookies) {
    const pair = rawCookie.trim();
    const equals = pair.indexOf("=");
    if (equals < 1) {
      if (pair === OIDC_LOGIN_BINDING_COOKIE_NAME_V1) return null;
      continue;
    }
    if (pair.slice(0, equals) !== OIDC_LOGIN_BINDING_COOKIE_NAME_V1) continue;
    const candidate = pair.slice(equals + 1);
    if (token !== null || !OPAQUE_TOKEN_PATTERN_V1.test(candidate)) return null;
    token = candidate;
  }
  return token;
}

function configuredOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("OIDC edge handler requires an exact HTTPS public origin.");
  }
  return url.origin;
}

/** Rejects traffic that cannot reach an OIDC operation without opening request-scoped storage. */
export function createOidcLoginFetchRequestGuardV1(publicOriginValue: string): OidcLoginFetchRequestGuardV1 {
  const publicOrigin = configuredOrigin(publicOriginValue);
  return Object.freeze({
    reject(request: Request) {
      if (new TextEncoder().encode(request.url).byteLength > MAX_AUTH_REQUEST_TARGET_BYTES_V1) {
        return errorResponse(400, "Invalid authentication request.");
      }
      const url = new URL(request.url);
      if (
        url.origin !== publicOrigin ||
        (url.pathname !== OIDC_LOGIN_START_ROUTE_V1 && url.pathname !== OIDC_LOGIN_CALLBACK_ROUTE_V1)
      ) {
        return errorResponse(404, "Authentication endpoint not found.");
      }
      if (url.pathname === OIDC_LOGIN_START_ROUTE_V1) {
        if (request.method !== "GET" && request.method !== "POST") {
          return errorResponse(405, "Method not allowed.", false, "GET, POST");
        }
        if (url.search || url.hash) return errorResponse(400, "Authentication request is invalid.");
        if (request.method === "POST" && !validInvitationStartRequest(request, publicOrigin)) {
          return invalidInvitationStartResponse(request);
        }
        if (request.method === "GET" && !sameOriginStart(request, publicOrigin)) {
          return errorResponse(403, "Authentication could not be started.");
        }
        return null;
      }
      if (request.method !== "GET") return errorResponse(405, "Method not allowed.");
      const state = validCallbackParameters(url);
      const binding = browserBindingToken(request.headers.get("cookie"));
      if (!state || !binding) return errorResponse(400, "Authentication callback is invalid.", true);
      return null;
    },
  });
}

function exactSingleParameter(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function validState(value: string | null) {
  return value !== null && OPAQUE_TOKEN_PATTERN_V1.test(value) ? value : null;
}

function validCallbackParameters(url: URL) {
  const state = validState(exactSingleParameter(url, "state"));
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (!state || (codes.length === 1) === (errors.length === 1)) return null;
  if (codes.length > 1 || errors.length > 1) return null;
  const responseValue = codes[0] ?? errors[0];
  if (!responseValue || responseValue.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(responseValue)) return null;
  return state;
}

function sameOriginStart(request: Request, publicOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === publicOrigin;
}

function contentLength(request: Request) {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  return Number(value);
}

type InvitationStartMediaTypeV1 = "application/json" | "application/x-www-form-urlencoded";

function invitationStartMediaType(request: Request): InvitationStartMediaTypeV1 | null {
  const value = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value === "application/json" || value === "application/x-www-form-urlencoded" ? value : null;
}

function validInvitationStartRequest(request: Request, publicOrigin: string) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  const length = contentLength(request);
  return (
    request.headers.get("origin") === publicOrigin &&
    (fetchSite === undefined || fetchSite === "same-origin") &&
    invitationStartMediaType(request) !== null &&
    request.body !== null &&
    !request.headers.has("transfer-encoding") &&
    (length === null || (Number.isSafeInteger(length) && length > 0 && length <= MAX_INVITATION_START_BODY_BYTES_V1))
  );
}

function invalidInvitationStartResponse(request: Request) {
  const length = contentLength(request);
  if (Number.isFinite(length) && (length as number) > MAX_INVITATION_START_BODY_BYTES_V1) {
    return errorResponse(413, "Authentication request is too large.");
  }
  if (invitationStartMediaType(request) === null) {
    return errorResponse(
      415,
      "Authentication request content type must be application/json or application/x-www-form-urlencoded.",
    );
  }
  if (request.headers.get("origin") === null || request.headers.get("origin") !== new URL(request.url).origin) {
    return errorResponse(403, "Authentication could not be started.");
  }
  return errorResponse(400, "Authentication request is invalid.");
}

function canonicalInvitationToken(value: unknown) {
  if (typeof value !== "string" || !OPAQUE_TOKEN_PATTERN_V1.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    return bytes.byteLength === 32 && canonical === value ? value : null;
  } catch {
    return null;
  }
}

async function readInvitationStart(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const declaredLength = contentLength(request);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_INVITATION_START_BODY_BYTES_V1) {
        await reader.cancel();
        return "too-large" as const;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && total !== declaredLength) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (invitationStartMediaType(request) === "application/x-www-form-urlencoded") {
      const parameters = new URLSearchParams(decoded);
      if ([...parameters.keys()].length !== 1 || parameters.getAll("invitationToken").length !== 1) return null;
      return canonicalInvitationToken(parameters.get("invitationToken"));
    }
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length !== 1) return null;
    return canonicalInvitationToken((parsed as { invitationToken?: unknown }).invitationToken);
  } catch {
    return null;
  }
}

/** Fetch API boundary intended for the Cloudflare account/control-plane Worker. */
export function createOidcLoginFetchHandlerV1(
  service: OidcLoginServiceV1,
  publicOriginValue: string,
): OidcLoginFetchHandlerV1 {
  if (typeof service?.start !== "function" || typeof service.complete !== "function") {
    throw new TypeError("OIDC edge handler requires a complete login service.");
  }
  const publicOrigin = configuredOrigin(publicOriginValue);
  const requestGuard = createOidcLoginFetchRequestGuardV1(publicOrigin);
  return Object.freeze({
    async fetch(request) {
      const rejected = requestGuard.reject(request);
      if (rejected) return rejected;
      const url = new URL(request.url);

      if (url.pathname === OIDC_LOGIN_START_ROUTE_V1) {
        if (url.search || url.hash) return errorResponse(400, "Authentication request is invalid.");
        if (!sameOriginStart(request, publicOrigin)) {
          return errorResponse(403, "Authentication could not be started.");
        }
        try {
          const invitationToken = request.method === "POST" ? await readInvitationStart(request) : undefined;
          if (invitationToken === "too-large") return errorResponse(413, "Authentication request is too large.");
          if (request.method === "POST" && invitationToken === null) {
            return errorResponse(400, "Authentication request is invalid.");
          }
          const started = await service.start(
            typeof invitationToken === "string" ? { invitationToken } : {},
            request.signal,
          );
          request.signal.throwIfAborted();
          return redirect(request.method === "POST" ? 303 : 302, started.authorizationUrl.href, [
            cookie(OIDC_LOGIN_BINDING_COOKIE_NAME_V1, started.browserBindingToken, started.browserBindingTtlSeconds),
          ]);
        } catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof OidcLoginErrorV1 && error.kind === "access-denied") {
            return errorResponse(403, "Account access is not available.");
          }
          return errorResponse(503, "Authentication is temporarily unavailable.");
        }
      }

      const state = validCallbackParameters(url);
      const binding = browserBindingToken(request.headers.get("cookie"));
      if (!state || !binding) return errorResponse(400, "Authentication callback is invalid.", true);
      try {
        const completed = await service.complete(
          { browserBindingToken: binding, callbackUrl: url, state },
          request.signal,
        );
        request.signal.throwIfAborted();
        return redirect(303, "/", [
          cookie(ACCOUNT_SESSION_COOKIE_NAME_V1, completed.sessionToken, completed.sessionTtlSeconds),
          clearLoginBindingCookie(),
        ]);
      } catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof OidcLoginErrorV1 && error.kind === "access-denied") {
          return errorResponse(403, "Account access is not available.", true);
        }
        if (error instanceof OidcLoginErrorV1 && error.kind === "invalid-callback") {
          return errorResponse(400, "Authentication callback is invalid.", true);
        }
        return errorResponse(503, "Authentication is temporarily unavailable.", true);
      }
    },
  } satisfies OidcLoginFetchHandlerV1);
}
