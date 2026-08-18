import { describe, expect, it, vi } from "vitest";

import { authenticateManimPrincipal } from "../manim-request-principal";
import type { EntitlementSnapshotV1 } from "./entitlement-repository";
import { FakeStripeBillingGatewayV1 } from "./fake-stripe-gateway";
import {
  createStripeCheckoutPlanCatalogV1,
  DEFAULT_PRO_AI_SUGGESTION_LIMIT_V1,
  DEFAULT_PRO_EXPORT_PUBLICATION_LIMIT_V1,
  DEFAULT_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT_V1,
} from "./plan-catalog";
import type {
  BillingCheckoutAttemptV1,
  BillingSubscriptionV1,
  StripeBillingAccountV1,
  StripeBillingRepositoryV1,
  StripeEventInboxEntryV1,
} from "./stripe-billing-repository";
import { createStripeBillingServiceV1 } from "./stripe-billing-service";
import { type CanonicalStripeSubscriptionV1, STRIPE_API_VERSION_V1, StripeGatewayErrorV1 } from "./stripe-gateway";

const TENANT_ID = "organization-a";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "cus_service_customer";
const SUBSCRIPTION_ID = "sub_service_subscription";
const PRICE_ID = "price_service_pro";
const PORTAL_CONFIGURATION_ID = "bpc_service_portal";
const WEBHOOK_SECRET = "whsec_service_test_secret";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const PERIOD_START = new Date("2026-08-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-09-01T00:00:00.000Z");

const catalog = createStripeCheckoutPlanCatalogV1({
  pro: { renderJobLimit: 100, stripePriceId: PRICE_ID },
});

type RepositoryFixture = ReturnType<typeof repositoryFixture>;
type ReconciliationInput = Parameters<StripeBillingRepositoryV1["reconcileSubscription"]>[0];

function repositoryFixture() {
  const state: {
    account: StripeBillingAccountV1 | null;
    attempts: Map<string, BillingCheckoutAttemptV1>;
    beforeReconcile: ((input: ReconciliationInput) => Promise<void>) | null;
    entitlement: EntitlementSnapshotV1 | null;
    eventDigests: Map<string, string>;
    events: Map<string, StripeEventInboxEntryV1>;
    forcedConflicts: number;
    subscription: BillingSubscriptionV1 | null;
  } = {
    account: null,
    attempts: new Map(),
    beforeReconcile: null,
    entitlement: null,
    eventDigests: new Map(),
    events: new Map(),
    forcedConflicts: 0,
    subscription: null,
  };

  const reconcileSubscription = vi.fn<StripeBillingRepositoryV1["reconcileSubscription"]>(async (input) => {
    await state.beforeReconcile?.(input);
    const account = state.account;
    const event = state.events.get(input.sourceEventId);
    if (!account || account.stripeCustomerId !== input.stripeCustomerId || account.livemode !== input.livemode) {
      return { kind: "unbound" };
    }
    if (!event || event.tenantId !== input.tenantId) return { kind: "event-conflict" };
    if (state.forcedConflicts > 0) {
      state.forcedConflicts -= 1;
      state.account = {
        ...account,
        entitlementGeneration: account.entitlementGeneration + 1n,
        reconcileGeneration: account.reconcileGeneration + 1n,
        reconciledAt: NOW,
        updatedAt: NOW,
      };
      return {
        entitlementGeneration: state.account.entitlementGeneration,
        kind: "conflict",
        observationGeneration: state.account.observationGeneration,
        reconcileGeneration: state.account.reconcileGeneration,
      };
    }
    if (
      account.entitlementGeneration !== input.entitlement.expectedGeneration ||
      account.observationGeneration !== input.expectedObservationGeneration ||
      account.reconcileGeneration !== input.expectedReconcileGeneration
    ) {
      return {
        entitlementGeneration: account.entitlementGeneration,
        kind: "conflict",
        observationGeneration: account.observationGeneration,
        reconcileGeneration: account.reconcileGeneration,
      };
    }

    const entitlement: EntitlementSnapshotV1 = {
      ...input.entitlement,
      createdAt: NOW,
    };
    const subscription: BillingSubscriptionV1 = {
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      canonicalDigest: input.canonicalDigest,
      canonicalRetrievedAt: input.canonicalRetrievedAt,
      createdAt: state.subscription?.createdAt ?? NOW,
      currentPeriodEnd: input.currentPeriodEnd,
      currentPeriodStart: input.currentPeriodStart,
      entitlementSnapshotId: entitlement.snapshotId,
      entitlementSourceGeneration: entitlement.sourceGeneration,
      livemode: input.livemode,
      planKey: input.planKey,
      reconcileGeneration: input.expectedReconcileGeneration + 1n,
      sourceEventId: input.sourceEventId,
      status: input.status,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      tenantId: input.tenantId,
      updatedAt: NOW,
    };
    state.account = {
      ...account,
      entitlementGeneration: entitlement.sourceGeneration,
      reconcileGeneration: subscription.reconcileGeneration,
      reconciledAt: NOW,
      updatedAt: NOW,
    };
    state.entitlement = entitlement;
    state.subscription = subscription;
    for (const [attemptId, attempt] of state.attempts) {
      const consumesAttempt =
        (input.status !== "canceled" && input.status !== "incomplete_expired") || event.checkoutAttemptId === attemptId;
      if (consumesAttempt && (attempt.state === "reserved" || attempt.state === "open")) {
        state.attempts.set(attemptId, { ...attempt, state: "consumed" });
      }
    }
    state.events.set(input.sourceEventId, { ...event, processedAt: NOW, state: "processed" });
    return { account: state.account, entitlement, kind: "applied", replayed: false, subscription };
  });

  const repository: StripeBillingRepositoryV1 = {
    acknowledgeEvent: vi.fn<StripeBillingRepositoryV1["acknowledgeEvent"]>(async (input) => {
      const account = state.account;
      const subscription = state.subscription;
      const event = state.events.get(input.stripeEventId);
      if (
        !account ||
        !subscription ||
        !event ||
        account.reconcileGeneration !== input.expectedReconcileGeneration ||
        subscription.reconcileGeneration !== input.expectedReconcileGeneration ||
        subscription.stripeSubscriptionId !== input.expectedStripeSubscriptionId ||
        subscription.status !== input.expectedSubscriptionStatus ||
        event.tenantId !== input.tenantId ||
        event.stripeCustomerId !== input.stripeCustomerId ||
        event.livemode !== input.livemode
      ) {
        return { kind: "conflict" } as const;
      }
      if (event.state === "processed") return { event, kind: "processed", replayed: true } as const;
      const processed = { ...event, processedAt: NOW, state: "processed" as const };
      state.events.set(input.stripeEventId, processed);
      return { event: processed, kind: "processed", replayed: false } as const;
    }),
    bindCustomer: vi.fn<StripeBillingRepositoryV1["bindCustomer"]>(async (input) => {
      if (state.account === null) {
        state.account = {
          createdAt: NOW,
          entitlementGeneration: 0n,
          livemode: input.livemode,
          observationGeneration: 0n,
          reconcileGeneration: 0n,
          reconciledAt: null,
          stripeCustomerId: input.stripeCustomerId,
          tenantId: input.tenantId,
          updatedAt: NOW,
        };
        return { account: state.account, kind: "bound", replayed: false } as const;
      }
      if (state.account.stripeCustomerId === null && state.account.livemode === null) {
        state.account = {
          ...state.account,
          livemode: input.livemode,
          stripeCustomerId: input.stripeCustomerId,
          updatedAt: NOW,
        };
        return { account: state.account, kind: "bound", replayed: false } as const;
      }
      if (
        state.account.tenantId !== input.tenantId ||
        state.account.stripeCustomerId !== input.stripeCustomerId ||
        state.account.livemode !== input.livemode
      ) {
        return { kind: "conflict" } as const;
      }
      return { account: state.account, kind: "bound", replayed: true } as const;
    }),
    close: vi.fn(async () => undefined),
    reserveCheckoutAttempt: vi.fn<StripeBillingRepositoryV1["reserveCheckoutAttempt"]>(async (input) => {
      if (
        state.subscription &&
        state.subscription.status !== "canceled" &&
        state.subscription.status !== "incomplete_expired"
      ) {
        return { kind: "conflict" } as const;
      }
      const existing = [...state.attempts.values()].find(
        (attempt) => attempt.tenantId === input.tenantId && (attempt.state === "reserved" || attempt.state === "open"),
      );
      if (existing) return { attempt: existing, kind: "reserved", replayed: true } as const;
      const attempt: BillingCheckoutAttemptV1 = {
        ...input,
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
        state: "reserved",
        stripeCheckoutSessionId: null,
      };
      state.account ??= {
        createdAt: NOW,
        entitlementGeneration: 0n,
        livemode: null,
        observationGeneration: 0n,
        reconcileGeneration: 0n,
        reconciledAt: null,
        stripeCustomerId: null,
        tenantId: input.tenantId,
        updatedAt: NOW,
      };
      state.attempts.set(input.attemptId, attempt);
      return { attempt, kind: "reserved", replayed: false } as const;
    }),
    reserveCanonicalObservation: vi.fn<StripeBillingRepositoryV1["reserveCanonicalObservation"]>(async (input) => {
      const account = state.account;
      const event = state.events.get(input.stripeEventId);
      if (
        !account ||
        account.tenantId !== input.tenantId ||
        !event ||
        event.tenantId !== input.tenantId ||
        event.stripeCustomerId !== input.stripeCustomerId ||
        event.livemode !== input.livemode ||
        (account.stripeCustomerId !== null &&
          (account.stripeCustomerId !== input.stripeCustomerId || account.livemode !== input.livemode))
      ) {
        return { kind: "conflict" } as const;
      }
      if (event.state === "processed") return { kind: "processed" } as const;
      state.account = {
        ...account,
        observationGeneration: account.observationGeneration + 1n,
        updatedAt: NOW,
      };
      return { kind: "reserved", observationGeneration: state.account.observationGeneration } as const;
    }),
    openCheckoutAttempt: vi.fn<StripeBillingRepositoryV1["openCheckoutAttempt"]>(async (input) => {
      const existing = state.attempts.get(input.attemptId);
      if (!existing || existing.tenantId !== input.tenantId) return { kind: "conflict" } as const;
      if (existing.state === "open") {
        return existing.stripeCheckoutSessionId === input.stripeCheckoutSessionId &&
          existing.expiresAt.getTime() === input.expiresAt.getTime()
          ? ({ attempt: existing, kind: "open", replayed: true } as const)
          : ({ kind: "conflict" } as const);
      }
      if (existing.state !== "reserved") return { kind: "conflict" } as const;
      const attempt: BillingCheckoutAttemptV1 = {
        ...existing,
        expiresAt: input.expiresAt,
        state: "open",
        stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      };
      state.attempts.set(input.attemptId, attempt);
      return { attempt, kind: "open", replayed: false } as const;
    }),
    failCheckoutAttempt: vi.fn<StripeBillingRepositoryV1["failCheckoutAttempt"]>(async (input) => {
      const existing = state.attempts.get(input.attemptId);
      if (!existing || existing.tenantId !== input.tenantId) return { kind: "conflict" } as const;
      if (existing.state === "failed") return { attempt: existing, kind: "failed", replayed: true } as const;
      if (existing.state !== "reserved") return { kind: "conflict" } as const;
      const attempt: BillingCheckoutAttemptV1 = { ...existing, state: "failed" };
      state.attempts.set(input.attemptId, attempt);
      return { attempt, kind: "failed", replayed: false } as const;
    }),
    ingestEvent: vi.fn<StripeBillingRepositoryV1["ingestEvent"]>(async (input) => {
      const existing = state.events.get(input.stripeEventId);
      if (existing) {
        if (state.eventDigests.get(input.stripeEventId) !== input.payloadDigest) return { kind: "conflict" } as const;
        return { event: existing, kind: "received", replayed: true } as const;
      }
      const event: StripeEventInboxEntryV1 = {
        checkoutAttemptId: input.checkoutAttemptId,
        eventCreatedAt: input.eventCreatedAt,
        eventType: input.eventType,
        livemode: input.livemode,
        payloadDigest: input.payloadDigest,
        processedAt: null,
        receivedAt: NOW,
        sourceObjectId: input.sourceObjectId,
        state: "pending",
        stripeCustomerId: input.stripeCustomerId,
        stripeEventId: input.stripeEventId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        tenantId: input.tenantId,
      };
      state.eventDigests.set(input.stripeEventId, input.payloadDigest);
      state.events.set(input.stripeEventId, event);
      return { event, kind: "received", replayed: false } as const;
    }),
    readAccount: vi.fn(async (tenantId) => (state.account?.tenantId === tenantId ? state.account : null)),
    readAccountByStripeCustomerId: vi.fn(async (customerId, livemode) => {
      const account = state.account;
      return account !== null && account.stripeCustomerId === customerId && account.livemode === livemode
        ? account
        : null;
    }),
    readCheckoutAttempt: vi.fn(async (attemptId) => state.attempts.get(attemptId) ?? null),
    readCheckoutAttemptBySessionId: vi.fn(
      async (sessionId) =>
        [...state.attempts.values()].find(
          (attempt) => attempt.stripeCheckoutSessionId !== null && attempt.stripeCheckoutSessionId === sessionId,
        ) ?? null,
    ),
    readCurrentEntitlement: vi.fn(async (tenantId) =>
      state.entitlement?.tenantId === tenantId ? state.entitlement : null,
    ),
    readCurrentSubscription: vi.fn(async (tenantId) =>
      state.subscription?.tenantId === tenantId ? state.subscription : null,
    ),
    ready: vi.fn(async () => true),
    reconcileSubscription,
  };
  return { repository, state };
}

async function ownerPrincipal() {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId: USER_ID, tenantId: TENANT_ID }) },
    {},
    new AbortController().signal,
  );
}

function canonicalSubscription(overrides: Partial<CanonicalStripeSubscriptionV1> = {}): CanonicalStripeSubscriptionV1 {
  return {
    cancelAtPeriodEnd: false,
    customerId: CUSTOMER_ID,
    id: SUBSCRIPTION_ID,
    livemode: false,
    periodEnd: PERIOD_END,
    periodStart: PERIOD_START,
    priceId: PRICE_ID,
    status: "active",
    ...overrides,
  };
}

function serviceFixture(
  options: {
    canonical?: CanonicalStripeSubscriptionV1;
    clock?: () => Date;
    gatewayLivemode?: boolean;
    livemode?: boolean;
    repository?: RepositoryFixture;
  } = {},
) {
  const repository = options.repository ?? repositoryFixture();
  const gateway = new FakeStripeBillingGatewayV1({
    livemode: options.gatewayLivemode ?? false,
    subscriptions: [options.canonical ?? canonicalSubscription()],
  });
  const service = createStripeBillingServiceV1({
    catalog,
    clock: options.clock ?? (() => new Date(NOW)),
    gateway,
    livemode: options.livemode ?? false,
    portalConfigurationId: PORTAL_CONFIGURATION_ID,
    publicOrigin: "https://studio.poietra.example",
    repository: repository.repository,
    webhookSigningSecret: WEBHOOK_SECRET,
  });
  return { gateway, repository, service };
}

async function signedWebhook(input: {
  attemptId?: string;
  checkoutSessionId?: string;
  createdAt?: Date;
  customerId?: string;
  eventId: string;
  livemode?: boolean;
  signatureAt?: Date;
  subscriptionId?: string;
  type?: "checkout.session.completed" | "customer.subscription.updated";
}) {
  const type = input.type ?? "customer.subscription.updated";
  const dataObject =
    type === "checkout.session.completed"
      ? {
          client_reference_id: input.attemptId,
          customer: input.customerId ?? CUSTOMER_ID,
          id: input.checkoutSessionId,
          object: "checkout.session",
          subscription: input.subscriptionId ?? SUBSCRIPTION_ID,
        }
      : {
          customer: input.customerId ?? CUSTOMER_ID,
          id: input.subscriptionId ?? SUBSCRIPTION_ID,
          metadata: input.attemptId ? { poietra_checkout_attempt_id: input.attemptId } : {},
          object: "subscription",
        };
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      api_version: STRIPE_API_VERSION_V1,
      created: Math.floor((input.createdAt ?? NOW).getTime() / 1_000),
      data: { object: dataObject },
      id: input.eventId,
      livemode: input.livemode ?? false,
      object: "event",
      type,
    }),
  );
  const timestamp = Math.floor((input.signatureAt ?? NOW).getTime() / 1_000);
  const signedContent = new TextEncoder().encode(`${timestamp}.${new TextDecoder().decode(rawBody)}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, signedContent));
  return {
    rawBody,
    stripeSignature: `t=${timestamp},v1=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}

async function startCheckout(fixture: ReturnType<typeof serviceFixture>) {
  const checkout = await fixture.service.startCheckout({ planKey: "pro", principal: await ownerPrincipal() });
  const request = fixture.gateway.checkoutRequests()[0];
  const attempt = [...fixture.repository.state.attempts.values()][0];
  if (!request || !attempt) throw new TypeError("Checkout fixture did not persist its correlation.");
  return { attempt, checkout, request };
}

describe("Stripe billing service", () => {
  it("opens a fixed Customer Portal for the durable customer without consulting subscription status", async () => {
    const fixture = serviceFixture();
    fixture.repository.state.account = {
      createdAt: NOW,
      entitlementGeneration: 1n,
      livemode: false,
      observationGeneration: 1n,
      reconcileGeneration: 1n,
      reconciledAt: NOW,
      stripeCustomerId: CUSTOMER_ID,
      tenantId: TENANT_ID,
      updatedAt: NOW,
    };
    fixture.repository.state.subscription = {
      cancelAtPeriodEnd: false,
      canonicalDigest: "a".repeat(64),
      canonicalRetrievedAt: NOW,
      createdAt: NOW,
      currentPeriodEnd: PERIOD_END,
      currentPeriodStart: PERIOD_START,
      entitlementSnapshotId: "00000000-0000-4000-8000-000000000777",
      entitlementSourceGeneration: 1n,
      livemode: false,
      planKey: "pro",
      reconcileGeneration: 1n,
      sourceEventId: "evt_portal_canceled",
      status: "canceled",
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      tenantId: TENANT_ID,
      updatedAt: NOW,
    };

    const principal = await ownerPrincipal();
    const [first, second] = await Promise.all([
      fixture.service.openPortal({ principal }),
      fixture.service.openPortal({ principal }),
    ]);
    expect(first.portalUrl).toMatch(/^https:\/\/billing\.stripe\.test\/p\/session\//u);
    expect(second.portalUrl).toMatch(/^https:\/\/billing\.stripe\.test\/p\/session\//u);
    expect(second.portalUrl).not.toBe(first.portalUrl);
    const portalRequests = fixture.gateway.portalRequests();
    expect(portalRequests).toHaveLength(2);
    expect(new Set(portalRequests.map((request) => request.requestId)).size).toBe(2);
    for (const request of portalRequests) {
      expect(request).toEqual({
        configurationId: PORTAL_CONFIGURATION_ID,
        customerId: CUSTOMER_ID,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        returnUrl: "https://studio.poietra.example/?billing=portal-return",
      });
    }
    expect(fixture.repository.repository.readCurrentSubscription).not.toHaveBeenCalled();
  });

  it("rejects Customer Portal before Stripe when the durable customer binding is absent or in another mode", async () => {
    const unbound = serviceFixture();
    await expect(unbound.service.openPortal({ principal: await ownerPrincipal() })).rejects.toMatchObject({
      status: 409,
    });
    expect(unbound.gateway.portalRequests()).toEqual([]);

    const mismatched = serviceFixture();
    mismatched.repository.state.account = {
      createdAt: NOW,
      entitlementGeneration: 0n,
      livemode: true,
      observationGeneration: 0n,
      reconcileGeneration: 0n,
      reconciledAt: null,
      stripeCustomerId: CUSTOMER_ID,
      tenantId: TENANT_ID,
      updatedAt: NOW,
    };
    await expect(mismatched.service.openPortal({ principal: await ownerPrincipal() })).rejects.toMatchObject({
      status: 409,
    });
    expect(mismatched.gateway.portalRequests()).toEqual([]);

    const invalidProviderMode = serviceFixture({ gatewayLivemode: true });
    invalidProviderMode.repository.state.account = {
      ...mismatched.repository.state.account,
      livemode: false,
    };
    await expect(invalidProviderMode.service.openPortal({ principal: await ownerPrincipal() })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("uses one durable Checkout intent across parallel and post-response retries", async () => {
    const fixture = serviceFixture();
    const principal = await ownerPrincipal();
    const [first, second] = await Promise.all([
      fixture.service.startCheckout({ planKey: "pro", principal }),
      fixture.service.startCheckout({ planKey: "pro", principal }),
    ]);
    expect(second).toEqual(first);
    expect([...new Set(fixture.gateway.checkoutRequests().map((request) => request.attemptId))]).toHaveLength(1);
    expect(fixture.repository.state.attempts.size).toBe(1);

    const retryFixture = serviceFixture();
    vi.mocked(retryFixture.repository.repository.openCheckoutAttempt).mockRejectedValueOnce(
      new Error("simulated durable finalize outage"),
    );
    await expect(retryFixture.service.startCheckout({ planKey: "pro", principal })).rejects.toThrow(
      /simulated durable finalize outage/u,
    );
    await expect(retryFixture.service.startCheckout({ planKey: "pro", principal })).resolves.toMatchObject({
      checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//u),
    });
    expect([...new Set(retryFixture.gateway.checkoutRequests().map((request) => request.attemptId))]).toHaveLength(1);
    expect(retryFixture.repository.state.attempts.size).toBe(1);
  });

  it("pins an in-flight Checkout price across a catalog deployment", async () => {
    const fixture = serviceFixture();
    const principal = await ownerPrincipal();
    const original = await fixture.service.startCheckout({ planKey: "pro", principal });
    const attempt = [...fixture.repository.state.attempts.values()][0];
    if (!attempt) throw new TypeError("Checkout intent was not reserved.");
    const rotatedService = createStripeBillingServiceV1({
      catalog: createStripeCheckoutPlanCatalogV1({
        pro: { renderJobLimit: 100, stripePriceId: "price_rotated_pro" },
      }),
      clock: () => new Date(NOW),
      gateway: fixture.gateway,
      livemode: false,
      portalConfigurationId: PORTAL_CONFIGURATION_ID,
      publicOrigin: "https://studio.poietra.example",
      repository: fixture.repository.repository,
      webhookSigningSecret: WEBHOOK_SECRET,
    });

    await expect(rotatedService.startCheckout({ planKey: "pro", principal })).resolves.toEqual(original);
    expect(fixture.gateway.checkoutRequests().at(-1)?.plan.stripePriceId).toBe(PRICE_ID);
    await rotatedService.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_catalog_rotated" }),
    );
    expect(fixture.repository.state.entitlement).toMatchObject({ planKey: "pro", renderEnabled: true });
  });

  it("grants no access on redirect and activates only after signed webhooks and canonical refetch", async () => {
    const fixture = serviceFixture();
    const retrieveSubscription = vi.spyOn(fixture.gateway, "retrieveSubscription");
    const { attempt, checkout, request } = await startCheckout(fixture);

    expect(checkout.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//u);
    expect(request).toMatchObject({ customerId: null, plan: { planKey: "pro" }, tenantId: TENANT_ID });
    await expect(fixture.service.readStatus({ principal: await ownerPrincipal() })).resolves.toMatchObject({
      configured: false,
      entitlement: null,
      subscription: null,
    });

    await fixture.service.acceptWebhook(
      await signedWebhook({
        attemptId: attempt.attemptId,
        checkoutSessionId: attempt.stripeCheckoutSessionId ?? undefined,
        eventId: "evt_checkout_completed",
        type: "checkout.session.completed",
      }),
    );
    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_subscription_updated" }),
    );

    expect(retrieveSubscription).toHaveBeenCalledTimes(2);
    await expect(fixture.service.readStatus({ principal: await ownerPrincipal() })).resolves.toMatchObject({
      configured: true,
      entitlement: {
        accessState: "active",
        accessUntil: PERIOD_END.toISOString(),
        planKey: "pro",
        renderEnabled: true,
        renderJobLimit: 100,
      },
      subscription: { planKey: "pro", status: "active" },
    });
  });

  it("acknowledges an exact duplicate event without reconciling twice", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);
    const webhook = await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_duplicate_event" });

    await fixture.service.acceptWebhook(webhook);
    const generation = fixture.repository.state.account?.reconcileGeneration;
    await fixture.service.acceptWebhook(webhook);

    expect(fixture.repository.repository.reconcileSubscription).toHaveBeenCalledOnce();
    expect(fixture.repository.state.account?.reconcileGeneration).toBe(generation);
    expect(fixture.repository.state.events.get("evt_duplicate_event")?.state).toBe("processed");
  });

  it("durably keeps a verified event pending across a canonical Stripe outage", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);
    const webhook = await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_retry_after_stripe_outage" });
    vi.spyOn(fixture.gateway, "retrieveSubscription").mockRejectedValueOnce(
      new StripeGatewayErrorV1("simulated Stripe outage", { retryable: true }),
    );

    await expect(fixture.service.acceptWebhook(webhook)).rejects.toThrow(/simulated Stripe outage/u);
    expect(fixture.repository.state.events.get("evt_retry_after_stripe_outage")?.state).toBe("pending");
    expect(fixture.repository.state.account).toMatchObject({
      observationGeneration: 1n,
      stripeCustomerId: null,
    });

    await fixture.service.acceptWebhook(webhook);
    expect(fixture.repository.state.events.get("evt_retry_after_stripe_outage")?.state).toBe("processed");
    expect(fixture.repository.state.entitlement).toMatchObject({ accessState: "active", renderEnabled: true });
  });

  it("keeps canonical state for an out-of-order event and retries a competing reconciliation", async () => {
    const fixture = serviceFixture();
    const retrieveSubscription = vi.spyOn(fixture.gateway, "retrieveSubscription");
    const { attempt } = await startCheckout(fixture);
    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_newer_reconcile" }),
    );
    fixture.repository.state.forcedConflicts = 1;

    await fixture.service.acceptWebhook(
      await signedWebhook({
        attemptId: attempt.attemptId,
        createdAt: new Date(NOW.getTime() - 60_000),
        eventId: "evt_older_competing_reconcile",
      }),
    );

    expect(retrieveSubscription).toHaveBeenCalledTimes(3);
    expect(fixture.repository.repository.reconcileSubscription).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(fixture.repository.repository.reconcileSubscription).mock.calls;
    expect(calls.map(([input]) => input.expectedObservationGeneration)).toEqual([1n, 2n, 3n]);
    expect(calls.map(([input]) => input.expectedReconcileGeneration)).toEqual([0n, 1n, 2n]);
    expect(calls.map(([input]) => input.entitlement.expectedGeneration)).toEqual([0n, 1n, 2n]);
    expect(fixture.repository.state.entitlement).toMatchObject({ accessState: "active", sourceGeneration: 3n });
  });

  it("cannot apply an old canonical observation after a newer observation commits", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);
    const staleEventId = "evt_stale_canonical_observation";
    let releaseStale: (() => void) | undefined;
    let staleReached: (() => void) | undefined;
    const staleCanContinue = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const staleIsWaiting = new Promise<void>((resolve) => {
      staleReached = resolve;
    });
    let paused = false;
    fixture.repository.state.beforeReconcile = async (input) => {
      if (input.sourceEventId !== staleEventId || paused) return;
      paused = true;
      staleReached?.();
      await staleCanContinue;
    };

    const staleAcceptance = fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: staleEventId }),
    );
    await staleIsWaiting;

    fixture.gateway.upsertSubscription(canonicalSubscription({ status: "canceled" }));
    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_newer_canonical_observation" }),
    );
    releaseStale?.();
    await staleAcceptance;

    const calls = vi.mocked(fixture.repository.repository.reconcileSubscription).mock.calls.map(([input]) => input);
    expect(calls.map((input) => [input.sourceEventId, input.status, input.expectedObservationGeneration])).toEqual([
      [staleEventId, "active", 1n],
      ["evt_newer_canonical_observation", "canceled", 2n],
      [staleEventId, "canceled", 3n],
    ]);
    expect(fixture.repository.state.account?.observationGeneration).toBe(3n);
    expect(fixture.repository.state.entitlement).toMatchObject({ accessState: "blocked", renderEnabled: false });
    expect(fixture.repository.state.subscription).toMatchObject({ status: "canceled" });
  });

  it("acknowledges a terminal event for an older subscription without replacing the active one", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);
    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_authoritative_subscription" }),
    );
    const generation = fixture.repository.state.account?.reconcileGeneration;
    fixture.gateway.upsertSubscription(canonicalSubscription({ id: "sub_stale_terminal", status: "canceled" }));

    await fixture.service.acceptWebhook(
      await signedWebhook({
        attemptId: attempt.attemptId,
        eventId: "evt_stale_terminal_subscription",
        subscriptionId: "sub_stale_terminal",
      }),
    );

    expect(fixture.repository.state.account?.reconcileGeneration).toBe(generation);
    expect(fixture.repository.state.subscription?.stripeSubscriptionId).toBe(SUBSCRIPTION_ID);
    expect(fixture.repository.state.events.get("evt_stale_terminal_subscription")?.state).toBe("processed");
  });

  it("preserves the usage period across an overlapping rollout entitlement", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);
    fixture.repository.state.account = {
      createdAt: NOW,
      entitlementGeneration: 1n,
      livemode: false,
      observationGeneration: 0n,
      reconcileGeneration: 0n,
      reconciledAt: null,
      stripeCustomerId: CUSTOMER_ID,
      tenantId: TENANT_ID,
      updatedAt: NOW,
    };
    fixture.repository.state.entitlement = {
      accessState: "active",
      accessUntil: new Date("2026-08-15T00:00:00.000Z"),
      createdAt: NOW,
      periodEnd: new Date("2026-08-15T00:00:00.000Z"),
      periodStart: new Date("2026-07-15T00:00:00.000Z"),
      planKey: "pro",
      renderEnabled: true,
      renderJobLimit: 50,
      snapshotId: "00000000-0000-4000-8000-000000000101",
      sourceGeneration: 1n,
      tenantId: TENANT_ID,
      usagePeriodKey: "rollout:preserve-consumed-render-usage",
    };

    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_overlapping_rollout" }),
    );

    expect(fixture.repository.state.entitlement).toMatchObject({
      sourceGeneration: 2n,
      usagePeriodKey: "rollout:preserve-consumed-render-usage",
    });
  });

  it("maps past_due to a bounded grace entitlement", async () => {
    const fixture = serviceFixture({ canonical: canonicalSubscription({ status: "past_due" }) });
    const { attempt } = await startCheckout(fixture);

    await fixture.service.acceptWebhook(await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_past_due" }));

    expect(fixture.repository.state.entitlement).toMatchObject({
      accessState: "grace",
      accessUntil: new Date("2026-08-04T12:00:00.000Z"),
      renderEnabled: true,
      renderJobLimit: 100,
    });
  });

  it("does not extend an existing past_due grace deadline on later canonical changes", async () => {
    let currentTime = new Date(NOW);
    const fixture = serviceFixture({
      canonical: canonicalSubscription({ status: "past_due" }),
      clock: () => new Date(currentTime),
    });
    const { attempt } = await startCheckout(fixture);
    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_past_due_initial" }),
    );
    const initialDeadline = fixture.repository.state.entitlement?.accessUntil;
    expect(initialDeadline).toEqual(new Date("2026-08-04T12:00:00.000Z"));

    currentTime = new Date("2026-08-03T12:00:00.000Z");
    fixture.gateway.upsertSubscription(canonicalSubscription({ cancelAtPeriodEnd: true, status: "past_due" }));
    await fixture.service.acceptWebhook(
      await signedWebhook({
        attemptId: attempt.attemptId,
        createdAt: currentTime,
        eventId: "evt_past_due_later_change",
        signatureAt: currentTime,
      }),
    );

    expect(fixture.repository.state.entitlement).toMatchObject({
      accessState: "grace",
      accessUntil: initialDeadline,
    });

    currentTime = new Date("2026-09-01T00:00:00.000Z");
    fixture.gateway.upsertSubscription(
      canonicalSubscription({
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
        periodStart: currentTime,
        status: "past_due",
      }),
    );
    await fixture.service.acceptWebhook(
      await signedWebhook({
        attemptId: attempt.attemptId,
        createdAt: currentTime,
        eventId: "evt_past_due_period_rollover",
        signatureAt: currentTime,
      }),
    );
    expect(fixture.repository.state.entitlement).toMatchObject({
      accessState: "blocked",
      renderEnabled: false,
      renderJobLimit: 0,
    });
  });

  it("maps a canceled subscription to blocked local access", async () => {
    const fixture = serviceFixture({ canonical: canonicalSubscription({ status: "canceled" }) });
    const { attempt } = await startCheckout(fixture);

    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_subscription_canceled" }),
    );

    expect(fixture.repository.state.entitlement).toMatchObject({
      accessState: "blocked",
      renderEnabled: false,
      renderJobLimit: 0,
    });
  });

  it("builds the applied entitlement with plan-derived billing v2 grant limits", async () => {
    const fixture = serviceFixture();
    const { attempt } = await startCheckout(fixture);

    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_grant_limits" }),
    );

    const [input] = vi.mocked(fixture.repository.repository.reconcileSubscription).mock.calls.at(-1) ?? [];
    expect(input?.entitlement).toMatchObject({
      aiSuggestionLimit: DEFAULT_PRO_AI_SUGGESTION_LIMIT_V1,
      exportPublicationLimit: DEFAULT_PRO_EXPORT_PUBLICATION_LIMIT_V1,
      publishedArtifactBytesLimit: DEFAULT_PRO_PUBLISHED_ARTIFACT_BYTES_LIMIT_V1,
      renderEnabled: true,
      renderJobLimit: 100,
    });
  });

  it("zeroes every billing v2 grant limit on a blocked entitlement", async () => {
    const fixture = serviceFixture({ canonical: canonicalSubscription({ status: "unpaid" }) });
    const { attempt } = await startCheckout(fixture);

    await fixture.service.acceptWebhook(
      await signedWebhook({ attemptId: attempt.attemptId, eventId: "evt_grant_limits_blocked" }),
    );

    const [input] = vi.mocked(fixture.repository.repository.reconcileSubscription).mock.calls.at(-1) ?? [];
    expect(input?.entitlement).toMatchObject({
      accessState: "blocked",
      aiSuggestionLimit: 0,
      exportPublicationLimit: 0,
      publishedArtifactBytesLimit: 0,
      renderJobLimit: 0,
    });
  });

  it("fails closed for an unknown plan and webhook or canonical mode mismatches", async () => {
    const unknownPlan = serviceFixture({ canonical: canonicalSubscription({ priceId: "price_unknown" }) });
    const unknownAttempt = (await startCheckout(unknownPlan)).attempt;
    await expect(
      unknownPlan.service.acceptWebhook(
        await signedWebhook({ attemptId: unknownAttempt.attemptId, eventId: "evt_unknown_plan" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(unknownPlan.repository.state.entitlement).toBeNull();
    expect(unknownPlan.repository.state.account).toMatchObject({ stripeCustomerId: null });
    expect(unknownPlan.repository.repository.bindCustomer).not.toHaveBeenCalled();
    expect(unknownPlan.repository.state.events.get("evt_unknown_plan")?.state).toBe("pending");

    const canonicalModeMismatch = serviceFixture({ canonical: canonicalSubscription({ livemode: true }) });
    const canonicalAttempt = (await startCheckout(canonicalModeMismatch)).attempt;
    await expect(
      canonicalModeMismatch.service.acceptWebhook(
        await signedWebhook({ attemptId: canonicalAttempt.attemptId, eventId: "evt_canonical_mode" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(canonicalModeMismatch.repository.state.entitlement).toBeNull();
    expect(canonicalModeMismatch.repository.state.account).toMatchObject({ stripeCustomerId: null });
    expect(canonicalModeMismatch.repository.repository.bindCustomer).not.toHaveBeenCalled();

    const canonicalCustomerMismatch = serviceFixture({
      canonical: canonicalSubscription({ customerId: "cus_other_customer" }),
    });
    const customerAttempt = (await startCheckout(canonicalCustomerMismatch)).attempt;
    await expect(
      canonicalCustomerMismatch.service.acceptWebhook(
        await signedWebhook({ attemptId: customerAttempt.attemptId, eventId: "evt_canonical_customer" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(canonicalCustomerMismatch.repository.state.account).toMatchObject({ stripeCustomerId: null });
    expect(canonicalCustomerMismatch.repository.repository.bindCustomer).not.toHaveBeenCalled();

    const webhookModeMismatch = serviceFixture();
    const webhookAttempt = (await startCheckout(webhookModeMismatch)).attempt;
    await expect(
      webhookModeMismatch.service.acceptWebhook(
        await signedWebhook({
          attemptId: webhookAttempt.attemptId,
          eventId: "evt_webhook_mode",
          livemode: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(webhookModeMismatch.repository.repository.ingestEvent).not.toHaveBeenCalled();
    expect(webhookModeMismatch.repository.state.entitlement).toBeNull();
  });
});
