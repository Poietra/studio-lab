import type { PoolClient } from "pg";

/**
 * Injected metering seam for client-export publication acceptance (ADR 0005
 * §"Flow quota and stock quota are separate models"). The port mirrors the
 * existing flow-reservation lifecycle: `reservePublication` before bytes are
 * staged, then exactly one settlement inside the same PostgreSQL transaction
 * that inserts the artifact and publication rows. `operationId` is the
 * `publicationId`, so reserve and settle are naturally replay-safe.
 *
 * v1 wires the no-op implementation below: local client export is free and the
 * `export-publication` operation kind does not exist yet. #726 (billing v2)
 * replaces it with the real `EntitlementFlowGrant` reservation
 * (operation kind `export-publication`, one unit) plus the
 * `StockAllocation` byte admission under the tenant billing-account lock;
 * `settlePublicationWithClient` receives the transaction client precisely so
 * that implementation can commit the flow reservation and insert the stock
 * allocation atomically with the publication. Replay detection runs BEFORE
 * settlement, so an accepted retry never reaches this port twice.
 */
export type ReserveClientExportPublicationInputV1 = Readonly<{
  lifetimeMs: number;
  operationId: string;
  tenantId: string;
}>;

export type ReserveClientExportPublicationResultV1 =
  | Readonly<{ kind: "reserved"; replayed: boolean }>
  | Readonly<{
      kind: "denied";
      reason: "blocked" | "operation-settled" | "quota-exhausted" | "unconfigured";
    }>;

export type SettleClientExportPublicationInputV1 = Readonly<{
  byteSize: number;
  operationId: string;
  target: "committed" | "released";
  tenantId: string;
}>;

export type SettleClientExportPublicationResultV1 =
  | Readonly<{ kind: "settled"; replayed: boolean }>
  | Readonly<{ kind: "denied"; reason: "stock-exhausted" }>;

export interface ClientExportPublicationMeteringV1 {
  /** Releases a reservation whose acceptance failed outside a repository transaction. */
  releasePublication(tenantId: string, operationId: string, signal?: AbortSignal): Promise<void>;
  /** Reserves one `export-publication` flow unit before any bytes are staged. */
  reservePublication(
    input: ReserveClientExportPublicationInputV1,
    signal?: AbortSignal,
  ): Promise<ReserveClientExportPublicationResultV1>;
  /**
   * Settles the reservation (and, under #726, inserts the byte stock
   * allocation) inside the caller's acceptance transaction.
   */
  settlePublicationWithClient(
    client: PoolClient,
    input: SettleClientExportPublicationInputV1,
  ): Promise<SettleClientExportPublicationResultV1>;
}

/** v1 no-op wiring: client-export publication is admitted without metering until #726 lands billing v2. */
export function createUnmeteredClientExportPublicationMeteringV1(): ClientExportPublicationMeteringV1 {
  return {
    async releasePublication() {
      // No reservation exists in the unmetered lane.
    },
    async reservePublication() {
      return { kind: "reserved", replayed: false } as const;
    },
    async settlePublicationWithClient() {
      return { kind: "settled", replayed: false } as const;
    },
  };
}
