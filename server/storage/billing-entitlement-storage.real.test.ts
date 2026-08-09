import { createHmac } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { MAX_USAGE_RESERVATION_LIFETIME_MS_V1 } from "../billing/entitlement-repository";
import { FakeStripeBillingGatewayV1 } from "../billing/fake-stripe-gateway";
import { createStripeCheckoutPlanCatalogV1 } from "../billing/plan-catalog";
import { createStripeBillingServiceV1 } from "../billing/stripe-billing-service";
import { STRIPE_API_VERSION_V1 } from "../billing/stripe-gateway";
import { authenticateManimPrincipal } from "../manim-request-principal";
import { applyBundledDurableStorageMigrations } from "./postgres/migrate";
import { PostgresBillingEntitlementRepositoryV1 } from "./postgres/postgres-entitlement-repository";
import { PostgresStripeBillingRepositoryV1 } from "./postgres/postgres-stripe-billing-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT_A = "billing-tenant-a";
const TENANT_B = "billing-tenant-b";
const TENANT_C = "billing-stripe-tenant";
const OWNER_ID = "00000000-0000-4000-8000-000000000321";
const STRIPE_OWNER_ID = "00000000-0000-4000-8000-000000000322";
const STRIPE_WEBHOOK_SECRET = "whsec_storage_vertical_secret";

async function createOrganizations(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1), ($2)", [TENANT_A, TENANT_B]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.example/', 'billing-owner', 'Billing owner')`,
      [OWNER_ID],
    );
    await client.query(
      `INSERT INTO public.organizations (tenant_id, display_name)
       VALUES ($1, 'Billing tenant A'), ($2, 'Billing tenant B')`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $3::uuid, 'owner'), ($2, $3::uuid, 'owner')`,
      [TENANT_A, TENANT_B, OWNER_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createStripeOrganization(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [TENANT_C]);
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://identity.example/', 'stripe-billing-owner', 'Stripe billing owner')`,
      [STRIPE_OWNER_ID],
    );
    await client.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, $2)", [
      TENANT_C,
      "Stripe billing tenant",
    ]);
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
       VALUES ($1, $2::uuid, 'owner')`,
      [TENANT_C, STRIPE_OWNER_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!DATABASE_URL)("PostgreSQL billing entitlements", () => {
  it("atomically reserves one render quota, replays safely, preserves period usage, and isolates tenants", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const repositoryA = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const repositoryB = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    try {
      expect(await applyBundledDurableStorageMigrations(pool)).toEqual({ applied: true, version: 29 });
      await createOrganizations(pool);
      await expect(repositoryA.ready()).resolves.toBe(true);
      await expect(repositoryB.ready()).resolves.toBe(true);

      const now = Date.now();
      const periodStart = new Date(now - 60_000);
      const accessUntil = new Date(now + 30 * 60_000);
      const periodEnd = new Date(now + 60 * 60_000);
      const usagePeriodKey = "render:2026-08";
      const snapshots = await Promise.all(
        [
          { snapshotId: "00000000-0000-4000-8000-000000000401", tenantId: TENANT_A },
          { snapshotId: "00000000-0000-4000-8000-000000000402", tenantId: TENANT_B },
        ].map((identity) =>
          repositoryA.applySnapshot({
            ...identity,
            accessState: "active",
            accessUntil,
            expectedGeneration: 0n,
            periodEnd,
            periodStart,
            planKey: "pro",
            renderEnabled: true,
            renderJobLimit: 1,
            sourceGeneration: 1n,
            usagePeriodKey,
          }),
        ),
      );
      expect(snapshots.map(({ kind }) => kind)).toEqual(["applied", "applied"]);

      const candidateOperationIds = [
        "00000000-0000-4000-8000-000000000411",
        "00000000-0000-4000-8000-000000000412",
      ] as const;
      const concurrent = await Promise.all(
        candidateOperationIds.map((operationId, index) =>
          (index === 0 ? repositoryA : repositoryB).reserveRender({
            lifetimeMs: 60_000,
            operationId,
            tenantId: TENANT_A,
          }),
        ),
      );
      const winner = concurrent.find((result) => result.kind === "reserved");
      expect(concurrent.filter((result) => result.kind === "reserved")).toHaveLength(1);
      expect(concurrent.filter((result) => result.kind === "denied")).toEqual([
        { kind: "denied", reason: "quota-exhausted" },
      ]);
      if (!winner || winner.kind !== "reserved") throw new Error("The quota race produced no winner.");

      await expect(
        repositoryA.reserveRender({
          lifetimeMs: 60_000,
          operationId: winner.reservation.operationId,
          tenantId: TENANT_A,
        }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: true, reservation: { state: "reserved" } });
      await expect(
        repositoryB.reserveRender({
          lifetimeMs: 60_000,
          operationId: winner.reservation.operationId,
          tenantId: TENANT_B,
        }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: false, reservation: { tenantId: TENANT_B } });

      const nextSnapshots = await Promise.all(
        ["00000000-0000-4000-8000-000000000421", "00000000-0000-4000-8000-000000000422"].map((snapshotId, index) =>
          (index === 0 ? repositoryA : repositoryB).applySnapshot({
            accessState: "active",
            accessUntil,
            expectedGeneration: 1n,
            periodEnd,
            periodStart,
            planKey: "pro",
            renderEnabled: true,
            renderJobLimit: 1,
            snapshotId,
            sourceGeneration: 2n,
            tenantId: TENANT_A,
            usagePeriodKey,
          }),
        ),
      );
      expect(nextSnapshots.filter(({ kind }) => kind === "applied")).toHaveLength(1);
      expect(nextSnapshots.filter(({ kind }) => kind === "conflict")).toEqual([
        { appliedGeneration: 2n, kind: "conflict" },
      ]);
      const appliedNextSnapshot = nextSnapshots.find(({ kind }) => kind === "applied");
      if (!appliedNextSnapshot || appliedNextSnapshot.kind !== "applied") {
        throw new Error("The entitlement CAS race produced no winner.");
      }
      await expect(
        repositoryA.reserveRender({
          lifetimeMs: 60_000,
          operationId: "00000000-0000-4000-8000-000000000423",
          tenantId: TENANT_A,
        }),
      ).resolves.toEqual({ kind: "denied", reason: "quota-exhausted" });

      const followingPeriodStart = periodEnd;
      const followingPeriodEnd = new Date(periodEnd.getTime() + 60 * 60_000);
      await expect(
        repositoryA.applySnapshot({
          accessState: "active",
          accessUntil: new Date(periodEnd.getTime() + 30 * 60_000),
          expectedGeneration: 2n,
          periodEnd: followingPeriodEnd,
          periodStart: followingPeriodStart,
          planKey: "pro",
          renderEnabled: true,
          renderJobLimit: 1,
          snapshotId: "00000000-0000-4000-8000-000000000424",
          sourceGeneration: 3n,
          tenantId: TENANT_A,
          usagePeriodKey: "render:2026-09",
        }),
      ).resolves.toMatchObject({ kind: "applied" });
      await expect(
        repositoryA.applySnapshot({
          accessState: "active",
          accessUntil,
          expectedGeneration: 3n,
          periodEnd,
          periodStart,
          planKey: "pro",
          renderEnabled: true,
          renderJobLimit: 1,
          snapshotId: "00000000-0000-4000-8000-000000000425",
          sourceGeneration: 4n,
          tenantId: TENANT_A,
          usagePeriodKey: "render:reset-attempt",
        }),
      ).rejects.toMatchObject({ code: "23514" });

      await expect(repositoryA.commitReservation(TENANT_A, winner.reservation.operationId)).resolves.toMatchObject({
        kind: "settled",
        replayed: false,
        reservation: { state: "committed", version: 2n },
      });
      await expect(repositoryA.commitReservation(TENANT_A, winner.reservation.operationId)).resolves.toMatchObject({
        kind: "settled",
        replayed: true,
      });
      await expect(repositoryA.releaseReservation(TENANT_A, winner.reservation.operationId)).resolves.toEqual({
        kind: "conflict",
        state: "committed",
      });

      await expect(repositoryB.releaseReservation(TENANT_B, winner.reservation.operationId)).resolves.toMatchObject({
        kind: "settled",
        replayed: false,
        reservation: { state: "released", version: 2n },
      });
      await expect(repositoryB.releaseReservation(TENANT_B, winner.reservation.operationId)).resolves.toMatchObject({
        kind: "settled",
        replayed: true,
      });
      await expect(repositoryB.commitReservation(TENANT_B, winner.reservation.operationId)).resolves.toEqual({
        kind: "conflict",
        state: "released",
      });

      const replacementOperationId = "00000000-0000-4000-8000-000000000431";
      await expect(
        repositoryB.reserveRender({
          lifetimeMs: MAX_USAGE_RESERVATION_LIFETIME_MS_V1,
          operationId: replacementOperationId,
          tenantId: TENANT_B,
        }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: false });
      await expect(
        pool.query<{ exact_lifetime: boolean }>(
          `SELECT expires_at - created_at = interval '30 minutes' AS exact_lifetime
             FROM public.usage_reservations
            WHERE tenant_id = $1 AND operation_kind = 'render' AND operation_id = $2::uuid`,
          [TENANT_B, replacementOperationId],
        ),
      ).resolves.toMatchObject({ rowCount: 1, rows: [{ exact_lifetime: true }] });

      const unloggedSettlement = await pool.connect();
      try {
        await unloggedSettlement.query("BEGIN");
        await unloggedSettlement.query(
          `UPDATE public.usage_reservations
              SET state = 'released'
            WHERE tenant_id = $1 AND operation_kind = 'render' AND operation_id = $2::uuid`,
          [TENANT_B, replacementOperationId],
        );
        await expect(unloggedSettlement.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
          code: "23514",
        });
      } finally {
        await unloggedSettlement.query("ROLLBACK").catch(() => undefined);
        unloggedSettlement.release();
      }

      const events = await pool.query<{ event_count: string; outcome: string; tenant_id: string }>(
        `SELECT tenant_id, outcome, count(*)::text AS event_count
           FROM public.usage_events
          WHERE operation_kind = 'render' AND operation_id = $1::uuid
          GROUP BY tenant_id, outcome
          ORDER BY tenant_id`,
        [winner.reservation.operationId],
      );
      expect(events.rows).toEqual([
        { event_count: "1", outcome: "committed", tenant_id: TENANT_A },
        { event_count: "1", outcome: "released", tenant_id: TENANT_B },
      ]);

      await expect(
        pool.query(
          "UPDATE public.usage_events SET outcome = 'expired' WHERE tenant_id = $1 AND operation_id = $2::uuid",
          [TENANT_B, winner.reservation.operationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "UPDATE public.usage_reservations SET state = 'released' WHERE tenant_id = $1 AND operation_id = $2::uuid",
          [TENANT_A, winner.reservation.operationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("DELETE FROM public.usage_reservations WHERE tenant_id = $1 AND operation_id = $2::uuid", [
          TENANT_B,
          replacementOperationId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "UPDATE public.entitlement_snapshots SET plan_key = 'other' WHERE tenant_id = $1 AND snapshot_id = $2::uuid",
          [TENANT_A, appliedNextSnapshot.snapshot.snapshotId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await repositoryB.close();
      await repositoryA.close();
      await pool.end();
    }
  });

  it("reconciles Stripe state into render admission atomically and replays duplicate delivery", async () => {
    const now = Date.now();
    const periodStart = new Date(now - 60_000);
    const periodEnd = new Date(now + 60 * 60_000);
    const stripeCustomerId = "cus_storage_vertical";
    const stripeEventId = "evt_storage_vertical";
    const stripeSubscriptionId = "sub_storage_vertical";
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const entitlementRepository = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const stripeRepository = new PostgresStripeBillingRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const gateway = new FakeStripeBillingGatewayV1({
      subscriptions: [
        {
          cancelAtPeriodEnd: false,
          customerId: stripeCustomerId,
          id: stripeSubscriptionId,
          livemode: false,
          periodEnd,
          periodStart,
          priceId: "price_storage_vertical",
          status: "active",
        },
      ],
    });
    const service = createStripeBillingServiceV1({
      catalog: createStripeCheckoutPlanCatalogV1({
        pro: { renderJobLimit: 2, stripePriceId: "price_storage_vertical" },
      }),
      clock: () => new Date(now),
      gateway,
      livemode: false,
      publicOrigin: "https://studio.poietra.example",
      repository: stripeRepository,
      webhookSigningSecret: STRIPE_WEBHOOK_SECRET,
    });
    try {
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toMatchObject({ version: 29 });
      await createStripeOrganization(pool);
      await expect(stripeRepository.ready()).resolves.toBe(true);

      const principal = await authenticateManimPrincipal(
        { authenticate: async () => ({ subjectId: STRIPE_OWNER_ID, tenantId: TENANT_C }) },
        {},
        new AbortController().signal,
      );
      await expect(service.startCheckout({ planKey: "pro", principal })).resolves.toMatchObject({
        checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//u),
      });
      await expect(service.readStatus({ principal })).resolves.toMatchObject({
        configured: false,
        entitlement: null,
      });

      const checkoutRequest = gateway.checkoutRequests()[0];
      if (!checkoutRequest) throw new TypeError("The fake Stripe gateway did not receive Checkout.");
      const payloadBytes = Buffer.from(
        JSON.stringify({
          api_version: STRIPE_API_VERSION_V1,
          created: Math.floor(now / 1_000),
          data: {
            object: {
              customer: stripeCustomerId,
              id: stripeSubscriptionId,
              metadata: { poietra_checkout_attempt_id: checkoutRequest.attemptId },
              object: "subscription",
            },
          },
          id: stripeEventId,
          livemode: false,
          object: "event",
          type: "customer.subscription.created",
        }),
      );
      const timestamp = Math.floor(now / 1_000);
      const stripeSignature = `t=${timestamp},v1=${createHmac("sha256", STRIPE_WEBHOOK_SECRET)
        .update(`${timestamp}.`)
        .update(payloadBytes)
        .digest("hex")}`;
      const webhook = { rawBody: new Uint8Array(payloadBytes), stripeSignature };
      await service.acceptWebhook(webhook);

      await expect(service.readStatus({ principal })).resolves.toMatchObject({
        configured: true,
        entitlement: { renderEnabled: true, renderJobLimit: 2, sourceGeneration: "1" },
        subscription: { planKey: "pro", status: "active" },
      });
      await expect(
        entitlementRepository.reserveRender({
          lifetimeMs: 60_000,
          operationId: "00000000-0000-4000-8000-000000000503",
          tenantId: TENANT_C,
        }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: false });

      await service.acceptWebhook(webhook);
      await expect(stripeRepository.readAccount(TENANT_C)).resolves.toMatchObject({
        entitlementGeneration: 1n,
        reconcileGeneration: 1n,
      });
      await expect(stripeRepository.readCurrentEntitlement(TENANT_C)).resolves.toMatchObject({
        renderEnabled: true,
        sourceGeneration: 1n,
      });
    } finally {
      await service.close();
      await entitlementRepository.close();
      await pool.end();
    }
  });
});
