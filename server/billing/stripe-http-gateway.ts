import { z } from "zod";

import {
  type CanonicalStripeSubscriptionV1,
  type CreateStripeCheckoutInputV1,
  type CreateStripePortalSessionInputV1,
  parseCanonicalStripeSubscriptionV1,
  parseCreateStripeCheckoutInputV1,
  parseCreateStripePortalSessionInputV1,
  parseStripeCheckoutSessionV1,
  parseStripePortalSessionV1,
  parseStripeSubscriptionIdV1,
  STRIPE_API_VERSION_V1,
  type StripeBillingGatewayV1,
  StripeGatewayErrorV1,
} from "./stripe-gateway";

const STRIPE_API_ORIGIN_V1 = "https://api.stripe.com";
const DEFAULT_STRIPE_REQUEST_TIMEOUT_MS_V1 = 10_000;
const MAX_STRIPE_RESPONSE_BYTES_V1 = 512 * 1_024;

const stripeGatewayOptionsSchemaV1 = z
  .object({
    secretKey: z
      .string()
      .min(16)
      .max(512)
      .regex(/^sk_(?:live|test)_[A-Za-z0-9_]+$/u),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(DEFAULT_STRIPE_REQUEST_TIMEOUT_MS_V1),
  })
  .strict();

type FetchV1 = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type StripeHttpGatewayOptionsV1 = Readonly<{
  fetch?: FetchV1;
  secretKey: string;
  timeoutMs?: number;
}>;

const checkoutResponseSchemaV1 = z
  .object({
    expires_at: z.number().int().positive(),
    id: z.string(),
    livemode: z.boolean(),
    object: z.literal("checkout.session"),
    url: z.string().nullable(),
  })
  .passthrough();

const portalResponseSchemaV1 = z
  .object({
    configuration: z.string(),
    customer: z.string(),
    id: z.string(),
    livemode: z.boolean(),
    object: z.literal("billing_portal.session"),
    return_url: z.string(),
    url: z.string(),
  })
  .passthrough();

const subscriptionResponseSchemaV1 = z
  .object({
    cancel_at_period_end: z.boolean(),
    customer: z.string(),
    id: z.string(),
    items: z
      .object({
        data: z.array(
          z
            .object({
              current_period_end: z.number().int().positive(),
              current_period_start: z.number().int().positive(),
              price: z.object({ id: z.string() }).passthrough(),
            })
            .passthrough(),
        ),
        has_more: z.boolean(),
      })
      .passthrough(),
    livemode: z.boolean(),
    object: z.literal("subscription"),
    status: z.string(),
  })
  .passthrough();

function retryableStatus(status: number) {
  return status === 409 || status === 429 || status >= 500;
}

async function boundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_STRIPE_RESPONSE_BYTES_V1)
  ) {
    throw new StripeGatewayErrorV1("Stripe returned an invalid response.", {
      retryable: true,
      status: response.status,
    });
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_STRIPE_RESPONSE_BYTES_V1) {
    throw new StripeGatewayErrorV1("Stripe returned an invalid response.", {
      retryable: true,
      status: response.status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StripeGatewayErrorV1("Stripe returned an invalid response.", {
      retryable: true,
      status: response.status,
    });
  }
}

function requestHeaders(secretKey: string, idempotencyKey?: string) {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Basic ${btoa(`${secretKey}:`)}`,
    "stripe-version": STRIPE_API_VERSION_V1,
  });
  if (idempotencyKey) {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    headers.set("idempotency-key", idempotencyKey);
  }
  return headers;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function checkoutParameters(input: CreateStripeCheckoutInputV1) {
  const parameters = new URLSearchParams({
    cancel_url: input.cancelUrl,
    client_reference_id: input.attemptId,
    "line_items[0][price]": input.plan.stripePriceId,
    "line_items[0][quantity]": "1",
    "metadata[poietra_checkout_attempt_id]": input.attemptId,
    "metadata[poietra_tenant_id]": input.tenantId,
    mode: "subscription",
    "subscription_data[metadata][poietra_checkout_attempt_id]": input.attemptId,
    "subscription_data[metadata][poietra_tenant_id]": input.tenantId,
    success_url: input.successUrl,
    ui_mode: "hosted_page",
  });
  if (input.customerId !== null) parameters.set("customer", input.customerId);
  return parameters;
}

function portalParameters(input: CreateStripePortalSessionInputV1) {
  return new URLSearchParams({
    configuration: input.configurationId,
    customer: input.customerId,
    return_url: input.returnUrl,
  });
}

function canonicalSubscription(value: unknown): CanonicalStripeSubscriptionV1 {
  const parsed = subscriptionResponseSchemaV1.safeParse(value);
  if (!parsed.success) {
    throw new StripeGatewayErrorV1("Stripe returned an invalid subscription.", { retryable: true });
  }
  const response = parsed.data;
  if (response.items.has_more || response.items.data.length !== 1) {
    throw new StripeGatewayErrorV1("Stripe returned an unsupported subscription.", {
      retryable: false,
    });
  }
  const item = response.items.data[0];
  if (!item) {
    throw new StripeGatewayErrorV1("Stripe returned an unsupported subscription.", {
      retryable: false,
    });
  }
  try {
    return parseCanonicalStripeSubscriptionV1({
      cancelAtPeriodEnd: response.cancel_at_period_end,
      customerId: response.customer,
      id: response.id,
      livemode: response.livemode,
      periodEnd: new Date(item.current_period_end * 1_000),
      periodStart: new Date(item.current_period_start * 1_000),
      priceId: item.price.id,
      status: response.status,
    });
  } catch {
    throw new StripeGatewayErrorV1("Stripe returned an invalid subscription.", { retryable: true });
  }
}

/** Minimal Fetch/Web Crypto-friendly Stripe adapter; all authority comes from canonical GET responses. */
export function createStripeHttpBillingGatewayV1(options: StripeHttpGatewayOptionsV1): StripeBillingGatewayV1 {
  const { secretKey, timeoutMs } = stripeGatewayOptionsSchemaV1.parse({
    secretKey: options.secretKey,
    timeoutMs: options.timeoutMs,
  });
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== "function") throw new TypeError("Stripe Fetch implementation is unavailable.");

  const request = async (path: string, init: RequestInit, signal?: AbortSignal) => {
    let response: Response;
    try {
      response = await fetchRequest(`${STRIPE_API_ORIGIN_V1}${path}`, {
        ...init,
        redirect: "error",
        signal: requestSignal(signal, timeoutMs),
      });
    } catch {
      throw new StripeGatewayErrorV1("Stripe is temporarily unavailable.", { retryable: true });
    }
    const body = await boundedJsonResponse(response);
    if (!response.ok) {
      throw new StripeGatewayErrorV1("Stripe rejected the billing request.", {
        retryable: retryableStatus(response.status),
        status: response.status,
      });
    }
    return body;
  };

  return Object.freeze({
    async createCheckoutSession(inputValue: CreateStripeCheckoutInputV1, signal?: AbortSignal) {
      const input = parseCreateStripeCheckoutInputV1(inputValue);
      const body = await request(
        "/v1/checkout/sessions",
        {
          body: checkoutParameters(input),
          headers: requestHeaders(secretKey, `checkout-${input.attemptId}`),
          method: "POST",
        },
        signal,
      );
      const parsedResponse = checkoutResponseSchemaV1.safeParse(body);
      if (!parsedResponse.success) {
        throw new StripeGatewayErrorV1("Stripe returned an invalid Checkout Session.", { retryable: true });
      }
      const response = parsedResponse.data;
      if (response.url === null) {
        throw new StripeGatewayErrorV1("Stripe returned an unusable Checkout Session.", { retryable: true });
      }
      try {
        return parseStripeCheckoutSessionV1({
          expiresAt: new Date(response.expires_at * 1_000),
          id: response.id,
          livemode: response.livemode,
          url: response.url,
        });
      } catch {
        throw new StripeGatewayErrorV1("Stripe returned an invalid Checkout Session.", { retryable: true });
      }
    },
    async createPortalSession(inputValue: CreateStripePortalSessionInputV1, signal?: AbortSignal) {
      const input = parseCreateStripePortalSessionInputV1(inputValue);
      const body = await request(
        "/v1/billing_portal/sessions",
        {
          body: portalParameters(input),
          headers: requestHeaders(secretKey, `portal-${input.requestId}`),
          method: "POST",
        },
        signal,
      );
      const parsedResponse = portalResponseSchemaV1.safeParse(body);
      if (!parsedResponse.success) {
        throw new StripeGatewayErrorV1("Stripe returned an invalid Customer Portal Session.", { retryable: true });
      }
      const response = parsedResponse.data;
      try {
        const session = parseStripePortalSessionV1({
          configurationId: response.configuration,
          customerId: response.customer,
          id: response.id,
          livemode: response.livemode,
          returnUrl: response.return_url,
          url: response.url,
        });
        if (
          session.configurationId !== input.configurationId ||
          session.customerId !== input.customerId ||
          session.returnUrl !== input.returnUrl
        ) {
          throw new TypeError("Stripe Customer Portal Session does not match the request.");
        }
        return session;
      } catch {
        throw new StripeGatewayErrorV1("Stripe returned an invalid Customer Portal Session.", { retryable: true });
      }
    },
    async retrieveSubscription(subscriptionIdValue: string, signal?: AbortSignal) {
      const subscriptionId = parseStripeSubscriptionIdV1(subscriptionIdValue);
      const body = await request(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { headers: requestHeaders(secretKey), method: "GET" },
        signal,
      );
      return canonicalSubscription(body);
    },
  } satisfies StripeBillingGatewayV1);
}
