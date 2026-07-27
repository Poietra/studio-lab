import { describe, expect, it } from "vitest";

import type { StudioPreviewSnapshotProviderV1 } from "./preview-snapshot-provider";
import {
  createStudioPreviewAuthorityStateV1,
  createStudioPreviewEditingContextV1,
  reduceStudioPreviewAuthorityV1,
  requestedStudioPreviewRendererSearchV1,
  studioPreviewLocationSearchSnapshotV1,
  subscribeStudioPreviewLocationSearchChangesV1,
  type StudioPreviewAuthoritySceneV1,
} from "./use-preview-authority-controller";

const SERVER_SEARCH = "?previewRenderer=server";
const FIXTURE_SEARCH = "?previewRenderer=fixture";
const provider: StudioPreviewSnapshotProviderV1 = {
  id: "resolved-provider",
  loadVerifiedSnapshot: async () => {
    throw new Error("not used by authority transition tests");
  },
};

function scene(): StudioPreviewAuthoritySceneV1 {
  return {
    name: "SceneOne",
    runtimeSceneState: { duration: 2 },
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
  };
}

describe("requestedStudioPreviewRendererSearchV1", () => {
  it("keeps semantic preview as the default and ignores unknown requests", () => {
    expect(requestedStudioPreviewRendererSearchV1(null, true)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1("", true)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1("?previewRenderer=other", true)).toBeNull();
  });

  it("admits server authority in production but fixture authority only in development", () => {
    expect(requestedStudioPreviewRendererSearchV1(SERVER_SEARCH, false)).toBe(SERVER_SEARCH);
    expect(requestedStudioPreviewRendererSearchV1(FIXTURE_SEARCH, false)).toBeNull();
    expect(requestedStudioPreviewRendererSearchV1(FIXTURE_SEARCH, true)).toBe(FIXTURE_SEARCH);
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
});

describe("createStudioPreviewEditingContextV1", () => {
  it("uses the pristine revision only when no editor history can affect authority", () => {
    expect(
      createStudioPreviewEditingContextV1({
        appliedTransactionIds: [],
        draftActive: false,
        editingAppliedProgram: false,
        projectId: "project-a",
        redoProgramCount: 0,
        scene: scene(),
      }),
    ).toEqual({
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceDuration: 2,
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      workingRevision: "pristine",
    });
  });

  it.each([
    ["applied program", { appliedTransactionIds: ["tx-1"] }],
    ["draft", { draftActive: true }],
    ["applied-program edit", { editingAppliedProgram: true }],
    ["redo history", { redoProgramCount: 1 }],
  ] as const)("invalidates snapshot correlation for an %s", (_label, change) => {
    const context = createStudioPreviewEditingContextV1({
      appliedTransactionIds: [],
      draftActive: false,
      editingAppliedProgram: false,
      projectId: "project-a",
      redoProgramCount: 0,
      scene: scene(),
      ...change,
    });

    expect(context?.workingRevision).not.toBe("pristine");
  });

  it("does not create preview authority without both project and Scene identity", () => {
    const input = {
      appliedTransactionIds: [],
      draftActive: false,
      editingAppliedProgram: false,
      projectId: "project-a",
      redoProgramCount: 0,
      scene: scene(),
    };
    expect(createStudioPreviewEditingContextV1({ ...input, projectId: null })).toBeNull();
    expect(createStudioPreviewEditingContextV1({ ...input, scene: null })).toBeNull();
  });
});
