import type { PoolClient } from "pg";

/**
 * Injected metering seam for client-export publication acceptance (ADR 0005
 * §"Flow quota and stock quota are separate models"). The port mirrors the
 * existing flow-reservation lifecycle: `reservePublication` before bytes are
 * staged, then exactly one settlement inside the same PostgreSQL transaction
 * that inserts the artifact and publication rows. `operationId` is the
 * `publicationId`, so reserve and settle are naturally replay-safe.
 *
 * Production wires an `export-publication` flow grant plus retained-byte stock
 * admission. Local export uses the unmetered implementation below. Replay
 * detection runs before settlement, so an accepted retry never reaches this
 * port twice.
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
  /** Releases retained-byte stock inside the transaction that queues publication deletion. */
  releasePublicationStockWithClient(client: PoolClient, tenantId: string, publicationId: string): Promise<void>;
  /** Settles the reservation and stock allocation inside the acceptance transaction. */
  settlePublicationWithClient(
    client: PoolClient,
    input: SettleClientExportPublicationInputV1,
  ): Promise<SettleClientExportPublicationResultV1>;
}

/** Explicit local-only wiring: client-export publication is admitted without billing metering. */
export function createUnmeteredClientExportPublicationMeteringV1(): ClientExportPublicationMeteringV1 {
  return {
    async releasePublication() {
      // No reservation exists in the unmetered lane.
    },
    async reservePublication() {
      return { kind: "reserved", replayed: false } as const;
    },
    async releasePublicationStockWithClient() {
      // No stock allocation exists in the unmetered lane.
    },
    async settlePublicationWithClient() {
      return { kind: "settled", replayed: false } as const;
    },
  };
}
