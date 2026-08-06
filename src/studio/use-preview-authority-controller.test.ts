import { describe, expect, it } from "vitest";

import type { StudioPreviewSnapshotProviderV1 } from "./preview-snapshot-provider";
import {
  createStudioPreviewAuthorityStateV1,
  effectiveStudioPreviewRendererSearchV1,
  reduceStudioPreviewAuthorityV1,
  requestedStudioPreviewRendererSearchV1,
  STUDIO_PREVIEW_SERVER_REQUEST_SEARCH_V1,
  studioPreviewLocationSearchSnapshotV1,
  subscribeStudioPreviewLocationSearchChangesV1,
} from "./use-preview-authority-controller";

const SERVER_SEARCH = "?previewRenderer=server";
const FIXTURE_SEARCH = "?previewRenderer=fixture";
const MATHTEX_FIXTURE_SEARCH = "?previewRenderer=mathtex-fixture";
const provider: StudioPreviewSnapshotProviderV1 = {
  id: "resolved-provider",
  loadVerifiedSnapshot: async () => {
    throw new Error("not used by authority transition tests");
  },
};

describe("requestedStudioPreviewRendererSearchV1", () => {
  it("keeps semantic preview as the default and ignores unknown requests", () => {
    expect(requestedStudioPreviewRendererSearchV1(null, true)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1("", true)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1("?previewRenderer=other", true)).toBeNull();
  });

  it("keeps a standard-UI server request tab-local without overriding an admitted URL request", () => {
    expect(effectiveStudioPreviewRendererSearchV1(null, false, false)).toBeNull();
    expect(effectiveStudioPreviewRendererSearchV1(null, false, true)).toBe(STUDIO_PREVIEW_SERVER_REQUEST_SEARCH_V1);
    expect(effectiveStudioPreviewRendererSearchV1(FIXTURE_SEARCH, true, true)).toBe(FIXTURE_SEARCH);
    expect(effectiveStudioPreviewRendererSearchV1("?previewRenderer=unknown", false, true)).toBe(
      STUDIO_PREVIEW_SERVER_REQUEST_SEARCH_V1,
    );
  });

  it("admits server authority in production but fixture authority only in development", () => {
    expect(requestedStudioPreviewRendererSearchV1(SERVER_SEARCH, false)).toBe(SERVER_SEARCH);
    expect(requestedStudioPreviewRendererSearchV1(FIXTURE_SEARCH, false)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1(MATHTEX_FIXTURE_SEARCH, false)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1(FIXTURE_SEARCH, true)).toBe(FIXTURE_SEARCH);
    expect(requestedStudioPreviewRendererSearchV1(MATHTEX_FIXTURE_SEARCH, true)).toBe(MATHTEX_FIXTURE_SEARCH);
  });
});

describe("preview location search external store", () => {
  it("uses a null server snapshot and preserves the browser search exactly", () => {
    expect(studioPreviewLocationSearchSnapshotV1(null)).toBeNull();
    expect(studioPreviewLocationSearchSnapshotV1({ search: SERVER_SEARCH })).toBe(SERVER_SEARCH);
  });

  it("subscribes to traversal and Navigation API changes and removes both listeners", () => {
    const traversalTarget = new EventTarget();
    const navigationTarget = new EventTarget();
    let changes = 0;
    const unsubscribe = subscribeStudioPreviewLocationSearchChangesV1({ navigationTarget, traversalTarget }, () => {
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

describe("reduceStudioPreviewAuthorityV1", () => {
  it("never resolves a requested provider before explicit allowed consent", () => {
    const requested = createStudioPreviewAuthorityStateV1(SERVER_SEARCH);

    const denied = reduceStudioPreviewAuthorityV1(requested, { allowed: false, type: "activate" });
    const unsolicited = reduceStudioPreviewAuthorityV1(requested, {
      generation: requested.generation,
      provider,
      type: "provider-resolved",
    });

    expect(denied).toBe(requested);
    expect(unsolicited).toBe(requested);
    expect(requested).toMatchObject({ phase: "awaiting-consent", provider: null });
  });

  it("grants only the provider from the exact consent generation", () => {
    const requested = createStudioPreviewAuthorityStateV1(SERVER_SEARCH);
    const resolving = reduceStudioPreviewAuthorityV1(requested, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthorityV1(resolving, {
      generation: resolving.generation,
      provider,
      type: "provider-resolved",
    });

    expect(resolving).toMatchObject({ generation: 1, phase: "resolving", provider: null });
    expect(active).toMatchObject({ generation: 1, phase: "active", provider });
    expect(reduceStudioPreviewAuthorityV1(active, { requestSearch: SERVER_SEARCH, type: "configure" })).toBe(active);
  });

  it("fails closed on request reset and rejects a delayed provider completion", () => {
    const requested = createStudioPreviewAuthorityStateV1(SERVER_SEARCH);
    const resolving = reduceStudioPreviewAuthorityV1(requested, { allowed: true, type: "activate" });
    const reset = reduceStudioPreviewAuthorityV1(resolving, { requestSearch: null, type: "configure" });
    const staleCompletion = reduceStudioPreviewAuthorityV1(reset, {
      generation: resolving.generation,
      provider,
      type: "provider-resolved",
    });

    expect(reset).toMatchObject({ generation: 2, phase: "disabled", provider: null, requestSearch: null });
    expect(staleCompletion).toBe(reset);
  });

  it("requires fresh consent when the requested authority changes", () => {
    const first = createStudioPreviewAuthorityStateV1(SERVER_SEARCH);
    const resolving = reduceStudioPreviewAuthorityV1(first, { allowed: true, type: "activate" });
    const reconfigured = reduceStudioPreviewAuthorityV1(resolving, {
      requestSearch: FIXTURE_SEARCH,
      type: "configure",
    });

    expect(reconfigured).toMatchObject({
      generation: 2,
      phase: "awaiting-consent",
      provider: null,
      requestSearch: FIXTURE_SEARCH,
    });
    expect(
      reduceStudioPreviewAuthorityV1(reconfigured, {
        generation: resolving.generation,
        provider,
        type: "provider-resolved",
      }),
    ).toBe(reconfigured);
  });

  it("retries only an already-consented authority and rejects its stale provider", () => {
    const requested = createStudioPreviewAuthorityStateV1(SERVER_SEARCH);
    const firstResolution = reduceStudioPreviewAuthorityV1(requested, { allowed: true, type: "activate" });
    const active = reduceStudioPreviewAuthorityV1(firstResolution, {
      generation: firstResolution.generation,
      provider,
      type: "provider-resolved",
    });
    const retrying = reduceStudioPreviewAuthorityV1(active, { allowed: true, type: "retry" });

    expect(reduceStudioPreviewAuthorityV1(requested, { allowed: true, type: "retry" })).toBe(requested);
    expect(retrying).toMatchObject({ generation: 2, phase: "resolving", provider: null });
    expect(
      reduceStudioPreviewAuthorityV1(retrying, {
        generation: firstResolution.generation,
        provider,
        type: "provider-resolved",
      }),
    ).toBe(retrying);
  });
});
