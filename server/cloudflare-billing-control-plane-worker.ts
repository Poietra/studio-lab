import { Pool } from "pg";
import { createAccountSessionIdentityAuthenticatorV1 } from "./accounts/account-session-authenticator";
import { createOrganizationMembershipProductionAdmissionV1 } from "./accounts/organization-membership-admission";
import { createStripeCheckoutPlanCatalogV1 } from "./billing/plan-catalog";
import { createStripeBillingServiceV1 } from "./billing/stripe-billing-service";
import { createStripeHttpBillingGatewayV1 } from "./billing/stripe-http-gateway";
import {
  BILLING_CHECKOUT_ROUTE_V1,
  BILLING_PORTAL_ROUTE_V1,
  BILLING_STATUS_ROUTE_V1,
  createBillingControlPlaneV1,
  STRIPE_BILLING_WEBHOOK_ROUTE_V1,
} from "./billing-control-plane";
import { PostgresAccountSessionRepositoryV1 } from "./storage/postgres/postgres-account-session-repository";
import { PostgresOrganizationMembershipRepositoryV1 } from "./storage/postgres/postgres-organization-membership-repository";
import { POSTGRES_REPOSITORY_OPTIONS_V1 } from "./storage/postgres/postgres-repository-connection";
import { PostgresStripeBillingRepositoryV1 } from "./storage/postgres/postgres-stripe-billing-repository";

export interface CloudflareBillingRateLimitBindingV1 {
  limit(input: Readonly<{ key: string }>): Promise<unknown>;
}

export interface CloudflareBillingHyperdriveBindingV1 {
  readonly connectionString: string;
}

export type CloudflareBillingControlPlaneEnvironmentV1 = Readonly<{
  BILLING_CHECKOUT_RATE_LIMITER: CloudflareBillingRateLimitBindingV1;
  BILLING_WEBHOOK_RATE_LIMITER: CloudflareBillingRateLimitBindingV1;
  HYPERDRIVE: CloudflareBillingHyperdriveBindingV1;
  POIETRA_PUBLIC_ORIGIN: string;
  POIETRA_STRIPE_EXPECTED_MODE: "live" | "test";
  POIETRA_STRIPE_PORTAL_CONFIGURATION_ID: string;
  /** Optional billing v2 grant limits; omitted vars use the documented plan-catalog defaults. */
  POIETRA_STRIPE_PRO_AI_SUGGESTION_LIMIT?: string;
  POIETRA_STRIPE_PRO_EXPORT_PUBLICATION_LIMIT?: string;
  POIETRA_STRIPE_PRO_PRICE_ID: string;
  POIETRA_STRIPE_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT?: string;
  POIETRA_STRIPE_PRO_RENDER_JOB_LIMIT: string;
  POIETRA_STRIPE_SECRET_KEY: string;
  POIETRA_STRIPE_WEBHOOK_SECRET: string;
}>;

type BillingRequestScopeV1 = Readonly<{
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}>;

type BillingRequestScopeFactoryV1 = (
  environment: CloudflareBillingControlPlaneEnvironmentV1,
) => Promise<BillingRequestScopeV1>;

export type CloudflareBillingControlPlaneWorkerOptionsV1 = Readonly<{
  createRequestScope?: BillingRequestScopeFactoryV1;
}>;

const MAX_POSTGRES_CONNECTION_STRING_BYTES_V1 = 8 * 1_024;
const MAX_STRIPE_SIGNATURE_BYTES_V1 = 8 * 1_024;
const POSTGRES_STATEMENT_TIMEOUT_MS_V1 = 5_000;
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

function jsonResponse(status: number, body: unknown, allow?: string) {
  const headers = safeHeaders();
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(body), { headers, status });
}

function unavailableResponse(status: 429 | 503) {
  const headers = safeHeaders();
  if (status === 429) headers.set("retry-after", "60");
  return new Response(JSON.stringify({ error: "Billing is temporarily unavailable." }), { headers, status });
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

function exactPublicOrigin(value: unknown) {
  const configured = boundedString(value, "Public origin", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new TypeError("Public origin is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== configured ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Public origin is invalid.");
  }
  return parsed.origin;
}

function postgresConnectionString(environment: CloudflareBillingControlPlaneEnvironmentV1) {
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

function rateLimitBinding(value: unknown, name: string): CloudflareBillingRateLimitBindingV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as CloudflareBillingRateLimitBindingV1).limit !== "function"
  ) {
    throw new TypeError(`${name} is unavailable.`);
  }
  return value as CloudflareBillingRateLimitBindingV1;
}

function configuredEnvironment(environment: CloudflareBillingControlPlaneEnvironmentV1) {
  const publicOrigin = exactPublicOrigin(environment.POIETRA_PUBLIC_ORIGIN);
  const expectedMode = environment.POIETRA_STRIPE_EXPECTED_MODE;
  if (expectedMode !== "live" && expectedMode !== "test") throw new TypeError("Stripe mode is invalid.");
  const secretKey = boundedString(environment.POIETRA_STRIPE_SECRET_KEY, "Stripe secret key", 512);
  if (!new RegExp(`^sk_${expectedMode}_[A-Za-z0-9_]+$`, "u").test(secretKey)) {
    throw new TypeError("Stripe secret key mode is invalid.");
  }
  const renderJobLimit = Number(environment.POIETRA_STRIPE_PRO_RENDER_JOB_LIMIT);
  if (!/^\d+$/u.test(environment.POIETRA_STRIPE_PRO_RENDER_JOB_LIMIT) || !Number.isSafeInteger(renderJobLimit)) {
    throw new TypeError("Stripe Pro render limit is invalid.");
  }
  const optionalLimit = (value: string | undefined, name: string) => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed)) throw new TypeError(`${name} is invalid.`);
    return parsed;
  };
  const aiSuggestionLimit = optionalLimit(
    environment.POIETRA_STRIPE_PRO_AI_SUGGESTION_LIMIT,
    "Stripe Pro AI-suggestion limit",
  );
  const exportPublicationLimit = optionalLimit(
    environment.POIETRA_STRIPE_PRO_EXPORT_PUBLICATION_LIMIT,
    "Stripe Pro export-publication limit",
  );
  const publishedArtifactBytesLimit = optionalLimit(
    environment.POIETRA_STRIPE_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT,
    "Stripe Pro published-artifact-bytes limit",
  );
  const catalog = createStripeCheckoutPlanCatalogV1({
    pro: {
      ...(aiSuggestionLimit === undefined ? {} : { aiSuggestionLimit }),
      ...(exportPublicationLimit === undefined ? {} : { exportPublicationLimit }),
      ...(publishedArtifactBytesLimit === undefined ? {} : { publishedArtifactBytesLimit }),
      renderJobLimit,
      stripePriceId: boundedString(environment.POIETRA_STRIPE_PRO_PRICE_ID, "Stripe Pro price ID", 255),
    },
  });
  const portalConfigurationId = boundedString(
    environment.POIETRA_STRIPE_PORTAL_CONFIGURATION_ID,
    "Stripe Customer Portal configuration ID",
    255,
  );
  if (!/^bpc_[A-Za-z0-9_]{1,247}$/u.test(portalConfigurationId)) {
    throw new TypeError("Stripe Customer Portal configuration ID is invalid.");
  }
  const webhookSigningSecret = boundedString(environment.POIETRA_STRIPE_WEBHOOK_SECRET, "Stripe webhook secret", 512);
  if (!/^whsec_[A-Za-z0-9_]+$/u.test(webhookSigningSecret)) {
    throw new TypeError("Stripe webhook secret is invalid.");
  }
  return Object.freeze({
    catalog,
    checkoutLimiter: rateLimitBinding(environment.BILLING_CHECKOUT_RATE_LIMITER, "Checkout rate limiter"),
    connectionString: postgresConnectionString(environment),
    livemode: expectedMode === "live",
    portalConfigurationId,
    publicOrigin,
    secretKey,
    webhookLimiter: rateLimitBinding(environment.BILLING_WEBHOOK_RATE_LIMITER, "Webhook rate limiter"),
    webhookSigningSecret,
  });
}

function connectingIp(request: Request) {
  const value = request.headers.get("cf-connecting-ip");
  if (!value || !CONNECTING_IP_PATTERN_V1.test(value)) {
    throw new TypeError("Cloudflare connecting IP is unavailable.");
  }
  return value;
}

async function isAllowed(binding: CloudflareBillingRateLimitBindingV1, key: string) {
  const result = await binding.limit({ key });
  if (typeof result !== "object" || result === null || typeof (result as { success?: unknown }).success !== "boolean") {
    throw new TypeError("Cloudflare rate limiter returned an invalid result.");
  }
  return (result as { success: boolean }).success;
}

function rejectAtEdge(request: Request, publicOrigin: string) {
  const url = new URL(request.url);
  if (url.origin !== publicOrigin) return jsonResponse(404, { error: "Billing endpoint not found." });
  if (url.search || url.hash) return jsonResponse(400, { error: "Billing request is invalid." });
  if (url.pathname === BILLING_STATUS_ROUTE_V1) {
    return request.method === "GET" ? null : jsonResponse(405, { error: "Method not allowed." }, "GET");
  }
  if (url.pathname === BILLING_CHECKOUT_ROUTE_V1) {
    if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." }, "POST");
    if (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") !== "same-origin") {
      return jsonResponse(403, { error: "Checkout requires a same-origin request." });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse(415, { error: "Checkout requires an application/json request." });
    }
    return null;
  }
  if (url.pathname === BILLING_PORTAL_ROUTE_V1) {
    if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." }, "POST");
    if (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") !== "same-origin") {
      return jsonResponse(403, { error: "Customer Portal requires a same-origin request." });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse(415, { error: "Customer Portal requires an application/json request." });
    }
    return null;
  }
  if (url.pathname === STRIPE_BILLING_WEBHOOK_ROUTE_V1) {
    if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." }, "POST");
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse(415, { error: "Stripe webhook requires an application/json request." });
    }
    const signature = request.headers.get("stripe-signature");
    if (
      !signature ||
      new TextEncoder().encode(signature).byteLength > MAX_STRIPE_SIGNATURE_BYTES_V1 ||
      signature.trim() !== signature ||
      /[\u0000-\u001f\u007f]/u.test(signature)
    ) {
      return jsonResponse(400, { error: "Stripe webhook signature is invalid." });
    }
    return null;
  }
  return jsonResponse(404, { error: "Billing endpoint not found." });
}

async function closeAll(
  resources: readonly (Readonly<{ close?: () => Promise<void> }> | null | undefined)[],
  pool: Pool,
) {
  const closeRequests = resources.flatMap((resource) =>
    resource?.close ? [Promise.resolve().then(() => resource.close!())] : [],
  );
  const results = await Promise.allSettled(closeRequests);
  const [poolResult] = await Promise.allSettled([pool.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (poolResult?.status === "rejected") errors.push(poolResult.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Billing request-scope cleanup failed.");
}

/** Builds all database adapters per request; no Hyperdrive connection or pool is retained globally. */
export async function createCloudflareBillingRequestScopeV1(
  environment: CloudflareBillingControlPlaneEnvironmentV1,
): Promise<BillingRequestScopeV1> {
  const configured = configuredEnvironment(environment);
  const pool = new Pool({
    connectionString: configured.connectionString,
    connectionTimeoutMillis: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    max: 1,
    options: POSTGRES_REPOSITORY_OPTIONS_V1,
    query_timeout: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
  });
  let admission: ReturnType<typeof createOrganizationMembershipProductionAdmissionV1> | null = null;
  let service: ReturnType<typeof createStripeBillingServiceV1> | null = null;
  try {
    const sessions = new PostgresAccountSessionRepositoryV1({
      pool,
      statementTimeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    });
    const memberships = new PostgresOrganizationMembershipRepositoryV1({
      pool,
      statementTimeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    });
    admission = createOrganizationMembershipProductionAdmissionV1({
      identities: createAccountSessionIdentityAuthenticatorV1(sessions),
      memberships,
      permissionForRequest: (input) =>
        input.method === "GET" && input.pathname === BILLING_STATUS_ROUTE_V1 ? "billing:read" : "billing:manage",
    });
    const repository = new PostgresStripeBillingRepositoryV1({
      pool,
      statementTimeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS_V1,
    });
    service = createStripeBillingServiceV1({
      catalog: configured.catalog,
      gateway: createStripeHttpBillingGatewayV1({ secretKey: configured.secretKey }),
      livemode: configured.livemode,
      portalConfigurationId: configured.portalConfigurationId,
      publicOrigin: configured.publicOrigin,
      repository,
      webhookSigningSecret: configured.webhookSigningSecret,
    });
    if (!(await service.ready())) throw new TypeError("Stripe billing storage is not ready at migration v16.");
    const controlPlane = createBillingControlPlaneV1(admission, service, configured.publicOrigin);
    let closeRequest: Promise<void> | null = null;
    return Object.freeze({
      close() {
        closeRequest ??= closeAll([admission, service], pool);
        return closeRequest;
      },
      fetch: (request: Request) => controlPlane.fetch(request),
    });
  } catch (error) {
    await closeAll([admission, service], pool).catch(() => undefined);
    throw error;
  }
}

/** Dedicated Cloudflare Worker edge for the same-origin billing control plane. */
export function createCloudflareBillingControlPlaneWorkerV1(
  options: CloudflareBillingControlPlaneWorkerOptionsV1 = {},
) {
  const createRequestScope = options.createRequestScope ?? createCloudflareBillingRequestScopeV1;
  return Object.freeze({
    async fetch(request: Request, environment: CloudflareBillingControlPlaneEnvironmentV1) {
      let scope: BillingRequestScopeV1 | null = null;
      let response: Response;
      try {
        const configured = configuredEnvironment(environment);
        const rejected = rejectAtEdge(request, configured.publicOrigin);
        if (rejected) return rejected;

        const pathname = new URL(request.url).pathname;
        if (
          pathname === BILLING_CHECKOUT_ROUTE_V1 ||
          pathname === BILLING_PORTAL_ROUTE_V1 ||
          pathname === STRIPE_BILLING_WEBHOOK_ROUTE_V1
        ) {
          const route =
            pathname === BILLING_CHECKOUT_ROUTE_V1
              ? "checkout"
              : pathname === BILLING_PORTAL_ROUTE_V1
                ? "portal"
                : "webhook";
          const limiter =
            pathname === STRIPE_BILLING_WEBHOOK_ROUTE_V1 ? configured.webhookLimiter : configured.checkoutLimiter;
          if (!(await isAllowed(limiter, `billing:${route}:${connectingIp(request)}`))) {
            return unavailableResponse(429);
          }
        }

        scope = await createRequestScope(environment);
        response = await scope.fetch(request);
      } catch {
        response = unavailableResponse(503);
      }
      if (scope) {
        try {
          await scope.close();
        } catch {
          return unavailableResponse(503);
        }
      }
      return response;
    },
  });
}

export default createCloudflareBillingControlPlaneWorkerV1();
