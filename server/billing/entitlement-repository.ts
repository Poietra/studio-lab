import { z } from "zod";

import { organizationIdSchemaV1 } from "../accounts/account-domain";

export const MIN_USAGE_RESERVATION_LIFETIME_MS_V1 = 1_000;
export const MAX_USAGE_RESERVATION_LIFETIME_MS_V1 = 30 * 60 * 1_000;
export const MAX_RENDER_JOB_LIMIT_V1 = 1_000_000;
export const MAX_FLOW_UNIT_LIMIT_V1 = 1_000_000;
export const MAX_STOCK_QUANTITY_V1 = 9_007_199_254_740_991;

/** The closed flow-operation set (ADR 0005); each admitted operation consumes one unit. */
export const FLOW_OPERATION_KINDS_V1 = ["render", "ai-suggestion", "export-publication"] as const;
/** The closed stock-resource set (ADR 0005); quantities are exact retained bytes. */
export const STOCK_RESOURCE_KINDS_V1 = ["published-artifact-bytes"] as const;

const generationSchema = z.bigint().min(0n).max(BigInt(Number.MAX_SAFE_INTEGER));
const positiveGenerationSchema = generationSchema.min(1n);
const operationIdSchema = z.uuid();
const planKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const usagePeriodKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u);
const flowUnitLimitSchema = z.number().int().min(0).max(MAX_FLOW_UNIT_LIMIT_V1);
const stockQuantityLimitSchema = z.number().int().min(0).max(MAX_STOCK_QUANTITY_V1);

export const entitlementAccessStateSchemaV1 = z.enum(["active", "grace", "blocked"]);
export const usageReservationStateSchemaV1 = z.enum(["reserved", "committed", "released"]);
export const flowOperationKindSchemaV1 = z.enum(FLOW_OPERATION_KINDS_V1);
export const stockResourceKindSchemaV1 = z.enum(STOCK_RESOURCE_KINDS_V1);

const entitlementSnapshotBaseSchema = z
  .object({
    accessState: entitlementAccessStateSchemaV1,
    accessUntil: z.date(),
    createdAt: z.date(),
    periodEnd: z.date(),
    periodStart: z.date(),
    planKey: planKeySchema,
    renderEnabled: z.boolean(),
    renderJobLimit: z.number().int().min(0).max(MAX_RENDER_JOB_LIMIT_V1),
    snapshotId: z.uuid(),
    sourceGeneration: positiveGenerationSchema,
    tenantId: organizationIdSchemaV1,
    usagePeriodKey: usagePeriodKeySchema,
  })
  .strict();

type EntitlementSnapshotFieldsV1 = Omit<z.infer<typeof entitlementSnapshotBaseSchema>, "createdAt">;

function validateEntitlementSnapshotFieldsV1(snapshot: EntitlementSnapshotFieldsV1, context: z.RefinementCtx) {
  if (snapshot.periodEnd <= snapshot.periodStart) {
    context.addIssue({ code: "custom", message: "The entitlement usage period is invalid.", path: ["periodEnd"] });
  }
  if (snapshot.accessUntil <= snapshot.periodStart || snapshot.accessUntil > snapshot.periodEnd) {
    context.addIssue({
      code: "custom",
      message: "The entitlement access deadline is invalid.",
      path: ["accessUntil"],
    });
  }
  if (snapshot.renderEnabled !== snapshot.renderJobLimit > 0) {
    context.addIssue({
      code: "custom",
      message: "The render feature and its bounded job limit disagree.",
      path: ["renderJobLimit"],
    });
  }
  if (snapshot.accessState === "blocked" && snapshot.renderEnabled) {
    context.addIssue({
      code: "custom",
      message: "A blocked entitlement cannot enable rendering.",
      path: ["renderEnabled"],
    });
  }
}

const entitlementSnapshotSchema = entitlementSnapshotBaseSchema.superRefine(validateEntitlementSnapshotFieldsV1);

// The new limits live on the normalized grant tables only; the v14 snapshot
// row and its wire fields (`renderEnabled`, `renderJobLimit`) stay
// byte-identical. Each `*Limit` field is enabled exactly when it is positive,
// the `renderEnabled === (renderJobLimit > 0)` analogue for grants.
const applySnapshotInputSchema = entitlementSnapshotBaseSchema
  .omit({ createdAt: true })
  .extend({
    aiSuggestionLimit: flowUnitLimitSchema.default(0),
    expectedGeneration: generationSchema,
    exportPublicationLimit: flowUnitLimitSchema.default(0),
    publishedArtifactBytesLimit: stockQuantityLimitSchema.default(0),
  })
  .strict()
  .superRefine((input, context) => {
    validateEntitlementSnapshotFieldsV1(input, context);
    if (input.sourceGeneration !== input.expectedGeneration + 1n) {
      context.addIssue({
        code: "custom",
        message: "The entitlement source generation must immediately follow the expected generation.",
        path: ["sourceGeneration"],
      });
    }
    if (
      input.accessState === "blocked" &&
      (input.aiSuggestionLimit > 0 || input.exportPublicationLimit > 0 || input.publishedArtifactBytesLimit > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "A blocked entitlement cannot grant flow or stock quota.",
        path: ["accessState"],
      });
    }
  });

const usageReservationSchema = z
  .object({
    createdAt: z.date(),
    expiresAt: z.date(),
    operationId: operationIdSchema,
    operationKind: flowOperationKindSchemaV1,
    settledAt: z.date().nullable(),
    snapshotId: z.uuid(),
    sourceGeneration: positiveGenerationSchema,
    state: usageReservationStateSchemaV1,
    tenantId: organizationIdSchemaV1,
    updatedAt: z.date(),
    usagePeriodKey: usagePeriodKeySchema,
    version: positiveGenerationSchema,
  })
  .strict()
  .superRefine((reservation, context) => {
    const lifetimeMs = reservation.expiresAt.getTime() - reservation.createdAt.getTime();
    if (
      lifetimeMs < MIN_USAGE_RESERVATION_LIFETIME_MS_V1 ||
      lifetimeMs > MAX_USAGE_RESERVATION_LIFETIME_MS_V1 ||
      reservation.updatedAt < reservation.createdAt
    ) {
      context.addIssue({ code: "custom", message: "The usage reservation timestamps are invalid." });
    }
    if ((reservation.state === "reserved") !== (reservation.settledAt === null)) {
      context.addIssue({ code: "custom", message: "The usage reservation settlement is inconsistent." });
    }
    if (
      reservation.settledAt !== null &&
      (reservation.settledAt < reservation.createdAt || reservation.settledAt > reservation.updatedAt)
    ) {
      context.addIssue({ code: "custom", message: "The usage reservation settlement timestamp is invalid." });
    }
  });

const reserveRenderInputSchema = z
  .object({
    lifetimeMs: z.number().int().min(MIN_USAGE_RESERVATION_LIFETIME_MS_V1).max(MAX_USAGE_RESERVATION_LIFETIME_MS_V1),
    operationId: operationIdSchema,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const reserveFlowUsageInputSchema = z
  .object({
    lifetimeMs: z.number().int().min(MIN_USAGE_RESERVATION_LIFETIME_MS_V1).max(MAX_USAGE_RESERVATION_LIFETIME_MS_V1),
    operationId: operationIdSchema,
    operationKind: flowOperationKindSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const entitlementFlowGrantSchema = z
  .object({
    createdAt: z.date(),
    entitlementGeneration: positiveGenerationSchema,
    entitlementSnapshotId: z.uuid(),
    operationKind: flowOperationKindSchemaV1,
    tenantId: organizationIdSchemaV1,
    unitLimit: flowUnitLimitSchema,
    usagePeriodKey: usagePeriodKeySchema,
  })
  .strict();

const entitlementStockGrantSchema = z
  .object({
    createdAt: z.date(),
    entitlementGeneration: positiveGenerationSchema,
    entitlementSnapshotId: z.uuid(),
    quantityLimit: stockQuantityLimitSchema,
    resourceKind: stockResourceKindSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const stockAllocationSchema = z
  .object({
    allocatedAt: z.date(),
    publicationId: z.uuid(),
    quantity: stockQuantityLimitSchema.min(1),
    releasedAt: z.date().nullable(),
    resourceKind: stockResourceKindSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict()
  .superRefine((allocation, context) => {
    if (allocation.releasedAt !== null && allocation.releasedAt < allocation.allocatedAt) {
      context.addIssue({ code: "custom", message: "The stock allocation release timestamp is invalid." });
    }
  });

const allocateStockInputSchema = z
  .object({
    publicationId: z.uuid(),
    quantity: stockQuantityLimitSchema.min(1),
    resourceKind: stockResourceKindSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

const releaseStockInputSchema = z
  .object({
    publicationId: z.uuid(),
    resourceKind: stockResourceKindSchemaV1,
    tenantId: organizationIdSchemaV1,
  })
  .strict();

export type EntitlementAccessStateV1 = z.infer<typeof entitlementAccessStateSchemaV1>;
export type EntitlementSnapshotV1 = Readonly<z.infer<typeof entitlementSnapshotSchema>>;
export type ApplyEntitlementSnapshotInputV1 = Readonly<z.input<typeof applySnapshotInputSchema>>;
export type ParsedApplyEntitlementSnapshotInputV1 = Readonly<z.output<typeof applySnapshotInputSchema>>;
export type UsageReservationStateV1 = z.infer<typeof usageReservationStateSchemaV1>;
export type UsageReservationV1 = Readonly<z.infer<typeof usageReservationSchema>>;
export type ReserveRenderInputV1 = Readonly<z.infer<typeof reserveRenderInputSchema>>;
export type FlowOperationKindV1 = z.infer<typeof flowOperationKindSchemaV1>;
export type StockResourceKindV1 = z.infer<typeof stockResourceKindSchemaV1>;
export type ReserveFlowUsageInputV1 = Readonly<z.infer<typeof reserveFlowUsageInputSchema>>;
export type EntitlementFlowGrantV1 = Readonly<z.infer<typeof entitlementFlowGrantSchema>>;
export type EntitlementStockGrantV1 = Readonly<z.infer<typeof entitlementStockGrantSchema>>;
export type StockAllocationV1 = Readonly<z.infer<typeof stockAllocationSchema>>;
export type AllocateStockInputV1 = Readonly<z.infer<typeof allocateStockInputSchema>>;
export type ReleaseStockInputV1 = Readonly<z.infer<typeof releaseStockInputSchema>>;

export type ApplyEntitlementSnapshotResultV1 =
  | Readonly<{ kind: "applied"; snapshot: EntitlementSnapshotV1 }>
  | Readonly<{ appliedGeneration: bigint; kind: "conflict" }>;

export type ReserveRenderResultV1 =
  | Readonly<{ kind: "reserved"; replayed: boolean; reservation: UsageReservationV1 }>
  | Readonly<{
      kind: "denied";
      reason: "blocked" | "expired" | "operation-settled" | "quota-exhausted" | "render-disabled" | "unconfigured";
    }>;

export type FlowUsageDenialReasonV1 =
  | "blocked"
  | "expired"
  | "operation-disabled"
  | "operation-settled"
  | "quota-exhausted"
  | "unconfigured";

export type ReserveFlowUsageResultV1 =
  | Readonly<{ kind: "reserved"; replayed: boolean; reservation: UsageReservationV1 }>
  | Readonly<{ kind: "denied"; reason: FlowUsageDenialReasonV1 }>;

export type SettleUsageReservationResultV1 =
  | Readonly<{ kind: "settled"; replayed: boolean; reservation: UsageReservationV1 }>
  | Readonly<{ kind: "conflict"; state: UsageReservationStateV1 }>
  | Readonly<{ kind: "missing" }>;

export type StockAdmissionDenialReasonV1 =
  | "allocation-conflict"
  | "blocked"
  | "expired"
  | "quota-exhausted"
  | "stock-disabled"
  | "unconfigured";

export type AllocateStockResultV1 =
  | Readonly<{ allocation: StockAllocationV1; kind: "allocated"; replayed: boolean }>
  | Readonly<{ kind: "denied"; reason: StockAdmissionDenialReasonV1 }>;

export type ReleaseStockResultV1 =
  | Readonly<{ allocation: StockAllocationV1; kind: "released"; replayed: boolean }>
  | Readonly<{ kind: "missing" }>;

export type EntitlementGrantSetV1 = Readonly<{
  flowGrants: readonly EntitlementFlowGrantV1[];
  snapshot: EntitlementSnapshotV1;
  stockGrants: readonly EntitlementStockGrantV1[];
}>;

export function parseApplyEntitlementSnapshotInputV1(input: unknown): ParsedApplyEntitlementSnapshotInputV1 {
  return applySnapshotInputSchema.parse(input);
}

export function parseReserveRenderInputV1(input: unknown): ReserveRenderInputV1 {
  return reserveRenderInputSchema.parse(input);
}

export function parseReserveFlowUsageInputV1(input: unknown): ReserveFlowUsageInputV1 {
  return reserveFlowUsageInputSchema.parse(input);
}

export function parseEntitlementFlowGrantV1(input: unknown): EntitlementFlowGrantV1 {
  return entitlementFlowGrantSchema.parse(input);
}

export function parseEntitlementStockGrantV1(input: unknown): EntitlementStockGrantV1 {
  return entitlementStockGrantSchema.parse(input);
}

export function parseStockAllocationV1(input: unknown): StockAllocationV1 {
  return stockAllocationSchema.parse(input);
}

export function parseAllocateStockInputV1(input: unknown): AllocateStockInputV1 {
  return allocateStockInputSchema.parse(input);
}

export function parseReleaseStockInputV1(input: unknown): ReleaseStockInputV1 {
  return releaseStockInputSchema.parse(input);
}

export function parseEntitlementSnapshotV1(input: unknown): EntitlementSnapshotV1 {
  return entitlementSnapshotSchema.parse(input);
}

export function parseUsageReservationV1(input: unknown): UsageReservationV1 {
  return usageReservationSchema.parse(input);
}

export function parseUsageReservationIdentityV1(tenantId: unknown, operationId: unknown) {
  return z
    .object({ operationId: operationIdSchema, tenantId: organizationIdSchemaV1 })
    .parse({ operationId, tenantId });
}

export function parseFlowUsageReservationIdentityV1(tenantId: unknown, operationKind: unknown, operationId: unknown) {
  return z
    .object({
      operationId: operationIdSchema,
      operationKind: flowOperationKindSchemaV1,
      tenantId: organizationIdSchemaV1,
    })
    .parse({ operationId, operationKind, tenantId });
}

export interface BillingEntitlementRepositoryV1 {
  applySnapshot(
    input: ApplyEntitlementSnapshotInputV1,
    signal?: AbortSignal,
  ): Promise<ApplyEntitlementSnapshotResultV1>;
  close(): Promise<void>;
  commitFlowReservation(
    tenantId: string,
    operationKind: FlowOperationKindV1,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  commitReservation(
    tenantId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  readCurrentEntitlementGrants(tenantId: string, signal?: AbortSignal): Promise<EntitlementGrantSetV1 | null>;
  ready(signal?: AbortSignal): Promise<boolean>;
  releaseFlowReservation(
    tenantId: string,
    operationKind: FlowOperationKindV1,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  releaseReservation(
    tenantId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  reserveFlowUsage(input: ReserveFlowUsageInputV1, signal?: AbortSignal): Promise<ReserveFlowUsageResultV1>;
  reserveRender(input: ReserveRenderInputV1, signal?: AbortSignal): Promise<ReserveRenderResultV1>;
}
