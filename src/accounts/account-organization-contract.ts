import { z } from "zod";

import { accountDisplayNameSchemaV1, accountOrganizationIdSchemaV1 } from "./account-session-contract";

const productionOrganizationIdSchemaV1 = accountOrganizationIdSchemaV1.refine(
  (organizationId) => organizationId !== "studio-local" && !organizationId.startsWith("local-"),
  { message: "Local organization IDs cannot be created through the account API." },
);

const organizationMutationIdSchemaV1 = z.uuid().transform((mutationId) => mutationId.toLowerCase());

export const accountOrganizationBootstrapRequestSchemaV1 = z
  .object({
    displayName: accountDisplayNameSchemaV1,
    expectedVersion: z.number().int().safe().positive(),
    mutationId: organizationMutationIdSchemaV1,
    organizationId: productionOrganizationIdSchemaV1,
  })
  .strict();

export const accountOrganizationBootstrapResponseSchemaV1 = z
  .object({
    mutation: z
      .object({
        mutationId: organizationMutationIdSchemaV1,
        replayed: z.boolean(),
        version: z.number().int().safe().positive(),
      })
      .strict(),
    organization: z
      .object({
        displayName: accountDisplayNameSchemaV1,
        id: accountOrganizationIdSchemaV1,
        role: z.literal("owner"),
      })
      .strict(),
  })
  .strict();

export type AccountOrganizationBootstrapRequestV1 = z.infer<typeof accountOrganizationBootstrapRequestSchemaV1>;
export type AccountOrganizationBootstrapResponseV1 = z.infer<typeof accountOrganizationBootstrapResponseSchemaV1>;
