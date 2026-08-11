import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  createAccountMembershipFetchHandlerV1,
  createAccountMembershipFetchRequestGuardV1,
} from "./account-membership-fetch";
import { ACCOUNT_SESSION_COOKIE_NAME_V1 } from "./account-session-cookie";
import type { AccountMembershipViewRepositoryV1 } from "./account-session-repository";

const token = "A".repeat(43);
const cookie = `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}`;

function repository(
  result: Awaited<ReturnType<AccountMembershipViewRepositoryV1["listActiveOrganizationMembers"]>> = {
    kind: "listed",
    members: [
      {
        displayName: "Ada Lovelace",
        id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
        role: "owner",
        version: 3,
      },
    ],
  },
) {
  const listActiveOrganizationMembers = vi.fn(async (_hash: Uint8Array, _signal?: AbortSignal) => result);
  return {
    listActiveOrganizationMembers,
    value: {
      close: vi.fn(async () => undefined),
      listActiveOrganizationMembers,
    } satisfies AccountMembershipViewRepositoryV1,
  };
}

describe("account membership fetch boundary", () => {
  it("rejects malformed and cross-origin requests before storage", () => {
    const guard = createAccountMembershipFetchRequestGuardV1("https://studio.example");

    expect(guard.reject(new Request("https://attacker.example/api/account/members"))?.status).toBe(404);
    expect(guard.reject(new Request("https://studio.example/api/account/members", { method: "POST" }))?.status).toBe(
      405,
    );
    expect(guard.reject(new Request("https://studio.example/api/account/members?page=2"))?.status).toBe(400);
    expect(
      guard.reject(
        new Request("https://studio.example/api/account/members", {
          headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
        }),
      )?.status,
    ).toBe(403);
  });

  it("returns a bounded member view without exposing an organization selector", async () => {
    const fixture = repository();
    const handler = createAccountMembershipFetchHandlerV1(fixture.value, "https://studio.example");

    const response = await handler.fetch(
      new Request("https://studio.example/api/account/members", { headers: { cookie } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      members: [
        {
          displayName: "Ada Lovelace",
          id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
          role: "owner",
          version: 3,
        },
      ],
    });
    expect(fixture.listActiveOrganizationMembers).toHaveBeenCalledOnce();
    expect(fixture.listActiveOrganizationMembers.mock.calls[0]?.[0]).toEqual(
      createHash("sha256").update(Buffer.alloc(32)).digest(),
    );
  });

  it("keeps authentication, authorization, and storage failures distinct", async () => {
    const unauthenticated = createAccountMembershipFetchHandlerV1(repository().value, "https://studio.example");
    await expect(
      unauthenticated.fetch(new Request("https://studio.example/api/account/members")),
    ).resolves.toMatchObject({ status: 401 });

    for (const [kind, status] of [
      ["invalid-session", 401],
      ["forbidden", 403],
    ] as const) {
      const handler = createAccountMembershipFetchHandlerV1(repository({ kind }).value, "https://studio.example");
      await expect(
        handler.fetch(new Request("https://studio.example/api/account/members", { headers: { cookie } })),
      ).resolves.toMatchObject({ status });
    }

    const unavailable = repository();
    unavailable.listActiveOrganizationMembers.mockRejectedValueOnce(new Error("database unavailable"));
    const handler = createAccountMembershipFetchHandlerV1(unavailable.value, "https://studio.example");
    await expect(
      handler.fetch(new Request("https://studio.example/api/account/members", { headers: { cookie } })),
    ).resolves.toMatchObject({ status: 503 });
  });
});
