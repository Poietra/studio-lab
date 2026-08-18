import { describe, expect, it } from "vitest";

import {
  accountMembershipMutationRequestSchemaV1,
  accountMembershipMutationResponseSchemaV1,
} from "./account-membership-contract";

const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";

describe("account membership mutation contract", () => {
  it("accepts only explicit role changes and removals", () => {
    expect(
      accountMembershipMutationRequestSchemaV1.parse({
        action: "set-role",
        expectedVersion: 3,
        mutationId,
        role: "admin",
      }),
    ).toEqual({ action: "set-role", expectedVersion: 3, mutationId, role: "admin" });
    expect(
      accountMembershipMutationRequestSchemaV1.parse({ action: "remove", expectedVersion: 3, mutationId }),
    ).toEqual({ action: "remove", expectedVersion: 3, mutationId });
    expect(
      accountMembershipMutationRequestSchemaV1.safeParse({
        action: "remove",
        expectedVersion: 3,
        mutationId,
        role: "admin",
      }).success,
    ).toBe(false);
  });

  it("keeps active and removed outcomes disjoint", () => {
    expect(
      accountMembershipMutationResponseSchemaV1.safeParse({
        member: { id: mutationId, role: "admin", status: "active", version: 4 },
        mutation: { mutationId, replayed: false },
      }).success,
    ).toBe(true);
    expect(
      accountMembershipMutationResponseSchemaV1.safeParse({
        member: { id: mutationId, role: "admin", status: "removed", version: 4 },
        mutation: { mutationId, replayed: false },
      }).success,
    ).toBe(false);
  });
});
