import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { settleRenderUsageWithClientV1 } from "./postgres/postgres-entitlement-repository";

export async function seedActiveRenderEntitlementFixtureV1(pool: Pool, tenantId: string, renderJobLimit = 64) {
  const ownerId = randomUUID();
  const snapshotId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.users (user_id, oidc_issuer, oidc_subject, display_name)
       VALUES ($1::uuid, 'https://storage-e2e.poietra.invalid/', $2, 'Storage E2E owner')`,
      [ownerId, `storage-e2e-${ownerId}`],
    );
    await client.query(
      "INSERT INTO public.organizations (tenant_id, display_name) VALUES ($1, 'Storage E2E organization')",
      [tenantId],
    );
    await client.query(
      `INSERT INTO public.organization_memberships (tenant_id, user_id, role)
      VALUES ($1, $2::uuid, 'owner')`,
      [tenantId, ownerId],
    );
    await client.query("INSERT INTO public.billing_accounts (tenant_id) VALUES ($1)", [tenantId]);
    await client.query(
      `WITH entitlement_clock AS (
         SELECT clock_timestamp() AS issued_at
       )
       INSERT INTO public.entitlement_snapshots
         (tenant_id, snapshot_id, source_generation, plan_key, access_state, render_enabled,
          render_job_limit, usage_period_key, period_start, access_until, period_end)
       SELECT $1, $2::uuid, 1, 'storage-e2e', 'active', true,
              $3, $4, issued_at - interval '1 minute', issued_at + interval '30 minutes',
              issued_at + interval '1 hour'
         FROM entitlement_clock`,
      [tenantId, snapshotId, renderJobLimit, `storage-e2e:${randomUUID()}`],
    );
    await client.query(
      `UPDATE public.billing_accounts
          SET current_snapshot_id = $2::uuid, applied_generation = 1
        WHERE tenant_id = $1`,
      [tenantId, snapshotId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function mutateRenderSessionWithUsageFixtureV1(
  pool: Pool,
  input: Readonly<{
    mutate: (client: PoolClient) => Promise<Readonly<{ rowCount: number | null }>>;
    sessionId: string;
    target: "committed" | "released";
    tenantId: string;
  }>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mutation = await input.mutate(client);
    if (mutation.rowCount !== 1) throw new Error("The storage E2E render mutation did not update one session.");
    const settled = await settleRenderUsageWithClientV1(client, input.tenantId, input.sessionId, input.target);
    if (
      settled.kind !== "settled" &&
      !(input.target === "released" && settled.kind === "conflict" && settled.state === "released")
    ) {
      throw new Error("The storage E2E render mutation did not settle its usage reservation.");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
