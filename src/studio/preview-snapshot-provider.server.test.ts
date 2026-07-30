import { describe, expect, it, vi } from "vitest";
import bundleFixture from "../../server/test-fixtures/fast-manim-static-bundle.json";
import { digestAssetManifestV1, parseVerifiedSceneIrBundleV1 } from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import type { StudioPreviewSceneIdentityV1 } from "./preview-snapshot-provider";
import { createServerPreviewSnapshotProviderV1 } from "./preview-snapshot-provider.server";

const REQUEST_ID = "studio-preview:test-request";
const SOURCE_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);
const PNG_BYTES = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
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

async function verifiedRun(options: Readonly<{ identityMap?: boolean; pngAsset?: boolean }> = {}) {
  const id = await sceneId();
  const pngDigest = await crypto.subtle.digest("SHA-256", PNG_BYTES);
  const pngSha256 = Array.from(new Uint8Array(pngDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const pngAsset = {
    alphaMode: "straight" as const,
    byteLength: PNG_BYTES.byteLength,
    colorSpace: "srgb" as const,
    id: `${id}/asset:image:0`,
    kind: "png-image" as const,
    mediaType: "image/png" as const,
    pixelHeight: 1,
    pixelWidth: 1,
    sha256: pngSha256,
  };
  const manifestId = `${id}/manifest`;
  const pngManifestDigest = await digestAssetManifestV1({
    assets: [pngAsset],
    manifestDigest: "0".repeat(64),
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  const pngManifest = {
    assets: [pngAsset],
    manifestDigest: pngManifestDigest,
    manifestId,
    schema: "poietra.asset-manifest" as const,
    version: 1 as const,
  };
  const unsealedBundle = {
    ...bundleFixture,
    assets: options.pngAsset ? pngManifest : bundleFixture.assets,
    scene: {
      ...bundleFixture.scene,
      ...(options.pngAsset
        ? {
            assetManifest: { manifestDigest: pngManifestDigest, manifestId },
            entities: [
              {
                ...bundleFixture.scene.entities[0],
                appearance: { kind: "image", opacity: 1 },
                geometry: {
                  asset: { assetId: pngAsset.id, sha256: pngAsset.sha256 },
                  kind: "image",
                  localRect: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
                  sampler: "nearest",
                },
              },
              ...bundleFixture.scene.entities.slice(1),
            ],
            requiredCapabilities: ["cubic-path-geometry", "png-image"],
          }
        : {}),
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
  const firstEntity = bundle.scene.entities[0]!;
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
    ...(options.identityMap === false
      ? {}
      : {
          sourceRuntimeIdentity: {
            mappings: [
              {
                binding: {
                  id: `source-binding:${"c".repeat(64)}`,
                  name: "circle",
                  ordinal: 1,
                  span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
                },
                entityId: firstEntity.id,
                familyPath: [],
                provenanceId: firstEntity.provenanceId,
              },
            ],
            runtimeConfigHash: RUNTIME_HASH,
            sceneId: id,
            schema: "poietra.studio-verified-source-runtime-identity-map",
            snapshotDigest: "d".repeat(64),
            snapshotHash,
            sourceHash: SOURCE_HASH,
            version: 1,
          },
        }),
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
    expect(loaded.sourceRuntimeIdentity?.get("circle")).toEqual({
      bindingId: `source-binding:${"c".repeat(64)}`,
      entityId: run.snapshot.bundle.scene.entities[0]?.id,
      sourceName: "circle",
    });
    expect(provider.evidence).toBeUndefined();
  });

  it("fetches each digest-correlated PNG and returns manifest-owned transfer metadata", async () => {
    const run = await verifiedRun({ pngAsset: true });
    const asset = run.snapshot.bundle.assets.assets[0]!;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/scene-snapshots")) return jsonResponse(run);
      expect(String(input)).toBe(`/api/manim/projects/default/scene-snapshot-assets/${asset.sha256}`);
      expect(init).toMatchObject({ headers: { accept: "image/png" }, method: "GET" });
      return new Response(PNG_BYTES.slice(), {
        headers: { "content-length": String(PNG_BYTES.byteLength), "content-type": "image/png" },
      });
    });
    const loaded = await createServerPreviewSnapshotProviderV1({
      fetcher,
      requestIdFactory: () => REQUEST_ID,
    }).loadVerifiedSnapshot({ identity });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(loaded.assetPayloads).toHaveLength(1);
    expect(loaded.assetPayloads[0]).toMatchObject({
      assetId: asset.id,
      byteLength: asset.byteLength,
      mediaType: "image/png",
      pixelHeight: asset.pixelHeight,
      pixelWidth: asset.pixelWidth,
      sha256: asset.sha256,
    });
    expect(new Uint8Array(loaded.assetPayloads[0]!.bytes)).toEqual(PNG_BYTES);
  });

  it("rejects stale, malformed, truncated, oversized, and failed PNG responses", async () => {
    const run = await verifiedRun({ pngAsset: true });
    const wrongDigest = PNG_BYTES.slice();
    wrongDigest[wrongDigest.length - 1] ^= 1;
    const variants: ReadonlyArray<Readonly<{ message: RegExp; response: () => Response }>> = [
      {
        message: /non-PNG/i,
        response: () => new Response(PNG_BYTES.slice(), { headers: { "content-type": "application/octet-stream" } }),
      },
      {
        message: /HTTP 404/i,
        response: () => new Response(null, { status: 404 }),
      },
      {
        message: /shorter than its manifest/i,
        response: () => new Response(PNG_BYTES.slice(0, -1), { headers: { "content-type": "image/png" } }),
      },
      {
        message: /exceeds its manifest/i,
        response: () =>
          new Response(new Uint8Array(PNG_BYTES.byteLength + 1), { headers: { "content-type": "image/png" } }),
      },
      {
        message: /stale digest/i,
        response: () => new Response(wrongDigest, { headers: { "content-type": "image/png" } }),
      },
      {
        message: /content length does not match/i,
        response: () =>
          new Response(PNG_BYTES.slice(), {
            headers: { "content-length": String(PNG_BYTES.byteLength + 1), "content-type": "image/png" },
          }),
      },
    ];
    for (const variant of variants) {
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/scene-snapshots") ? jsonResponse(run) : variant.response(),
      );
      await expect(
        createServerPreviewSnapshotProviderV1({ fetcher, requestIdFactory: () => REQUEST_ID }).loadVerifiedSnapshot({
          identity,
        }),
      ).rejects.toThrow(variant.message);
    }
  });

  it("keeps legacy verified runs without identity evidence on semantic interaction fallback", async () => {
    const run = await verifiedRun({ identityMap: false });
    const loaded = await providerReturning(run).provider.loadVerifiedSnapshot({ identity });
    expect(loaded.sourceRuntimeIdentity).toBeNull();
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

  it("rejects stale, ambiguous, and non-entity source/runtime maps", async () => {
    const base = await verifiedRun();
    const identityMap = base.sourceRuntimeIdentity;
    if (!identityMap) throw new Error("Expected the verified fixture identity map.");
    const mapping = identityMap.mappings[0]!;
    const variants = [
      { ...base, sourceRuntimeIdentity: { ...identityMap, sourceHash: "e".repeat(64) } },
      { ...base, sourceRuntimeIdentity: { ...identityMap, sceneId: "scene:stale" } },
      { ...base, sourceRuntimeIdentity: { ...identityMap, runtimeConfigHash: "e".repeat(64) } },
      { ...base, sourceRuntimeIdentity: { ...identityMap, snapshotHash: "e".repeat(64) } },
      {
        ...base,
        sourceRuntimeIdentity: {
          ...identityMap,
          mappings: [{ ...mapping, entityId: "missing-runtime-entity" }],
        },
      },
      {
        ...base,
        sourceRuntimeIdentity: {
          ...identityMap,
          mappings: [{ ...mapping, provenanceId: "wrong-provenance" }],
        },
      },
      {
        ...base,
        sourceRuntimeIdentity: { ...identityMap, mappings: [{ ...mapping, familyPath: [0] }] },
      },
      {
        ...base,
        sourceRuntimeIdentity: {
          ...identityMap,
          mappings: [mapping, { ...mapping, binding: { ...mapping.binding, id: `source-binding:${"e".repeat(64)}` } }],
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
        new Response(new Uint8Array(8 * 1024 * 1024 + 64 * 1024 + 1), {
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
