import { z } from "zod";

const billingPlanKeySchemaV1 = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

const billingRedirectUrlSchemaV1 = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  });

export const billingCheckoutRequestSchemaV1 = z
  .object({
    planKey: billingPlanKeySchemaV1,
  })
  .strict();

export const billingPortalRequestSchemaV1 = z.object({}).strict();

export const billingCheckoutViewSchemaV1 = z
  .object({
    checkoutUrl: billingRedirectUrlSchemaV1,
  })
  .strict();

export const billingPortalViewSchemaV1 = z
  .object({
    portalUrl: billingRedirectUrlSchemaV1,
  })
  .strict();

export const billingStatusViewSchemaV1 = z
  .object({
    configured: z.boolean(),
    entitlement: z
      .object({
        accessState: z.enum(["active", "grace", "blocked"]),
        accessUntil: z.iso.datetime(),
        periodEnd: z.iso.datetime(),
        periodStart: z.iso.datetime(),
        planKey: billingPlanKeySchemaV1,
        renderEnabled: z.boolean(),
        renderJobLimit: z.number().int().min(0).max(1_000_000),
        sourceGeneration: z.string().regex(/^[1-9][0-9]*$/u),
      })
      .strict()
      .nullable(),
    subscription: z
      .object({
        cancelAtPeriodEnd: z.boolean(),
        periodEnd: z.iso.datetime(),
        periodStart: z.iso.datetime(),
        planKey: billingPlanKeySchemaV1,
        status: z.enum([
          "active",
          "canceled",
          "incomplete",
          "incomplete_expired",
          "past_due",
          "paused",
          "trialing",
          "unpaid",
        ]),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type BillingCheckoutRequestV1 = Readonly<z.infer<typeof billingCheckoutRequestSchemaV1>>;
export type BillingCheckoutViewV1 = Readonly<z.infer<typeof billingCheckoutViewSchemaV1>>;
export type BillingPortalRequestV1 = Readonly<z.infer<typeof billingPortalRequestSchemaV1>>;
export type BillingPortalViewV1 = Readonly<z.infer<typeof billingPortalViewSchemaV1>>;
export type BillingStatusViewV1 = Readonly<z.infer<typeof billingStatusViewSchemaV1>>;
