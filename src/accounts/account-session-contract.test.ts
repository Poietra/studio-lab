import { describe, expect, it } from "vitest";

import { accountOrganizationSwitchRequestSchemaV1, accountSessionViewSchemaV1 } from "./account-session-contract";

const session = {
  activeOrganization: { displayName: "Poietra", id: "organization-a", role: "owner" as const },
  organizationSwitch: null,
  organizations: [
    { displayName: "Poietra", id: "organization-a", role: "owner" as const },
    { displayName: "Studio Team", id: "organization-b", role: "member" as const },
  ],
  user: { displayName: "Ada", id: "2f2e3ea4-88de-4f37-81f7-1860d8f942f8" },
  version: 3,
};
const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";

describe("account session contract", () => {
  it("requires one strict organization switch compare-and-set request", () => {
    expect(
      accountOrganizationSwitchRequestSchemaV1.parse({
        expectedVersion: 3,
        mutationId,
        organizationId: "organization-b",
      }),
    ).toEqual({ expectedVersion: 3, mutationId, organizationId: "organization-b" });
    expect(accountOrganizationSwitchRequestSchemaV1.safeParse({ organizationId: "organization-b" }).success).toBe(
      false,
    );
    expect(
      accountOrganizationSwitchRequestSchemaV1.safeParse({
        expectedVersion: 3,
        mutationId,
        organizationId: "organization-b",
        sessionToken: "must-not-cross",
      }).success,
    ).toBe(false);
  });

  it("accepts one canonical active organization membership", () => {
    expect(accountSessionViewSchemaV1.parse(session)).toEqual(session);
  });

  it("counts Unicode display names like PostgreSQL char_length", () => {
    expect(
      accountSessionViewSchemaV1.safeParse({ ...session, user: { ...session.user, displayName: "🧮".repeat(120) } })
        .success,
    ).toBe(true);
    expect(
      accountSessionViewSchemaV1.safeParse({ ...session, user: { ...session.user, displayName: "🧮".repeat(121) } })
        .success,
    ).toBe(false);
  });

  it.each([
    ["unknown fields", { ...session, sessionToken: "secret" }],
    ["a missing active membership", { ...session, organizations: session.organizations.slice(1) }],
    ["a mismatched active role", { ...session, activeOrganization: { ...session.activeOrganization, role: "admin" } }],
    ["duplicate memberships", { ...session, organizations: [session.organizations[0], session.organizations[0]] }],
    ["an untrimmed display name", { ...session, user: { ...session.user, displayName: " Ada " } }],
    [
      "a missing version",
      { activeOrganization: session.activeOrganization, organizations: session.organizations, user: session.user },
    ],
    ["a non-positive version", { ...session, version: 0 }],
    ["an unsafe version", { ...session, version: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_label, value) => {
    expect(accountSessionViewSchemaV1.safeParse(value).success).toBe(false);
  });
});
