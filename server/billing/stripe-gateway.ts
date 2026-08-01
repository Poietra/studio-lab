import { z } from "zod";

import { organizationIdSchemaV1 } from "../accounts/account-domain";
import {
  parseStripeCheckoutPlanDefinitionV1,
  parseStripePriceIdV1,
  type StripeCheckoutPlanDefinitionV1,
} from "./plan-catalog";

export const STRIPE_API_VERSION_V1 = "2026-03-25.dahlia" as const;

const stripeObjectId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,247}$`, "u"));
const checkoutAttemptIdSchemaV1 = z.uuid();
const checkoutSessionIdSchemaV1 = stripeObjectId("cs");
const customerIdSchemaV1 = stripeObjectId("cus");
const subscriptionIdSchemaV1 = stripeObjectId("sub");
const safeHttpsUrlSchemaV1 = z
  .string()
  .max(4_096)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected an absolute HTTPS URL." });
      return;
    }
    if (url.protocol !== "https:" || url.origin === "null" || url.username || url.password) {
      context.addIssue({ code: "custom", message: "Expected an absolute HTTPS URL without credentials." });
    }
  });

const createCheckoutInputSchemaV1 = z
  .object({
    attemptId: checkoutAttemptIdSchemaV1,
    cancelUrl: safeHttpsUrlSchemaV1,
    customerId: customerIdSchemaV1.nullable(),
    plan: z.custom<StripeCheckoutPlanDefinitionV1>(
      (value) => {
        try {
          parseStripeCheckoutPlanDefinitionV1(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "Checkout plan is invalid." },
    ),
    successUrl: safeHttpsUrlSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const checkoutSessionSchemaV1 = z
  .object({
    expiresAt: z.date(),
    id: checkoutSessionIdSchemaV1,
    livemode: z.boolean(),
    url: safeHttpsUrlSchemaV1,
  })
  .strict();

export const stripeSubscriptionStatusSchemaV1 = z.enum([
  "active",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

const canonicalSubscriptionSchemaV1 = z
  .object({
    cancelAtPeriodEnd: z.boolean(),
    customerId: customerIdSchemaV1,
    id: subscriptionIdSchemaV1,
    livemode: z.boolean(),
    periodEnd: z.date(),
    periodStart: z.date(),
    priceId: z.string().transform((value, context) => {
      try {
        return parseStripePriceIdV1(value);
      } catch {
        context.addIssue({ code: "custom", message: "Stripe returned an invalid price ID." });
        return z.NEVER;
      }
    }),
    status: stripeSubscriptionStatusSchemaV1,
  })
  .strict()
  .superRefine((subscription, context) => {
    if (subscription.periodEnd <= subscription.periodStart) {
      context.addIssue({ code: "custom", message: "Stripe returned an invalid subscription period." });
    }
  });

export type CreateStripeCheckoutInputV1 = Readonly<z.infer<typeof createCheckoutInputSchemaV1>>;
export type StripeCheckoutSessionV1 = Readonly<z.infer<typeof checkoutSessionSchemaV1>>;
export type StripeSubscriptionStatusV1 = z.infer<typeof stripeSubscriptionStatusSchemaV1>;
export type CanonicalStripeSubscriptionV1 = Readonly<z.infer<typeof canonicalSubscriptionSchemaV1>>;

export function parseCreateStripeCheckoutInputV1(value: unknown): CreateStripeCheckoutInputV1 {
  return createCheckoutInputSchemaV1.parse(value);
}

export function parseStripeCheckoutSessionV1(value: unknown): StripeCheckoutSessionV1 {
  return checkoutSessionSchemaV1.parse(value);
}

export function parseCanonicalStripeSubscriptionV1(value: unknown): CanonicalStripeSubscriptionV1 {
  return canonicalSubscriptionSchemaV1.parse(value);
}

/** Stable UTF-8 material for canonical-response evidence; periods use exact ISO-8601 UTC instants. */
export function canonicalStripeSubscriptionBytesV1(value: unknown): Uint8Array {
  const subscription = parseCanonicalStripeSubscriptionV1(value);
  return new TextEncoder().encode(
    JSON.stringify({
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      customerId: subscription.customerId,
      id: subscription.id,
      livemode: subscription.livemode,
      periodEnd: subscription.periodEnd.toISOString(),
      periodStart: subscription.periodStart.toISOString(),
      priceId: subscription.priceId,
      status: subscription.status,
    }),
  );
}

export function parseStripeSubscriptionIdV1(value: unknown): string {
  return subscriptionIdSchemaV1.parse(value);
}

export interface StripeBillingGatewayV1 {
  createCheckoutSession(input: CreateStripeCheckoutInputV1, signal?: AbortSignal): Promise<StripeCheckoutSessionV1>;
  retrieveSubscription(subscriptionId: string, signal?: AbortSignal): Promise<CanonicalStripeSubscriptionV1>;
}

export class StripeGatewayErrorV1 extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, options: Readonly<{ retryable: boolean; status?: number | null }>) {
    super(message);
    this.name = "StripeGatewayErrorV1";
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}
