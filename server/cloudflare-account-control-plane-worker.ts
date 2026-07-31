import {
  createOidcAccountControlPlaneV1,
  OIDC_LOGIN_START_ROUTE_V1,
  type OidcAccountControlPlaneOptionsV1,
  PostgresOidcLoginRepositoryV1,
} from "./account-control-plane";
import { createOidcLoginFetchRequestGuardV1 } from "./accounts/oidc-login-fetch";

export interface CloudflareRateLimitBindingV1 {
  limit(input: Readonly<{ key: string }>): Promise<unknown>;
}

export interface CloudflareHyperdriveBindingV1 {
  readonly connectionString: string;
}

export type CloudflareAccountControlPlaneEnvironmentV1 = Readonly<{
  HYPERDRIVE: CloudflareHyperdriveBindingV1;
  OIDC_CALLBACK_RATE_LIMITER: CloudflareRateLimitBindingV1;
  OIDC_START_RATE_LIMITER: CloudflareRateLimitBindingV1;
  POIETRA_OIDC_CLIENT_AUTHENTICATION?: "client_secret_basic" | "client_secret_post";
  POIETRA_OIDC_CLIENT_ID: string;
  POIETRA_OIDC_CLIENT_SECRET: string;
  POIETRA_OIDC_ISSUER: string;
  POIETRA_PUBLIC_ORIGIN: string;
}>;

interface AccountControlPlaneFetchV1 {
  fetch(request: Request, environment: CloudflareAccountControlPlaneEnvironmentV1): Promise<Response>;
}

type AccountControlPlaneFactoryV1 = (
  options: OidcAccountControlPlaneOptionsV1<CloudflareAccountControlPlaneEnvironmentV1>,
) => AccountControlPlaneFetchV1;

export type CloudflareAccountControlPlaneWorkerOptionsV1 = Readonly<{
  createControlPlane?: AccountControlPlaneFactoryV1;
}>;

const MAX_POSTGRES_CONNECTION_STRING_BYTES_V1 = 8 * 1_024;
const CONNECTING_IP_PATTERN_V1 = /^[0-9A-Fa-f:.]{2,64}$/u;

function safeHeaders() {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function unavailableResponse(status: 429 | 503) {
  const headers = safeHeaders();
  if (status === 429) headers.set("retry-after", "60");
  return new Response(JSON.stringify({ error: "Authentication is temporarily unavailable." }), { headers, status });
}

function boundedString(value: unknown, name: string, maximum: number) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function postgresConnectionString(environment: CloudflareAccountControlPlaneEnvironmentV1) {
  const value = boundedString(
    environment.HYPERDRIVE?.connectionString,
    "Hyperdrive connection string",
    MAX_POSTGRES_CONNECTION_STRING_BYTES_V1,
  );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Hyperdrive connection string is invalid.");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || parsed.hash) {
    throw new TypeError("Hyperdrive connection string is invalid.");
  }
  return value;
}

function rateLimitBinding(value: unknown, name: string): CloudflareRateLimitBindingV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as CloudflareRateLimitBindingV1).limit !== "function"
  ) {
    throw new TypeError(`${name} is unavailable.`);
  }
  return value as CloudflareRateLimitBindingV1;
}

function connectingIp(request: Request) {
  const value = request.headers.get("cf-connecting-ip");
  if (!value || !CONNECTING_IP_PATTERN_V1.test(value)) {
    throw new TypeError("Cloudflare connecting IP is unavailable.");
  }
  return value;
}

function oidcOptions(environment: CloudflareAccountControlPlaneEnvironmentV1) {
  const clientAuthentication = environment.POIETRA_OIDC_CLIENT_AUTHENTICATION;
  if (
    clientAuthentication !== undefined &&
    clientAuthentication !== "client_secret_basic" &&
    clientAuthentication !== "client_secret_post"
  ) {
    throw new TypeError("OIDC client authentication is invalid.");
  }
  return Object.freeze({
    clientAuthentication,
    clientId: boundedString(environment.POIETRA_OIDC_CLIENT_ID, "OIDC client ID", 512),
    clientSecret: boundedString(environment.POIETRA_OIDC_CLIENT_SECRET, "OIDC client secret", 4_096),
    issuer: boundedString(environment.POIETRA_OIDC_ISSUER, "OIDC issuer", 2_048),
    publicOrigin: boundedString(environment.POIETRA_PUBLIC_ORIGIN, "Public origin", 2_048),
  });
}

function configuredBindings(environment: CloudflareAccountControlPlaneEnvironmentV1) {
  const oidc = oidcOptions(environment);
  postgresConnectionString(environment);
  return Object.freeze({
    callbackLimiter: rateLimitBinding(environment.OIDC_CALLBACK_RATE_LIMITER, "OIDC callback rate limiter"),
    oidc,
    startLimiter: rateLimitBinding(environment.OIDC_START_RATE_LIMITER, "OIDC start rate limiter"),
  });
}

async function isAllowed(binding: CloudflareRateLimitBindingV1, key: string) {
  const result = await binding.limit({ key });
  if (typeof result !== "object" || result === null || typeof (result as { success?: unknown }).success !== "boolean") {
    throw new TypeError("Cloudflare rate limiter returned an invalid result.");
  }
  return (result as { success: boolean }).success;
}

/** Cloudflare Worker edge for the OIDC account control plane. */
export function createCloudflareAccountControlPlaneWorkerV1(
  options: CloudflareAccountControlPlaneWorkerOptionsV1 = {},
) {
  const createControlPlane: AccountControlPlaneFactoryV1 =
    options.createControlPlane ?? ((controlPlaneOptions) => createOidcAccountControlPlaneV1(controlPlaneOptions));
  let controlPlane: AccountControlPlaneFetchV1 | null = null;

  return Object.freeze({
    async fetch(request: Request, environment: CloudflareAccountControlPlaneEnvironmentV1) {
      try {
        const bindings = configuredBindings(environment);
        const rejected = createOidcLoginFetchRequestGuardV1(bindings.oidc.publicOrigin).reject(request);
        if (rejected) return rejected;

        const pathname = new URL(request.url).pathname;
        const limiter = pathname === OIDC_LOGIN_START_ROUTE_V1 ? bindings.startLimiter : bindings.callbackLimiter;
        const route = pathname === OIDC_LOGIN_START_ROUTE_V1 ? "start" : "callback";
        if (!(await isAllowed(limiter, `oidc:${route}:${connectingIp(request)}`))) {
          return unavailableResponse(429);
        }

        controlPlane ??= createControlPlane({
          oidc: bindings.oidc,
          repository: (requestEnvironment) =>
            new PostgresOidcLoginRepositoryV1({
              poolConfig: {
                connectionString: postgresConnectionString(requestEnvironment),
                max: 1,
              },
            }),
        });
        return await controlPlane.fetch(request, environment);
      } catch {
        return unavailableResponse(503);
      }
    },
  });
}

export default createCloudflareAccountControlPlaneWorkerV1();
