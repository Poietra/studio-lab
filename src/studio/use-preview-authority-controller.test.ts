import { describe, expect, it } from "vitest";

import type { StudioPreviewSnapshotProviderV1 } from "./preview-snapshot-provider";
import {
  createStudioPreviewAuthorityState,
  reduceStudioPreviewAuthority,
  selectStudioPreviewProvider,
  studioPreviewExecutionConsentScope,
  studioPreviewLocationSearchSnapshot,
  subscribeStudioPreviewLocationSearchChanges,
} from "./use-preview-authority-controller";

const LEGACY_SERVER_SEARCH = "?previewRenderer=server";
const FIXTURE_SEARCH = "?previewRenderer=fixture";
const MATHTEX_FIXTURE_SEARCH = "?previewRenderer=mathtex-fixture";
const provider: StudioPreviewSnapshotProviderV1 = {
  id: "resolved-provider",
  loadVerifiedSnapshot: async () => {
    throw new Error("not used by authority transition tests");
  },
};

describe("selectStudioPreviewProvider", () => {
  it("uses the server provider by default without letting unknown queries disable it", () => {
    expect(selectStudioPreviewProvider(null, false)).toBe("server");
    expect(selectStudioPreviewProvider("", true)).toBe("server");
    expect(selectStudioPreviewProvider("?previewRenderer=unknown", true)).toBe("server");
    expect(selectStudioPreviewProvider(LEGACY_SERVER_SEARCH, true)).toBe("server");
  });

  it("admits fixture authority only in development", () => {
    expect(selectStudioPreviewProvider(FIXTURE_SEARCH, false)).toBe("server");
    expect(selectStudioPreviewProvider(MATHTEX_FIXTURE_SEARCH, false)).toBe("server");
    expect(selectStudioPreviewProvider(FIXTURE_SEARCH, true)).toBe("fixture");
    expect(selectStudioPreviewProvider(MATHTEX_FIXTURE_SEARCH, true)).toBe("mathtex-fixture");
  });
});

describe("studioPreviewExecutionConsentScope", () => {
  it("is tab-storage ready and scoped to the exact project and provider", () => {
    expect(studioPreviewExecutionConsentScope("server", null)).toBeNull();
    expect(studioPreviewExecutionConsentScope("server", "project-a")).toBe(
      JSON.stringify({ projectId: "project-a", providerKind: "server" }),
    );
    expect(studioPreviewExecutionConsentScope("fixture", "project-a")).not.toBe(
      studioPreviewExecutionConsentScope("server", "project-a"),
    );
    expect(studioPreviewExecutionConsentScope("server", "project-b")).not.toBe(
      studioPreviewExecutionConsentScope("server", "project-a"),
    );
  });
});

describe("preview location search external store", () => {
  it("uses a null server snapshot and preserves the browser search exactly", () => {
    expect(studioPreviewLocationSearchSnapshot(null)).toBeNull();
    expect(studioPreviewLocationSearchSnapshot({ search: LEGACY_SERVER_SEARCH })).toBe(LEGACY_SERVER_SEARCH);
  });

  it("subscribes to traversal and Navigation API changes and removes both listeners", () => {
    const traversalTarget = new EventTarget();
    const navigationTarget = new EventTarget();
    let changes = 0;
    const unsubscribe = subscribeStudioPreviewLocationSearchChanges({ navigationTarget, traversalTarget }, () => {
      changes += 1;
    });

    traversalTarget.dispatchEvent(new Event("popstate"));
    navigationTarget.dispatchEvent(new Event("currententrychange"));
    expect(changes).toBe(2);

    unsubscribe();
    traversalTarget.dispatchEvent(new Event("popstate"));
    navigationTarget.dispatchEvent(new Event("currententrychange"));
    expect(changes).toBe(2);
  });
});

describe("reduceStudioPreviewAuthority", () => {
  it("never resolves the default provider before explicit allowed consent", () => {
    const requested = createStudioPreviewAuthorityState("server");
    const denied = reduceStudioPreviewAuthority(requested, { allowed: false, type: "activate" });
    const unsolicited = reduceStudioPreviewAuthority(requested, {
      generation: requested.generation,
      provider,
      type: "provider-resolved",
    });

    expect(requested).toMatchObject({ generation: 0, phase: "awaiting-consent", provider: null });
    expect(denied).toBe(requested);
    expect(unsolicited).toBe(requested);
  });

  it("activates only the provider from the exact consent generation", () => {
    const requested = createStudioPreviewAuthorityState("server");
    const resolving = reduceStudioPreviewAuthority(requested, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthority(resolving, {
      generation: resolving.generation,
      provider,
      type: "provider-resolved",
    });

    expect(resolving).toMatchObject({ generation: 1, phase: "resolving", provider: null });
    expect(active).toMatchObject({ generation: 1, phase: "active", provider });
    expect(reduceStudioPreviewAuthority(active, { projectId: null, providerKind: "server", type: "configure" })).toBe(
      active,
    );
  });

  it("requires fresh consent after a provider change and rejects the previous completion", () => {
    const first = createStudioPreviewAuthorityState("server");
    const resolving = reduceStudioPreviewAuthority(first, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthority(resolving, {
      generation: resolving.generation,
      provider,
      type: "provider-resolved",
    });
    const reconfigured = reduceStudioPreviewAuthority(active, {
      projectId: null,
      providerKind: "fixture",
      type: "configure",
    });

    expect(reconfigured).toMatchObject({
      generation: 2,
      phase: "awaiting-consent",
      provider: null,
      providerKind: "fixture",
    });
    expect(
      reduceStudioPreviewAuthority(reconfigured, {
        generation: resolving.generation,
        provider,
        type: "provider-resolved",
      }),
    ).toBe(reconfigured);
  });

  it("requires fresh consent for a different project but retains scope while no workspace is open", () => {
    const initial = reduceStudioPreviewAuthority(createStudioPreviewAuthorityState("server"), {
      projectId: "project-a",
      providerKind: "server",
      type: "configure",
    });
    const resolving = reduceStudioPreviewAuthority(initial, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthority(resolving, {
      generation: resolving.generation,
      provider,
      type: "provider-resolved",
    });

    expect(reduceStudioPreviewAuthority(active, { projectId: null, providerKind: "server", type: "configure" })).toBe(
      active,
    );
    expect(
      reduceStudioPreviewAuthority(active, { projectId: "project-a", providerKind: "server", type: "configure" }),
    ).toBe(active);
    expect(
      reduceStudioPreviewAuthority(active, { projectId: "project-b", providerKind: "server", type: "configure" }),
    ).toMatchObject({
      generation: active.generation + 1,
      phase: "awaiting-consent",
      projectId: "project-b",
      provider: null,
    });
  });

  it("retries only an active authority and rejects its stale provider", () => {
    const requested = createStudioPreviewAuthorityState("server");
    const firstResolution = reduceStudioPreviewAuthority(requested, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthority(firstResolution, {
      generation: firstResolution.generation,
      provider,
      type: "provider-resolved",
    });
    const retrying = reduceStudioPreviewAuthority(active, { allowed: true, type: "retry" });

    expect(reduceStudioPreviewAuthority(requested, { allowed: true, type: "retry" })).toBe(requested);
    expect(retrying).toMatchObject({ generation: 2, phase: "resolving", provider: null });
    expect(
      reduceStudioPreviewAuthority(retrying, {
        generation: firstResolution.generation,
        provider,
        type: "provider-resolved",
      }),
    ).toBe(retrying);
  });
});
