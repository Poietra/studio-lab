import { calculatePKCECodeChallenge } from "openid-client";

import {
  ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
  OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
  type OidcLoginRepositoryV1,
} from "./oidc-login-repository";
import type { OidcIdentityProviderV1 } from "./openid-client-provider";

const OPAQUE_TOKEN_PATTERN_V1 = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_SESSION_LIFETIME_MS_V1 = 7 * 24 * 60 * 60_000;

export class OidcLoginErrorV1 extends Error {
  readonly kind: "access-denied" | "invalid-callback" | "temporarily-unavailable";

  constructor(kind: OidcLoginErrorV1["kind"], cause?: unknown) {
    super("OIDC login could not be completed.", cause === undefined ? undefined : { cause });
    this.name = "OidcLoginErrorV1";
    this.kind = kind;
  }
}

export type OidcLoginStartV1 = Readonly<{
  authorizationUrl: URL;
  browserBindingToken: string;
  browserBindingTtlSeconds: number;
}>;

export type OidcLoginCompletionV1 = Readonly<{
  sessionToken: string;
  sessionTtlSeconds: number;
}>;

export interface OidcLoginServiceV1 {
  close(): Promise<void>;
  complete(
    input: Readonly<{ browserBindingToken: string; callbackUrl: URL; state: string }>,
    signal?: AbortSignal,
  ): Promise<OidcLoginCompletionV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  start(input?: Readonly<{ invitationToken?: string }>, signal?: AbortSignal): Promise<OidcLoginStartV1>;
}

function boundedLifetime(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 60_000 || value > maximum) {
    throw new RangeError(`${label} is outside its allowed range.`);
  }
  return value;
}

function exactOpaqueToken(value: string) {
  if (!OPAQUE_TOKEN_PATTERN_V1.test(value)) throw new OidcLoginErrorV1("invalid-callback");
  const decoded = decodeBase64Url(value);
  if (decoded.byteLength !== 32 || encodeBase64Url(decoded) !== value) {
    throw new OidcLoginErrorV1("invalid-callback");
  }
  return decoded;
}

function encodeBase64Url(bytes: Uint8Array) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new OidcLoginErrorV1("invalid-callback");
  }
}

async function tokenHash(token: Uint8Array) {
  const copy = new Uint8Array(token.byteLength);
  copy.set(token);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
}

function generatedToken(generator: (size: number) => Uint8Array) {
  const bytes = generator(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new TypeError("OIDC token generator must return exactly 32 random bytes.");
  }
  return encodeBase64Url(bytes);
}

function generatedUserId(generator: () => string) {
  const value = generator();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError("OIDC user ID generator returned an invalid UUID.");
  }
  return value;
}

function invitationTokenDigest(value: string | undefined) {
  if (value === undefined) return Promise.resolve(undefined);
  return tokenHash(exactOpaqueToken(value));
}

const secureRandomBytes = (size: number) => crypto.getRandomValues(new Uint8Array(size));

function safeAuthorizationUrl(value: URL) {
  if (
    !(value instanceof URL) ||
    value.protocol !== "https:" ||
    value.origin === "null" ||
    value.username ||
    value.password ||
    value.hash
  ) {
    throw new TypeError("OIDC provider returned an unsafe authorization URL.");
  }
  return value;
}

function remainingTtlSeconds(expiresAt: Date, now: () => number, maximumMs: number) {
  const remaining = Math.floor((expiresAt.getTime() - now()) / 1_000);
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new OidcLoginErrorV1("temporarily-unavailable");
  }
  return Math.min(remaining, Math.ceil(maximumMs / 1_000));
}

/** Coordinates one-time login state without persisting raw state or session tokens. */
export function createOidcLoginServiceV1(
  options: Readonly<{
    loginAttemptLifetimeMs?: number;
    now?: () => number;
    provider: OidcIdentityProviderV1;
    randomBytes?: (size: number) => Uint8Array;
    randomUuid?: () => string;
    repository: OidcLoginRepositoryV1;
    sessionLifetimeMs?: number;
  }>,
): OidcLoginServiceV1 {
  if (
    typeof options.provider?.authorizationUrl !== "function" ||
    typeof options.provider.exchange !== "function" ||
    typeof options.repository?.createLoginAttempt !== "function" ||
    typeof options.repository.consumeLoginAttempt !== "function" ||
    typeof options.repository.issueAccountSession !== "function" ||
    typeof options.repository.issueInvitedAccountSession !== "function" ||
    typeof options.repository.ready !== "function" ||
    typeof options.repository.close !== "function"
  ) {
    throw new TypeError("OIDC login requires complete provider and repository adapters.");
  }
  const attemptLifetimeMs = boundedLifetime(
    options.loginAttemptLifetimeMs ?? OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
    OIDC_LOGIN_ATTEMPT_MAX_LIFETIME_MS_V1,
    "OIDC login-attempt lifetime",
  );
  const sessionLifetimeMs = boundedLifetime(
    options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS_V1,
    ACCOUNT_SESSION_MAX_LIFETIME_MS_V1,
    "Account-session lifetime",
  );
  const generate = options.randomBytes ?? secureRandomBytes;
  const generateUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  let closeRequest: Promise<void> | null = null;

  return Object.freeze({
    close() {
      closeRequest ??= Promise.resolve().then(() => options.repository.close());
      return closeRequest;
    },
    async complete(input, signal) {
      signal?.throwIfAborted();
      const stateBytes = exactOpaqueToken(input.state);
      const bindingBytes = exactOpaqueToken(input.browserBindingToken);
      let attempt: Awaited<ReturnType<OidcLoginRepositoryV1["consumeLoginAttempt"]>>;
      try {
        attempt = await options.repository.consumeLoginAttempt(
          { browserBindingHash: await tokenHash(bindingBytes), stateHash: await tokenHash(stateBytes) },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new OidcLoginErrorV1("temporarily-unavailable", error);
      }
      signal?.throwIfAborted();
      if (attempt === null) throw new OidcLoginErrorV1("invalid-callback");
      if (input.callbackUrl.searchParams.has("error")) throw new OidcLoginErrorV1("access-denied");

      let identity: Awaited<ReturnType<OidcIdentityProviderV1["exchange"]>>;
      try {
        identity = await options.provider.exchange({
          callbackUrl: input.callbackUrl,
          codeVerifier: attempt.codeVerifier,
          expectedNonce: attempt.nonce,
          expectedState: input.state,
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw new OidcLoginErrorV1("temporarily-unavailable", error);
      }
      signal?.throwIfAborted();

      const sessionToken = generatedToken(generate);
      let issued: Awaited<ReturnType<OidcLoginRepositoryV1["issueAccountSession"]>>;
      try {
        const sessionTokenHash = await tokenHash(decodeBase64Url(sessionToken));
        issued =
          attempt.invitationTokenDigest === null
            ? await options.repository.issueAccountSession(
                { identity, lifetimeMs: sessionLifetimeMs, sessionTokenHash },
                signal,
              )
            : typeof identity.verifiedEmail !== "string"
              ? null
              : await options.repository.issueInvitedAccountSession(
                  {
                    identity,
                    invitationTokenDigest: attempt.invitationTokenDigest,
                    lifetimeMs: sessionLifetimeMs,
                    newUserDisplayName: "New member",
                    newUserId: generatedUserId(generateUuid),
                    sessionTokenHash,
                    verifiedEmail: identity.verifiedEmail,
                  },
                  signal,
                );
      } catch (error) {
        signal?.throwIfAborted();
        throw new OidcLoginErrorV1("temporarily-unavailable", error);
      }
      signal?.throwIfAborted();
      if (issued === null) throw new OidcLoginErrorV1("access-denied");
      return Object.freeze({
        sessionToken,
        sessionTtlSeconds: remainingTtlSeconds(issued.expiresAt, now, sessionLifetimeMs),
      });
    },
    ready(signal) {
      signal?.throwIfAborted();
      return options.repository.ready(signal);
    },
    async start(input = {}, signal) {
      signal?.throwIfAborted();
      const digest = await invitationTokenDigest(input.invitationToken);
      const state = generatedToken(generate);
      const nonce = generatedToken(generate);
      const codeVerifier = generatedToken(generate);
      const browserBindingToken = generatedToken(generate);
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      signal?.throwIfAborted();
      let authorizationUrl: URL;
      try {
        authorizationUrl = safeAuthorizationUrl(
          await options.provider.authorizationUrl({ codeChallenge, nonce, state }),
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new OidcLoginErrorV1("temporarily-unavailable", error);
      }
      let created: Awaited<ReturnType<OidcLoginRepositoryV1["createLoginAttempt"]>>;
      try {
        created = await options.repository.createLoginAttempt(
          {
            browserBindingHash: await tokenHash(decodeBase64Url(browserBindingToken)),
            codeVerifier,
            ...(digest === undefined ? {} : { invitationTokenDigest: digest }),
            lifetimeMs: attemptLifetimeMs,
            nonce,
            stateHash: await tokenHash(decodeBase64Url(state)),
          },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        throw new OidcLoginErrorV1("temporarily-unavailable", error);
      }
      signal?.throwIfAborted();
      if (created === null) throw new OidcLoginErrorV1("access-denied");
      return Object.freeze({
        authorizationUrl,
        browserBindingToken,
        browserBindingTtlSeconds: remainingTtlSeconds(created.expiresAt, now, attemptLifetimeMs),
      });
    },
  } satisfies OidcLoginServiceV1);
}
