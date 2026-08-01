import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchOrganizationScopedBillingApiV1,
  POIETRA_BILLING_ORGANIZATION_HEADER_V1,
} from "./organization-scoped-billing-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("organization-scoped billing fetch", () => {
  it("pins a known same-origin route to the active organization", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await fetchOrganizationScopedBillingApiV1("organization-a", "/api/billing/status", {
      headers: { accept: "application/json" },
    });

    const [path, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(path).toBe("/api/billing/status");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get(POIETRA_BILLING_ORGANIZATION_HEADER_V1)).toBe("organization-a");
  });

  it("rejects unknown routes and a conflicting organization header before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      fetchOrganizationScopedBillingApiV1("organization-a", "https://attacker.example/api/billing/status"),
    ).rejects.toThrow("known same-origin");
    await expect(
      fetchOrganizationScopedBillingApiV1("organization-a", "/api/billing/status", {
        headers: { [POIETRA_BILLING_ORGANIZATION_HEADER_V1]: "organization-b" },
      }),
    ).rejects.toThrow("does not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});
