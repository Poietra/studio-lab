import { z } from "zod";

import { manimTenantIdSchema } from "../manim-request-principal";

export const accountUserIdSchemaV1 = z.uuid();
/** The P0 organization identity is also the existing Manim tenant identity. */
export const organizationIdSchemaV1 = manimTenantIdSchema;
export const organizationRoleSchemaV1 = z.enum(["owner", "admin", "member", "billing"]);
export type OrganizationRoleV1 = z.infer<typeof organizationRoleSchemaV1>;

export const ORGANIZATION_PERMISSIONS_V1 = [
  "organization:read",
  "organization:manage",
  "organization:delete",
  "membership:read",
  "membership:manage",
  "billing:read",
  "billing:manage",
  "manim:read",
  "manim:write",
] as const;

export type OrganizationPermissionV1 = (typeof ORGANIZATION_PERMISSIONS_V1)[number];

const ROLE_PERMISSIONS_V1 = {
  owner: ORGANIZATION_PERMISSIONS_V1,
  admin: [
    "organization:read",
    "organization:manage",
    "membership:read",
    "membership:manage",
    "manim:read",
    "manim:write",
  ],
  member: ["organization:read", "membership:read", "manim:read", "manim:write"],
  billing: ["organization:read", "billing:read", "billing:manage"],
} as const satisfies Record<OrganizationRoleV1, readonly OrganizationPermissionV1[]>;

/** Unknown persisted roles or permissions fail closed instead of inheriting access. */
export function organizationRoleAllowsV1(role: unknown, permission: unknown): boolean {
  const parsedRole = organizationRoleSchemaV1.safeParse(role);
  if (!parsedRole.success || !(ORGANIZATION_PERMISSIONS_V1 as readonly unknown[]).includes(permission)) return false;
  return (ROLE_PERMISSIONS_V1[parsedRole.data] as readonly unknown[]).includes(permission);
}
