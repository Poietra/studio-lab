import { z } from "zod";

export const accountOrganizationIdSchemaV1 = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const accountOrganizationRoleSchemaV1 = z.enum(["owner", "admin", "member", "billing"]);

export const accountOrganizationSwitchRequestSchemaV1 = z
  .object({
    organizationId: accountOrganizationIdSchemaV1,
    expectedVersion: z.number().int().safe().positive(),
  })
  .strict();

export const accountDisplayNameSchemaV1 = z
  .string()
  .refine(
    (value) =>
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 120 &&
      !value.startsWith(" ") &&
      !value.endsWith(" ") &&
      !/\p{Cc}/u.test(value),
    {
      message: "Display names must be trimmed and contain no control characters.",
    },
  );

const accountOrganizationSummarySchemaV1 = z
  .object({
    displayName: accountDisplayNameSchemaV1,
    id: accountOrganizationIdSchemaV1,
  })
  .strict();

export const accountSessionViewSchemaV1 = z
  .object({
    activeOrganization: accountOrganizationSummarySchemaV1.safeExtend({
      role: accountOrganizationRoleSchemaV1,
    }),
    organizations: z
      .array(
        accountOrganizationSummarySchemaV1.safeExtend({
          role: accountOrganizationRoleSchemaV1,
        }),
      )
      .min(1)
      .max(256),
    user: z
      .object({
        displayName: accountDisplayNameSchemaV1,
        id: z.uuid(),
      })
      .strict(),
    version: z.number().int().safe().positive(),
  })
  .strict()
  .superRefine((session, context) => {
    let activeOrganizations = 0;
    const organizationIds = new Set<string>();
    session.organizations.forEach((organization, index) => {
      const organizationId = organization.id;
      if (organizationIds.has(organizationId)) {
        context.addIssue({
          code: "custom",
          message: "Organization memberships must be unique.",
          path: ["organizations", index, "id"],
        });
      }
      organizationIds.add(organizationId);
      if (organizationId !== session.activeOrganization.id) return;
      activeOrganizations += 1;
      if (
        organization.displayName !== session.activeOrganization.displayName ||
        organization.role !== session.activeOrganization.role
      ) {
        context.addIssue({
          code: "custom",
          message: "The active organization must match its membership.",
          path: ["activeOrganization"],
        });
      }
    });
    if (activeOrganizations !== 1) {
      context.addIssue({
        code: "custom",
        message: "The active organization must have exactly one membership.",
        path: ["activeOrganization", "id"],
      });
    }
  });

export type AccountSessionViewV1 = z.infer<typeof accountSessionViewSchemaV1>;
