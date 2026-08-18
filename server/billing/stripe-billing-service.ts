import { z } from "zod";

import type { BillingControlPlaneServiceV1 } from "../billing-control-plane";
import { HttpError } from "../http/json";
import { isVerifiedManimPrincipal } from "../manim-request-principal";
import type { EntitlementSnapshotV1 } from "./entitlement-repository";
import type { StripeCheckoutPlanCatalogV1, StripeCheckoutPlanDefinitionV1 } from "./plan-catalog";
import type {
  BillingCheckoutAttemptV1,
  BillingSubscriptionV1,
  StripeBillingRepositoryV1,
} from "./stripe-billing-repository";
import {
  type CanonicalStripeSubscriptionV1,
  canonicalStripeSubscriptionBytesV1,
  type StripeBillingGatewayV1,
  StripeGatewayErrorV1,
} from "./stripe-gateway";
import {
  type StripeWebhookEventEnvelopeV1,
  StripeWebhookVerificationErrorV1,
  verifyAndParseStripeWebhookV1,
} from "./stripe-webhook";

const DEFAULT_PAST_DUE_GRACE_MS_V1 = 3 * 24 * 60 * 60 * 1_000;
const MAX_RECONCILE_ATTEMPTS_V1 = 3;
const SUPPORTED_WEBHOOK_EVENTS_V1 = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
]);

const optionsSchemaV1 = z
  .object({
    livemode: z.boolean(),
    pastDueGraceMs: z
      .number()
      .int()
      .min(60 * 60 * 1_000)
      .max(30 * 24 * 60 * 60 * 1_000)
      .default(DEFAULT_PAST_DUE_GRACE_MS_V1),
    portalConfigurationId: z
      .string()
      .regex(/^bpc_[A-Za-z0-9_]{1,247}$/u)
      .nullable()
      .default(null),
    publicOrigin: z.string().url(),
    webhookSigningSecret: z
      .string()
      .min(16)
      .max(512)
      .regex(/^whsec_[A-Za-z0-9_]+$/u),
  })
  .strict();

export type StripeBillingServiceV1 = BillingControlPlaneServiceV1 &
  Readonly<{
    close(): Promise<void>;
    ready(signal?: AbortSignal): Promise<boolean>;
  }>;

export type StripeBillingServiceOptionsV1 = Readonly<{
  catalog: StripeCheckoutPlanCatalogV1;
  clock?: () => Date;
  crypto?: Pick<Crypto, "randomUUID" | "subtle">;
  gateway: StripeBillingGatewayV1;
  livemode: boolean;
  pastDueGraceMs?: number;
  portalConfigurationId?: string;
  publicOrigin: string;
  repository: StripeBillingRepositoryV1;
  webhookSigningSecret: string;
}>;

function exactPublicOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new TypeError("Stripe billing requires an exact HTTPS public origin.");
  }
  return url.origin;
}

function exactClock(clock: () => Date) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Stripe billing clock returned an invalid instant.");
  }
  return new Date(value);
}

function assertPrincipal(input: unknown) {
  if (!isVerifiedManimPrincipal(input)) throw new HttpError("Authentication is required.", 401);
  return input;
}

async function sha256Hex(cryptoProvider: Pick<Crypto, "subtle">, bytes: Uint8Array) {
  const digest = await cryptoProvider.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entitlementView(snapshot: EntitlementSnapshotV1 | null) {
  if (snapshot === null) return null;
  return {
    accessState: snapshot.accessState,
    accessUntil: snapshot.accessUntil.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    periodStart: snapshot.periodStart.toISOString(),
    planKey: snapshot.planKey,
    renderEnabled: snapshot.renderEnabled,
    renderJobLimit: snapshot.renderJobLimit,
    sourceGeneration: snapshot.sourceGeneration.toString(),
  } as const;
}

function periodsOverlap(snapshot: EntitlementSnapshotV1, subscription: CanonicalStripeSubscriptionV1) {
  return snapshot.periodStart < subscription.periodEnd && subscription.periodStart < snapshot.periodEnd;
}

function targetAttempt(
  envelope: StripeWebhookEventEnvelopeV1,
  byId: BillingCheckoutAttemptV1 | null,
  bySession: BillingCheckoutAttemptV1 | null,
) {
  if (byId && bySession && byId.attemptId !== bySession.attemptId) {
    throw new HttpError("Stripe webhook correlation is inconsistent.", 409);
  }
  const attempt = byId ?? bySession;
  if (!attempt) return null;
  if (
    attempt.livemode !== envelope.livemode ||
    (envelope.checkoutAttemptId !== null && attempt.attemptId !== envelope.checkoutAttemptId) ||
    (envelope.checkoutSessionId !== null &&
      attempt.stripeCheckoutSessionId !== null &&
      attempt.stripeCheckoutSessionId !== envelope.checkoutSessionId)
  ) {
    throw new HttpError("Stripe webhook correlation is inconsistent.", 409);
  }
  return attempt;
}

function entitlementAccess(
  subscription: CanonicalStripeSubscriptionV1,
  plan: StripeCheckoutPlanDefinitionV1,
  now: Date,
  pastDueGraceMs: number,
  currentEntitlement: EntitlementSnapshotV1 | null,
  currentSubscription: BillingSubscriptionV1 | null,
) {
  // The plan-derived billing v2 grant limits ride beside the legacy render
  // fields: they land on the normalized grant tables only and never change the
  // v14 snapshot wire fields.
  const grantedLimits = {
    aiSuggestionLimit: plan.aiSuggestionLimit,
    exportPublicationLimit: plan.exportPublicationLimit,
    publishedArtifactBytesLimit: plan.publishedArtifactBytesLimit,
  };
  const blockedLimits = {
    aiSuggestionLimit: 0,
    exportPublicationLimit: 0,
    publishedArtifactBytesLimit: 0,
  };
  if (subscription.status === "active" || subscription.status === "trialing") {
    return {
      accessState: "active" as const,
      accessUntil: subscription.periodEnd,
      renderEnabled: true,
      renderJobLimit: plan.renderJobLimit,
      ...grantedLimits,
    };
  }
  if (subscription.status === "past_due") {
    if (currentSubscription?.stripeSubscriptionId === subscription.id && currentSubscription.status === "past_due") {
      const priorGraceIsAuthoritative =
        currentEntitlement?.accessState === "grace" &&
        currentEntitlement.snapshotId === currentSubscription.entitlementSnapshotId &&
        currentEntitlement.sourceGeneration === currentSubscription.entitlementSourceGeneration;
      if (!priorGraceIsAuthoritative || currentEntitlement.accessUntil <= subscription.periodStart) {
        return {
          accessState: "blocked" as const,
          accessUntil: subscription.periodEnd,
          renderEnabled: false,
          renderJobLimit: 0,
          ...blockedLimits,
        };
      }
      return {
        accessState: "grace" as const,
        accessUntil: new Date(Math.min(subscription.periodEnd.getTime(), currentEntitlement.accessUntil.getTime())),
        renderEnabled: true,
        renderJobLimit: plan.renderJobLimit,
        ...grantedLimits,
      };
    }
    const lowerBound = subscription.periodStart.getTime() + 1;
    const graceDeadline = Math.max(lowerBound, now.getTime() + pastDueGraceMs);
    return {
      accessState: "grace" as const,
      accessUntil: new Date(Math.min(subscription.periodEnd.getTime(), graceDeadline)),
      renderEnabled: true,
      renderJobLimit: plan.renderJobLimit,
      ...grantedLimits,
    };
  }
  return {
    accessState: "blocked" as const,
    accessUntil: subscription.periodEnd,
    renderEnabled: false,
    renderJobLimit: 0,
    ...blockedLimits,
  };
}

async function reconcileUsagePeriodKey(
  cryptoProvider: Pick<Crypto, "subtle">,
  subscription: CanonicalStripeSubscriptionV1,
) {
  const identity = new TextEncoder().encode(
    `${subscription.id}:${subscription.periodStart.toISOString()}:${subscription.periodEnd.toISOString()}`,
  );
  return `stripe:${await sha256Hex(cryptoProvider, identity)}`;
}

function validateDependencies(options: StripeBillingServiceOptionsV1) {
  if (
    typeof options.catalog?.byPlanKey !== "function" ||
    typeof options.catalog.byStripePriceId !== "function" ||
    typeof options.gateway?.createCheckoutSession !== "function" ||
    typeof options.gateway.createPortalSession !== "function" ||
    typeof options.gateway.retrieveSubscription !== "function" ||
    typeof options.repository?.readAccount !== "function" ||
    typeof options.repository.readAccountByStripeCustomerId !== "function" ||
    typeof options.repository.readCheckoutAttempt !== "function" ||
    typeof options.repository.readCheckoutAttemptBySessionId !== "function" ||
    typeof options.repository.readCurrentEntitlement !== "function" ||
    typeof options.repository.readCurrentSubscription !== "function" ||
    typeof options.repository.acknowledgeEvent !== "function" ||
    typeof options.repository.bindCustomer !== "function" ||
    typeof options.repository.reserveCheckoutAttempt !== "function" ||
    typeof options.repository.openCheckoutAttempt !== "function" ||
    typeof options.repository.failCheckoutAttempt !== "function" ||
    typeof options.repository.ingestEvent !== "function" ||
    typeof options.repository.reserveCanonicalObservation !== "function" ||
    typeof options.repository.reconcileSubscription !== "function" ||
    typeof options.repository.ready !== "function" ||
    typeof options.repository.close !== "function"
  ) {
    throw new TypeError("Stripe billing requires complete gateway, catalog, and repository adapters.");
  }
}

/** Checkout and verified webhook orchestration; Stripe is never consulted by render admission. */
export function createStripeBillingServiceV1(options: StripeBillingServiceOptionsV1): StripeBillingServiceV1 {
  validateDependencies(options);
  const parsedOptions = optionsSchemaV1.parse({
    livemode: options.livemode,
    pastDueGraceMs: options.pastDueGraceMs,
    portalConfigurationId: options.portalConfigurationId ?? null,
    publicOrigin: options.publicOrigin,
    webhookSigningSecret: options.webhookSigningSecret,
  });
  const publicOrigin = exactPublicOrigin(parsedOptions.publicOrigin);
  const cryptoProvider = options.crypto ?? globalThis.crypto;
  if (!cryptoProvider?.subtle || typeof cryptoProvider.randomUUID !== "function") {
    throw new TypeError("Stripe billing requires Web Crypto.");
  }
  const clock = options.clock ?? (() => new Date());
  let closeRequest: Promise<void> | null = null;

  const resolveWebhookTarget = async (envelope: StripeWebhookEventEnvelopeV1, signal?: AbortSignal) => {
    const [byId, bySession, byCustomer] = await Promise.all([
      envelope.checkoutAttemptId
        ? options.repository.readCheckoutAttempt(envelope.checkoutAttemptId, signal)
        : Promise.resolve(null),
      envelope.checkoutSessionId
        ? options.repository.readCheckoutAttemptBySessionId(envelope.checkoutSessionId, signal)
        : Promise.resolve(null),
      envelope.customerId
        ? options.repository.readAccountByStripeCustomerId(envelope.customerId, envelope.livemode, signal)
        : Promise.resolve(null),
    ]);
    const attempt = targetAttempt(envelope, byId, bySession);
    if (attempt && byCustomer && attempt.tenantId !== byCustomer.tenantId) {
      throw new HttpError("Stripe webhook correlation is inconsistent.", 409);
    }
    if (!attempt && !byCustomer) {
      // A server-issued attempt locator can race only with durable attempt persistence;
      // retry instead of permanently acknowledging a potentially valid purchase.
      if (envelope.checkoutAttemptId || envelope.checkoutSessionId) {
        throw new HttpError("Stripe webhook correlation is not ready.", 503);
      }
      return null;
    }
    return { account: byCustomer, attempt, tenantId: (attempt ?? byCustomer)!.tenantId } as const;
  };

  const retrieveValidatedCanonical = async (
    envelope: StripeWebhookEventEnvelopeV1,
    attempt: BillingCheckoutAttemptV1 | null,
    signal?: AbortSignal,
  ) => {
    if (!envelope.subscriptionId || !envelope.customerId) {
      throw new HttpError("Stripe webhook does not identify a subscription.", 400);
    }
    const subscription = await options.gateway.retrieveSubscription(envelope.subscriptionId, signal);
    const retrievedAt = exactClock(clock);
    if (
      subscription.id !== envelope.subscriptionId ||
      subscription.customerId !== envelope.customerId ||
      subscription.livemode !== envelope.livemode ||
      subscription.livemode !== parsedOptions.livemode
    ) {
      throw new HttpError("Stripe canonical subscription is inconsistent.", 409);
    }
    const plan = attempt
      ? options.catalog.byPlanKey(attempt.planKey)
      : options.catalog.byStripePriceId(subscription.priceId);
    if (!plan || (attempt && (subscription.priceId !== attempt.stripePriceId || plan.planKey !== attempt.planKey))) {
      throw new HttpError("Stripe subscription plan is not available.", 409);
    }
    return { plan, retrievedAt, subscription } as const;
  };

  const observeCanonical = async (
    envelope: StripeWebhookEventEnvelopeV1,
    tenantId: string,
    attempt: BillingCheckoutAttemptV1 | null,
    signal?: AbortSignal,
  ) => {
    if (!envelope.customerId) throw new HttpError("Stripe webhook does not identify a customer.", 400);
    const reservation = await options.repository.reserveCanonicalObservation(
      {
        livemode: envelope.livemode,
        stripeCustomerId: envelope.customerId,
        stripeEventId: envelope.eventId,
        tenantId,
      },
      signal,
    );
    if (reservation.kind === "processed") return null;
    if (reservation.kind !== "reserved") {
      throw new HttpError("Stripe canonical observation was rejected.", 409);
    }
    return {
      ...(await retrieveValidatedCanonical(envelope, attempt, signal)),
      observationGeneration: reservation.observationGeneration,
    } as const;
  };

  const reconcile = async (
    envelope: StripeWebhookEventEnvelopeV1,
    tenantId: string,
    attempt: BillingCheckoutAttemptV1 | null,
    initialCanonical: NonNullable<Awaited<ReturnType<typeof observeCanonical>>>,
    signal?: AbortSignal,
  ) => {
    if (!envelope.subscriptionId || !envelope.customerId) {
      throw new HttpError("Stripe webhook does not identify a subscription.", 400);
    }
    for (let index = 0; index < MAX_RECONCILE_ATTEMPTS_V1; index += 1) {
      const canonical = index === 0 ? initialCanonical : await observeCanonical(envelope, tenantId, attempt, signal);
      if (canonical === null) return;
      const [account, currentEntitlement, currentSubscription] = await Promise.all([
        options.repository.readAccount(tenantId, signal),
        options.repository.readCurrentEntitlement(tenantId, signal),
        options.repository.readCurrentSubscription(tenantId, signal),
      ]);
      if (!account || account.stripeCustomerId !== envelope.customerId || account.livemode !== envelope.livemode) {
        throw new HttpError("Stripe customer binding changed.", 409);
      }
      const { observationGeneration, plan, retrievedAt, subscription } = canonical;
      if (
        currentSubscription &&
        currentSubscription.stripeSubscriptionId !== subscription.id &&
        currentSubscription.status !== "canceled" &&
        currentSubscription.status !== "incomplete_expired"
      ) {
        if (
          subscription.status === "active" ||
          subscription.status === "trialing" ||
          subscription.status === "past_due"
        ) {
          throw new HttpError("Another Stripe subscription is already authoritative.", 409);
        }
        const acknowledged = await options.repository.acknowledgeEvent(
          {
            expectedReconcileGeneration: account.reconcileGeneration,
            expectedStripeSubscriptionId: currentSubscription.stripeSubscriptionId,
            expectedSubscriptionStatus: currentSubscription.status,
            livemode: subscription.livemode,
            stripeCustomerId: subscription.customerId,
            stripeEventId: envelope.eventId,
            tenantId,
          },
          signal,
        );
        if (acknowledged.kind === "processed") return;
        continue;
      }
      const [canonicalDigest, derivedUsagePeriodKey] = await Promise.all([
        sha256Hex(cryptoProvider, canonicalStripeSubscriptionBytesV1(subscription)),
        reconcileUsagePeriodKey(cryptoProvider, subscription),
      ]);
      const usagePeriodKey =
        currentEntitlement && periodsOverlap(currentEntitlement, subscription)
          ? currentEntitlement.usagePeriodKey
          : derivedUsagePeriodKey;
      const access = entitlementAccess(
        subscription,
        plan,
        retrievedAt,
        parsedOptions.pastDueGraceMs,
        currentEntitlement,
        currentSubscription,
      );
      const result = await options.repository.reconcileSubscription(
        {
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          canonicalDigest,
          canonicalRetrievedAt: retrievedAt,
          currentPeriodEnd: subscription.periodEnd,
          currentPeriodStart: subscription.periodStart,
          entitlement: {
            ...access,
            expectedGeneration: account.entitlementGeneration,
            periodEnd: subscription.periodEnd,
            periodStart: subscription.periodStart,
            planKey: plan.planKey,
            snapshotId: cryptoProvider.randomUUID(),
            sourceGeneration: account.entitlementGeneration + 1n,
            tenantId,
            usagePeriodKey,
          },
          expectedObservationGeneration: observationGeneration,
          expectedReconcileGeneration: account.reconcileGeneration,
          livemode: subscription.livemode,
          planKey: plan.planKey,
          sourceEventId: envelope.eventId,
          status: subscription.status,
          stripeCustomerId: subscription.customerId,
          stripeSubscriptionId: subscription.id,
          tenantId,
        },
        signal,
      );
      if (result.kind === "applied") return;
      if (result.kind !== "conflict") throw new HttpError("Stripe reconciliation was rejected.", 409);
    }
    throw new HttpError("Stripe reconciliation is busy.", 409);
  };

  return Object.freeze({
    async acceptWebhook({ rawBody, stripeSignature }, signal) {
      let envelope: StripeWebhookEventEnvelopeV1;
      try {
        envelope = await verifyAndParseStripeWebhookV1(rawBody, stripeSignature, parsedOptions.webhookSigningSecret, {
          crypto: cryptoProvider,
          now: exactClock(clock),
        });
      } catch (error) {
        if (error instanceof StripeWebhookVerificationErrorV1) {
          throw new HttpError("Stripe webhook verification failed.", 400);
        }
        throw error;
      }
      if (envelope.livemode !== parsedOptions.livemode) {
        throw new HttpError("Stripe webhook mode is invalid.", 400);
      }
      if (!SUPPORTED_WEBHOOK_EVENTS_V1.has(envelope.eventType)) return;
      if (!envelope.customerId || !envelope.subscriptionId) {
        throw new HttpError("Stripe webhook does not identify a subscription.", 400);
      }

      const target = await resolveWebhookTarget(envelope, signal);
      if (!target) return;
      if (
        target.attempt?.stripeCustomerId !== null &&
        target.attempt?.stripeCustomerId !== undefined &&
        target.attempt.stripeCustomerId !== envelope.customerId
      ) {
        throw new HttpError("Stripe webhook correlation is inconsistent.", 409);
      }
      const payloadDigest = await sha256Hex(cryptoProvider, envelope.payloadBytes);
      const ingested = await options.repository.ingestEvent(
        {
          checkoutAttemptId: target.attempt?.attemptId ?? null,
          eventCreatedAt: envelope.createdAt,
          eventType: envelope.eventType,
          livemode: envelope.livemode,
          payloadBytes: Uint8Array.from(envelope.payloadBytes),
          payloadDigest,
          sourceObjectId: envelope.sourceObjectId,
          stripeCustomerId: envelope.customerId,
          stripeEventId: envelope.eventId,
          stripeSubscriptionId: envelope.subscriptionId,
          tenantId: target.tenantId,
        },
        signal,
      );
      if (ingested.kind !== "received") throw new HttpError("Stripe webhook replay is inconsistent.", 409);
      if (ingested.event.state === "processed") return;

      const canonical = await observeCanonical(envelope, target.tenantId, target.attempt, signal);
      if (canonical === null) return;
      const bound = await options.repository.bindCustomer(
        {
          livemode: envelope.livemode,
          stripeCustomerId: envelope.customerId,
          tenantId: target.tenantId,
        },
        signal,
      );
      if (bound.kind !== "bound") throw new HttpError("Stripe customer binding changed.", 409);
      await reconcile(envelope, target.tenantId, target.attempt, canonical, signal);
    },
    close() {
      closeRequest ??= Promise.resolve().then(() => options.repository.close());
      return closeRequest;
    },
    async readStatus({ principal }, signal) {
      const verified = assertPrincipal(principal);
      const [account, entitlement, subscription] = await Promise.all([
        options.repository.readAccount(verified.tenantId, signal),
        options.repository.readCurrentEntitlement(verified.tenantId, signal),
        options.repository.readCurrentSubscription(verified.tenantId, signal),
      ]);
      return {
        configured: account?.stripeCustomerId !== null && account?.stripeCustomerId !== undefined,
        entitlement: entitlementView(entitlement),
        subscription: subscription
          ? {
              cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
              periodEnd: subscription.currentPeriodEnd.toISOString(),
              periodStart: subscription.currentPeriodStart.toISOString(),
              planKey: subscription.planKey,
              status: subscription.status,
            }
          : null,
      };
    },
    async openPortal({ principal }, signal) {
      const verified = assertPrincipal(principal);
      const configurationId = parsedOptions.portalConfigurationId;
      if (configurationId === null) throw new HttpError("Stripe Customer Portal is not configured.", 503);
      const account = await options.repository.readAccount(verified.tenantId, signal);
      if (account?.stripeCustomerId === null || account?.stripeCustomerId === undefined || account.livemode === null) {
        throw new HttpError("Stripe customer is not bound.", 409);
      }
      if (account.livemode !== parsedOptions.livemode) {
        throw new HttpError("Stripe billing mode changed.", 409);
      }
      const returnUrl = new URL("/?billing=portal-return", publicOrigin).href;
      const portal = await options.gateway.createPortalSession(
        {
          configurationId,
          customerId: account.stripeCustomerId,
          requestId: cryptoProvider.randomUUID(),
          returnUrl,
        },
        signal,
      );
      if (
        portal.configurationId !== configurationId ||
        portal.customerId !== account.stripeCustomerId ||
        portal.livemode !== parsedOptions.livemode ||
        portal.returnUrl !== returnUrl
      ) {
        throw new HttpError("Stripe Customer Portal Session is invalid.", 503);
      }
      return { portalUrl: portal.url };
    },
    ready(signal) {
      return options.repository.ready(signal);
    },
    async startCheckout({ planKey, principal }, signal) {
      const verified = assertPrincipal(principal);
      const plan = options.catalog.byPlanKey(planKey);
      if (!plan) throw new HttpError("Billing plan is not available.", 400);
      const [account, currentSubscription] = await Promise.all([
        options.repository.readAccount(verified.tenantId, signal),
        options.repository.readCurrentSubscription(verified.tenantId, signal),
      ]);
      if (
        currentSubscription &&
        currentSubscription.status !== "canceled" &&
        currentSubscription.status !== "incomplete_expired"
      ) {
        throw new HttpError("An existing Stripe subscription must be managed before starting Checkout.", 409);
      }
      if (
        account?.livemode !== null &&
        account?.livemode !== undefined &&
        account.livemode !== parsedOptions.livemode
      ) {
        throw new HttpError("Stripe billing mode changed.", 409);
      }
      const reserved = await options.repository.reserveCheckoutAttempt(
        {
          attemptId: cryptoProvider.randomUUID(),
          livemode: parsedOptions.livemode,
          planKey: plan.planKey,
          stripeCustomerId: account?.stripeCustomerId ?? null,
          stripePriceId: plan.stripePriceId,
          tenantId: verified.tenantId,
        },
        signal,
      );
      if (reserved.kind !== "reserved") throw new HttpError("Checkout state changed. Retry the request.", 409);
      const attempt = reserved.attempt;
      let checkout: Awaited<ReturnType<StripeBillingGatewayV1["createCheckoutSession"]>>;
      try {
        checkout = await options.gateway.createCheckoutSession(
          {
            attemptId: attempt.attemptId,
            cancelUrl: new URL("/?billing=cancelled", publicOrigin).href,
            customerId: attempt.stripeCustomerId,
            plan: { ...plan, stripePriceId: attempt.stripePriceId },
            successUrl: new URL("/?billing=success", publicOrigin).href,
            tenantId: verified.tenantId,
          },
          signal,
        );
      } catch (error) {
        if (error instanceof StripeGatewayErrorV1 && !error.retryable) {
          const failed = await options.repository.failCheckoutAttempt(
            { attemptId: attempt.attemptId, tenantId: attempt.tenantId },
            signal,
          );
          if (failed.kind !== "failed") throw new HttpError("Checkout state changed. Retry the request.", 409);
        }
        throw error;
      }
      if (checkout.livemode !== parsedOptions.livemode) {
        throw new HttpError("Stripe Checkout mode is invalid.", 503);
      }
      const opened = await options.repository.openCheckoutAttempt(
        {
          attemptId: attempt.attemptId,
          expiresAt: checkout.expiresAt,
          stripeCheckoutSessionId: checkout.id,
          tenantId: attempt.tenantId,
        },
        signal,
      );
      if (opened.kind !== "open") throw new HttpError("Checkout state changed. Retry the request.", 409);
      return { checkoutUrl: checkout.url };
    },
  } satisfies StripeBillingServiceV1);
}
