import { z } from "zod";

import { organizationIdSchemaV1 } from "../accounts/account-domain";
import {
  type ApplyEntitlementSnapshotInputV1,
  type EntitlementSnapshotV1,
  parseApplyEntitlementSnapshotInputV1,
} from "./entitlement-repository";

export const MAX_STRIPE_EVENT_PAYLOAD_BYTES_V1 = 1_048_576;

const generationSchema = z.bigint().min(0n).max(BigInt(Number.MAX_SAFE_INTEGER));
const positiveGenerationSchema = generationSchema.min(1n);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const planKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const stripeCustomerIdSchema = z.string().regex(/^cus_[A-Za-z0-9_]{1,251}$/u);
const stripeCheckoutSessionIdSchema = z.string().regex(/^cs_[A-Za-z0-9_]{1,252}$/u);
const stripeEventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_]{1,251}$/u);
const stripeSubscriptionIdSchema = z.string().regex(/^sub_[A-Za-z0-9_]{1,251}$/u);
const stripeObjectIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{2,254}$/u);
const eventTypeSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/u);

export const stripeSubscriptionStatusSchemaV1 = z.enum([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

const billingAccountSchema = z
  .object({
    createdAt: z.date(),
    entitlementGeneration: generationSchema,
    livemode: z.boolean().nullable(),
    observationGeneration: generationSchema,
    reconcileGeneration: generationSchema,
    reconciledAt: z.date().nullable(),
    stripeCustomerId: stripeCustomerIdSchema.nullable(),
    tenantId: organizationIdSchemaV1,
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((account, context) => {
    if ((account.stripeCustomerId === null) !== (account.livemode === null)) {
      context.addIssue({ code: "custom", message: "The Stripe customer binding is incomplete." });
    }
    if ((account.reconcileGeneration === 0n) !== (account.reconciledAt === null)) {
      context.addIssue({ code: "custom", message: "The Stripe reconciliation clock is inconsistent." });
    }
    if (account.reconciledAt !== null && account.reconciledAt < account.createdAt) {
      context.addIssue({ code: "custom", message: "The Stripe reconciliation timestamp is invalid." });
    }
    if (account.updatedAt < account.createdAt) {
      context.addIssue({ code: "custom", message: "The billing-account timestamps are invalid." });
    }
  });

const bindCustomerInputSchema = z
  .object({
    livemode: z.boolean(),
    stripeCustomerId: stripeCustomerIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const checkoutAttemptBaseSchema = z
  .object({
    attemptId: z.uuid(),
    createdAt: z.date(),
    expiresAt: z.date(),
    livemode: z.boolean(),
    planKey: planKeySchema,
    state: z.enum(["reserved", "open", "consumed", "failed", "expired"]),
    stripeCheckoutSessionId: stripeCheckoutSessionIdSchema.nullable(),
    stripeCustomerId: stripeCustomerIdSchema.nullable(),
    stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]{1,249}$/u),
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const checkoutAttemptSchema = checkoutAttemptBaseSchema.superRefine((attempt, context) => {
  if (attempt.expiresAt <= attempt.createdAt) {
    context.addIssue({ code: "custom", message: "The Checkout attempt expiry is invalid.", path: ["expiresAt"] });
  }
  if (
    (attempt.state === "reserved" && attempt.stripeCheckoutSessionId !== null) ||
    (attempt.state === "open" && attempt.stripeCheckoutSessionId === null) ||
    (attempt.state === "failed" && attempt.stripeCheckoutSessionId !== null)
  ) {
    context.addIssue({ code: "custom", message: "The Checkout attempt state is inconsistent.", path: ["state"] });
  }
});

const reserveCheckoutAttemptInputSchema = z
  .object({
    attemptId: z.uuid(),
    livemode: z.boolean(),
    planKey: planKeySchema,
    stripeCustomerId: stripeCustomerIdSchema.nullable(),
    stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]{1,249}$/u),
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const openCheckoutAttemptInputSchema = z
  .object({
    attemptId: z.uuid(),
    expiresAt: z.date(),
    stripeCheckoutSessionId: stripeCheckoutSessionIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const failCheckoutAttemptInputSchema = z.object({ attemptId: z.uuid(), tenantId: organizationIdSchemaV1 }).strict();

const stripeEventSchema = z
  .object({
    checkoutAttemptId: z.uuid().nullable(),
    eventCreatedAt: z.date(),
    eventType: eventTypeSchema,
    livemode: z.boolean(),
    payloadDigest: digestSchema,
    processedAt: z.date().nullable(),
    receivedAt: z.date(),
    sourceObjectId: stripeObjectIdSchema.nullable(),
    state: z.enum(["pending", "processed"]),
    stripeCustomerId: stripeCustomerIdSchema,
    stripeEventId: stripeEventIdSchema,
    stripeSubscriptionId: stripeSubscriptionIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict()
  .superRefine((event, context) => {
    if ((event.state === "pending") !== (event.processedAt === null)) {
      context.addIssue({ code: "custom", message: "The Stripe event processing state is inconsistent." });
    }
    if (event.processedAt !== null && event.processedAt < event.receivedAt) {
      context.addIssue({ code: "custom", message: "The Stripe event processing timestamp is invalid." });
    }
  });

const ingestStripeEventInputSchema = z
  .object({
    checkoutAttemptId: z.uuid().nullable(),
    eventCreatedAt: z.date(),
    eventType: eventTypeSchema,
    livemode: z.boolean(),
    payloadBytes: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength >= 1 && bytes.byteLength <= MAX_STRIPE_EVENT_PAYLOAD_BYTES_V1),
    payloadDigest: digestSchema,
    sourceObjectId: stripeObjectIdSchema.nullable(),
    stripeCustomerId: stripeCustomerIdSchema,
    stripeEventId: stripeEventIdSchema,
    stripeSubscriptionId: stripeSubscriptionIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const acknowledgeStripeEventInputSchema = z
  .object({
    expectedReconcileGeneration: generationSchema,
    expectedStripeSubscriptionId: stripeSubscriptionIdSchema,
    expectedSubscriptionStatus: stripeSubscriptionStatusSchemaV1,
    livemode: z.boolean(),
    stripeCustomerId: stripeCustomerIdSchema,
    stripeEventId: stripeEventIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const reserveCanonicalObservationInputSchema = z
  .object({
    livemode: z.boolean(),
    stripeCustomerId: stripeCustomerIdSchema,
    stripeEventId: stripeEventIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const billingSubscriptionSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean(),
    canonicalDigest: digestSchema,
    canonicalRetrievedAt: z.date(),
    createdAt: z.date(),
    currentPeriodEnd: z.date(),
    currentPeriodStart: z.date(),
    entitlementSnapshotId: z.uuid(),
    entitlementSourceGeneration: positiveGenerationSchema,
    livemode: z.boolean(),
    planKey: planKeySchema,
    reconcileGeneration: positiveGenerationSchema,
    sourceEventId: stripeEventIdSchema,
    status: stripeSubscriptionStatusSchemaV1,
    stripeCustomerId: stripeCustomerIdSchema,
    stripeSubscriptionId: stripeSubscriptionIdSchema,
    tenantId: organizationIdSchemaV1,
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((subscription, context) => {
    if (subscription.currentPeriodEnd <= subscription.currentPeriodStart) {
      context.addIssue({ code: "custom", message: "The Stripe subscription period is invalid." });
    }
    if (subscription.updatedAt < subscription.createdAt) {
      context.addIssue({ code: "custom", message: "The billing-subscription timestamps are invalid." });
    }
  });

const reconcileSubscriptionBaseSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean(),
    canonicalDigest: digestSchema,
    canonicalRetrievedAt: z.date(),
    currentPeriodEnd: z.date(),
    currentPeriodStart: z.date(),
    expectedObservationGeneration: positiveGenerationSchema,
    expectedReconcileGeneration: generationSchema,
    livemode: z.boolean(),
    planKey: planKeySchema,
    sourceEventId: stripeEventIdSchema,
    status: stripeSubscriptionStatusSchemaV1,
    stripeCustomerId: stripeCustomerIdSchema,
    stripeSubscriptionId: stripeSubscriptionIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict()
  .refine((subscription) => subscription.currentPeriodEnd > subscription.currentPeriodStart, {
    message: "The Stripe subscription period is invalid.",
    path: ["currentPeriodEnd"],
  });

export type StripeSubscriptionStatusV1 = z.infer<typeof stripeSubscriptionStatusSchemaV1>;
export type StripeBillingAccountV1 = Readonly<z.infer<typeof billingAccountSchema>>;
export type BindStripeCustomerInputV1 = Readonly<z.infer<typeof bindCustomerInputSchema>>;
export type BillingCheckoutAttemptV1 = Readonly<z.infer<typeof checkoutAttemptSchema>>;
export type ReserveBillingCheckoutAttemptInputV1 = Readonly<z.infer<typeof reserveCheckoutAttemptInputSchema>>;
export type OpenBillingCheckoutAttemptInputV1 = Readonly<z.infer<typeof openCheckoutAttemptInputSchema>>;
export type FailBillingCheckoutAttemptInputV1 = Readonly<z.infer<typeof failCheckoutAttemptInputSchema>>;
export type StripeEventInboxEntryV1 = Readonly<z.infer<typeof stripeEventSchema>>;
export type IngestStripeEventInputV1 = Readonly<z.infer<typeof ingestStripeEventInputSchema>>;
export type AcknowledgeStripeEventInputV1 = Readonly<z.infer<typeof acknowledgeStripeEventInputSchema>>;
export type ReserveCanonicalObservationInputV1 = Readonly<z.infer<typeof reserveCanonicalObservationInputSchema>>;
export type BillingSubscriptionV1 = Readonly<z.infer<typeof billingSubscriptionSchema>>;
export type ReconcileBillingSubscriptionInputV1 = Readonly<
  z.infer<typeof reconcileSubscriptionBaseSchema> & { entitlement: ApplyEntitlementSnapshotInputV1 }
>;

export type BindStripeCustomerResultV1 =
  | Readonly<{ account: StripeBillingAccountV1; kind: "bound"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type ReserveBillingCheckoutAttemptResultV1 =
  | Readonly<{ attempt: BillingCheckoutAttemptV1; kind: "reserved"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type OpenBillingCheckoutAttemptResultV1 =
  | Readonly<{ attempt: BillingCheckoutAttemptV1; kind: "open"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type FailBillingCheckoutAttemptResultV1 =
  | Readonly<{ attempt: BillingCheckoutAttemptV1; kind: "failed"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type IngestStripeEventResultV1 =
  | Readonly<{ event: StripeEventInboxEntryV1; kind: "received"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type AcknowledgeStripeEventResultV1 =
  | Readonly<{ event: StripeEventInboxEntryV1; kind: "processed"; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

export type ReserveCanonicalObservationResultV1 =
  | Readonly<{ kind: "processed" }>
  | Readonly<{ kind: "reserved"; observationGeneration: bigint }>
  | Readonly<{ kind: "conflict" }>;

export type ReconcileBillingSubscriptionResultV1 =
  | Readonly<{
      account: StripeBillingAccountV1;
      entitlement: EntitlementSnapshotV1 | null;
      kind: "applied";
      replayed: boolean;
      subscription: BillingSubscriptionV1;
    }>
  | Readonly<{
      entitlementGeneration: bigint;
      kind: "conflict";
      observationGeneration: bigint;
      reconcileGeneration: bigint;
    }>
  | Readonly<{ kind: "event-conflict" | "unbound" }>;

export function parseStripeBillingAccountV1(input: unknown): StripeBillingAccountV1 {
  return billingAccountSchema.parse(input);
}

export function parseBindStripeCustomerInputV1(input: unknown): BindStripeCustomerInputV1 {
  return bindCustomerInputSchema.parse(input);
}

export function parseBillingCheckoutAttemptV1(input: unknown): BillingCheckoutAttemptV1 {
  return checkoutAttemptSchema.parse(input);
}

export function parseReserveBillingCheckoutAttemptInputV1(input: unknown): ReserveBillingCheckoutAttemptInputV1 {
  return reserveCheckoutAttemptInputSchema.parse(input);
}

export function parseOpenBillingCheckoutAttemptInputV1(input: unknown): OpenBillingCheckoutAttemptInputV1 {
  return openCheckoutAttemptInputSchema.parse(input);
}

export function parseFailBillingCheckoutAttemptInputV1(input: unknown): FailBillingCheckoutAttemptInputV1 {
  return failCheckoutAttemptInputSchema.parse(input);
}

export function parseBillingCheckoutAttemptIdV1(input: unknown) {
  return z.uuid().parse(input);
}

export function parseStripeCheckoutSessionIdV1(input: unknown) {
  return stripeCheckoutSessionIdSchema.parse(input);
}

export function parseStripeCustomerLookupV1(stripeCustomerId: unknown, livemode: unknown) {
  return z
    .object({ livemode: z.boolean(), stripeCustomerId: stripeCustomerIdSchema })
    .parse({ livemode, stripeCustomerId });
}

export function parseStripeEventInboxEntryV1(input: unknown): StripeEventInboxEntryV1 {
  return stripeEventSchema.parse(input);
}

export function parseIngestStripeEventInputV1(input: unknown): IngestStripeEventInputV1 {
  const parsed = ingestStripeEventInputSchema.parse(input);
  return { ...parsed, payloadBytes: Uint8Array.from(parsed.payloadBytes) };
}

export function parseAcknowledgeStripeEventInputV1(input: unknown): AcknowledgeStripeEventInputV1 {
  return acknowledgeStripeEventInputSchema.parse(input);
}

export function parseReserveCanonicalObservationInputV1(input: unknown): ReserveCanonicalObservationInputV1 {
  return reserveCanonicalObservationInputSchema.parse(input);
}

export function parseBillingSubscriptionV1(input: unknown): BillingSubscriptionV1 {
  return billingSubscriptionSchema.parse(input);
}

export function parseReconcileBillingSubscriptionInputV1(input: unknown): ReconcileBillingSubscriptionInputV1 {
  if (typeof input !== "object" || input === null || !("entitlement" in input)) {
    throw new TypeError("Stripe subscription reconciliation requires an entitlement snapshot.");
  }
  const { entitlement: entitlementValue, ...subscriptionValue } = input as Record<string, unknown>;
  const subscription = reconcileSubscriptionBaseSchema.parse(subscriptionValue);
  const entitlement = parseApplyEntitlementSnapshotInputV1(entitlementValue);
  if (
    entitlement.tenantId !== subscription.tenantId ||
    entitlement.planKey !== subscription.planKey ||
    entitlement.periodStart.getTime() !== subscription.currentPeriodStart.getTime() ||
    entitlement.periodEnd.getTime() !== subscription.currentPeriodEnd.getTime()
  ) {
    throw new TypeError("The local entitlement does not describe the canonical Stripe subscription.");
  }
  return { ...subscription, entitlement };
}

/** Durable boundary between verified Stripe input and local entitlement authority. */
export interface StripeBillingRepositoryV1 {
  acknowledgeEvent(input: AcknowledgeStripeEventInputV1, signal?: AbortSignal): Promise<AcknowledgeStripeEventResultV1>;
  bindCustomer(input: BindStripeCustomerInputV1, signal?: AbortSignal): Promise<BindStripeCustomerResultV1>;
  close(): Promise<void>;
  openCheckoutAttempt(
    input: OpenBillingCheckoutAttemptInputV1,
    signal?: AbortSignal,
  ): Promise<OpenBillingCheckoutAttemptResultV1>;
  failCheckoutAttempt(
    input: FailBillingCheckoutAttemptInputV1,
    signal?: AbortSignal,
  ): Promise<FailBillingCheckoutAttemptResultV1>;
  ingestEvent(input: IngestStripeEventInputV1, signal?: AbortSignal): Promise<IngestStripeEventResultV1>;
  readAccount(tenantId: string, signal?: AbortSignal): Promise<StripeBillingAccountV1 | null>;
  readAccountByStripeCustomerId(
    stripeCustomerId: string,
    livemode: boolean,
    signal?: AbortSignal,
  ): Promise<StripeBillingAccountV1 | null>;
  readCheckoutAttempt(attemptId: string, signal?: AbortSignal): Promise<BillingCheckoutAttemptV1 | null>;
  readCheckoutAttemptBySessionId(
    stripeCheckoutSessionId: string,
    signal?: AbortSignal,
  ): Promise<BillingCheckoutAttemptV1 | null>;
  readCurrentEntitlement(tenantId: string, signal?: AbortSignal): Promise<EntitlementSnapshotV1 | null>;
  readCurrentSubscription(tenantId: string, signal?: AbortSignal): Promise<BillingSubscriptionV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  reserveCanonicalObservation(
    input: ReserveCanonicalObservationInputV1,
    signal?: AbortSignal,
  ): Promise<ReserveCanonicalObservationResultV1>;
  reserveCheckoutAttempt(
    input: ReserveBillingCheckoutAttemptInputV1,
    signal?: AbortSignal,
  ): Promise<ReserveBillingCheckoutAttemptResultV1>;
  reconcileSubscription(
    input: ReconcileBillingSubscriptionInputV1,
    signal?: AbortSignal,
  ): Promise<ReconcileBillingSubscriptionResultV1>;
}
