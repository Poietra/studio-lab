import { z } from "zod";

import { MAX_RENDER_JOB_LIMIT_V1 } from "./entitlement-repository";

export const STRIPE_CHECKOUT_PLAN_KEYS_V1 = ["pro"] as const;

const stripePriceIdSchemaV1 = z.string().regex(/^price_[A-Za-z0-9_]{1,247}$/u);
const planDefinitionSchemaV1 = z
  .object({
    planKey: z.literal("pro"),
    renderJobLimit: z.number().int().min(1).max(MAX_RENDER_JOB_LIMIT_V1),
    stripePriceId: stripePriceIdSchemaV1,
  })
  .strict();
const planCatalogInputSchemaV1 = z
  .object({
    pro: planDefinitionSchemaV1.omit({ planKey: true }),
  })
  .strict();

export type StripeCheckoutPlanKeyV1 = (typeof STRIPE_CHECKOUT_PLAN_KEYS_V1)[number];
export type StripeCheckoutPlanDefinitionV1 = Readonly<z.infer<typeof planDefinitionSchemaV1>>;

export interface StripeCheckoutPlanCatalogV1 {
  byPlanKey(planKey: unknown): StripeCheckoutPlanDefinitionV1 | null;
  byStripePriceId(stripePriceId: unknown): StripeCheckoutPlanDefinitionV1 | null;
}

/** The initial paid catalog is intentionally closed: clients select `pro`, never a Stripe price ID. */
export function createStripeCheckoutPlanCatalogV1(input: unknown): StripeCheckoutPlanCatalogV1 {
  const parsed = planCatalogInputSchemaV1.parse(input);
  const pro = Object.freeze({ planKey: "pro" as const, ...parsed.pro });
  return Object.freeze({
    byPlanKey(planKey: unknown) {
      return planKey === pro.planKey ? pro : null;
    },
    byStripePriceId(stripePriceId: unknown) {
      return stripePriceId === pro.stripePriceId ? pro : null;
    },
  });
}

export function parseStripePriceIdV1(value: unknown): string {
  return stripePriceIdSchemaV1.parse(value);
}

export function parseStripeCheckoutPlanDefinitionV1(value: unknown): StripeCheckoutPlanDefinitionV1 {
  return planDefinitionSchemaV1.parse(value);
}
