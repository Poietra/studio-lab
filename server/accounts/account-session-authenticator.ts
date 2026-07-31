import { createHash } from "node:crypto";

import type { ProductionAdmissionRequest } from "../manim-production-server";
import { ACCOUNT_SESSION_COOKIE_NAME_V1 } from "./account-session-cookie";
import type { AccountSessionRepositoryV1 } from "./account-session-repository";
import type { ExternalAccountIdentityAuthenticatorV1 } from "./organization-membership-admission";

export { ACCOUNT_SESSION_COOKIE_NAME_V1 } from "./account-session-cookie";

const MAX_COOKIE_HEADER_BYTES_V1 = 8 * 1_024;
const MAX_COOKIES_V1 = 64;
const SESSION_TOKEN_PATTERN_V1 = /^[A-Za-z0-9_-]{43}$/u;

function sessionTokenHash(cookieHeader: string | undefined) {
  if (cookieHeader === undefined) return null;
  if (Buffer.byteLength(cookieHeader, "utf8") > MAX_COOKIE_HEADER_BYTES_V1) return null;
  const cookies = cookieHeader.split(";");
  if (cookies.length > MAX_COOKIES_V1) return null;
  let token: string | null = null;
  for (const cookie of cookies) {
    const pair = cookie.trim();
    const equals = pair.indexOf("=");
    if (equals < 1) {
      if (pair === ACCOUNT_SESSION_COOKIE_NAME_V1) return null;
      continue;
    }
    if (pair.slice(0, equals) !== ACCOUNT_SESSION_COOKIE_NAME_V1) continue;
    const candidate = pair.slice(equals + 1);
    if (token !== null || !SESSION_TOKEN_PATTERN_V1.test(candidate)) return null;
    token = candidate;
  }
  if (token === null) return null;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== token) return null;
  return createHash("sha256").update(bytes).digest();
}

/** Resolves the fixed HttpOnly browser cookie without accepting bearer-token fallbacks. */
export function createAccountSessionIdentityAuthenticatorV1(
  repository: AccountSessionRepositoryV1,
): ExternalAccountIdentityAuthenticatorV1 {
  if (
    typeof repository?.resolveActiveSession !== "function" ||
    typeof repository.ready !== "function" ||
    typeof repository.close !== "function"
  ) {
    throw new TypeError("Account session authentication requires a complete session repository.");
  }
  let closeRequest: Promise<void> | null = null;
  return Object.freeze({
    async authenticate(input: ProductionAdmissionRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      const hash = sessionTokenHash(input.credentials.cookie);
      if (hash === null) return null;
      return repository.resolveActiveSession(hash, signal);
    },
    close() {
      closeRequest ??= Promise.resolve().then(() => repository.close());
      return closeRequest;
    },
    ready(signal: AbortSignal) {
      signal.throwIfAborted();
      return repository.ready(signal);
    },
  });
}
