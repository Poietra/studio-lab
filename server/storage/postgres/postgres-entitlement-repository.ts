import type { Pool, PoolClient, PoolConfig, QueryResultRow } from "pg";

import {
  type AllocateStockInputV1,
  type AllocateStockResultV1,
  type ApplyEntitlementSnapshotInputV1,
  type BillingEntitlementRepositoryV1,
  type EntitlementGrantSetV1,
  type FlowOperationKindV1,
  parseAllocateStockInputV1,
  parseApplyEntitlementSnapshotInputV1,
  parseEntitlementFlowGrantV1,
  parseEntitlementSnapshotV1,
  parseEntitlementStockGrantV1,
  parseFlowUsageReservationIdentityV1,
  parseReleaseStockInputV1,
  parseReserveFlowUsageInputV1,
  parseReserveRenderInputV1,
  parseStockAllocationV1,
  parseUsageReservationV1,
  type ReleaseStockInputV1,
  type ReleaseStockResultV1,
  type ReserveRenderResultV1,
  type SettleUsageReservationResultV1,
} from "../../billing/entitlement-repository";
import { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
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

type CurrentStockSnapshotRow = SnapshotRow & {
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

type FlowGrantRow = QueryResultRow & {
  created_at: Date;
  entitlement_generation: string;
  entitlement_snapshot_id: string;
  operation_kind: string;
  tenant_id: string;
  unit_limit: number;
  usage_period_key: string;
};

type StockGrantRow = QueryResultRow & {
  created_at: Date;
  entitlement_generation: string;
  entitlement_snapshot_id: string;
  quantity_limit: string;
  resource_kind: string;
  tenant_id: string;
};

type StockAllocationRow = QueryResultRow & {
  allocated_at: Date;
  publication_id: string;
  quantity: string;
  released_at: Date | null;
  resource_kind: string;
  tenant_id: string;
};

function generation(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  return parsed;
}

function quantity(value: string, label: string) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`PostgreSQL returned an invalid ${label}.`);
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

function flowGrantFromRow(row: FlowGrantRow) {
  return parseEntitlementFlowGrantV1({
    createdAt: row.created_at,
    entitlementGeneration: generation(row.entitlement_generation, "flow grant entitlement generation"),
    entitlementSnapshotId: row.entitlement_snapshot_id,
    operationKind: row.operation_kind,
    tenantId: row.tenant_id,
    unitLimit: row.unit_limit,
    usagePeriodKey: row.usage_period_key,
  });
}

function stockGrantFromRow(row: StockGrantRow) {
  return parseEntitlementStockGrantV1({
    createdAt: row.created_at,
    entitlementGeneration: generation(row.entitlement_generation, "stock grant entitlement generation"),
    entitlementSnapshotId: row.entitlement_snapshot_id,
    quantityLimit: quantity(row.quantity_limit, "stock grant quantity limit"),
    resourceKind: row.resource_kind,
    tenantId: row.tenant_id,
  });
}

function stockAllocationFromRow(row: StockAllocationRow) {
  return parseStockAllocationV1({
    allocatedAt: row.allocated_at,
    publicationId: row.publication_id,
    quantity: quantity(row.quantity, "stock allocation quantity"),
    releasedAt: row.released_at,
    resourceKind: row.resource_kind,
    tenantId: row.tenant_id,
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

const FLOW_GRANT_COLUMNS = `flow_grant.tenant_id,
       flow_grant.entitlement_snapshot_id::text AS entitlement_snapshot_id,
       flow_grant.entitlement_generation::text AS entitlement_generation,
       flow_grant.operation_kind,
       flow_grant.usage_period_key,
       flow_grant.unit_limit,
       flow_grant.created_at`;

const STOCK_GRANT_COLUMNS = `stock_grant.tenant_id,
       stock_grant.entitlement_snapshot_id::text AS entitlement_snapshot_id,
       stock_grant.entitlement_generation::text AS entitlement_generation,
       stock_grant.resource_kind,
       stock_grant.quantity_limit::text AS quantity_limit,
       stock_grant.created_at`;

const STOCK_ALLOCATION_COLUMNS = `allocation.tenant_id,
       allocation.resource_kind,
       allocation.publication_id::text AS publication_id,
       allocation.quantity::text AS quantity,
       allocation.allocated_at,
       allocation.released_at`;

async function expireFlowUsageWithClientV1(client: PoolClient, row: ReservationRow) {
  const updated = await client.query<ReservationRow>(
    `UPDATE public.usage_reservations reservation
        SET state = 'released'
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = $2
        AND reservation.operation_id = $3::uuid
      RETURNING ${RESERVATION_COLUMNS}`,
    [row.tenant_id, row.operation_kind, row.operation_id],
  );
  const updatedRow = updated.rows[0];
  if (updated.rowCount !== 1 || !updatedRow) throw new TypeError("PostgreSQL did not expire the usage reservation.");
  await client.query(
    `INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     VALUES ($1, $2, $3::uuid, 'expired', $4::uuid, $5, $6)`,
    [row.tenant_id, row.operation_kind, row.operation_id, row.snapshot_id, row.source_generation, row.usage_period_key],
  );
  return reservationFromRow(updatedRow);
}

/** Reserves one flow-operation unit against its exact entitlement grant on an existing transaction. */
export async function reserveFlowUsageWithClientV1(
  client: PoolClient,
  inputValue: Parameters<BillingEntitlementRepositoryV1["reserveFlowUsage"]>[0],
) {
  const input = parseReserveFlowUsageInputV1(inputValue);
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
        AND reservation.operation_kind = $2
        AND reservation.operation_id = $3::uuid
      FOR UPDATE`,
    [input.tenantId, input.operationKind, input.operationId],
  );
  if (existing.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate usage reservations.");
  const existingRow = existing.rows[0];
  if (existingRow) {
    if (existingRow.state === "reserved" && existingRow.expired) {
      await expireFlowUsageWithClientV1(client, existingRow);
      return { kind: "denied", reason: "operation-settled" } as const;
    }
    const reservation = reservationFromRow(existingRow);
    return reservation.state === "reserved"
      ? ({ kind: "reserved", replayed: true, reservation } as const)
      : ({ kind: "denied", reason: "operation-settled" } as const);
  }

  if (entitlement.accessState === "blocked") return { kind: "denied", reason: "blocked" } as const;
  if (currentRow.access_expired || currentRow.period_inactive) return { kind: "denied", reason: "expired" } as const;

  const grantResult = await client.query<{ unit_limit: number }>(
    `SELECT flow_grant.unit_limit
       FROM public.entitlement_flow_grants flow_grant
      WHERE flow_grant.tenant_id = $1 AND flow_grant.entitlement_snapshot_id = $2::uuid
        AND flow_grant.entitlement_generation = $3 AND flow_grant.operation_kind = $4
        AND flow_grant.usage_period_key = $5`,
    [
      input.tenantId,
      entitlement.snapshotId,
      entitlement.sourceGeneration.toString(),
      input.operationKind,
      entitlement.usagePeriodKey,
    ],
  );
  if (grantResult.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate entitlement flow grants.");
  const unitLimit = grantResult.rows[0]?.unit_limit;
  if (typeof unitLimit === "number" && !Number.isSafeInteger(unitLimit)) {
    throw new TypeError("PostgreSQL returned an invalid flow grant unit limit.");
  }
  if (unitLimit === undefined || unitLimit <= 0) return { kind: "denied", reason: "operation-disabled" } as const;

  await client.query(
    `WITH expired AS (
       UPDATE public.usage_reservations
          SET state = 'released'
        WHERE tenant_id = $1 AND operation_kind = $2 AND usage_period_key = $3
          AND state = 'reserved' AND expires_at <= clock_timestamp()
      RETURNING tenant_id, operation_kind, operation_id, snapshot_id, source_generation, usage_period_key
     )
     INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     SELECT tenant_id, operation_kind, operation_id, 'expired', snapshot_id, source_generation, usage_period_key
       FROM expired`,
    [input.tenantId, input.operationKind, entitlement.usagePeriodKey],
  );
  const consumed = await client.query<{ consumed: string }>(
    `SELECT count(*)::text AS consumed
       FROM public.usage_reservations
      WHERE tenant_id = $1 AND operation_kind = $2 AND usage_period_key = $3
        AND state IN ('reserved', 'committed')`,
    [input.tenantId, input.operationKind, entitlement.usagePeriodKey],
  );
  if (consumed.rowCount !== 1 || !consumed.rows[0]) {
    throw new TypeError("PostgreSQL did not return bounded flow usage.");
  }
  if (generation(consumed.rows[0].consumed, "flow usage") >= BigInt(unitLimit)) {
    return { kind: "denied", reason: "quota-exhausted" } as const;
  }

  const inserted = await client.query<ReservationRow>(
    `WITH reservation_clock AS (
       SELECT clock_timestamp() AS issued_at
     )
     INSERT INTO public.usage_reservations AS reservation
       (tenant_id, operation_kind, operation_id, snapshot_id, source_generation, usage_period_key, state,
        expires_at, created_at, updated_at)
     SELECT $1, $2, $3::uuid, $4::uuid, $5, $6, 'reserved',
            issued_at + $7::bigint * interval '1 millisecond', issued_at, issued_at
       FROM reservation_clock
     RETURNING ${RESERVATION_COLUMNS}`,
    [
      input.tenantId,
      input.operationKind,
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

/** Reserves one render job on an existing PostgreSQL transaction. */
export async function reserveRenderUsageWithClientV1(
  client: PoolClient,
  inputValue: Parameters<BillingEntitlementRepositoryV1["reserveRender"]>[0],
): Promise<ReserveRenderResultV1> {
  const input = parseReserveRenderInputV1(inputValue);
  const result = await reserveFlowUsageWithClientV1(client, { ...input, operationKind: "render" });
  if (result.kind === "denied") {
    // The backfilled and mirrored render grant equals the snapshot render job
    // limit, so only the denial-name mapping differs from the v14 behavior.
    const reason = result.reason === "operation-disabled" ? "render-disabled" : result.reason;
    return { kind: "denied", reason } as const;
  }
  return result;
}

/** Settles one flow reservation of an exact operation kind on an existing transaction. */
export async function settleFlowUsageWithClientV1(
  client: PoolClient,
  tenantIdValue: string,
  operationKindValue: FlowOperationKindV1,
  operationIdValue: string,
  target: "committed" | "released",
): Promise<SettleUsageReservationResultV1> {
  const { operationId, operationKind, tenantId } = parseFlowUsageReservationIdentityV1(
    tenantIdValue,
    operationKindValue,
    operationIdValue,
  );
  const result = await client.query<ExistingReservationRow>(
    `SELECT ${RESERVATION_COLUMNS}, reservation.expires_at <= clock_timestamp() AS expired
       FROM public.usage_reservations reservation
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = $2
        AND reservation.operation_id = $3::uuid
      FOR UPDATE`,
    [tenantId, operationKind, operationId],
  );
  if (result.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate usage reservations.");
  const row = result.rows[0];
  if (!row) return { kind: "missing" };
  if (row.state === target) return { kind: "settled", replayed: true, reservation: reservationFromRow(row) };
  if (row.state !== "reserved") return { kind: "conflict", state: reservationFromRow(row).state };
  if (row.expired) {
    const expired = await expireFlowUsageWithClientV1(client, row);
    return { kind: "conflict", state: expired.state };
  }
  const updated = await client.query<ReservationRow>(
    `UPDATE public.usage_reservations reservation
        SET state = $4
      WHERE reservation.tenant_id = $1 AND reservation.operation_kind = $2
        AND reservation.operation_id = $3::uuid
      RETURNING ${RESERVATION_COLUMNS}`,
    [tenantId, operationKind, operationId, target],
  );
  const updatedRow = updated.rows[0];
  if (updated.rowCount !== 1 || !updatedRow) throw new TypeError("PostgreSQL did not settle the usage reservation.");
  await client.query(
    `INSERT INTO public.usage_events
       (tenant_id, operation_kind, operation_id, outcome, snapshot_id, source_generation, usage_period_key)
     VALUES ($1, $2, $3::uuid, $4, $5::uuid, $6, $7)`,
    [tenantId, operationKind, operationId, target, row.snapshot_id, row.source_generation, row.usage_period_key],
  );
  return { kind: "settled", replayed: false, reservation: reservationFromRow(updatedRow) };
}

/** Settles one render reservation on an existing PostgreSQL transaction. */
export async function settleRenderUsageWithClientV1(
  client: PoolClient,
  tenantIdValue: string,
  operationIdValue: string,
  target: "committed" | "released",
): Promise<SettleUsageReservationResultV1> {
  return settleFlowUsageWithClientV1(client, tenantIdValue, "render", operationIdValue, target);
}

/**
 * Admits one exact stock allocation under the tenant billing-account lock by
 * summing unreleased allocations; there is no cached used-quantity projection.
 */
export async function allocateStockWithClientV1(
  client: PoolClient,
  inputValue: AllocateStockInputV1,
): Promise<AllocateStockResultV1> {
  const input = parseAllocateStockInputV1(inputValue);
  const current = await client.query<CurrentStockSnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS},
            snapshot.access_until <= clock_timestamp() AS access_expired,
            clock_timestamp() < snapshot.period_start AS period_inactive
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

  const existing = await client.query<StockAllocationRow>(
    `SELECT ${STOCK_ALLOCATION_COLUMNS}
       FROM public.stock_allocations allocation
      WHERE allocation.tenant_id = $1 AND allocation.resource_kind = $2
        AND allocation.publication_id = $3::uuid
      FOR UPDATE`,
    [input.tenantId, input.resourceKind, input.publicationId],
  );
  if (existing.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate stock allocations.");
  const existingRow = existing.rows[0];
  if (existingRow) {
    const allocation = stockAllocationFromRow(existingRow);
    return allocation.releasedAt === null && allocation.quantity === input.quantity
      ? ({ allocation, kind: "allocated", replayed: true } as const)
      : ({ kind: "denied", reason: "allocation-conflict" } as const);
  }

  if (entitlement.accessState === "blocked") return { kind: "denied", reason: "blocked" } as const;
  if (currentRow.access_expired || currentRow.period_inactive) return { kind: "denied", reason: "expired" } as const;

  const grantResult = await client.query<{ quantity_limit: string }>(
    `SELECT stock_grant.quantity_limit::text AS quantity_limit
       FROM public.entitlement_stock_grants stock_grant
      WHERE stock_grant.tenant_id = $1 AND stock_grant.entitlement_snapshot_id = $2::uuid
        AND stock_grant.entitlement_generation = $3 AND stock_grant.resource_kind = $4`,
    [input.tenantId, entitlement.snapshotId, entitlement.sourceGeneration.toString(), input.resourceKind],
  );
  if (grantResult.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate entitlement stock grants.");
  const grantRow = grantResult.rows[0];
  if (!grantRow) return { kind: "denied", reason: "stock-disabled" } as const;
  const quantityLimit = quantity(grantRow.quantity_limit, "stock grant quantity limit");
  if (quantityLimit <= 0) return { kind: "denied", reason: "stock-disabled" } as const;

  const allocated = await client.query<{ allocated: string }>(
    `SELECT COALESCE(sum(allocation.quantity), 0)::text AS allocated
       FROM public.stock_allocations allocation
      WHERE allocation.tenant_id = $1 AND allocation.resource_kind = $2
        AND allocation.released_at IS NULL`,
    [input.tenantId, input.resourceKind],
  );
  if (allocated.rowCount !== 1 || !allocated.rows[0]) {
    throw new TypeError("PostgreSQL did not return bounded stock usage.");
  }
  // A plan downgrade below current stock blocks new allocation without
  // deleting customer data; period rollover never resets this sum.
  if (BigInt(allocated.rows[0].allocated) + BigInt(input.quantity) > BigInt(quantityLimit)) {
    return { kind: "denied", reason: "quota-exhausted" } as const;
  }

  const inserted = await client.query<StockAllocationRow>(
    `INSERT INTO public.stock_allocations AS allocation
       (tenant_id, resource_kind, publication_id, quantity)
     VALUES ($1, $2, $3::uuid, $4)
     RETURNING ${STOCK_ALLOCATION_COLUMNS}`,
    [input.tenantId, input.resourceKind, input.publicationId, input.quantity],
  );
  const row = inserted.rows[0];
  if (inserted.rowCount !== 1 || !row) throw new TypeError("PostgreSQL did not return the stock allocation.");
  return { allocation: stockAllocationFromRow(row), kind: "allocated", replayed: false } as const;
}

/**
 * Credits stock exactly when the publication enters its deletion queue
 * (expiry or logical unpublication); the later physical object-deletion
 * acknowledgement never touches the ledger.
 */
export async function releaseStockWithClientV1(
  client: PoolClient,
  inputValue: ReleaseStockInputV1,
): Promise<ReleaseStockResultV1> {
  const input = parseReleaseStockInputV1(inputValue);
  const existing = await client.query<StockAllocationRow>(
    `SELECT ${STOCK_ALLOCATION_COLUMNS}
       FROM public.stock_allocations allocation
      WHERE allocation.tenant_id = $1 AND allocation.resource_kind = $2
        AND allocation.publication_id = $3::uuid
      FOR UPDATE`,
    [input.tenantId, input.resourceKind, input.publicationId],
  );
  if (existing.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate stock allocations.");
  const existingRow = existing.rows[0];
  if (!existingRow) return { kind: "missing" };
  if (existingRow.released_at !== null) {
    return { allocation: stockAllocationFromRow(existingRow), kind: "released", replayed: true };
  }
  const updated = await client.query<StockAllocationRow>(
    `UPDATE public.stock_allocations allocation
        SET released_at = clock_timestamp()
      WHERE allocation.tenant_id = $1 AND allocation.resource_kind = $2
        AND allocation.publication_id = $3::uuid
      RETURNING ${STOCK_ALLOCATION_COLUMNS}`,
    [input.tenantId, input.resourceKind, input.publicationId],
  );
  const updatedRow = updated.rows[0];
  if (updated.rowCount !== 1 || !updatedRow) throw new TypeError("PostgreSQL did not release the stock allocation.");
  return { allocation: stockAllocationFromRow(updatedRow), kind: "released", replayed: false };
}

/** Applies one entitlement snapshot on an existing PostgreSQL transaction. */
export async function applyEntitlementSnapshotWithClientV1(
  client: PoolClient,
  inputValue: ApplyEntitlementSnapshotInputV1,
) {
  const input = parseApplyEntitlementSnapshotInputV1(inputValue);
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
  // The render flow grant is mirrored from the snapshot by the v32 trigger;
  // the snapshot additionally owns its normalized non-render grants.
  await client.query(
    `INSERT INTO public.entitlement_flow_grants
       (tenant_id, entitlement_snapshot_id, entitlement_generation, operation_kind, usage_period_key, unit_limit)
     VALUES
       ($1, $2::uuid, $3, 'ai-suggestion', $4, $5),
       ($1, $2::uuid, $3, 'export-publication', $4, $6)`,
    [
      input.tenantId,
      input.snapshotId,
      input.sourceGeneration.toString(),
      input.usagePeriodKey,
      input.aiSuggestionLimit,
      input.exportPublicationLimit,
    ],
  );
  await client.query(
    `INSERT INTO public.entitlement_stock_grants
       (tenant_id, entitlement_snapshot_id, entitlement_generation, resource_kind, quantity_limit)
     VALUES ($1, $2::uuid, $3, 'published-artifact-bytes', $4)`,
    [input.tenantId, input.snapshotId, input.sourceGeneration.toString(), input.publishedArtifactBytesLimit],
  );
  const advanced = await client.query(
    `UPDATE public.billing_accounts
        SET current_snapshot_id = $2::uuid, applied_generation = $3
      WHERE tenant_id = $1 AND applied_generation = $4`,
    [input.tenantId, input.snapshotId, input.sourceGeneration.toString(), input.expectedGeneration.toString()],
  );
  if (advanced.rowCount !== 1) throw new TypeError("PostgreSQL did not advance the billing account.");
  return { kind: "applied", snapshot: snapshotFromRow(row) } as const;
}

export class PostgresBillingEntitlementRepositoryV1 implements BillingEntitlementRepositoryV1 {
  readonly #connection: PostgresRepositoryConnectionV1;

  constructor(options: Readonly<{ pool?: Pool; poolConfig?: PoolConfig; statementTimeoutMs?: number }>) {
    this.#connection = new PostgresRepositoryConnectionV1(options);
  }

  async ready(signal?: AbortSignal) {
    try {
      const result = await this.#connection.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version IN (14, 32) ORDER BY version",
        [],
        signal,
      );
      signal?.throwIfAborted();
      return (
        result.rowCount === 2 &&
        result.rows[0]?.version === 14 &&
        result.rows[0]?.checksum === BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM &&
        result.rows[1]?.version === 32 &&
        result.rows[1]?.checksum === BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM
      );
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  async applySnapshot(inputValue: ApplyEntitlementSnapshotInputV1, signal?: AbortSignal) {
    const input = parseApplyEntitlementSnapshotInputV1(inputValue);
    return this.#connection.transaction((client) => applyEntitlementSnapshotWithClientV1(client, input), signal);
  }

  async reserveRender(
    inputValue: Parameters<BillingEntitlementRepositoryV1["reserveRender"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReserveRenderInputV1(inputValue);
    return this.#connection.transaction((client) => reserveRenderUsageWithClientV1(client, input), signal);
  }

  async reserveFlowUsage(
    inputValue: Parameters<BillingEntitlementRepositoryV1["reserveFlowUsage"]>[0],
    signal?: AbortSignal,
  ) {
    const input = parseReserveFlowUsageInputV1(inputValue);
    return this.#connection.transaction((client) => reserveFlowUsageWithClientV1(client, input), signal);
  }

  async commitReservation(tenantId: string, operationId: string, signal?: AbortSignal) {
    return this.commitFlowReservation(tenantId, "render", operationId, signal);
  }

  async releaseReservation(tenantId: string, operationId: string, signal?: AbortSignal) {
    return this.releaseFlowReservation(tenantId, "render", operationId, signal);
  }

  async commitFlowReservation(
    tenantId: string,
    operationKind: FlowOperationKindV1,
    operationId: string,
    signal?: AbortSignal,
  ) {
    const identity = parseFlowUsageReservationIdentityV1(tenantId, operationKind, operationId);
    return this.#connection.transaction(
      (client) =>
        settleFlowUsageWithClientV1(
          client,
          identity.tenantId,
          identity.operationKind,
          identity.operationId,
          "committed",
        ),
      signal,
    );
  }

  async releaseFlowReservation(
    tenantId: string,
    operationKind: FlowOperationKindV1,
    operationId: string,
    signal?: AbortSignal,
  ) {
    const identity = parseFlowUsageReservationIdentityV1(tenantId, operationKind, operationId);
    return this.#connection.transaction(
      (client) =>
        settleFlowUsageWithClientV1(
          client,
          identity.tenantId,
          identity.operationKind,
          identity.operationId,
          "released",
        ),
      signal,
    );
  }

  async readCurrentEntitlementGrants(tenantId: string, signal?: AbortSignal): Promise<EntitlementGrantSetV1 | null> {
    return this.#connection.transaction(async (client) => {
      const current = await client.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM public.billing_accounts account
           JOIN public.entitlement_snapshots snapshot
             ON snapshot.tenant_id = account.tenant_id
            AND snapshot.snapshot_id = account.current_snapshot_id
          WHERE account.tenant_id = $1`,
        [tenantId],
      );
      if (current.rows.length > 1) throw new TypeError("PostgreSQL returned duplicate current entitlements.");
      const currentRow = current.rows[0];
      if (!currentRow) return null;
      const snapshot = snapshotFromRow(currentRow);
      const [flowGrants, stockGrants] = await Promise.all([
        client.query<FlowGrantRow>(
          `SELECT ${FLOW_GRANT_COLUMNS}
             FROM public.entitlement_flow_grants flow_grant
            WHERE flow_grant.tenant_id = $1 AND flow_grant.entitlement_snapshot_id = $2::uuid
            ORDER BY flow_grant.operation_kind`,
          [tenantId, snapshot.snapshotId],
        ),
        client.query<StockGrantRow>(
          `SELECT ${STOCK_GRANT_COLUMNS}
             FROM public.entitlement_stock_grants stock_grant
            WHERE stock_grant.tenant_id = $1 AND stock_grant.entitlement_snapshot_id = $2::uuid
            ORDER BY stock_grant.resource_kind`,
          [tenantId, snapshot.snapshotId],
        ),
      ]);
      return {
        flowGrants: flowGrants.rows.map((row) => flowGrantFromRow(row)),
        snapshot,
        stockGrants: stockGrants.rows.map((row) => stockGrantFromRow(row)),
      };
    }, signal);
  }

  close() {
    return this.#connection.close();
  }
}
