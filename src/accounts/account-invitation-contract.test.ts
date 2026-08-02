import { describe, expect, it } from "vitest";

import {
  accountInvitationCreateRequestSchemaV1,
  accountInvitationCreateResponseSchemaV1,
  accountInvitationTokenSchemaV1,
} from "./account-invitation-contract";

const invitationToken = Buffer.alloc(32, 4).toString("base64url");

describe("account invitation browser contract", () => {
  it("accepts the exact bounded request and response", () => {
    expect(accountInvitationCreateRequestSchemaV1.parse({ email: "member@example.com", role: "member" })).toEqual({
      email: "member@example.com",
      role: "member",
    });
    expect(
      accountInvitationCreateResponseSchemaV1.parse({
        expiresAt: "2026-08-05T00:00:00.000Z",
        invitationId: "00000000-0000-4000-8000-000000000001",
        invitationToken,
      }),
    ).toMatchObject({ invitationToken });
  });

  it("rejects owner issuance, extra fields, and non-canonical secrets", () => {
    expect(
      accountInvitationCreateRequestSchemaV1.safeParse({ email: "member@example.com", role: "owner" }).success,
    ).toBe(false);
    expect(
      accountInvitationCreateResponseSchemaV1.safeParse({
        expiresAt: "2026-08-05T00:00:00.000Z",
        invitationId: "00000000-0000-4000-8000-000000000001",
        invitationToken,
        targetEmail: "member@example.com",
      }).success,
    ).toBe(false);
    expect(accountInvitationTokenSchemaV1.safeParse(`${invitationToken.slice(0, -1)}B`).success).toBe(false);
  });
});
