import { describe, expect, it } from "vitest";

import {
  accountOrganizationBootstrapRequestSchemaV1,
  accountOrganizationBootstrapResponseSchemaV1,
} from "./account-organization-contract";

const mutationId = "8ADBE79B-41AF-4CAF-BB6F-84FD13A4CA6B";

describe("account Organization contracts", () => {
  it("normalizes the mutation UUID and accepts one bounded bootstrap request", () => {
    expect(
      accountOrganizationBootstrapRequestSchemaV1.parse({
        displayName: "Research Team",
        expectedVersion: 3,
        mutationId,
        organizationId: "research-team",
      }),
    ).toEqual({
      displayName: "Research Team",
      expectedVersion: 3,
      mutationId: mutationId.toLowerCase(),
      organizationId: "research-team",
    });
  });

  it.each([
    { displayName: " Research Team", expectedVersion: 3, mutationId, organizationId: "research-team" },
    { displayName: "Research Team", expectedVersion: 0, mutationId, organizationId: "research-team" },
    { displayName: "Research Team", expectedVersion: 3, mutationId: "not-a-uuid", organizationId: "research-team" },
    { displayName: "Research Team", expectedVersion: 3, mutationId, organizationId: "studio-local" },
    { displayName: "Research Team", expectedVersion: 3, mutationId, organizationId: "local-test" },
    { displayName: "Research Team", expectedVersion: 3, mutationId, organizationId: "research-team", role: "owner" },
  ])("rejects an invalid or ambiguous request", (value) => {
    expect(accountOrganizationBootstrapRequestSchemaV1.safeParse(value).success).toBe(false);
  });

  it("requires the response to report the owner projection and replay status", () => {
    expect(
      accountOrganizationBootstrapResponseSchemaV1.safeParse({
        mutation: { mutationId, replayed: true, version: 4 },
        organization: { displayName: "Research Team", id: "research-team", role: "owner" },
      }).success,
    ).toBe(true);
    expect(
      accountOrganizationBootstrapResponseSchemaV1.safeParse({
        mutation: { mutationId, replayed: true, version: 4 },
        organization: { displayName: "Research Team", id: "research-team", role: "admin" },
      }).success,
    ).toBe(false);
  });
});
