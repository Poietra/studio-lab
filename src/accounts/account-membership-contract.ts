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

export type AccountOrganizationMemberV1 = z.infer<typeof accountOrganizationMemberSchemaV1>;
export type AccountOrganizationMembersViewV1 = z.infer<typeof accountOrganizationMembersViewSchemaV1>;
