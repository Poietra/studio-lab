import { describe, expect, it, vi } from "vitest";
import bundleFixture from "../../server/test-fixtures/fast-manim-static-bundle.json";
import { parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import type { StudioPreviewSceneIdentityV1 } from "./preview-snapshot-provider";
import { createServerPreviewSnapshotProviderV1 } from "./preview-snapshot-provider.server";

const REQUEST_ID = "studio-preview:test-request";
const SOURCE_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);
const identity: StudioPreviewSceneIdentityV1 = {
  projectId: "default",
  sceneName: "ExampleScene",
  sourceHash: SOURCE_HASH,
  sourcePath: "scene.py",
};

async function sceneId() {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity.sourcePath}\u0000${identity.sceneName}`),
  );
  return `scene:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function verifiedRun() {
  const id = await sceneId();
  const unsealedBundle = {
    ...bundleFixture,
    scene: {
      ...bundleFixture.scene,
      sceneId: id,
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: RUNTIME_HASH,
        snapshotHash: "0".repeat(64),
        snapshotVersion: 1,
        sourceHash: SOURCE_HASH,
      },
    },
  };
  const parsedUnsealedBundle = await parseVerifiedSceneIrBundleV1(unsealedBundle);
  const snapshotHash = await digestFastManimSnapshotBundleInBrowserV1(parsedUnsealedBundle);
  const bundle = await parseVerifiedSceneIrBundleV1({
    ...unsealedBundle,
    scene: {
      ...unsealedBundle.scene,
      source: { ...unsealedBundle.scene.source, snapshotHash },
    },
  });
  return {
    projectId: identity.projectId,
    publishedAt: "2026-07-27T00:00:00.000Z",
    requestId: REQUEST_ID,
    revision: 7,
    runtimeConfigHash: RUNTIME_HASH,
    sceneName: identity.sceneName,
    schema: "poietra.fast-manim-snapshot-run",
    snapshot: {
      bundle,
      kind: "compiled",
      projectId: identity.projectId,
      requestId: REQUEST_ID,
      runtimeConfigHash: RUNTIME_HASH,
      sceneId: id,
      sceneName: identity.sceneName,
      schema: "poietra.fast-manim-snapshot-result",
      snapshotHash,
      sourceHash: SOURCE_HASH,
      sourcePath: identity.sourcePath,
      version: 1,
    },
    sourcePath: identity.sourcePath,
    status: "verified",
    version: 1,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

function providerReturning(value: unknown) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(value));
  return {
    fetcher,
    provider: createServerPreviewSnapshotProviderV1({ fetcher, requestIdFactory: () => REQUEST_ID }),
  };
}

describe("createServerPreviewSnapshotProviderV1", () => {
  it("posts the full request identity and returns independently correlated engine and publication revisions", async () => {
    const run = await verifiedRun();
    const { fetcher, provider } = providerReturning(run);
    const controller = new AbortController();
    const loaded = await provider.loadVerifiedSnapshot({ identity, signal: controller.signal });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/manim/projects/default/scene-snapshots");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect(JSON.parse(String(init?.body))).toEqual({ ...identity, requestId: REQUEST_ID });
    expect(loaded).toMatchObject({
      correlation: {
        assetsManifestDigest: run.snapshot.bundle.assets.manifestDigest,
        context: { ...identity, sourceDuration: 1, workingRevision: "pristine" },
        engineRevisionHash: run.snapshot.snapshotHash,
        sceneDuration: 1,
        sceneId: run.snapshot.sceneId,
        serverPublicationRevision: 7,
      },
      duration: 1,
      sceneId: run.snapshot.sceneId,
      sourceLabel: "verified server snapshot r7",
    });
    expect(loaded.correlation.engineRevisionHash).not.toBe(String(loaded.correlation.serverPublicationRevision));
    expect(provider.evidence).toBeUndefined();
  });

  it.each(["failed", "stale", "unsupported"] as const)("fails closed for a %s run", async (status) => {
    const { provider } = providerReturning({ status });
    await expect(provider.loadVerifiedSnapshot({ identity })).rejects.toThrow(`did not verify this Scene (${status})`);
  });

  it("rejects malformed envelopes and every cross-boundary correlation mismatch", async () => {
    const base = await verifiedRun();
    const variants: unknown[] = [
      { ...base, revision: 0 },
      { ...base, requestId: "studio-preview:stale" },
      { ...base, projectId: "another" },
      { ...base, sourcePath: "other.py" },
      { ...base, sceneName: "OtherScene" },
      { ...base, snapshot: { ...base.snapshot, projectId: "another" } },
      { ...base, snapshot: { ...base.snapshot, requestId: "studio-preview:stale" } },
      { ...base, snapshot: { ...base.snapshot, sourceHash: "d".repeat(64) } },
      { ...base, runtimeConfigHash: "d".repeat(64) },
      { ...base, snapshot: { ...base.snapshot, sceneId: "scene:wrong" } },
      { ...base, snapshot: { ...base.snapshot, snapshotHash: "d".repeat(64) } },
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          bundle: {
            ...base.snapshot.bundle,
            scene: { ...base.snapshot.bundle.scene, sceneId: "scene:wrong" },
          },
        },
      },
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          bundle: {
            ...base.snapshot.bundle,
            scene: {
              ...base.snapshot.bundle.scene,
              source: { ...base.snapshot.bundle.scene.source, sourceHash: "d".repeat(64) },
            },
          },
        },
      },
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          bundle: {
            ...base.snapshot.bundle,
            scene: { ...base.snapshot.bundle.scene, duration: 0 },
          },
        },
      },
      {
        ...base,
        snapshot: {
          ...base.snapshot,
          bundle: {
            ...base.snapshot.bundle,
            assets: { ...base.snapshot.bundle.assets, manifestDigest: "d".repeat(64) },
          },
        },
      },
    ];
    for (const value of variants) {
      await expect(providerReturning(value).provider.loadVerifiedSnapshot({ identity })).rejects.toThrow();
    }
  });

  it("rejects invalid transport data and HTTP failures without adopting a snapshot", async () => {
    const invalidJson = createServerPreviewSnapshotProviderV1({
      fetcher: async () => new Response("not json", { headers: { "content-type": "application/json" } }),
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(invalidJson.loadVerifiedSnapshot({ identity })).rejects.toThrow("malformed JSON");

    const wrongMedia = createServerPreviewSnapshotProviderV1({
      fetcher: async () => new Response("{}", { headers: { "content-type": "text/plain" } }),
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(wrongMedia.loadVerifiedSnapshot({ identity })).rejects.toThrow("non-JSON");

    const httpFailure = createServerPreviewSnapshotProviderV1({
      fetcher: async () => jsonResponse({ error: "unavailable" }, 503),
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(httpFailure.loadVerifiedSnapshot({ identity })).rejects.toThrow("HTTP 503");

    const streamedOversize = createServerPreviewSnapshotProviderV1({
      fetcher: async () =>
        new Response(new Uint8Array(5 * 1024 * 1024 + 32 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(streamedOversize.loadVerifiedSnapshot({ identity })).rejects.toThrow("response is too large");
  });

  it("rejects content tampering even when every copied seal string still matches", async () => {
    const run = await verifiedRun();
    const tampered = {
      ...run,
      snapshot: {
        ...run.snapshot,
        bundle: {
          ...run.snapshot.bundle,
          scene: {
            ...run.snapshot.bundle.scene,
            camera: {
              ...run.snapshot.bundle.scene.camera,
              background: { ...run.snapshot.bundle.scene.camera.background, red: 0.5 },
            },
          },
        },
      },
    };
    await expect(providerReturning(tampered).provider.loadVerifiedSnapshot({ identity })).rejects.toThrow(
      "canonical snapshot digest",
    );
  });

  it("honors aborts before and during a request even when an injected fetcher ignores the signal", async () => {
    const run = await verifiedRun();
    const before = new AbortController();
    before.abort();
    const beforeFetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(run));
    await expect(
      createServerPreviewSnapshotProviderV1({
        fetcher: beforeFetcher,
        requestIdFactory: () => REQUEST_ID,
      }).loadVerifiedSnapshot({ identity, signal: before.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeFetcher).not.toHaveBeenCalled();

    const during = new AbortController();
    const provider = createServerPreviewSnapshotProviderV1({
      fetcher: async () => {
        during.abort();
        return jsonResponse(run);
      },
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(provider.loadVerifiedSnapshot({ identity, signal: during.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
