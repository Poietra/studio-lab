import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientSecretBasic,
  ClientSecretPost,
  type Configuration,
  discovery,
} from "openid-client";
import { z } from "zod";
import { OIDC_LOGIN_CALLBACK_ROUTE_V1 } from "./oidc-login-fetch";
import type { ExternalAccountIdentityV1 } from "./organization-membership-repository";

const oidcProviderConfigSchemaV1 = z
  .object({
    clientId: z.string().min(1).max(512),
    clientAuthentication: z.enum(["client_secret_post", "client_secret_basic"]).default("client_secret_post"),
    clientSecret: z.string().min(1).max(4_096),
    issuer: z.string().min(1).max(2_048),
    publicOrigin: z.string().min(1).max(2_048),
    timeoutSeconds: z.number().int().min(1).max(30).default(10),
  })
  .strict();

export type OidcProviderConfigV1 = z.input<typeof oidcProviderConfigSchemaV1>;

export type OidcAuthorizationRequestV1 = Readonly<{
  codeChallenge: string;
  nonce: string;
  state: string;
}>;

export type OidcAuthorizationResponseV1 = Readonly<{
  callbackUrl: URL;
  codeVerifier: string;
  expectedNonce: string;
  expectedState: string;
}>;

export interface OidcIdentityProviderV1 {
  authorizationUrl(input: OidcAuthorizationRequestV1): Promise<URL>;
  exchange(input: OidcAuthorizationResponseV1): Promise<ExternalAccountIdentityV1>;
}

function canonicalHttpsUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.origin === "null" || url.username || url.password || url.search || url.hash) {
    throw new TypeError(`${label} must be an HTTPS URL without credentials, query, or fragment.`);
  }
  return url;
}

function canonicalHttpsOrigin(value: string) {
  const url = canonicalHttpsUrl(value, "OIDC public origin");
  if (url.origin !== value || url.pathname !== "/") {
    throw new TypeError("OIDC public origin must contain only an HTTPS scheme and host.");
  }
  return url.origin;
}

function boundedOpaqueValue(value: string, label: string) {
  if (value.length < 32 || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function verifiedSubject(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("The OIDC provider returned an invalid subject.");
  }
  return value;
}

function verifiedIssuer(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || value.trim() !== value) {
    throw new TypeError("The OIDC provider returned an invalid issuer.");
  }
  canonicalHttpsUrl(value, "OIDC issuer claim");
  return value;
}

/** Delegates authorization-response, token, and ID-token protocol validation to openid-client. */
export function createOpenIdClientIdentityProviderV1(
  configuration: Configuration,
  redirectUriValue: string,
): OidcIdentityProviderV1 {
  if (!(configuration instanceof Object) || typeof configuration.serverMetadata !== "function") {
    throw new TypeError("OIDC configuration is invalid.");
  }
  const redirectUri = canonicalHttpsUrl(redirectUriValue, "OIDC redirect URI").href;
  canonicalHttpsUrl(configuration.serverMetadata().issuer, "OIDC issuer");
  return Object.freeze({
    async authorizationUrl(input: OidcAuthorizationRequestV1) {
      return buildAuthorizationUrl(configuration, {
        code_challenge: boundedOpaqueValue(input.codeChallenge, "OIDC PKCE challenge"),
        code_challenge_method: "S256",
        nonce: boundedOpaqueValue(input.nonce, "OIDC nonce"),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        state: boundedOpaqueValue(input.state, "OIDC state"),
      });
    },
    async exchange(input: OidcAuthorizationResponseV1) {
      if (
        input.callbackUrl.origin !== new URL(redirectUri).origin ||
        input.callbackUrl.pathname !== new URL(redirectUri).pathname
      ) {
        throw new TypeError("OIDC callback URL does not match the configured redirect URI.");
      }
      const tokens = await authorizationCodeGrant(configuration, input.callbackUrl, {
        expectedNonce: boundedOpaqueValue(input.expectedNonce, "OIDC nonce"),
        expectedState: boundedOpaqueValue(input.expectedState, "OIDC state"),
        idTokenExpected: true,
        pkceCodeVerifier: boundedOpaqueValue(input.codeVerifier, "OIDC PKCE verifier"),
      });
      const claims = tokens.claims();
      return Object.freeze({ issuer: verifiedIssuer(claims?.iss), subject: verifiedSubject(claims?.sub) });
    },
  } satisfies OidcIdentityProviderV1);
}

/** Lazily discovers a startup-configured issuer; successful metadata is cached and failures remain retryable. */
export function discoverOpenIdClientIdentityProviderV1(input: OidcProviderConfigV1): OidcIdentityProviderV1 {
  const parsed = oidcProviderConfigSchemaV1.parse(input);
  const issuer = canonicalHttpsUrl(parsed.issuer, "OIDC issuer");
  const redirectUri = new URL(OIDC_LOGIN_CALLBACK_ROUTE_V1, canonicalHttpsOrigin(parsed.publicOrigin));
  let pendingConfiguration: Promise<Configuration> | null = null;
  const configured = () => {
    pendingConfiguration ??= discovery(
      issuer,
      parsed.clientId,
      {
        client_secret: parsed.clientSecret,
        redirect_uris: [redirectUri.href],
        response_types: ["code"],
        token_endpoint_auth_method: parsed.clientAuthentication,
      },
      parsed.clientAuthentication === "client_secret_basic"
        ? ClientSecretBasic(parsed.clientSecret)
        : ClientSecretPost(parsed.clientSecret),
      { timeout: parsed.timeoutSeconds },
    ).catch((error: unknown) => {
      pendingConfiguration = null;
      throw error;
    });
    return pendingConfiguration;
  };
  return Object.freeze({
    async authorizationUrl(request) {
      return (await createOpenIdClientIdentityProviderV1(await configured(), redirectUri.href)).authorizationUrl(
        request,
      );
    },
    async exchange(response) {
      return (await createOpenIdClientIdentityProviderV1(await configured(), redirectUri.href)).exchange(response);
    },
  } satisfies OidcIdentityProviderV1);
}
