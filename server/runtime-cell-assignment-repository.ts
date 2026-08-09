import { z } from "zod";

import { isReservedLocalManimTenantId, manimTenantIdSchema } from "./manim-request-principal";
import {
  type ProductionRuntimeCellAssignmentSourceV1,
  type ProductionRuntimeCellAssignmentV1,
  productionRuntimeCellIdSchemaV1,
} from "./production-runtime-cell";

export const runtimeCellAssignmentMutationIdSchemaV1 = z.uuid().transform((mutationId) => mutationId.toLowerCase());

const runtimeCellAssignmentExpectedGenerationSchemaV1 = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);

const productionTenantIdSchemaV1 = manimTenantIdSchema.refine(
  (tenantId): boolean => !isReservedLocalManimTenantId(tenantId),
);

export const createRuntimeCellAssignmentInputSchemaV1 = z
  .object({
    cellId: productionRuntimeCellIdSchemaV1,
    expectedGeneration: z.literal(0),
    mutationId: runtimeCellAssignmentMutationIdSchemaV1,
    tenantId: productionTenantIdSchemaV1,
  })
  .strict();

export const rotateRuntimeCellAssignmentInputSchemaV1 = z
  .object({
    cellId: productionRuntimeCellIdSchemaV1,
    expectedGeneration: runtimeCellAssignmentExpectedGenerationSchemaV1,
    mutationId: runtimeCellAssignmentMutationIdSchemaV1,
    tenantId: productionTenantIdSchemaV1,
  })
  .strict();

export const disableRuntimeCellAssignmentInputSchemaV1 = z
  .object({
    expectedGeneration: runtimeCellAssignmentExpectedGenerationSchemaV1,
    mutationId: runtimeCellAssignmentMutationIdSchemaV1,
    tenantId: productionTenantIdSchemaV1,
  })
  .strict();

export type CreateRuntimeCellAssignmentInputV1 = Readonly<z.infer<typeof createRuntimeCellAssignmentInputSchemaV1>>;
export type RotateRuntimeCellAssignmentInputV1 = Readonly<z.infer<typeof rotateRuntimeCellAssignmentInputSchemaV1>>;
export type DisableRuntimeCellAssignmentInputV1 = Readonly<z.infer<typeof disableRuntimeCellAssignmentInputSchemaV1>>;

export type RuntimeCellAssignmentMutationResultV1 =
  | Readonly<{
      assignment: ProductionRuntimeCellAssignmentV1;
      kind: "applied";
      replayed: boolean;
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "organization-unavailable" }>;

/** Durable assignment authority plus replay-safe administrative mutations. */
export interface RuntimeCellAssignmentRepositoryV1 extends ProductionRuntimeCellAssignmentSourceV1 {
  close(): Promise<void>;
  createAssignment(
    input: CreateRuntimeCellAssignmentInputV1,
    signal?: AbortSignal,
  ): Promise<RuntimeCellAssignmentMutationResultV1>;
  disableAssignment(
    input: DisableRuntimeCellAssignmentInputV1,
    signal?: AbortSignal,
  ): Promise<RuntimeCellAssignmentMutationResultV1>;
  ready(signal?: AbortSignal): Promise<boolean>;
  resolve(tenantId: string, signal?: AbortSignal): Promise<ProductionRuntimeCellAssignmentV1 | null>;
  rotateAssignment(
    input: RotateRuntimeCellAssignmentInputV1,
    signal?: AbortSignal,
  ): Promise<RuntimeCellAssignmentMutationResultV1>;
}
