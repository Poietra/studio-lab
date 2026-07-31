import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchOrganizationScopedManimApiV1,
  POIETRA_ORGANIZATION_HEADER_V1,
  setManimOrganizationScopeV1,
} from "./organization-scoped-manim-fetch";

afterEach(() => {
  setManimOrganizationScopeV1(undefined);
  vi.unstubAllGlobals();
});

describe("organization-scoped Manim fetch", () => {
  it("preserves local Vite and native-shell requests when account bootstrap is disabled", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const init = { method: "POST" } satisfies RequestInit;

    await fetchOrganizationScopedManimApiV1("/api/manim/projects", init);

    expect(fetch).toHaveBeenCalledWith("/api/manim/projects", init);
  });

  it("pins browser requests to the bootstrapped organization without replacing other headers", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    setManimOrganizationScopeV1("organization-a");

    await fetchOrganizationScopedManimApiV1("/api/manim/projects/project-a", {
      headers: { accept: "application/json" },
    });

    const [, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get(POIETRA_ORGANIZATION_HEADER_V1)).toBe("organization-a");
  });

  it("fails closed while account state changes and never leaks organization IDs off origin", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setManimOrganizationScopeV1(null);
    await expect(fetchOrganizationScopedManimApiV1("/api/manim/projects")).rejects.toThrow("being refreshed");

    setManimOrganizationScopeV1("organization-a");
    await expect(fetchOrganizationScopedManimApiV1("https://attacker.example/api/manim/projects")).rejects.toThrow(
      "same-origin API paths",
    );
    await expect(
      fetchOrganizationScopedManimApiV1("/api/manim/projects", {
        headers: { [POIETRA_ORGANIZATION_HEADER_V1]: "organization-b" },
      }),
    ).rejects.toThrow("does not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});
