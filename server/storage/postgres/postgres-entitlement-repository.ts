import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  type ApplyEntitlementSnapshotInputV1,
  type BillingEntitlementRepositoryV1,
  parseApplyEntitlementSnapshotInputV1,
  parseEntitlementSnapshotV1,
  parseReserveRenderInputV1,
  parseUsageReservationIdentityV1,
  parseUsageReservationV1,
  type SettleUsageReservationResultV1,
} from "../../billing/entitlement-repository";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import { PostgresRepositoryConnectionV1 } from "./postgres-repository-connection";

type SnapshotRow = QueryResultRow & {
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

type CurrentSnapshotRow = SnapshotRow & {
  access_expired: boolean;
  period_inactive: boolean;
};

type ReservationRow = QueryResultRow & {
  created_at: Date;
  expires_at: Date;
  operation_id: string;
  operation_kind: string;
  settled_at: Date | null;
  snapshot_id: string;
  source_generation: string;
  state: string;
  tenant_id: string;
  updated_at: Date;
  usage_period_key: string;
  version: string;
};

type ExistingReservationRow = ReservationRow & { expired: boolean };

function generation(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  return parsed;
}

function snapshotFromRow(row: SnapshotRow) {
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

function reservationFromRow(row: ReservationRow) {
  return parseUsageReservationV1({
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    settledAt: row.settled_at,
    snapshotId: row.snapshot_id,
    sourceGeneration: generation(row.source_generation, "reservation source generation"),
    state: row.state,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    usagePeriodKey: row.usage_period_key,
    version: generation(row.version, "reservation version"),
  });
}

const SNAPSHOT_COLUMNS = `snapshot.tenant_id,
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
       snapshot.created_at`;

const RESERVATION_COLUMNS = `reservation.tenant_id,
       reservation.operation_kind,
       reservation.operation_id::text AS operation_id,
       reservation.snapshot_id::text AS snapshot_id,
       reservation.source_generation::text AS source_generation,
       reservation.usage_period_key,
       reservation.state,
       reservation.expires_at,
       reservation.settled_at,
       reservation.version::text AS version,
       reservation.created_at,
       reservation.updated_at`;

async function expireRenderUsageWithClientV1(client: PoolClient, row: ReservationRow) {
  const updated = await client.query<ReservationRow>(
    `UPDATE public.usage_reservations reservation
        SET state = 'released'
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = 'render'
        AND reservation.operation_id = $2::uuid
      RETURNING ${RESERVATION_COLUMNS}`,
    [row.tenant_id, row.operation_id],
  );
  const updatedRow = updated.rows[0];
  if (updated.rowCount !== 1 || !updatedRow) throw new TypeError("PostgreSQL did not expire the usage reservation.");
  await client.query(
    `INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     VALUES ($1, 'render', $2::uuid, 'expired', $3::uuid, $4, $5)`,
    [row.tenant_id, row.operation_id, row.snapshot_id, row.source_generation, row.usage_period_key],
  );
  return reservationFromRow(updatedRow);
}

/** Reserves one render job on an existing PostgreSQL transaction. */
export async function reserveRenderUsageWithClientV1(
  client: PoolClient,
  inputValue: Parameters<BillingEntitlementRepositoryV1["reserveRender"]>[0],
) {
  const input = parseReserveRenderInputV1(inputValue);
  const current = await client.query<CurrentSnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS},
            snapshot.access_until <= clock_timestamp() AS access_expired,
            clock_timestamp() < snapshot.period_start OR clock_timestamp() >= snapshot.period_end AS period_inactive
       FROM public.billing_accounts account
       JOIN public.entitlement_snapshots snapshot
         ON snapshot.tenant_id = account.tenant_id
        AND snapshot.snapshot_id = account.current_snapshot_id
      WHERE account.tenant_id = $1
      FOR UPDATE OF account`,
    [input.tenantId],
  );
  if (current.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate current entitlements.");
  const currentRow = current.rows[0];
  if (!currentRow) return { kind: "denied", reason: "unconfigured" } as const;
  const entitlement = snapshotFromRow(currentRow);

  const existing = await client.query<ExistingReservationRow>(
    `SELECT ${RESERVATION_COLUMNS}, reservation.expires_at <= clock_timestamp() AS expired
       FROM public.usage_reservations reservation
      WHERE reservation.tenant_id = $1
        AND reservation.operation_kind = 'render'
        AND reservation.operation_id = $2::uuid
      FOR UPDATE`,
    [input.tenantId, input.operationId],
  );
  if (existing.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate usage reservations.");
  const existingRow = existing.rows[0];
  if (existingRow) {
    if (existingRow.state === "reserved" && existingRow.expired) {
      await expireRenderUsageWithClientV1(client, existingRow);
      return { kind: "denied", reason: "operation-settled" } as const;
    }
    const reservation = reservationFromRow(existingRow);
    return reservation.state === "reserved"
      ? ({ kind: "reserved", replayed: true, reservation } as const)
      : ({ kind: "denied", reason: "operation-settled" } as const);
  }

  if (entitlement.accessState === "blocked") return { kind: "denied", reason: "blocked" } as const;
  if (currentRow.access_expired || currentRow.period_inactive) return { kind: "denied", reason: "expired" } as const;
  if (!entitlement.renderEnabled) return { kind: "denied", reason: "render-disabled" } as const;

  await client.query(
    `WITH expired AS (
       UPDATE public.usage_reservations
          SET state = 'released'
        WHERE tenant_id = $1 AND operation_kind = 'render' AND usage_period_key = $2
          AND state = 'reserved' AND expires_at <= clock_timestamp()
      RETURNING tenant_id, operation_kind, operation_id, snapshot_id, source_generation, usage_period_key
     )
     INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     SELECT tenant_id, operation_kind, operation_id, 'expired', snapshot_id, source_generation, usage_period_key
       FROM expired`,
    [input.tenantId, entitlement.usagePeriodKey],
  );
  const consumed = await client.query<{ consumed: string }>(
    `SELECT count(*)::text AS consumed
       FROM public.usage_reservations
      WHERE tenant_id = $1 AND operation_kind = 'render' AND usage_period_key = $2
        AND state IN ('reserved', 'committed')`,
    [input.tenantId, entitlement.usagePeriodKey],
  );
  if (consumed.rowCount !== 1 || !consumed.rows[0]) {
    throw new TypeError("PostgreSQL did not return bounded render usage.");
  }
  if (generation(consumed.rows[0].consumed, "render usage") >= BigInt(entitlement.renderJobLimit)) {
    return { kind: "denied", reason: "quota-exhausted" } as const;
  }

  const inserted = await client.query<ReservationRow>(
    `WITH reservation_clock AS (
       SELECT clock_timestamp() AS issued_at
     )
     INSERT INTO public.usage_reservations AS reservation
       (tenant_id, operation_kind, operation_id, snapshot_id, source_generation, usage_period_key, state,
        expires_at, created_at, updated_at)
     SELECT $1, 'render', $2::uuid, $3::uuid, $4, $5, 'reserved',
            issued_at + $6::bigint * interval '1 millisecond', issued_at, issued_at
       FROM reservation_clock
     RETURNING ${RESERVATION_COLUMNS}`,
    [
      input.tenantId,
      input.operationId,
      entitlement.snapshotId,
      entitlement.sourceGeneration.toString(),
      entitlement.usagePeriodKey,
      input.lifetimeMs,
    ],
  );
  const row = inserted.rows[0];
  if (inserted.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not return the usage reservation.");
  return { kind: "reserved", replayed: false, reservation: reservationFromRow(row) } as const;
}

/** Settles one render reservation on an existing PostgreSQL transaction. */
export async function settleRenderUsageWithClientV1(
  client: PoolClient,
  tenantIdValue: string,
  operationIdValue: string,
  target: "committed" | "released",
): Promise<SettleUsageReservationResultV1> {
  const { operationId, tenantId } = parseUsageReservationIdentityV1(tenantIdValue, operationIdValue);
  const result = await client.query<ExistingReservationRow>(
    `SELECT ${RESERVATION_COLUMNS}, reservation.expires_at <= clock_timestamp() AS expired
       FROM public.usage_reservations reservation
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = 'render'
        AND reservation.operation_id = $2::uuid
      FOR UPDATE`,
    [tenantId, operationId],
  );
  if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate usage reservations.");
  const row = result.rows[0];
  if (!row) return { kind: "missing" };
  if (row.state === target) return { kind: "settled", replayed: true, reservation: reservationFromRow(row) };
  if (row.state !== "reserved") return { kind: "conflict", state: reservationFromRow(row).state };
  if (row.expired) {
    const expired = await expireRenderUsageWithClientV1(client, row);
    return { kind: "conflict", state: expired.state };
  }
  const updated = await client.query<ReservationRow>(
    `UPDATE public.usage_reservations reservation
        SET state = $3
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = 'render'
        AND reservation.operation_id = $2::uuid
      RETURNING ${RESERVATION_COLUMNS}`,
    [tenantId, operationId, target],
  );
  const updatedRow = updated.rows[0];
  if (updated.rowCount !== 1 || !updatedRow) throw new TypeError("PostgreSQL did not settle the usage reservation.");
  await client.query(
    `INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     VALUES ($1, 'render', $2::uuid, $3, $4::uuid, $5, $6)`,
    [tenantId, operationId, target, row.snapshot_id, row.source_generation, row.usage_period_key],
  );
  return { kind: "settled", replayed: false, reservation: reservationFromRow(updatedRow) };
}

export class PostgresBillingEntitlementRepositoryV1 implements BillingEntitlementRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version = 14",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 1 &&
        result.rows[0]?.version === 14 &&
        result.rows[0]?.checksum === BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM
      );
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async applySnapshot(inputValue: ApplyEntitlementSnapshotInputV1, signal?: AbortSignal) {
    const input = parseApplyEntitlementSnapshotInputV1(inputValue);
    return this.#connection.transaction(async (client) => {
      const organization = await client.query(
        "SELECT tenant_id FROM public.organizations WHERE tenant_id = $1 FOR UPDATE",
        [input.tenantId],
      );
      if (organization.rowCount !== 1) throw new TypeError("The entitlement organization does not exist.");
      await client.query(
        `INSERT INTO public.billing_accounts (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId],
      );
      const account = await client.query<{ applied_generation: string }>(
        `SELECT applied_generation::text AS applied_generation
           FROM public.billing_accounts
          WHERE tenant_id = $1
          FOR UPDATE`,
        [input.tenantId],
      );
      if (account.rowCount !== 1 || !account.rows[0]) {
        throw new TypeError("PostgreSQL did not return the billing account.");
      }
      const appliedGeneration = generation(account.rows[0].applied_generation, "applied entitlement generation");
      if (appliedGeneration !== input.expectedGeneration) return { appliedGeneration, kind: "conflict" } as const;

      const inserted = await client.query<SnapshotRow>(
        `INSERT INTO public.entitlement_snapshots
           (tenant_id, snapshot_id, source_generation, plan_key, access_state, render_enabled,
            render_job_limit, usage_period_key, period_start, period_end, access_until)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING tenant_id, snapshot_id::text AS snapshot_id, source_generation::text AS source_generation,
                   plan_key, access_state, render_enabled, render_job_limit, usage_period_key,
                   period_start, period_end, access_until, created_at`,
        [
          input.tenantId,
          input.snapshotId,
          input.sourceGeneration.toString(),
          input.planKey,
          input.accessState,
          input.renderEnabled,
          input.renderJobLimit,
          input.usagePeriodKey,
          input.periodStart,
          input.periodEnd,
          input.accessUntil,
        ],
      );
      const row = inserted.rows[0];
      if (inserted.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not return the applied entitlement.");
      const advanced = await client.query(
        `UPDATE public.billing_accounts
            SET current_snapshot_id = $2::uuid, applied_generation = $3
          WHERE tenant_id = $1 AND applied_generation = $4`,
        [input.tenantId, input.snapshotId, input.sourceGeneration.toString(), input.expectedGeneration.toString()],
      );
      if (advanced.rowCount !== 1) throw new TypeError("PostgreSQL did not advance the billing account.");
      return { kind: "applied", snapshot: snapshotFromRow(row) } as const;
    }, signal);
  }

  async reserveRender(
    inputValue: Parameters<BillingEntitlementRepositoryV1["reserveRender"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReserveRenderInputV1(inputValue);
    return this.#connection.transaction((client) => reserveRenderUsageWithClientV1(client, input), signal);
  }

  async commitReservation(tenantId: string, operationId: string, signal?: AbortSignal) {
    const identity = parseUsageReservationIdentityV1(tenantId, operationId);
    return this.#connection.transaction(
      (client) => settleRenderUsageWithClientV1(client, identity.tenantId, identity.operationId, "committed"),
      signal,
    );
  }

  async releaseReservation(tenantId: string, operationId: string, signal?: AbortSignal) {
    const identity = parseUsageReservationIdentityV1(tenantId, operationId);
    return this.#connection.transaction(
      (client) => settleRenderUsageWithClientV1(client, identity.tenantId, identity.operationId, "released"),
      signal,
    );
  }

  close() {
    return this.#connection.close();
  }
}
