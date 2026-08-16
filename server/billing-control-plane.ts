import type { ZodType } from "zod";
import {
  type BillingCheckoutViewV1,
  type BillingPortalViewV1,
  type BillingStatusViewV1,
  billingCheckoutRequestSchemaV1,
  billingCheckoutViewSchemaV1,
  billingPortalRequestSchemaV1,
  billingPortalViewSchemaV1,
  billingStatusViewSchemaV1,
} from "../src/billing/billing-contract";
import {
  normalizeCombinedOrganizationSelectorHeaderV1,
  ORGANIZATION_SELECTOR_HEADER_V1,
} from "./accounts/organization-selector-header";
import { MAX_STRIPE_WEBHOOK_BYTES_V1 } from "./billing/stripe-webhook";
import { HttpError } from "./http/json";
import type { ProductionAdmissionRequest, ProductionRequestAdmission } from "./manim-production-server";
import { authenticateManimPrincipal, type VerifiedManimPrincipal } from "./manim-request-principal";

export const BILLING_STATUS_ROUTE_V1 = "/api/billing/status";
export const BILLING_CHECKOUT_ROUTE_V1 = "/api/billing/checkout";
export const BILLING_PORTAL_ROUTE_V1 = "/api/billing/portal";
export const STRIPE_BILLING_WEBHOOK_ROUTE_V1 = "/api/billing/stripe/webhook";

const STRIPE_SIGNATURE_HEADER_V1 = "stripe-signature";
const MAX_BILLING_MUTATION_BODY_BYTES_V1 = 1_024;
const MAX_STRIPE_SIGNATURE_BYTES_V1 = 8 * 1_024;

export type BillingControlPlaneServiceV1 = Readonly<{
  acceptWebhook(input: Readonly<{ rawBody: Uint8Array; stripeSignature: string }>, signal?: AbortSignal): Promise<void>;
  openPortal(
    input: Readonly<{ principal: VerifiedManimPrincipal }>,
    signal?: AbortSignal,
  ): Promise<BillingPortalViewV1>;
  readStatus(
    input: Readonly<{ principal: VerifiedManimPrincipal }>,
    signal?: AbortSignal,
  ): Promise<BillingStatusViewV1>;
  startCheckout(
    input: Readonly<{ planKey: string; principal: VerifiedManimPrincipal }>,
    signal?: AbortSignal,
  ): Promise<BillingCheckoutViewV1>;
}>;

export type BillingControlPlaneFetchV1 = Readonly<{
  fetch(request: Request): Promise<Response>;
}>;

class BillingRequestErrorV1 extends Error {
  readonly status: 400 | 401 | 403 | 404 | 405 | 413 | 415;

  constructor(message: string, status: BillingRequestErrorV1["status"]) {
    super(message);
    this.name = "BillingRequestErrorV1";
    this.status = status;
  }
}

function configuredOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Billing control-plane requires an exact HTTPS public origin.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError("Billing control-plane requires an exact HTTPS public origin.");
  }
  return parsed.origin;
}

function responseHeaders() {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function jsonResponse(status: number, body: unknown, allow?: string) {
  const headers = responseHeaders();
  if (allow) headers.set("allow", allow);
  return new Response(JSON.stringify(body) ?? "null", { headers, status });
}

function contentType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function contentLength(request: Request, maximumBytes: number) {
  const value = request.headers.get("content-length");
  if (value === null) return;
  if (!/^\d+$/u.test(value)) throw new BillingRequestErrorV1("Request body length is invalid.", 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BillingRequestErrorV1("Request body is too large.", 413);
  if (parsed > maximumBytes) throw new BillingRequestErrorV1("Request body is too large.", 413);
}

async function readBoundedRawBody(request: Request, maximumBytes: number) {
  contentLength(request, maximumBytes);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BillingRequestErrorV1("Request body is too large.", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function exactOrganizationHeader(request: Request) {
  const selector = normalizeCombinedOrganizationSelectorHeaderV1(request.headers.get(ORGANIZATION_SELECTOR_HEADER_V1));
  if (selector.kind === "rejected") throw new BillingRequestErrorV1(selector.message, selector.status);
  return selector.kind === "selected" ? selector.requestedOrganizationId : undefined;
}

function billingAdmissionRequest(request: Request, pathname: string): ProductionAdmissionRequest {
  const cookie = request.headers.get("cookie");
  if (cookie === null || cookie.length === 0) {
    throw new BillingRequestErrorV1("Authentication is required.", 401);
  }
  const requestedOrganizationId = exactOrganizationHeader(request);
  return {
    credentials: { cookie },
    directPeerAddress: null,
    forwardedHeaders: { immediatePeerTrusted: false, present: false },
    method: request.method,
    pathname,
    ...(requestedOrganizationId === undefined ? {} : { requestedOrganizationId }),
  };
}

function requireCheckoutMutation(request: Request, publicOrigin: string) {
  if (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") !== "same-origin") {
    throw new BillingRequestErrorV1("Checkout requires a same-origin request.", 403);
  }
  if (contentType(request) !== "application/json") {
    throw new BillingRequestErrorV1("Checkout requires an application/json request.", 415);
  }
}

function requirePortalMutation(request: Request, publicOrigin: string) {
  if (request.headers.get("origin") !== publicOrigin || request.headers.get("sec-fetch-site") !== "same-origin") {
    throw new BillingRequestErrorV1("Customer Portal requires a same-origin request.", 403);
  }
  if (contentType(request) !== "application/json") {
    throw new BillingRequestErrorV1("Customer Portal requires an application/json request.", 415);
  }
}

async function mutationBody<T>(request: Request, schema: ZodType<T>, errorMessage: string) {
  const rawBody = await readBoundedRawBody(request, MAX_BILLING_MUTATION_BODY_BYTES_V1);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    throw new BillingRequestErrorV1(errorMessage, 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BillingRequestErrorV1(errorMessage, 400);
  return parsed.data;
}

function stripeSignature(request: Request) {
  const value = request.headers.get(STRIPE_SIGNATURE_HEADER_V1);
  if (
    value === null ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > MAX_STRIPE_SIGNATURE_BYTES_V1 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BillingRequestErrorV1("Stripe webhook signature is invalid.", 400);
  }
  return value;
}

function publicFailure(error: unknown) {
  if (error instanceof BillingRequestErrorV1) return jsonResponse(error.status, { error: error.message });
  if (error instanceof HttpError) {
    if (error.status === 401) return jsonResponse(401, { error: "Authentication is required." });
    if (error.status === 403) return jsonResponse(403, { error: "Billing access is not available." });
    if (error.status === 400) return jsonResponse(400, { error: "Billing request is invalid." });
    if (error.status === 409) return jsonResponse(409, { error: "Billing state changed. Retry the request." });
    if (error.status === 429) return jsonResponse(429, { error: "Billing request capacity is temporarily exhausted." });
  }
  return jsonResponse(503, { error: "Billing is temporarily unavailable." });
}

/** Same-origin billing API boundary intended for a dedicated Cloudflare Worker. */
export function createBillingControlPlaneV1(
  admission: ProductionRequestAdmission,
  service: BillingControlPlaneServiceV1,
  publicOriginValue: string,
): BillingControlPlaneFetchV1 {
  if (typeof admission?.authenticate !== "function") {
    throw new TypeError("Billing control-plane requires request admission.");
  }
  if (
    typeof service?.readStatus !== "function" ||
    typeof service.startCheckout !== "function" ||
    typeof service.openPortal !== "function" ||
    typeof service.acceptWebhook !== "function"
  ) {
    throw new TypeError("Billing control-plane requires a complete service.");
  }
  const publicOrigin = configuredOrigin(publicOriginValue);

  return Object.freeze({
    async fetch(request: Request) {
      try {
        const url = new URL(request.url);
        if (url.origin !== publicOrigin) throw new BillingRequestErrorV1("Billing endpoint not found.", 404);
        const pathname = url.pathname;
        if (
          pathname !== BILLING_STATUS_ROUTE_V1 &&
          pathname !== BILLING_CHECKOUT_ROUTE_V1 &&
          pathname !== BILLING_PORTAL_ROUTE_V1 &&
          pathname !== STRIPE_BILLING_WEBHOOK_ROUTE_V1
        ) {
          throw new BillingRequestErrorV1("Billing endpoint not found.", 404);
        }
        if (url.search || url.hash) throw new BillingRequestErrorV1("Billing request is invalid.", 400);

        if (pathname === BILLING_STATUS_ROUTE_V1) {
          if (request.method !== "GET") {
            return jsonResponse(405, { error: "Method not allowed." }, "GET");
          }
          const principal = await authenticateManimPrincipal(
            admission,
            billingAdmissionRequest(request, pathname),
            request.signal,
          );
          const status = billingStatusViewSchemaV1.safeParse(await service.readStatus({ principal }, request.signal));
          if (!status.success) throw new TypeError("Billing service returned an invalid status view.");
          return jsonResponse(200, status.data);
        }

        if (pathname === BILLING_CHECKOUT_ROUTE_V1) {
          if (request.method !== "POST") {
            return jsonResponse(405, { error: "Method not allowed." }, "POST");
          }
          requireCheckoutMutation(request, publicOrigin);
          const body = await mutationBody(request, billingCheckoutRequestSchemaV1, "Checkout request is invalid.");
          const principal = await authenticateManimPrincipal(
            admission,
            billingAdmissionRequest(request, pathname),
            request.signal,
          );
          const checkout = billingCheckoutViewSchemaV1.safeParse(
            await service.startCheckout({ planKey: body.planKey, principal }, request.signal),
          );
          if (!checkout.success) throw new TypeError("Billing service returned an invalid Checkout URL.");
          return jsonResponse(200, checkout.data);
        }

        if (pathname === BILLING_PORTAL_ROUTE_V1) {
          if (request.method !== "POST") {
            return jsonResponse(405, { error: "Method not allowed." }, "POST");
          }
          requirePortalMutation(request, publicOrigin);
          await mutationBody(request, billingPortalRequestSchemaV1, "Customer Portal request is invalid.");
          const principal = await authenticateManimPrincipal(
            admission,
            billingAdmissionRequest(request, pathname),
            request.signal,
          );
          const portal = billingPortalViewSchemaV1.safeParse(await service.openPortal({ principal }, request.signal));
          if (!portal.success) throw new TypeError("Billing service returned an invalid Customer Portal URL.");
          return jsonResponse(200, portal.data);
        }

        if (request.method !== "POST") {
          return jsonResponse(405, { error: "Method not allowed." }, "POST");
        }
        if (contentType(request) !== "application/json") {
          throw new BillingRequestErrorV1("Stripe webhook requires an application/json request.", 415);
        }
        const signature = stripeSignature(request);
        const rawBody = await readBoundedRawBody(request, MAX_STRIPE_WEBHOOK_BYTES_V1);
        if (rawBody.byteLength === 0) throw new BillingRequestErrorV1("Stripe webhook body is invalid.", 400);
        await service.acceptWebhook({ rawBody, stripeSignature: signature }, request.signal);
        return jsonResponse(200, { accepted: true });
      } catch (error) {
        request.signal.throwIfAborted();
        return publicFailure(error);
      }
    },
  });
}
