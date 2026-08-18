import { createHash, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import { organizationIdSchemaV1 } from "../../accounts/account-domain";
import { parseEntitlementSnapshotV1 } from "../../billing/entitlement-repository";
import {
  type BillingCheckoutAttemptV1,
  type BillingSubscriptionV1,
  type IngestStripeEventInputV1,
  parseAcknowledgeStripeEventInputV1,
  parseBillingCheckoutAttemptIdV1,
  parseBillingCheckoutAttemptV1,
  parseBillingSubscriptionV1,
  parseBindStripeCustomerInputV1,
  parseFailBillingCheckoutAttemptInputV1,
  parseIngestStripeEventInputV1,
  parseOpenBillingCheckoutAttemptInputV1,
  parseReconcileBillingSubscriptionInputV1,
  parseReserveCanonicalObservationInputV1,
  parseReserveBillingCheckoutAttemptInputV1,
  parseStripeBillingAccountV1,
  parseStripeCheckoutSessionIdV1,
  parseStripeCustomerLookupV1,
  parseStripeEventInboxEntryV1,
  type ReconcileBillingSubscriptionInputV1,
  type StripeBillingAccountV1,
  type StripeBillingRepositoryV1,
  type StripeEventInboxEntryV1,
} from "../../billing/stripe-billing-repository";
import { applyEntitlementSnapshotWithClientV1 } from "./postgres-entitlement-repository";
import { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";
import { STRIPE_BILLING_MIGRATION_V16_CHECKSUM } from "./stripe-billing-schema";

type BillingAccountRow = QueryResultRow & {
  applied_generation: string;
  created_at: Date;
  stripe_customer_id: string | null;
  stripe_livemode: boolean | null;
  stripe_observation_generation: string;
  stripe_reconcile_generation: string;
  stripe_reconciled_at: Date | null;
  tenant_id: string;
  updated_at: Date;
};

type CheckoutAttemptRow = QueryResultRow & {
  attempt_id: string;
  created_at: Date;
  expires_at: Date;
  plan_key: string;
  state: string;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_livemode: boolean;
  stripe_price_id: string;
  tenant_id: string;
};

type StripeEventRow = QueryResultRow & {
  checkout_attempt_id: string | null;
  event_created_at: Date;
  event_type: string;
  payload_digest: Buffer;
  processed_at: Date | null;
  received_at: Date;
  source_object_id: string | null;
  state: string;
  stripe_customer_id: string;
  stripe_event_id: string;
  stripe_livemode: boolean;
  stripe_subscription_id: string;
  tenant_id: string;
};

type BillingSubscriptionRow = QueryResultRow & {
  cancel_at_period_end: boolean;
  canonical_digest: Buffer;
  canonical_retrieved_at: Date;
  created_at: Date;
  current_period_end: Date;
  current_period_start: Date;
  entitlement_snapshot_id: string;
  entitlement_source_generation: string;
  plan_key: string;
  reconcile_generation: string;
  source_event_id: string;
  status: string;
  stripe_customer_id: string;
  stripe_livemode: boolean;
  stripe_subscription_id: string;
  tenant_id: string;
  updated_at: Date;
};

type EntitlementSnapshotRow = QueryResultRow & {
  access_state: string;
  access_until: Date;
  created_at: Date;
  period_end: Date;
  period_start: Date;
  plan_key: string;
  render_enabled: boolean;
  render_job_limit: number;
  snapshot_id: string;
  source_generation: string;
  tenant_id: string;
  usage_period_key: string;
};

const BILLING_ACCOUNT_COLUMNS = `account.tenant_id,
       account.applied_generation::text AS applied_generation,
       account.stripe_customer_id,
       account.stripe_livemode,
       account.stripe_observation_generation::text AS stripe_observation_generation,
       account.stripe_reconcile_generation::text AS stripe_reconcile_generation,
       account.stripe_reconciled_at,
       account.created_at,
       account.updated_at`;

const CHECKOUT_ATTEMPT_COLUMNS = `attempt.tenant_id,
       attempt.attempt_id::text AS attempt_id,
       attempt.plan_key,
       attempt.stripe_price_id,
       attempt.stripe_customer_id,
       attempt.stripe_checkout_session_id,
       attempt.stripe_livemode,
       attempt.state,
       attempt.expires_at,
       attempt.created_at`;

const STRIPE_EVENT_COLUMNS = `event.stripe_event_id,
       event.tenant_id,
       event.checkout_attempt_id::text AS checkout_attempt_id,
       event.stripe_customer_id,
       event.stripe_subscription_id,
       event.stripe_livemode,
       event.event_type,
       event.source_object_id,
       event.event_created_at,
       event.payload_digest,
       event.state,
       event.received_at,
       event.processed_at`;

const BILLING_SUBSCRIPTION_COLUMNS = `subscription.tenant_id,
       subscription.stripe_subscription_id,
       subscription.stripe_customer_id,
       subscription.stripe_livemode,
       subscription.status,
       subscription.plan_key,
       subscription.current_period_start,
       subscription.current_period_end,
       subscription.cancel_at_period_end,
       subscription.canonical_digest,
       subscription.reconcile_generation::text AS reconcile_generation,
       subscription.canonical_retrieved_at,
       subscription.source_event_id,
       subscription.entitlement_snapshot_id::text AS entitlement_snapshot_id,
       subscription.entitlement_source_generation::text AS entitlement_source_generation,
       subscription.created_at,
       subscription.updated_at`;

function generation(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  return parsed;
}

function digestFromRow(value: Buffer, label: string) {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32) {
    throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  }
  return value.toString("hex");
}

function accountFromRow(row: BillingAccountRow): StripeBillingAccountV1 {
  return parseStripeBillingAccountV1({
    createdAt: row.created_at,
    entitlementGeneration: generation(row.applied_generation, "entitlement generation"),
    livemode: row.stripe_livemode,
    observationGeneration: generation(row.stripe_observation_generation, "Stripe observation generation"),
    reconcileGeneration: generation(row.stripe_reconcile_generation, "Stripe reconciliation generation"),
    reconciledAt: row.stripe_reconciled_at,
    stripeCustomerId: row.stripe_customer_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  });
}

function checkoutAttemptFromRow(row: CheckoutAttemptRow): BillingCheckoutAttemptV1 {
  return parseBillingCheckoutAttemptV1({
    attemptId: row.attempt_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    livemode: row.stripe_livemode,
    planKey: row.plan_key,
    state: row.state,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripeCustomerId: row.stripe_customer_id,
    stripePriceId: row.stripe_price_id,
    tenantId: row.tenant_id,
  });
}

function eventFromRow(row: StripeEventRow): StripeEventInboxEntryV1 {
  return parseStripeEventInboxEntryV1({
    checkoutAttemptId: row.checkout_attempt_id,
    eventCreatedAt: row.event_created_at,
    eventType: row.event_type,
    livemode: row.stripe_livemode,
    payloadDigest: digestFromRow(row.payload_digest, "Stripe event payload digest"),
    processedAt: row.processed_at,
    receivedAt: row.received_at,
    sourceObjectId: row.source_object_id,
    state: row.state,
    stripeCustomerId: row.stripe_customer_id,
    stripeEventId: row.stripe_event_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    tenantId: row.tenant_id,
  });
}

function subscriptionFromRow(row: BillingSubscriptionRow): BillingSubscriptionV1 {
  return parseBillingSubscriptionV1({
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canonicalDigest: digestFromRow(row.canonical_digest, "Stripe subscription canonical digest"),
    canonicalRetrievedAt: row.canonical_retrieved_at,
    createdAt: row.created_at,
    currentPeriodEnd: row.current_period_end,
    currentPeriodStart: row.current_period_start,
    entitlementSnapshotId: row.entitlement_snapshot_id,
    entitlementSourceGeneration: generation(
      row.entitlement_source_generation,
      "subscription entitlement source generation",
    ),
    livemode: row.stripe_livemode,
    planKey: row.plan_key,
    reconcileGeneration: generation(row.reconcile_generation, "subscription reconciliation generation"),
    sourceEventId: row.source_event_id,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
  });
}

function entitlementFromRow(row: EntitlementSnapshotRow) {
  return parseEntitlementSnapshotV1({
    accessState: row.access_state,
    accessUntil: row.access_until,
    createdAt: row.created_at,
    periodEnd: row.period_end,
    periodStart: row.period_start,
    planKey: row.plan_key,
    renderEnabled: row.render_enabled,
    renderJobLimit: row.render_job_limit,
    snapshotId: row.snapshot_id,
    sourceGeneration: generation(row.source_generation, "entitlement source generation"),
    tenantId: row.tenant_id,
    usagePeriodKey: row.usage_period_key,
  });
}

function accountHasBinding(account: StripeBillingAccountV1, stripeCustomerId: string, livemode: boolean) {
  return account.stripeCustomerId === stripeCustomerId && account.livemode === livemode;
}

function sameReservedCheckoutAttempt(
  left: BillingCheckoutAttemptV1,
  right: ReturnType<typeof parseReserveBillingCheckoutAttemptInputV1>,
) {
  return (
    left.tenantId === right.tenantId &&
    left.planKey === right.planKey &&
    (left.stripeCustomerId === right.stripeCustomerId || left.stripeCustomerId === null) &&
    left.livemode === right.livemode &&
    (left.state === "reserved" || left.state === "open")
  );
}

function sameEvent(row: StripeEventRow, input: IngestStripeEventInputV1, digest: Buffer) {
  return (
    row.tenant_id === input.tenantId &&
    row.checkout_attempt_id === input.checkoutAttemptId &&
    row.stripe_customer_id === input.stripeCustomerId &&
    row.stripe_subscription_id === input.stripeSubscriptionId &&
    row.stripe_livemode === input.livemode &&
    row.event_type === input.eventType &&
    row.source_object_id === input.sourceObjectId &&
    row.event_created_at.getTime() === input.eventCreatedAt.getTime() &&
    Buffer.isBuffer(row.payload_digest) &&
    row.payload_digest.byteLength === digest.byteLength &&
    timingSafeEqual(row.payload_digest, digest)
  );
}

function sameCanonicalSubscription(subscription: BillingSubscriptionV1, input: ReconcileBillingSubscriptionInputV1) {
  return (
    subscription.tenantId === input.tenantId &&
    subscription.stripeSubscriptionId === input.stripeSubscriptionId &&
    subscription.stripeCustomerId === input.stripeCustomerId &&
    subscription.livemode === input.livemode &&
    subscription.status === input.status &&
    subscription.planKey === input.planKey &&
    subscription.currentPeriodStart.getTime() === input.currentPeriodStart.getTime() &&
    subscription.currentPeriodEnd.getTime() === input.currentPeriodEnd.getTime() &&
    subscription.cancelAtPeriodEnd === input.cancelAtPeriodEnd &&
    subscription.canonicalDigest === input.canonicalDigest
  );
}

async function consumeCheckoutAttemptsWithClientV1(
  client: PoolClient,
  input: ReconcileBillingSubscriptionInputV1,
  event: StripeEventRow,
) {
  if (input.status !== "canceled" && input.status !== "incomplete_expired") {
    await client.query(
      `UPDATE public.billing_checkout_attempts
          SET state = 'consumed'
        WHERE tenant_id = $1 AND state IN ('reserved', 'open')`,
      [input.tenantId],
    );
    return;
  }
  if (event.checkout_attempt_id !== null) {
    await client.query(
      `UPDATE public.billing_checkout_attempts
          SET state = 'consumed'
        WHERE tenant_id = $1 AND attempt_id = $2::uuid AND state IN ('reserved', 'open')`,
      [input.tenantId, event.checkout_attempt_id],
    );
  }
}

export class PostgresStripeBillingRepositoryV1 implements StripeBillingRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (16, 32) ORDER BY version",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 2 &&
        result.rows[0]?.version === 16 &&
        result.rows[0]?.checksum === STRIPE_BILLING_MIGRATION_V16_CHECKSUM &&
        result.rows[1]?.version === 32 &&
        result.rows[1]?.checksum === BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM
      );
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async readAccount(tenantIdValue: string, signal?: AbortSignal) {
    const tenantId = organizationIdSchemaV1.parse(tenantIdValue);
    const result = await this.#connection.query<BillingAccountRow>(
      `SELECT ${BILLING_ACCOUNT_COLUMNS}
         FROM public.billing_accounts account
        WHERE account.tenant_id = $1
        LIMIT 2`,
      [tenantId],
      signal,
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate Stripe billing accounts.");
    const row = result.rows[0];
    return row ? accountFromRow(row) : null;
  }

  async readAccountByStripeCustomerId(stripeCustomerIdValue: string, livemodeValue: boolean, signal?: AbortSignal) {
    const { livemode, stripeCustomerId } = parseStripeCustomerLookupV1(stripeCustomerIdValue, livemodeValue);
    const result = await this.#connection.query<BillingAccountRow>(
      `SELECT ${BILLING_ACCOUNT_COLUMNS}
         FROM public.billing_accounts account
        WHERE account.stripe_customer_id = $1 AND account.stripe_livemode = $2
        LIMIT 2`,
      [stripeCustomerId, livemode],
      signal,
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate Stripe customer bindings.");
    const row = result.rows[0];
    return row ? accountFromRow(row) : null;
  }

  async readCheckoutAttempt(attemptIdValue: string, signal?: AbortSignal) {
    const attemptId = parseBillingCheckoutAttemptIdV1(attemptIdValue);
    const result = await this.#connection.query<CheckoutAttemptRow>(
      `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
         FROM public.billing_checkout_attempts attempt
        WHERE attempt.attempt_id = $1::uuid
        LIMIT 2`,
      [attemptId],
      signal,
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate Checkout attempts.");
    const row = result.rows[0];
    return row ? checkoutAttemptFromRow(row) : null;
  }

  async readCheckoutAttemptBySessionId(stripeCheckoutSessionIdValue: string, signal?: AbortSignal) {
    const stripeCheckoutSessionId = parseStripeCheckoutSessionIdV1(stripeCheckoutSessionIdValue);
    const result = await this.#connection.query<CheckoutAttemptRow>(
      `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
         FROM public.billing_checkout_attempts attempt
        WHERE attempt.stripe_checkout_session_id = $1
        LIMIT 2`,
      [stripeCheckoutSessionId],
      signal,
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate Checkout sessions.");
    const row = result.rows[0];
    return row ? checkoutAttemptFromRow(row) : null;
  }

  async readCurrentSubscription(tenantIdValue: string, signal?: AbortSignal) {
    const tenantId = organizationIdSchemaV1.parse(tenantIdValue);
    const result = await this.#connection.query<BillingSubscriptionRow>(
      `SELECT ${BILLING_SUBSCRIPTION_COLUMNS}
         FROM public.billing_subscriptions subscription
        WHERE subscription.tenant_id = $1
        ORDER BY subscription.reconcile_generation DESC
        LIMIT 1`,
      [tenantId],
      signal,
    );
    const row = result.rows[0];
    return row ? subscriptionFromRow(row) : null;
  }

  async readCurrentEntitlement(tenantIdValue: string, signal?: AbortSignal) {
    const tenantId = organizationIdSchemaV1.parse(tenantIdValue);
    const result = await this.#connection.query<EntitlementSnapshotRow>(
      `SELECT snapshot.tenant_id,
              snapshot.snapshot_id::text AS snapshot_id,
              snapshot.source_generation::text AS source_generation,
              snapshot.plan_key,
              snapshot.access_state,
              snapshot.render_enabled,
              snapshot.render_job_limit,
              snapshot.usage_period_key,
              snapshot.period_start,
              snapshot.period_end,
              snapshot.access_until,
              snapshot.created_at
         FROM public.billing_accounts account
         JOIN public.entitlement_snapshots snapshot
           ON snapshot.tenant_id = account.tenant_id
          AND snapshot.snapshot_id = account.current_snapshot_id
          AND snapshot.source_generation = account.applied_generation
        WHERE account.tenant_id = $1
        LIMIT 2`,
      [tenantId],
      signal,
    );
    if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate current entitlements.");
    const row = result.rows[0];
    return row ? entitlementFromRow(row) : null;
  }

  async bindCustomer(inputValue: Parameters<StripeBillingRepositoryV1["bindCustomer"]>[0], signal?: AbortSignal) {
    const input = parseBindStripeCustomerInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) throw new TypeError("The Stripe billing organization does not exist.");
      await client.query(
        `INSERT INTO public.billing_accounts (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId],
      );
      const selected = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const selectedRow = selected.rows[0];
      if (selected.rowCount !== 1 || !selectedRow)
        throw new TypeError("PostgreSQL did not return the billing account.");
      const account = accountFromRow(selectedRow);
      if (accountHasBinding(account, input.stripeCustomerId, input.livemode)) {
        return { account, kind: "bound", replayed: true } as const;
      }
      if (account.stripeCustomerId !== null || account.livemode !== null) return { kind: "conflict" } as const;

      const updated = await client.query<BillingAccountRow>(
        `UPDATE public.billing_accounts account
            SET stripe_customer_id = $2, stripe_livemode = $3
          WHERE account.tenant_id = $1 AND account.stripe_customer_id IS NULL
          RETURNING ${BILLING_ACCOUNT_COLUMNS}`,
        [input.tenantId, input.stripeCustomerId, input.livemode],
      );
      const row = updated.rows[0];
      if (updated.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not bind the Stripe customer.");
      return { account: accountFromRow(row), kind: "bound", replayed: false } as const;
    }, signal);
  }

  async reserveCheckoutAttempt(
    inputValue: Parameters<StripeBillingRepositoryV1["reserveCheckoutAttempt"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReserveBillingCheckoutAttemptInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) throw new TypeError("The Checkout organization does not exist.");
      await client.query(
        `INSERT INTO public.billing_accounts (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId],
      );
      const accountResult = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const accountRow = accountResult.rows[0];
      if (accountResult.rowCount !== 1 || !accountRow) {
        return { kind: "conflict" } as const;
      }
      const account = accountFromRow(accountRow);

      const subscriptionResult = await client.query<BillingSubscriptionRow>(
        `SELECT ${BILLING_SUBSCRIPTION_COLUMNS}
           FROM public.billing_subscriptions subscription
          WHERE subscription.tenant_id = $1
          ORDER BY subscription.reconcile_generation DESC
          LIMIT 1
          FOR UPDATE`,
        [input.tenantId],
      );
      const currentSubscriptionRow = subscriptionResult.rows[0];
      if (currentSubscriptionRow) {
        const currentSubscription = subscriptionFromRow(currentSubscriptionRow);
        if (currentSubscription.status !== "canceled" && currentSubscription.status !== "incomplete_expired") {
          return { kind: "conflict" } as const;
        }
      }

      await client.query(
        `UPDATE public.billing_checkout_attempts
            SET state = 'expired'
          WHERE tenant_id = $1 AND state IN ('reserved', 'open') AND expires_at <= clock_timestamp()`,
        [input.tenantId],
      );
      const activeResult = await client.query<CheckoutAttemptRow>(
        `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
          FROM public.billing_checkout_attempts attempt
          WHERE attempt.tenant_id = $1 AND attempt.state IN ('reserved', 'open')
          LIMIT 2
          FOR UPDATE`,
        [input.tenantId],
      );
      if (activeResult.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate active Checkout attempts.");
      const activeRow = activeResult.rows[0];
      if (activeRow) {
        const active = checkoutAttemptFromRow(activeRow);
        const activeBindingValid =
          active.stripeCustomerId === null
            ? account.stripeCustomerId === null || account.livemode === active.livemode
            : accountHasBinding(account, active.stripeCustomerId, active.livemode);
        return activeBindingValid && sameReservedCheckoutAttempt(active, input)
          ? ({ attempt: active, kind: "reserved", replayed: true } as const)
          : ({ kind: "conflict" } as const);
      }

      const bindingMatches =
        input.stripeCustomerId === null
          ? account.stripeCustomerId === null && account.livemode === null
          : accountHasBinding(account, input.stripeCustomerId, input.livemode);
      if (!bindingMatches) return { kind: "conflict" } as const;

      const inserted = await client.query<CheckoutAttemptRow>(
        `INSERT INTO public.billing_checkout_attempts AS attempt
           (tenant_id, attempt_id, plan_key, stripe_price_id, stripe_customer_id, stripe_livemode, state, expires_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, 'reserved', clock_timestamp() + interval '24 hours')
         ON CONFLICT DO NOTHING
         RETURNING ${CHECKOUT_ATTEMPT_COLUMNS}`,
        [input.tenantId, input.attemptId, input.planKey, input.stripePriceId, input.stripeCustomerId, input.livemode],
      );
      const insertedRow = inserted.rows[0];
      if (inserted.rowCount === 1 && insertedRow) {
        return { attempt: checkoutAttemptFromRow(insertedRow), kind: "reserved", replayed: false } as const;
      }
      return { kind: "conflict" } as const;
    }, signal);
  }

  async openCheckoutAttempt(
    inputValue: Parameters<StripeBillingRepositoryV1["openCheckoutAttempt"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseOpenBillingCheckoutAttemptInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) return { kind: "conflict" } as const;
      const selected = await client.query<CheckoutAttemptRow>(
        `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
           FROM public.billing_checkout_attempts attempt
          WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.attemptId],
      );
      const row = selected.rows[0];
      if (selected.rowCount !== 1 || !row) return { kind: "conflict" } as const;
      const attempt = checkoutAttemptFromRow(row);
      if (attempt.state === "open") {
        return attempt.stripeCheckoutSessionId === input.stripeCheckoutSessionId &&
          attempt.expiresAt.getTime() === input.expiresAt.getTime()
          ? ({ attempt, kind: "open", replayed: true } as const)
          : ({ kind: "conflict" } as const);
      }
      if (attempt.state !== "reserved") return { kind: "conflict" } as const;
      const updated = await client.query<CheckoutAttemptRow>(
        `UPDATE public.billing_checkout_attempts attempt
            SET stripe_checkout_session_id = $3, state = 'open', expires_at = $4
          WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid
            AND attempt.state = 'reserved' AND attempt.expires_at > clock_timestamp()
          RETURNING ${CHECKOUT_ATTEMPT_COLUMNS}`,
        [input.tenantId, input.attemptId, input.stripeCheckoutSessionId, input.expiresAt],
      );
      const updatedRow = updated.rows[0];
      return updated.rowCount === 1 && updatedRow
        ? ({ attempt: checkoutAttemptFromRow(updatedRow), kind: "open", replayed: false } as const)
        : ({ kind: "conflict" } as const);
    }, signal);
  }

  async failCheckoutAttempt(
    inputValue: Parameters<StripeBillingRepositoryV1["failCheckoutAttempt"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseFailBillingCheckoutAttemptInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) return { kind: "conflict" } as const;
      const selected = await client.query<CheckoutAttemptRow>(
        `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
           FROM public.billing_checkout_attempts attempt
          WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid
          FOR UPDATE`,
        [input.tenantId, input.attemptId],
      );
      const row = selected.rows[0];
      if (selected.rowCount !== 1 || !row) return { kind: "conflict" } as const;
      const attempt = checkoutAttemptFromRow(row);
      if (attempt.state === "failed") return { attempt, kind: "failed", replayed: true } as const;
      if (attempt.state !== "reserved") return { kind: "conflict" } as const;
      const updated = await client.query<CheckoutAttemptRow>(
        `UPDATE public.billing_checkout_attempts attempt
            SET state = 'failed'
          WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid AND attempt.state = 'reserved'
          RETURNING ${CHECKOUT_ATTEMPT_COLUMNS}`,
        [input.tenantId, input.attemptId],
      );
      const updatedRow = updated.rows[0];
      return updated.rowCount === 1 && updatedRow
        ? ({ attempt: checkoutAttemptFromRow(updatedRow), kind: "failed", replayed: false } as const)
        : ({ kind: "conflict" } as const);
    }, signal);
  }

  async ingestEvent(inputValue: Parameters<StripeBillingRepositoryV1["ingestEvent"]>[0], signal?: AbortSignal) {
    const input = parseIngestStripeEventInputV1(inputValue);
    const payload = Buffer.from(input.payloadBytes);
    const digest = createHash("sha256").update(payload).digest();
    const expectedDigest = Buffer.from(input.payloadDigest, "hex");
    if (!timingSafeEqual(digest, expectedDigest)) {
      throw new TypeError("The Stripe event payload digest does not match its raw body.");
    }

    return this.#connection.transaction(async (client) => {
      const accountResult = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const accountRow = accountResult.rows[0];
      if (accountResult.rowCount !== 1 || !accountRow) return { kind: "conflict" } as const;
      const account = accountFromRow(accountRow);
      if (account.stripeCustomerId !== null && !accountHasBinding(account, input.stripeCustomerId, input.livemode)) {
        return { kind: "conflict" } as const;
      }
      if (input.checkoutAttemptId !== null) {
        const attemptResult = await client.query<CheckoutAttemptRow>(
          `SELECT ${CHECKOUT_ATTEMPT_COLUMNS}
             FROM public.billing_checkout_attempts attempt
            WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2::uuid
            FOR UPDATE`,
          [input.tenantId, input.checkoutAttemptId],
        );
        const attemptRow = attemptResult.rows[0];
        if (attemptResult.rowCount !== 1 || !attemptRow) return { kind: "conflict" } as const;
        const attempt = checkoutAttemptFromRow(attemptRow);
        if (
          attempt.livemode !== input.livemode ||
          attempt.state === "failed" ||
          (attempt.stripeCustomerId !== null && attempt.stripeCustomerId !== input.stripeCustomerId)
        ) {
          return { kind: "conflict" } as const;
        }
      } else if (account.stripeCustomerId === null) {
        return { kind: "conflict" } as const;
      }

      const inserted = await client.query<StripeEventRow>(
        `INSERT INTO public.stripe_event_inbox AS event
           (stripe_event_id, tenant_id, checkout_attempt_id, stripe_customer_id, stripe_subscription_id,
            stripe_livemode, event_type, source_object_id, event_created_at, payload_digest)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (stripe_livemode, stripe_event_id) DO NOTHING
         RETURNING ${STRIPE_EVENT_COLUMNS}`,
        [
          input.stripeEventId,
          input.tenantId,
          input.checkoutAttemptId,
          input.stripeCustomerId,
          input.stripeSubscriptionId,
          input.livemode,
          input.eventType,
          input.sourceObjectId,
          input.eventCreatedAt,
          digest,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (inserted.rowCount === 1 && insertedRow) {
        return { event: eventFromRow(insertedRow), kind: "received", replayed: false } as const;
      }

      const existing = await client.query<StripeEventRow>(
        `SELECT ${STRIPE_EVENT_COLUMNS}
           FROM public.stripe_event_inbox event
          WHERE event.stripe_event_id = $1 AND event.stripe_livemode = $2
          FOR UPDATE`,
        [input.stripeEventId, input.livemode],
      );
      const row = existing.rows[0];
      if (existing.rowCount !== 1 || !row || !sameEvent(row, input, digest)) {
        return { kind: "conflict" } as const;
      }
      return { event: eventFromRow(row), kind: "received", replayed: true } as const;
    }, signal);
  }

  async acknowledgeEvent(
    inputValue: Parameters<StripeBillingRepositoryV1["acknowledgeEvent"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseAcknowledgeStripeEventInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const accountResult = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const accountRow = accountResult.rows[0];
      if (accountResult.rowCount !== 1 || !accountRow) return { kind: "conflict" } as const;
      const account = accountFromRow(accountRow);
      if (
        !accountHasBinding(account, input.stripeCustomerId, input.livemode) ||
        account.reconcileGeneration !== input.expectedReconcileGeneration
      ) {
        return { kind: "conflict" } as const;
      }
      const subscriptionResult = await client.query<BillingSubscriptionRow>(
        `SELECT ${BILLING_SUBSCRIPTION_COLUMNS}
           FROM public.billing_subscriptions subscription
          WHERE subscription.tenant_id = $1
          ORDER BY subscription.reconcile_generation DESC
          LIMIT 1
          FOR UPDATE`,
        [input.tenantId],
      );
      const subscriptionRow = subscriptionResult.rows[0];
      if (!subscriptionRow) return { kind: "conflict" } as const;
      const subscription = subscriptionFromRow(subscriptionRow);
      if (
        subscription.reconcileGeneration !== input.expectedReconcileGeneration ||
        subscription.stripeSubscriptionId !== input.expectedStripeSubscriptionId ||
        subscription.status !== input.expectedSubscriptionStatus
      ) {
        return { kind: "conflict" } as const;
      }
      const selected = await client.query<StripeEventRow>(
        `SELECT ${STRIPE_EVENT_COLUMNS}
           FROM public.stripe_event_inbox event
          WHERE event.stripe_event_id = $1 AND event.stripe_livemode = $2
          FOR UPDATE`,
        [input.stripeEventId, input.livemode],
      );
      const row = selected.rows[0];
      if (
        selected.rowCount !== 1 ||
        !row ||
        row.tenant_id !== input.tenantId ||
        row.stripe_customer_id !== input.stripeCustomerId
      ) {
        return { kind: "conflict" } as const;
      }
      const event = eventFromRow(row);
      if (event.state === "processed") return { event, kind: "processed", replayed: true } as const;
      const updated = await client.query<StripeEventRow>(
        `UPDATE public.stripe_event_inbox event
            SET state = 'processed'
          WHERE event.stripe_event_id = $1 AND event.stripe_livemode = $2 AND event.state = 'pending'
          RETURNING ${STRIPE_EVENT_COLUMNS}`,
        [input.stripeEventId, input.livemode],
      );
      const updatedRow = updated.rows[0];
      return updated.rowCount === 1 && updatedRow
        ? ({ event: eventFromRow(updatedRow), kind: "processed", replayed: false } as const)
        : ({ kind: "conflict" } as const);
    }, signal);
  }

  async reserveCanonicalObservation(
    inputValue: Parameters<StripeBillingRepositoryV1["reserveCanonicalObservation"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReserveCanonicalObservationInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const accountResult = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const accountRow = accountResult.rows[0];
      if (accountResult.rowCount !== 1 || !accountRow) return { kind: "conflict" } as const;
      const account = accountFromRow(accountRow);
      if (account.stripeCustomerId !== null && !accountHasBinding(account, input.stripeCustomerId, input.livemode)) {
        return { kind: "conflict" } as const;
      }

      const eventResult = await client.query<StripeEventRow>(
        `SELECT ${STRIPE_EVENT_COLUMNS}
           FROM public.stripe_event_inbox event
          WHERE event.stripe_event_id = $1 AND event.stripe_livemode = $2
          FOR UPDATE`,
        [input.stripeEventId, input.livemode],
      );
      const eventRow = eventResult.rows[0];
      if (
        eventResult.rowCount !== 1 ||
        !eventRow ||
        eventRow.tenant_id !== input.tenantId ||
        eventRow.stripe_customer_id !== input.stripeCustomerId
      ) {
        return { kind: "conflict" } as const;
      }
      if (eventRow.state === "processed") return { kind: "processed" } as const;

      const advanced = await client.query<BillingAccountRow>(
        `UPDATE public.billing_accounts account
            SET stripe_observation_generation = stripe_observation_generation + 1
          WHERE account.tenant_id = $1 AND account.stripe_observation_generation = $2
          RETURNING ${BILLING_ACCOUNT_COLUMNS}`,
        [input.tenantId, account.observationGeneration.toString()],
      );
      const advancedRow = advanced.rows[0];
      if (advanced.rowCount !== 1 || !advancedRow) {
        throw new TypeError("PostgreSQL did not advance the Stripe observation fence.");
      }
      return {
        kind: "reserved",
        observationGeneration: accountFromRow(advancedRow).observationGeneration,
      } as const;
    }, signal);
  }

  async reconcileSubscription(
    inputValue: Parameters<StripeBillingRepositoryV1["reconcileSubscription"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReconcileBillingSubscriptionInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      // Keep the same organization -> billing-account lock order as entitlement
      // application and Checkout admission. The shared helper below reacquires
      // both locks, so taking the account first here would permit a deadlock.
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) return { kind: "unbound" } as const;
      const accountResult = await client.query<BillingAccountRow>(
        `SELECT ${BILLING_ACCOUNT_COLUMNS}
           FROM public.billing_accounts account
          WHERE account.tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      const accountRow = accountResult.rows[0];
      if (accountResult.rowCount !== 1 || !accountRow) return { kind: "unbound" } as const;
      const account = accountFromRow(accountRow);
      if (!accountHasBinding(account, input.stripeCustomerId, input.livemode)) {
        return { kind: "unbound" } as const;
      }

      const eventResult = await client.query<StripeEventRow>(
        `SELECT ${STRIPE_EVENT_COLUMNS}
           FROM public.stripe_event_inbox event
          WHERE event.stripe_event_id = $1 AND event.stripe_livemode = $2
          FOR UPDATE`,
        [input.sourceEventId, input.livemode],
      );
      const eventRow = eventResult.rows[0];
      if (
        eventResult.rowCount !== 1 ||
        !eventRow ||
        eventRow.tenant_id !== input.tenantId ||
        eventRow.stripe_customer_id !== input.stripeCustomerId ||
        eventRow.stripe_subscription_id !== input.stripeSubscriptionId ||
        eventRow.stripe_livemode !== input.livemode
      ) {
        return { kind: "event-conflict" } as const;
      }

      const existingResult = await client.query<BillingSubscriptionRow>(
        `SELECT ${BILLING_SUBSCRIPTION_COLUMNS}
           FROM public.billing_subscriptions subscription
          WHERE subscription.tenant_id = $1 AND subscription.stripe_subscription_id = $2
          FOR UPDATE`,
        [input.tenantId, input.stripeSubscriptionId],
      );
      if (existingResult.rows.length > 1) {
        throw new TypeError("PostgreSQL returned duplicate billing subscriptions.");
      }
      const existingRow = existingResult.rows[0];
      if (existingRow) {
        const existing = subscriptionFromRow(existingRow);
        if (sameCanonicalSubscription(existing, input)) {
          await consumeCheckoutAttemptsWithClientV1(client, input, eventRow);
          if (eventRow.state === "pending") {
            const processed = await client.query(
              `UPDATE public.stripe_event_inbox
                  SET state = 'processed'
                WHERE stripe_event_id = $1 AND stripe_livemode = $2 AND state = 'pending'`,
              [input.sourceEventId, input.livemode],
            );
            if (processed.rowCount !== 1) throw new TypeError("PostgreSQL did not process the Stripe event replay.");
          }
          return { account, entitlement: null, kind: "applied", replayed: true, subscription: existing } as const;
        }
      }
      if (eventRow.state !== "pending") return { kind: "event-conflict" } as const;

      if (
        account.observationGeneration !== input.expectedObservationGeneration ||
        account.reconcileGeneration !== input.expectedReconcileGeneration
      ) {
        return {
          entitlementGeneration: account.entitlementGeneration,
          kind: "conflict",
          observationGeneration: account.observationGeneration,
          reconcileGeneration: account.reconcileGeneration,
        } as const;
      }

      const entitlementResult = await applyEntitlementSnapshotWithClientV1(client, input.entitlement);
      if (entitlementResult.kind === "conflict") {
        return {
          entitlementGeneration: entitlementResult.appliedGeneration,
          kind: "conflict",
          observationGeneration: account.observationGeneration,
          reconcileGeneration: account.reconcileGeneration,
        } as const;
      }

      const nextGeneration = input.expectedReconcileGeneration + 1n;
      const subscriptionResult = await client.query<BillingSubscriptionRow>(
        `INSERT INTO public.billing_subscriptions AS subscription
           (tenant_id, stripe_subscription_id, stripe_customer_id, stripe_livemode, status, plan_key,
            current_period_start, current_period_end, cancel_at_period_end, canonical_digest,
            reconcile_generation, canonical_retrieved_at, source_event_id,
            entitlement_snapshot_id, entitlement_source_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid, $15)
         ON CONFLICT (tenant_id, stripe_subscription_id) DO UPDATE
           SET status = EXCLUDED.status,
               plan_key = EXCLUDED.plan_key,
               current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end,
               cancel_at_period_end = EXCLUDED.cancel_at_period_end,
               canonical_digest = EXCLUDED.canonical_digest,
               reconcile_generation = EXCLUDED.reconcile_generation,
               canonical_retrieved_at = EXCLUDED.canonical_retrieved_at,
               source_event_id = EXCLUDED.source_event_id,
               entitlement_snapshot_id = EXCLUDED.entitlement_snapshot_id,
               entitlement_source_generation = EXCLUDED.entitlement_source_generation
         WHERE subscription.reconcile_generation <= $16
         RETURNING ${BILLING_SUBSCRIPTION_COLUMNS}`,
        [
          input.tenantId,
          input.stripeSubscriptionId,
          input.stripeCustomerId,
          input.livemode,
          input.status,
          input.planKey,
          input.currentPeriodStart,
          input.currentPeriodEnd,
          input.cancelAtPeriodEnd,
          Buffer.from(input.canonicalDigest, "hex"),
          nextGeneration.toString(),
          input.canonicalRetrievedAt,
          input.sourceEventId,
          entitlementResult.snapshot.snapshotId,
          entitlementResult.snapshot.sourceGeneration.toString(),
          input.expectedReconcileGeneration.toString(),
        ],
      );
      const subscriptionRow = subscriptionResult.rows[0];
      if (subscriptionResult.rowCount !== 1 || !subscriptionRow) {
        throw new TypeError("PostgreSQL did not advance the billing subscription.");
      }

      const advancedAccount = await client.query<BillingAccountRow>(
        `UPDATE public.billing_accounts account
            SET stripe_reconcile_generation = $2, stripe_reconciled_at = clock_timestamp()
          WHERE account.tenant_id = $1 AND account.stripe_reconcile_generation = $3
            AND account.stripe_observation_generation = $4
          RETURNING ${BILLING_ACCOUNT_COLUMNS}`,
        [
          input.tenantId,
          nextGeneration.toString(),
          input.expectedReconcileGeneration.toString(),
          input.expectedObservationGeneration.toString(),
        ],
      );
      const advancedAccountRow = advancedAccount.rows[0];
      if (advancedAccount.rowCount !== 1 || !advancedAccountRow) {
        throw new TypeError("PostgreSQL did not advance the Stripe reconciliation fence.");
      }

      await consumeCheckoutAttemptsWithClientV1(client, input, eventRow);
      const processed = await client.query(
        `UPDATE public.stripe_event_inbox
            SET state = 'processed'
          WHERE stripe_event_id = $1 AND stripe_livemode = $2 AND state = 'pending'`,
        [input.sourceEventId, input.livemode],
      );
      if (processed.rowCount !== 1) throw new TypeError("PostgreSQL did not process the Stripe event.");

      return {
        account: accountFromRow(advancedAccountRow),
        entitlement: entitlementResult.snapshot,
        kind: "applied",
        replayed: false,
        subscription: subscriptionFromRow(subscriptionRow),
      } as const;
    }, signal);
  }

  close() {
    return this.#connection.close();
  }
}
