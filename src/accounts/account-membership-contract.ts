import { z } from "zod";

import { accountDisplayNameSchemaV1, accountOrganizationRoleSchemaV1 } from "./account-session-contract";

export const accountOrganizationMemberSchemaV1 = z
  .object({
    displayName: accountDisplayNameSchemaV1,
    id: z.uuid(),
    role: accountOrganizationRoleSchemaV1,
    version: z.number().int().safe().positive(),
  })
  .strict();

export const accountOrganizationMembersViewSchemaV1 = z
  .object({
    members: z.array(accountOrganizationMemberSchemaV1).min(1).max(256),
  })
  .strict()
  .superRefine((view, context) => {
    for (let index = 1; index < view.members.length; index += 1) {
      if (view.members[index - 1]!.id >= view.members[index]!.id) {
        context.addIssue({
          code: "custom",
          message: "Organization members must be unique and sorted.",
          path: ["members", index, "id"],
        });
      }
    }
  });

const accountMembershipMutationIdSchemaV1 = z.uuid().transform((value) => value.toLowerCase());
const accountMembershipExpectedVersionSchemaV1 = z.number().int().safe().positive();

export const accountMembershipMutationRequestSchemaV1 = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set-role"),
      expectedVersion: accountMembershipExpectedVersionSchemaV1,
      mutationId: accountMembershipMutationIdSchemaV1,
      role: accountOrganizationRoleSchemaV1,
    })
    .strict(),
  z
    .object({
      action: z.literal("remove"),
      expectedVersion: accountMembershipExpectedVersionSchemaV1,
      mutationId: accountMembershipMutationIdSchemaV1,
    })
    .strict(),
]);

export const accountMembershipMutationResponseSchemaV1 = z
  .object({
    member: z.discriminatedUnion("status", [
      z
        .object({
          id: z.uuid(),
          role: accountOrganizationRoleSchemaV1,
          status: z.literal("active"),
          version: accountMembershipExpectedVersionSchemaV1,
        })
        .strict(),
      z
        .object({
          id: z.uuid(),
          status: z.literal("removed"),
          version: accountMembershipExpectedVersionSchemaV1,
        })
        .strict(),
    ]),
    mutation: z
      .object({
        mutationId: accountMembershipMutationIdSchemaV1,
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AccountOrganizationMemberV1 = z.infer<typeof accountOrganizationMemberSchemaV1>;
export type AccountOrganizationMembersViewV1 = z.infer<typeof accountOrganizationMembersViewSchemaV1>;
export type AccountMembershipMutationRequestV1 = z.infer<typeof accountMembershipMutationRequestSchemaV1>;
export type AccountMembershipMutationResponseV1 = z.infer<typeof accountMembershipMutationResponseSchemaV1>;
