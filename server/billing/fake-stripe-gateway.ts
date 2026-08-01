import {
  type CanonicalStripeSubscriptionV1,
  type CreateStripeCheckoutInputV1,
  parseCanonicalStripeSubscriptionV1,
  parseCreateStripeCheckoutInputV1,
  parseStripeSubscriptionIdV1,
  type StripeBillingGatewayV1,
  type StripeCheckoutSessionV1,
  StripeGatewayErrorV1,
} from "./stripe-gateway";

export class FakeStripeBillingGatewayV1 implements StripeBillingGatewayV1 {
  readonly #checkoutRequests: CreateStripeCheckoutInputV1[] = [];
  readonly #checkoutSessions = new Map<
    string,
    Readonly<{ input: CreateStripeCheckoutInputV1; session: StripeCheckoutSessionV1 }>
  >();
  readonly #livemode: boolean;
  readonly #subscriptions = new Map<string, CanonicalStripeSubscriptionV1>();

  constructor(
    options: Readonly<{ livemode?: boolean; subscriptions?: readonly CanonicalStripeSubscriptionV1[] }> = {},
  ) {
    this.#livemode = options.livemode ?? false;
    for (const subscription of options.subscriptions ?? []) this.upsertSubscription(subscription);
  }

  checkoutRequests(): readonly CreateStripeCheckoutInputV1[] {
    return this.#checkoutRequests.map((request) => ({ ...request, plan: { ...request.plan } }));
  }

  async createCheckoutSession(inputValue: CreateStripeCheckoutInputV1, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const input = parseCreateStripeCheckoutInputV1(inputValue);
    this.#checkoutRequests.push(input);
    const existing = this.#checkoutSessions.get(input.attemptId);
    if (existing) {
      if (
        existing.input.cancelUrl !== input.cancelUrl ||
        existing.input.customerId !== input.customerId ||
        existing.input.plan.planKey !== input.plan.planKey ||
        existing.input.plan.stripePriceId !== input.plan.stripePriceId ||
        existing.input.successUrl !== input.successUrl ||
        existing.input.tenantId !== input.tenantId
      ) {
        throw new StripeGatewayErrorV1("Stripe Checkout idempotency parameters changed.", { retryable: false });
      }
      return existing.session;
    }
    const compactAttemptId = input.attemptId.replaceAll("-", "");
    const session = Object.freeze({
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000),
      id: `cs_test_${compactAttemptId}`,
      livemode: this.#livemode,
      url: `https://checkout.stripe.test/c/pay/${compactAttemptId}`,
    }) satisfies StripeCheckoutSessionV1;
    this.#checkoutSessions.set(input.attemptId, { input, session });
    return session;
  }

  async retrieveSubscription(subscriptionIdValue: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const subscriptionId = parseStripeSubscriptionIdV1(subscriptionIdValue);
    const subscription = this.#subscriptions.get(subscriptionId);
    if (!subscription) {
      throw new StripeGatewayErrorV1("Stripe subscription is unavailable.", { retryable: false, status: 404 });
    }
    return Object.freeze({ ...subscription });
  }

  upsertSubscription(value: CanonicalStripeSubscriptionV1) {
    const subscription = parseCanonicalStripeSubscriptionV1(value);
    this.#subscriptions.set(subscription.id, Object.freeze({ ...subscription }));
  }
}
