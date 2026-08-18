import type { BillingEntitlementRepositoryV1, ReserveFlowUsageResultV1 } from "../billing/entitlement-repository";
import type { PoolClient } from "pg";
import type {
  ClientExportPublicationMeteringV1,
  ReserveClientExportPublicationInputV1,
  ReserveClientExportPublicationResultV1,
  SettleClientExportPublicationInputV1,
} from "./client-export-metering";
import {
  allocateStockWithClientV1,
  releaseStockWithClientV1,
  settleFlowUsageWithClientV1,
} from "./postgres/postgres-entitlement-repository";

function publicationReservationResult(result: ReserveFlowUsageResultV1): ReserveClientExportPublicationResultV1 {
  if (result.kind === "reserved") return { kind: "reserved", replayed: result.replayed };
  switch (result.reason) {
    case "blocked":
    case "operation-settled":
    case "quota-exhausted":
    case "unconfigured":
      return { kind: "denied", reason: result.reason };
    default:
      return { kind: "denied", reason: "unconfigured" };
  }
}

/** Connects client-export publication to billing v2 flow and retained-byte stock grants. */
export function createBillingClientExportPublicationMeteringV1(
  repository: Pick<BillingEntitlementRepositoryV1, "releaseFlowReservation" | "reserveFlowUsage">,
): ClientExportPublicationMeteringV1 {
  if (typeof repository?.releaseFlowReservation !== "function" || typeof repository.reserveFlowUsage !== "function") {
    throw new TypeError("Client export metering requires a billing v2 entitlement repository.");
  }
  return Object.freeze({
    async releasePublication(tenantId: string, operationId: string, signal?: AbortSignal) {
      await repository.releaseFlowReservation(tenantId, "export-publication", operationId, signal);
    },
    async releasePublicationStockWithClient(client: PoolClient, tenantId: string, publicationId: string) {
      await releaseStockWithClientV1(client, {
        publicationId,
        resourceKind: "published-artifact-bytes",
        tenantId,
      });
    },
    async reservePublication(input: ReserveClientExportPublicationInputV1, signal?: AbortSignal) {
      const result = await repository.reserveFlowUsage({ ...input, operationKind: "export-publication" }, signal);
      return publicationReservationResult(result);
    },
    async settlePublicationWithClient(client: PoolClient, input: SettleClientExportPublicationInputV1) {
      if (input.target === "released") {
        const settlement = await settleFlowUsageWithClientV1(
          client,
          input.tenantId,
          "export-publication",
          input.operationId,
          "released",
        );
        if (settlement.kind !== "settled") {
          throw new Error("The client export publication reservation could not be released.");
        }
        return { kind: "settled", replayed: settlement.replayed } as const;
      }

      // Stock admission runs first and writes only on success. A later flow
      // settlement failure throws, rolling that allocation back with the
      // caller's publication transaction.
      const allocation = await allocateStockWithClientV1(client, {
        publicationId: input.operationId,
        quantity: input.byteSize,
        resourceKind: "published-artifact-bytes",
        tenantId: input.tenantId,
      });
      if (allocation.kind !== "allocated") return { kind: "denied", reason: "stock-exhausted" } as const;

      const settlement = await settleFlowUsageWithClientV1(
        client,
        input.tenantId,
        "export-publication",
        input.operationId,
        "committed",
      );
      if (settlement.kind !== "settled") {
        throw new Error("The client export publication reservation could not be committed.");
      }
      return { kind: "settled", replayed: settlement.replayed } as const;
    },
  });
}
