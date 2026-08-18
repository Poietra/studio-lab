import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_ORGANIZATIONS_ROUTE_V1, createAccountOrganizationFetchHandlerV1 } from "./account-organization-fetch";
import type { AccountOrganizationRepositoryV1 } from "./account-organization-repository";

const origin = "https://studio.example";
const tokenBytes = Buffer.alloc(32, 19);
const token = tokenBytes.toString("base64url");
const mutationId = "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b";

function fixture() {
  const repository: AccountOrganizationRepositoryV1 = {
    close: vi.fn(async () => undefined),
    createOrganization: vi.fn(async () => ({
      kind: "applied" as const,
      mutationId,
      organization: { displayName: "Research Team", id: "research-team", role: "owner" as const },
      replayed: false,
      version: 4,
    })),
    ready: vi.fn(async () => true),
  };
  return { handler: createAccountOrganizationFetchHandlerV1(repository, origin), repository };
}

function request(
  body: unknown = {
    displayName: "Research Team",
    expectedVersion: 3,
    mutationId,
    organizationId: "research-team",
  },
) {
  return new Request(`${origin}${ACCOUNT_ORGANIZATIONS_ROUTE_V1}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: `__Host-poietra_session=${token}`,
      origin,
      "sec-fetch-site": "same-origin",
    },
    method: "POST",
  });
}

describe("account Organization Fetch handler", () => {
  it("creates an owner Organization for the authenticated session", async () => {
    const { handler, repository } = fixture();

    const response = await handler.fetch(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      mutation: { mutationId, replayed: false, version: 4 },
      organization: { displayName: "Research Team", id: "research-team", role: "owner" },
    });
    expect(repository.createOrganization).toHaveBeenCalledWith(
      {
        displayName: "Research Team",
        expectedVersion: 3,
        mutationId,
        organizationId: "research-team",
        sessionTokenHash: createHash("sha256").update(tokenBytes).digest(),
      },
      expect.any(AbortSignal),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("returns an exact replay without claiming a second creation", async () => {
    const { handler, repository } = fixture();
    vi.mocked(repository.createOrganization).mockResolvedValueOnce({
      kind: "applied",
      mutationId,
      organization: { displayName: "Research Team", id: "research-team", role: "owner" },
      replayed: true,
      version: 4,
    });

    const response = await handler.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mutation: { replayed: true, version: 4 } });
  });

  it.each([
    ["invalid-session", 401],
    ["organization-unavailable", 403],
    ["conflict", 409],
  ] as const)("maps %s without exposing repository details", async (kind, status) => {
    const { handler, repository } = fixture();
    vi.mocked(repository.createOrganization).mockResolvedValueOnce({ kind });

    const response = await handler.fetch(request());

    expect(response.status).toBe(status);
  });

  it("rejects malformed, cross-site, local-ID, oversized, and unauthenticated requests before storage", async () => {
    const { handler, repository } = fixture();
    const malformed = request({ displayName: "Research Team", expectedVersion: 3, mutationId });
    const local = request({
      displayName: "Local",
      expectedVersion: 3,
      mutationId,
      organizationId: "studio-local",
    });
    const crossSite = request();
    crossSite.headers.set("origin", "https://attacker.example");
    const unauthenticated = request();
    unauthenticated.headers.delete("cookie");
    const oversized = request({
      displayName: "A".repeat(2_000),
      expectedVersion: 3,
      mutationId,
      organizationId: "research-team",
    });

    const responses = [];
    for (const candidate of [malformed, local, crossSite, unauthenticated, oversized]) {
      responses.push(await handler.fetch(candidate));
    }

    expect(responses.map(({ status }) => status)).toEqual([400, 400, 403, 401, 413]);
    expect(repository.createOrganization).not.toHaveBeenCalled();
  });

  it("advertises only POST on the exact route", async () => {
    const { handler } = fixture();
    const response = await handler.fetch(new Request(`${origin}${ACCOUNT_ORGANIZATIONS_ROUTE_V1}`));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns a fixed unavailable response when storage fails", async () => {
    const { handler, repository } = fixture();
    vi.mocked(repository.createOrganization).mockRejectedValueOnce(new Error("secret database detail"));

    const response = await handler.fetch(request());

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.not.toContain("secret database detail");
  });
});
