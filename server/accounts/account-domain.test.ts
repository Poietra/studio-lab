import { describe, expect, it } from "vitest";

import {
  accountUserIdSchemaV1,
  normalizeAccountEmailV1,
  ORGANIZATION_PERMISSIONS_V1,
  organizationIdSchemaV1,
  organizationInvitationRoleSchemaV1,
  organizationRoleAllowsV1,
  organizationRoleSchemaV1,
} from "./account-domain";

describe("organization account boundary", () => {
  it("accepts only internal user UUIDs, tenant-safe organization IDs, and fixed roles", () => {
    expect(accountUserIdSchemaV1.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
    expect(accountUserIdSchemaV1.safeParse("external-subject").success).toBe(false);
    expect(organizationIdSchemaV1.safeParse("organization-a").success).toBe(true);
    expect(organizationIdSchemaV1.safeParse("../organization").success).toBe(false);
    for (const role of ["owner", "admin", "member", "billing"]) {
      expect(organizationRoleSchemaV1.safeParse(role).success).toBe(true);
    }
    expect(organizationRoleSchemaV1.safeParse("super-admin").success).toBe(false);
  });

  it("normalizes bounded ASCII emails and excludes owner from invitation roles", () => {
    expect(normalizeAccountEmailV1("  Ada.Lovelace+Studio@Example.COM ")).toBe("ada.lovelace+studio@example.com");
    for (const role of ["admin", "member", "billing"]) {
      expect(organizationInvitationRoleSchemaV1.safeParse(role).success).toBe(true);
    }
    expect(organizationInvitationRoleSchemaV1.safeParse("owner").success).toBe(false);
    for (const email of ["invalid", "name@example", "name@localhost", "name\u0000@example.com"]) {
      expect(() => normalizeAccountEmailV1(email)).toThrow(/email is invalid/i);
    }
  });

  it("fixes the complete role-permission matrix and fails closed for unknown values", () => {
    const expected = {
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
    } as const;

    for (const role of ["owner", "admin", "member", "billing"] as const) {
      for (const permission of ORGANIZATION_PERMISSIONS_V1) {
        expect(organizationRoleAllowsV1(role, permission), `${role} / ${permission}`).toBe(
          expected[role].includes(permission as never),
        );
      }
    }
    expect(organizationRoleAllowsV1("future-role", "manim:read")).toBe(false);
    expect(organizationRoleAllowsV1("owner", "future:permission")).toBe(false);
  });
});
