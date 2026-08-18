import { describe, expect, it, vi } from "vitest";

import { accountOrganizationCreationIdentity, runAccountOrganizationCreation } from "./account-organization-control";

describe("Account organization creation flow", () => {
  it("does not create until the editor session permits the transition", async () => {
    const create = vi.fn(async () => undefined);

    await expect(runAccountOrganizationCreation(async () => false, create)).resolves.toBe(false);

    expect(create).not.toHaveBeenCalled();
  });

  it("flushes before every creation attempt", async () => {
    const events: string[] = [];
    const beforeCreate = vi.fn(async () => {
      events.push("flush");
      return true;
    });
    const create = vi.fn(async () => {
      events.push("post");
    });

    await runAccountOrganizationCreation(beforeCreate, create);
    await runAccountOrganizationCreation(beforeCreate, create);

    expect(events).toEqual(["flush", "post", "flush", "post"]);
  });

  it("keeps one replay identity for an unchanged form and replaces it after an input change", () => {
    const first = accountOrganizationCreationIdentity(null, "Research Team", 3);
    const retry = accountOrganizationCreationIdentity(first, "Research Team", 3);
    const retryAfterRefresh = accountOrganizationCreationIdentity(first, "Research Team", 4);
    const changed = accountOrganizationCreationIdentity(first, "Research Lab", 3);

    expect(retry).toBe(first);
    expect(retryAfterRefresh).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.mutationId).not.toBe(first.mutationId);
    expect(changed.organizationId).not.toBe(first.organizationId);
  });
});
