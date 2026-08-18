import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  createAccountMembershipFetchHandlerV1,
  createAccountMembershipFetchRequestGuardV1,
} from "./account-membership-fetch";
import { ACCOUNT_SESSION_COOKIE_NAME_V1 } from "./account-session-cookie";
import type {
  AccountMembershipMutationRepositoryV1,
  AccountMembershipViewRepositoryV1,
} from "./account-session-repository";

const token = "A".repeat(43);
const cookie = `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}`;

function repository(
  result: Awaited<ReturnType<AccountMembershipViewRepositoryV1["listActiveOrganizationMembers"]>> = {
    actorRole: "owner",
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
  const mutateActiveOrganizationMember = vi.fn(
    async (): Promise<
      Awaited<ReturnType<AccountMembershipMutationRepositoryV1["mutateActiveOrganizationMember"]>>
    > => ({
      kind: "applied",
      member: {
        id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3",
        role: "admin",
        status: "active",
        version: 4,
      },
      mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
      replayed: false,
    }),
  );
  return {
    listActiveOrganizationMembers,
    mutateActiveOrganizationMember,
    value: {
      close: vi.fn(async () => undefined),
      listActiveOrganizationMembers,
      mutateActiveOrganizationMember,
    } satisfies AccountMembershipViewRepositoryV1 & AccountMembershipMutationRepositoryV1,
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

  it("changes or removes one member selected by the URL with an idempotency key", async () => {
    const fixture = repository();
    const handler = createAccountMembershipFetchHandlerV1(fixture.value, "https://studio.example");
    const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";
    const memberId = "6b0cd2da-7b88-4542-87ea-e48e73b33df3";
    const response = await handler.fetch(
      new Request(`https://studio.example/api/account/members/${memberId}`, {
        body: JSON.stringify({ action: "set-role", expectedVersion: 3, mutationId, role: "admin" }),
        headers: {
          "content-type": "application/json",
          cookie,
          origin: "https://studio.example",
          "sec-fetch-site": "same-origin",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      member: { id: memberId, role: "admin", status: "active", version: 4 },
      mutation: { mutationId, replayed: false },
    });
    expect(fixture.mutateActiveOrganizationMember).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      memberId,
      { action: "set-role", expectedVersion: 3, mutationId, role: "admin" },
      expect.any(AbortSignal),
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

    const forbiddenMutation = repository();
    forbiddenMutation.mutateActiveOrganizationMember.mockResolvedValueOnce({ kind: "forbidden" });
    await expect(
      createAccountMembershipFetchHandlerV1(forbiddenMutation.value, "https://studio.example").fetch(
        new Request("https://studio.example/api/account/members/6b0cd2da-7b88-4542-87ea-e48e73b33df3", {
          body: JSON.stringify({
            action: "remove",
            expectedVersion: 3,
            mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
          }),
          headers: {
            "content-type": "application/json",
            cookie,
            origin: "https://studio.example",
            "sec-fetch-site": "same-origin",
          },
          method: "DELETE",
        }),
      ),
    ).resolves.toMatchObject({ status: 403 });

    const billing = repository({
      actorRole: "billing",
      kind: "listed",
      members: [
        {
          displayName: "Billing User",
          id: "24a6f56d-df1d-4d89-8017-732daa15e070",
          role: "billing",
          version: 1,
        },
      ],
    });
    await expect(
      createAccountMembershipFetchHandlerV1(billing.value, "https://studio.example").fetch(
        new Request("https://studio.example/api/account/members", { headers: { cookie } }),
      ),
    ).resolves.toMatchObject({ status: 403 });

    const unavailable = repository();
    unavailable.listActiveOrganizationMembers.mockRejectedValueOnce(new Error("database unavailable"));
    const handler = createAccountMembershipFetchHandlerV1(unavailable.value, "https://studio.example");
    await expect(
      handler.fetch(new Request("https://studio.example/api/account/members", { headers: { cookie } })),
    ).resolves.toMatchObject({ status: 503 });
  });
});
