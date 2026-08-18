import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { MAX_USAGE_RESERVATION_LIFETIME_MS_V1 } from "../billing/entitlement-repository";
import { createBillingClientExportPublicationMeteringV1 } from "./client-export-billing-metering";
import { CLIENT_EXPORT_MEDIA_TYPE_V1, createClientExportArtifactLocatorV1 } from "./client-export-contract";
import { createBillingEditSuggestionUsageMeterV1 } from "../edit-suggestions/usage-metering";
import { FakeStripeBillingGatewayV1 } from "../billing/fake-stripe-gateway";
import { createStripeCheckoutPlanCatalogV1 } from "../billing/plan-catalog";
import { createStripeBillingServiceV1 } from "../billing/stripe-billing-service";
import { STRIPE_API_VERSION_V1 } from "../billing/stripe-gateway";
import { authenticateManimPrincipal } from "../manim-request-principal";
import { applyBundledDurableStorageMigrations, applyBundledDurableStorageMigrationsThrough } from "./postgres/migrate";
import { PostgresClientExportRepositoryV1 } from "./postgres/postgres-client-export-repository";
import { PostgresBillingEntitlementRepositoryV1 } from "./postgres/postgres-entitlement-repository";
import { PostgresStripeBillingRepositoryV1 } from "./postgres/postgres-stripe-billing-repository";

const DATABASE_URL = process.env.POIETRA_STORAGE_E2E_DATABASE_URL;
const TENANT_A = "billing-tenant-a";
const TENANT_B = "billing-tenant-b";
const TENANT_C = "billing-stripe-tenant";
const TENANT_D = "billing-grant-tenant";
const OWNER_ID = "00000000-0000-4000-8000-000000000321";
const STRIPE_OWNER_ID = "00000000-0000-4000-8000-000000000322";
const GRANT_OWNER_ID = "00000000-0000-4000-8000-000000000323";
const GRANT_EXPORT_PROJECT = "billing-export-project";
const GRANT_EXPORT_DOCUMENT_KEY = "ab".repeat(32);
const GRANT_EXPORT_EPOCH = "00000000-0000-4000-8000-000000000324";
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
  it("backfills render grants before widening kinds, meters ai-suggestion flow, and admits stock under the billing lock", async () => {
    const now = Date.now();
    const periodStart = new Date(now - 60_000);
    const accessUntil = new Date(now + 30 * 60_000);
    const periodEnd = new Date(now + 60 * 60_000);
    const usagePeriodKey = "grants:2026-08";
    const legacySnapshotId = "00000000-0000-4000-8000-000000000601";
    const legacyRenderOperationId = "00000000-0000-4000-8000-000000000602";
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const repository = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    let clientExports: PostgresClientExportRepositoryV1 | undefined;
    try {
      // 1. The pre-v32 world: a v14 binary applied an entitlement snapshot and
      //    held a live render reservation without any grant tables.
      expect(await applyBundledDurableStorageMigrationsThrough(pool, 30)).toEqual({ applied: true, version: 30 });
      const legacySetup = await pool.connect();
      try {
        await legacySetup.query("BEGIN");
        await legacySetup.query("INSERT INTO public.workspace_tenants (tenant_id) VALUES ($1)", [TENANT_D]);
        await legacySetup.query(
          `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
           VALUES ($1::uuid, 'https://identity.example/', 'grant-owner', 'Grant owner')`,
          [GRANT_OWNER_ID],
        );
        await legacySetup.query("INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, $2)", [
          TENANT_D,
          "Billing grant tenant",
        ]);
        await legacySetup.query(
          `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
           VALUES ($1, $2::uuid, 'owner')`,
          [TENANT_D, GRANT_OWNER_ID],
        );
        await legacySetup.query(
          "INSERT INTO public.workspace_projects (tenant_id, project_id, display_name) VALUES ($1, $2, 'Billing export project')",
          [TENANT_D, GRANT_EXPORT_PROJECT],
        );
        await legacySetup.query(
          `INSERT INTO public.editor_documents
             (tenant_id, project_id, document_key, epoch, origin, source_path, source_hash, revision)
           VALUES ($1, $2, decode($3, 'hex'), $4::uuid, 'studio-native', NULL, NULL, 0)`,
          [TENANT_D, GRANT_EXPORT_PROJECT, GRANT_EXPORT_DOCUMENT_KEY, GRANT_EXPORT_EPOCH],
        );
        await legacySetup.query("INSERT INTO public.billing_accounts (tenant_id) VALUES ($1)", [TENANT_D]);
        await legacySetup.query(
          `INSERT INTO public.entitlement_snapshots
             (tenant_id, snapshot_id, source_generation, plan_key, access_state, render_enabled,
              render_job_limit, usage_period_key, period_start, period_end, access_until)
           VALUES ($1, $2::uuid, 1, 'pro', 'active', true, 2, $3, $4, $5, $6)`,
          [TENANT_D, legacySnapshotId, usagePeriodKey, periodStart, periodEnd, accessUntil],
        );
        await legacySetup.query(
          `UPDATE public.billing_accounts
              SET current_snapshot_id = $2::uuid, applied_generation = 1
            WHERE tenant_id = $1`,
          [TENANT_D, legacySnapshotId],
        );
        await legacySetup.query(
          `INSERT INTO public.usage_reservations
             (tenant_id, operation_kind, operation_id, snapshot_id, source_generation, usage_period_key,
              state, expires_at)
           VALUES ($1, 'render', $2::uuid, $3::uuid, 1, $4, 'reserved', clock_timestamp() + interval '20 minutes')`,
          [TENANT_D, legacyRenderOperationId, legacySnapshotId, usagePeriodKey],
        );
        await legacySetup.query("COMMIT");
      } catch (error) {
        await legacySetup.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        legacySetup.release();
      }
      // The grant-aware repository fails closed until migration v32 exists.
      await expect(repository.ready()).resolves.toBe(false);

      // 2. v32 backfills exactly one render grant per snapshot BEFORE the
      //    operation-kind checks widen, and validates the legacy reservation
      //    against its exact grant.
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toEqual({ applied: true, version: 32 });
      await expect(repository.ready()).resolves.toBe(true);
      await expect(
        pool.query<{ entitlement_generation: string; operation_kind: string; unit_limit: number }>(
          `SELECT operation_kind, unit_limit, entitlement_generation::text AS entitlement_generation
             FROM public.entitlement_flow_grants
            WHERE tenant_id = $1
            ORDER BY operation_kind`,
          [TENANT_D],
        ),
      ).resolves.toMatchObject({
        rowCount: 1,
        rows: [{ entitlement_generation: "1", operation_kind: "render", unit_limit: 2 }],
      });
      await expect(
        pool.query<{ ungranted: string }>(
          `SELECT count(*)::text AS ungranted
             FROM public.entitlement_snapshots snapshot
             LEFT JOIN public.entitlement_flow_grants flow_grant
               ON flow_grant.tenant_id = snapshot.tenant_id
              AND flow_grant.entitlement_snapshot_id = snapshot.snapshot_id
              AND flow_grant.operation_kind = 'render'
            WHERE flow_grant.tenant_id IS NULL`,
        ),
      ).resolves.toMatchObject({ rows: [{ ungranted: "0" }] });

      // The live legacy render reservation replays and the render lane keeps
      // its v14 admission behavior against the backfilled grant.
      await expect(
        repository.reserveRender({ lifetimeMs: 60_000, operationId: legacyRenderOperationId, tenantId: TENANT_D }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: true });

      // 3. A snapshot without an ai-suggestion grant denies the new kind.
      await expect(
        repository.reserveFlowUsage({
          lifetimeMs: 60_000,
          operationId: "00000000-0000-4000-8000-000000000603",
          operationKind: "ai-suggestion",
          tenantId: TENANT_D,
        }),
      ).resolves.toEqual({ kind: "denied", reason: "operation-disabled" });

      // 4. A grant-aware snapshot enables the widened kinds and stock.
      await expect(
        repository.applySnapshot({
          accessState: "active",
          accessUntil,
          aiSuggestionLimit: 2,
          expectedGeneration: 1n,
          exportPublicationLimit: 1,
          periodEnd,
          periodStart,
          planKey: "pro",
          publishedArtifactBytesLimit: 1_000,
          renderEnabled: true,
          renderJobLimit: 2,
          snapshotId: "00000000-0000-4000-8000-000000000604",
          sourceGeneration: 2n,
          tenantId: TENANT_D,
          usagePeriodKey,
        }),
      ).resolves.toMatchObject({ kind: "applied" });
      await expect(repository.readCurrentEntitlementGrants(TENANT_D)).resolves.toMatchObject({
        flowGrants: [
          { operationKind: "ai-suggestion", unitLimit: 2 },
          { operationKind: "export-publication", unitLimit: 1 },
          { entitlementGeneration: 2n, operationKind: "render", unitLimit: 2 },
        ],
        snapshot: { sourceGeneration: 2n },
        stockGrants: [{ quantityLimit: 1_000, resourceKind: "published-artifact-bytes" }],
      });

      // 5. The ai-suggestion meter lifecycle: reserve, commit at the billable
      //    cost point, release on pre-dispatch rejection, then exhaust the
      //    kind-partitioned quota while the render reservation stays uncounted.
      const meter = createBillingEditSuggestionUsageMeterV1(repository);
      const aiCommitted = "00000000-0000-4000-8000-000000000611";
      const aiReleased = "00000000-0000-4000-8000-000000000612";
      const aiHeld = "00000000-0000-4000-8000-000000000613";
      const aiDenied = "00000000-0000-4000-8000-000000000614";
      await expect(
        meter.reserve({ lifetimeMs: 60_000, operationId: aiCommitted, tenantId: TENANT_D }),
      ).resolves.toMatchObject({
        kind: "reserved",
        reservation: { operationKind: "ai-suggestion", sourceGeneration: 2n },
      });
      await expect(meter.commit(TENANT_D, aiCommitted)).resolves.toMatchObject({
        kind: "settled",
        replayed: false,
        reservation: { state: "committed" },
      });
      await expect(meter.commit(TENANT_D, aiCommitted)).resolves.toMatchObject({ kind: "settled", replayed: true });
      await expect(meter.release(TENANT_D, aiCommitted)).resolves.toEqual({ kind: "conflict", state: "committed" });
      await expect(
        meter.reserve({ lifetimeMs: 60_000, operationId: aiReleased, tenantId: TENANT_D }),
      ).resolves.toMatchObject({ kind: "reserved" });
      await expect(meter.release(TENANT_D, aiReleased)).resolves.toMatchObject({
        kind: "settled",
        replayed: false,
        reservation: { state: "released" },
      });
      await expect(
        meter.reserve({ lifetimeMs: 60_000, operationId: aiHeld, tenantId: TENANT_D }),
      ).resolves.toMatchObject({ kind: "reserved", replayed: false });
      await expect(meter.reserve({ lifetimeMs: 60_000, operationId: aiDenied, tenantId: TENANT_D })).resolves.toEqual({
        kind: "denied",
        reason: "quota-exhausted",
      });
      await expect(
        pool.query<{ event_count: string; outcome: string }>(
          `SELECT outcome, count(*)::text AS event_count
             FROM public.usage_events
            WHERE tenant_id = $1 AND operation_kind = 'ai-suggestion'
            GROUP BY outcome
            ORDER BY outcome`,
          [TENANT_D],
        ),
      ).resolves.toMatchObject({
        rows: [
          { event_count: "1", outcome: "committed" },
          { event_count: "1", outcome: "released" },
        ],
      });

      // 6. Publication acceptance commits flow and allocates retained bytes in
      //    the same PostgreSQL transaction.
      const exportOperationId = "00000000-0000-4000-8000-000000000621";
      const exportMeter = createBillingClientExportPublicationMeteringV1(repository);
      clientExports = new PostgresClientExportRepositoryV1({
        metering: exportMeter,
        poolConfig: { connectionString: DATABASE_URL, max: 2 },
      });
      const exportLineage = {
        documentEpoch: GRANT_EXPORT_EPOCH,
        documentKey: GRANT_EXPORT_DOCUMENT_KEY,
        documentRevision: 0n,
        encoderEvidence: {
          codec: "h264-mp4",
          frameRate: 30,
          resolution: "854x480",
          schema: "poietra.browser-webcodecs-encoder-evidence",
          version: 1,
        },
        encoderEvidenceVersion: 1,
        exportProfileHash: "ef".repeat(32),
        producerKind: "browser-webcodecs",
        sceneContractVersion: 1,
        sceneRevisionHash: "12".repeat(32),
      } as const;
      const publicationInput = (input: {
        artifactId: string;
        byteSize: number;
        digest: string;
        expirationMs: number;
        publicationId: string;
      }) => {
        const receipt = {
          byteSize: input.byteSize,
          contentDigest: input.digest,
          etag: `billing-export-${input.artifactId}`,
          mediaType: CLIENT_EXPORT_MEDIA_TYPE_V1,
          ...createClientExportArtifactLocatorV1(TENANT_D, input.digest),
        } as const;
        return {
          receipt,
          value: {
            artifactId: input.artifactId,
            createdBySubjectId: GRANT_OWNER_ID,
            expirationMs: input.expirationMs,
            lineage: exportLineage,
            projectId: GRANT_EXPORT_PROJECT,
            publicationId: input.publicationId,
            receipt,
            tenantId: TENANT_D,
          } as const,
        };
      };
      const publicationA = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000625",
        byteSize: 600,
        digest: "cd".repeat(32),
        expirationMs: 1,
        publicationId: exportOperationId,
      });
      await expect(
        exportMeter.reservePublication({
          lifetimeMs: 60_000,
          operationId: exportOperationId,
          tenantId: TENANT_D,
        }),
      ).resolves.toMatchObject({ kind: "reserved" });
      await expect(clientExports.acceptPublication(publicationA.value)).resolves.toMatchObject({
        kind: "accepted",
        replayed: false,
      });
      await expect(
        pool.query(
          `SELECT reservation.state, allocation.quantity::int, allocation.released_at
             FROM public.usage_reservations reservation
             JOIN public.stock_allocations allocation
               ON allocation.tenant_id = reservation.tenant_id
              AND allocation.publication_id = reservation.operation_id
            WHERE reservation.tenant_id = $1 AND reservation.operation_kind = 'export-publication'
              AND reservation.operation_id = $2::uuid`,
          [TENANT_D, exportOperationId],
        ),
      ).resolves.toMatchObject({ rows: [{ quantity: 600, released_at: null, state: "committed" }] });
      await expect(
        repository.reserveFlowUsage({
          lifetimeMs: 60_000,
          operationId: "00000000-0000-4000-8000-000000000622",
          operationKind: "export-publication",
          tenantId: TENANT_D,
        }),
      ).resolves.toEqual({ kind: "denied", reason: "quota-exhausted" });

      // The allocation audit row may outlive publication metadata, but an
      // unreleased row can never commit without its same-tenant publication.
      await expect(
        pool.query(
          `INSERT INTO public.stock_allocations (tenant_id, resource_kind, publication_id, quantity)
           VALUES ($1, 'published-artifact-bytes', $2::uuid, 1)`,
          [TENANT_D, "00000000-0000-4000-8000-000000000629"],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      // 7. Stock admission is exercised only through real publication
      //    transactions. Two 400-byte accepts race against the retained 600
      //    bytes; the tenant billing lock admits exactly one.
      await expect(
        repository.applySnapshot({
          accessState: "active",
          accessUntil,
          aiSuggestionLimit: 2,
          expectedGeneration: 2n,
          exportPublicationLimit: 4,
          periodEnd,
          periodStart,
          planKey: "pro",
          publishedArtifactBytesLimit: 1_000,
          renderEnabled: true,
          renderJobLimit: 2,
          snapshotId: "00000000-0000-4000-8000-000000000605",
          sourceGeneration: 3n,
          tenantId: TENANT_D,
          usagePeriodKey,
        }),
      ).resolves.toMatchObject({ kind: "applied" });
      const publicationB = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000635",
        byteSize: 400,
        digest: "bd".repeat(32),
        expirationMs: 60_000,
        publicationId: "00000000-0000-4000-8000-000000000632",
      });
      const publicationC = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000636",
        byteSize: 400,
        digest: "ce".repeat(32),
        expirationMs: 60_000,
        publicationId: "00000000-0000-4000-8000-000000000633",
      });
      await expect(
        Promise.all(
          [publicationB, publicationC].map(({ value }) =>
            exportMeter.reservePublication({
              lifetimeMs: 60_000,
              operationId: value.publicationId,
              tenantId: TENANT_D,
            }),
          ),
        ),
      ).resolves.toMatchObject([{ kind: "reserved" }, { kind: "reserved" }]);
      const stockRace = await Promise.all(
        [publicationB, publicationC].map(({ value }) => clientExports!.acceptPublication(value)),
      );
      expect(stockRace.filter((result) => result.kind === "accepted")).toHaveLength(1);
      expect(stockRace.filter((result) => result.kind === "refused")).toEqual([
        { kind: "refused", reason: "quota-exhausted" },
      ]);
      const refusedIndex = stockRace.findIndex((result) => result.kind === "refused");
      await exportMeter.releasePublication(TENANT_D, [publicationB, publicationC][refusedIndex]!.value.publicationId);
      await expect(clientExports.acceptPublication(publicationA.value)).resolves.toMatchObject({
        kind: "accepted",
        replayed: true,
      });
      const conflictingA = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000637",
        byteSize: 500,
        digest: "ac".repeat(32),
        expirationMs: 1,
        publicationId: exportOperationId,
      });
      await expect(clientExports.acceptPublication(conflictingA.value)).resolves.toEqual({
        kind: "conflict",
        reason: "payload-mismatch",
      });

      // 8. A downgrade below current stock blocks new allocation without
      //    deleting customer data; releasing credits at the deletion queue.
      await expect(
        repository.applySnapshot({
          accessState: "active",
          accessUntil,
          aiSuggestionLimit: 2,
          expectedGeneration: 3n,
          exportPublicationLimit: 4,
          periodEnd,
          periodStart,
          planKey: "pro",
          publishedArtifactBytesLimit: 500,
          renderEnabled: true,
          renderJobLimit: 2,
          snapshotId: "00000000-0000-4000-8000-000000000606",
          sourceGeneration: 4n,
          tenantId: TENANT_D,
          usagePeriodKey,
        }),
      ).resolves.toMatchObject({ kind: "applied" });
      const publicationD = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000638",
        byteSize: 1,
        digest: "df".repeat(32),
        expirationMs: 60_000,
        publicationId: "00000000-0000-4000-8000-000000000634",
      });
      await expect(
        exportMeter.reservePublication({
          lifetimeMs: 60_000,
          operationId: publicationD.value.publicationId,
          tenantId: TENANT_D,
        }),
      ).resolves.toMatchObject({ kind: "reserved" });
      await expect(clientExports.acceptPublication(publicationD.value)).resolves.toEqual({
        kind: "refused",
        reason: "quota-exhausted",
      });
      await expect(
        pool.query<{ unreleased: string }>(
          `SELECT count(*)::text AS unreleased
             FROM public.stock_allocations
            WHERE tenant_id = $1 AND released_at IS NULL`,
          [TENANT_D],
        ),
      ).resolves.toMatchObject({ rows: [{ unreleased: "2" }] });
      await expect(
        pool.query("DELETE FROM public.client_export_publications WHERE tenant_id = $1 AND publication_id = $2::uuid", [
          TENANT_D,
          exportOperationId,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
      await delay(10);
      await expect(clientExports.queueDeletion(TENANT_D, publicationA.receipt, 1)).resolves.toMatchObject({
        tenantId: TENANT_D,
      });
      await expect(clientExports.queueDeletion(TENANT_D, publicationA.receipt, 1)).resolves.toMatchObject({
        tenantId: TENANT_D,
      });
      await expect(
        pool.query<{ released: boolean }>(
          `SELECT released_at IS NOT NULL AS released
             FROM public.stock_allocations
            WHERE tenant_id = $1 AND publication_id = $2::uuid`,
          [TENANT_D, exportOperationId],
        ),
      ).resolves.toMatchObject({ rows: [{ released: true }] });
      // The remaining 400 bytes fit under the downgraded 500-byte grant.
      await expect(clientExports.acceptPublication(publicationD.value)).resolves.toMatchObject({
        kind: "accepted",
        replayed: false,
      });

      // 9. Stock does not reset with the usage period, but a future
      //    entitlement cannot admit retained bytes before its period starts.
      const publicationE = publicationInput({
        artifactId: "00000000-0000-4000-8000-000000000639",
        byteSize: 1,
        digest: "ea".repeat(32),
        expirationMs: 60_000,
        publicationId: "00000000-0000-4000-8000-000000000640",
      });
      await expect(
        exportMeter.reservePublication({
          lifetimeMs: 60_000,
          operationId: publicationE.value.publicationId,
          tenantId: TENANT_D,
        }),
      ).resolves.toMatchObject({ kind: "reserved" });
      const futurePeriodStart = new Date(Date.now() + 60_000);
      await expect(
        repository.applySnapshot({
          accessState: "active",
          accessUntil: new Date(futurePeriodStart.getTime() + 30 * 60_000),
          aiSuggestionLimit: 2,
          expectedGeneration: 4n,
          exportPublicationLimit: 4,
          periodEnd: new Date(futurePeriodStart.getTime() + 60 * 60_000),
          periodStart: futurePeriodStart,
          planKey: "pro",
          publishedArtifactBytesLimit: 500,
          renderEnabled: true,
          renderJobLimit: 2,
          snapshotId: "00000000-0000-4000-8000-000000000607",
          sourceGeneration: 5n,
          tenantId: TENANT_D,
          usagePeriodKey,
        }),
      ).resolves.toMatchObject({ kind: "applied" });
      await expect(clientExports.acceptPublication(publicationE.value)).resolves.toEqual({
        kind: "refused",
        reason: "quota-exhausted",
      });
      await expect(
        pool.query<{ retained: string }>(
          `SELECT count(*)::text AS retained
             FROM public.stock_allocations
            WHERE tenant_id = $1 AND publication_id = $2::uuid`,
          [TENANT_D, publicationE.value.publicationId],
        ),
      ).resolves.toMatchObject({ rows: [{ retained: "0" }] });

      // 10. The ledgers stay append-only or release-only at the schema boundary.
      await expect(
        pool.query("UPDATE public.entitlement_flow_grants SET unit_limit = 99 WHERE tenant_id = $1", [TENANT_D]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("UPDATE public.entitlement_stock_grants SET quantity_limit = 99 WHERE tenant_id = $1", [TENANT_D]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query("DELETE FROM public.stock_allocations WHERE tenant_id = $1", [TENANT_D]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "UPDATE public.stock_allocations SET quantity = 1 WHERE tenant_id = $1 AND publication_id = $2::uuid",
          [TENANT_D, exportOperationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await clientExports?.close();
      await repository.close();
      await pool.end();
    }
  });

  it("atomically reserves one render quota, replays safely, preserves period usage, and isolates tenants", async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const repositoryA = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    const repositoryB = new PostgresBillingEntitlementRepositoryV1({
      poolConfig: { connectionString: DATABASE_URL, max: 4 },
    });
    try {
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toMatchObject({ version: 32 });
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
      await expect(applyBundledDurableStorageMigrations(pool)).resolves.toMatchObject({ version: 32 });
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
