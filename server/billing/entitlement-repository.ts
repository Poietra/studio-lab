import { z } from "zod";

import { organizationIdSchemaV1 } from "../accounts/account-domain";

export const MIN_USAGE_RESERVATION_LIFETIME_MS_V1 = 1_000;
export const MAX_USAGE_RESERVATION_LIFETIME_MS_V1 = 30 * 60 * 1_000;
export const MAX_RENDER_JOB_LIMIT_V1 = 1_000_000;

const generationSchema = z.bigint().min(0n).max(BigInt(Number.MAX_SAFE_INTEGER));
const positiveGenerationSchema = generationSchema.min(1n);
const operationIdSchema = z.uuid();
const planKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const usagePeriodKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u);

export const entitlementAccessStateSchemaV1 = z.enum(["active", "grace", "blocked"]);
export const usageReservationStateSchemaV1 = z.enum(["reserved", "committed", "released"]);

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

const applySnapshotInputSchema = entitlementSnapshotBaseSchema
  .omit({ createdAt: true })
  .extend({ expectedGeneration: generationSchema })
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
  });

const usageReservationSchema = z
  .object({
    createdAt: z.date(),
    expiresAt: z.date(),
    operationId: operationIdSchema,
    operationKind: z.literal("render"),
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

export type EntitlementAccessStateV1 = z.infer<typeof entitlementAccessStateSchemaV1>;
export type EntitlementSnapshotV1 = Readonly<z.infer<typeof entitlementSnapshotSchema>>;
export type ApplyEntitlementSnapshotInputV1 = Readonly<z.infer<typeof applySnapshotInputSchema>>;
export type UsageReservationStateV1 = z.infer<typeof usageReservationStateSchemaV1>;
export type UsageReservationV1 = Readonly<z.infer<typeof usageReservationSchema>>;
export type ReserveRenderInputV1 = Readonly<z.infer<typeof reserveRenderInputSchema>>;

export type ApplyEntitlementSnapshotResultV1 =
  | Readonly<{ kind: "applied"; snapshot: EntitlementSnapshotV1 }>
  | Readonly<{ appliedGeneration: bigint; kind: "conflict" }>;

export type ReserveRenderResultV1 =
  | Readonly<{ kind: "reserved"; replayed: boolean; reservation: UsageReservationV1 }>
  | Readonly<{
      kind: "denied";
      reason: "blocked" | "expired" | "operation-settled" | "quota-exhausted" | "render-disabled" | "unconfigured";
    }>;

export type SettleUsageReservationResultV1 =
  | Readonly<{ kind: "settled"; replayed: boolean; reservation: UsageReservationV1 }>
  | Readonly<{ kind: "conflict"; state: UsageReservationStateV1 }>
  | Readonly<{ kind: "missing" }>;

export function parseApplyEntitlementSnapshotInputV1(input: unknown): ApplyEntitlementSnapshotInputV1 {
  return applySnapshotInputSchema.parse(input);
}

export function parseReserveRenderInputV1(input: unknown): ReserveRenderInputV1 {
  return reserveRenderInputSchema.parse(input);
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

export interface BillingEntitlementRepositoryV1 {
  applySnapshot(
    input: ApplyEntitlementSnapshotInputV1,
    signal?: AbortSignal,
  ): Promise<ApplyEntitlementSnapshotResultV1>;
  close(): Promise<void>;
  commitReservation(
    tenantId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  releaseReservation(
    tenantId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SettleUsageReservationResultV1>;
  reserveRender(input: ReserveRenderInputV1, signal?: AbortSignal): Promise<ReserveRenderResultV1>;
}
