import type {
  BillingEntitlementRepositoryV1,
  ReserveFlowUsageResultV1,
  SettleUsageReservationResultV1,
} from "../billing/entitlement-repository";

/**
 * Durable metering seam for the production edit-suggestion route. The handler
 * reserves one `ai-suggestion` flow unit after in-process admission, commits it
 * exactly when the provider request crosses the billable cost point (whether or
 * not a useful model response returns), and releases it when the request is
 * rejected before that point. Local and dev loopback paths inject no meter and
 * stay unmetered.
 */
export type EditSuggestionUsageMeterV1 = Readonly<{
  commit(tenantId: string, operationId: string): Promise<SettleUsageReservationResultV1>;
  release(tenantId: string, operationId: string): Promise<SettleUsageReservationResultV1>;
  reserve(
    input: Readonly<{ lifetimeMs: number; operationId: string; tenantId: string }>,
  ): Promise<ReserveFlowUsageResultV1>;
}>;

export function createBillingEditSuggestionUsageMeterV1(
  repository: Pick<
    BillingEntitlementRepositoryV1,
    "commitFlowReservation" | "releaseFlowReservation" | "reserveFlowUsage"
  >,
): EditSuggestionUsageMeterV1 {
  if (
    typeof repository?.commitFlowReservation !== "function" ||
    typeof repository.releaseFlowReservation !== "function" ||
    typeof repository.reserveFlowUsage !== "function"
  ) {
    throw new TypeError("The edit-suggestion usage meter requires a flow-grant entitlement repository.");
  }
  return Object.freeze({
    commit: (tenantId: string, operationId: string) =>
      repository.commitFlowReservation(tenantId, "ai-suggestion", operationId),
    release: (tenantId: string, operationId: string) =>
      repository.releaseFlowReservation(tenantId, "ai-suggestion", operationId),
    reserve: (input: Readonly<{ lifetimeMs: number; operationId: string; tenantId: string }>) =>
      repository.reserveFlowUsage({ ...input, operationKind: "ai-suggestion" }),
  });
}
