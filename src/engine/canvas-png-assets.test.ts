import { describe, expect, it, vi } from "vitest";

import { type AssetManifestV1, digestAssetManifestV1, type PngAssetV1 } from "./asset-manifest";
import {
  CanvasPngAssetValidationError,
  type CanvasPngAssetTransferV1,
  canvasPngAssetTransferV1Schema,
  canvasPngAssetTransfersV1Schema,
  prepareCanvasPngAssetTransfersV1,
} from "./canvas-png-assets";

async function digest(bytes: ArrayBuffer) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(
  bytes: ArrayBuffer,
  overrides: Partial<Pick<PngAssetV1, "id" | "pixelHeight" | "pixelWidth" | "sha256">> = {},
) {
  const asset: PngAssetV1 = {
    alphaMode: "straight",
    byteLength: bytes.byteLength,
    colorSpace: "srgb",
    id: overrides.id ?? "asset:image",
    kind: "png-image",
    mediaType: "image/png",
    pixelHeight: overrides.pixelHeight ?? 2,
    pixelWidth: overrides.pixelWidth ?? 3,
    sha256: overrides.sha256 ?? (await digest(bytes)),
  };
  const draft: AssetManifestV1 = {
    assets: [asset],
    manifestDigest: "0".repeat(64),
    manifestId: "manifest:image",
    schema: "poietra.asset-manifest",
    version: 1,
  };
  const manifest = { ...draft, manifestDigest: await digestAssetManifestV1(draft) };
  const payload: CanvasPngAssetTransferV1 = {
    assetId: asset.id,
    byteLength: asset.byteLength,
    bytes,
    mediaType: "image/png",
    pixelHeight: asset.pixelHeight,
    pixelWidth: asset.pixelWidth,
    sha256: asset.sha256,
  };
  return { asset, manifest, payload };
}

const decodeDimensions = vi.fn(async () => ({ pixelHeight: 2, pixelWidth: 3 }));

describe("canvas PNG asset ingress", () => {
  it("verifies a new digest and transfers an owned fixed buffer", async () => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer;
    const { manifest, payload } = await fixture(source);
    const prepared = await prepareCanvasPngAssetTransfersV1({ decodeDimensions, manifest, payloads: [payload] });

    expect(prepared.transfers).toHaveLength(1);
    expect(prepared.transfers[0]?.bytes).not.toBe(source);
    expect(new Uint8Array(prepared.transfers[0]!.bytes)).toEqual(new Uint8Array(source));
    expect(source.byteLength).toBe(4);
    expect(prepared.nextRegistry.byDigest.has(payload.sha256)).toBe(true);
  });

  it("reuses an acknowledged digest and permits one logical ID to advance to new immutable bytes", async () => {
    const first = await fixture(new Uint8Array([1, 2, 3, 4]).buffer);
    const installed = await prepareCanvasPngAssetTransfersV1({
      decodeDimensions,
      manifest: first.manifest,
      payloads: [first.payload],
    });
    const reused = await prepareCanvasPngAssetTransfersV1({
      manifest: first.manifest,
      registry: installed.nextRegistry,
    });
    expect(reused.transfers).toEqual([]);

    const second = await fixture(new Uint8Array([5, 6, 7, 8]).buffer, { id: first.asset.id });
    const advanced = await prepareCanvasPngAssetTransfersV1({
      decodeDimensions,
      manifest: second.manifest,
      payloads: [second.payload],
      registry: installed.nextRegistry,
    });
    expect(advanced.transfers).toHaveLength(1);
    expect(advanced.nextRegistry.byDigest.size).toBe(1);
    expect(advanced.nextRegistry.byDigest.has(first.asset.sha256)).toBe(false);
  });

  it("rejects stale length, digest, decoded dimensions, and decoder failure", async () => {
    const current = await fixture(new Uint8Array([1, 2, 3, 4]).buffer);
    await expect(
      prepareCanvasPngAssetTransfersV1({
        decodeDimensions,
        manifest: current.manifest,
        payloads: [{ ...current.payload, sha256: "f".repeat(64) }],
      }),
    ).rejects.toBeInstanceOf(CanvasPngAssetValidationError);
    await expect(
      prepareCanvasPngAssetTransfersV1({
        decodeDimensions: async () => ({ pixelHeight: 9, pixelWidth: 3 }),
        manifest: current.manifest,
        payloads: [current.payload],
      }),
    ).rejects.toThrow(/decoded dimensions/i);
    await expect(
      prepareCanvasPngAssetTransfersV1({
        decodeDimensions: async () => {
          throw new Error("malformed PNG");
        },
        manifest: current.manifest,
        payloads: [current.payload],
      }),
    ).rejects.toThrow(/could not be verified/i);
    expect(
      canvasPngAssetTransferV1Schema.safeParse({ ...current.payload, byteLength: current.payload.byteLength + 1 })
        .success,
    ).toBe(false);
  });

  it("rejects missing, detached, duplicate, widened, and conflicting immutable payloads", async () => {
    const current = await fixture(new Uint8Array([1, 2, 3, 4]).buffer);
    await expect(prepareCanvasPngAssetTransfersV1({ manifest: current.manifest })).rejects.toThrow(/missing/i);

    const detached = current.payload.bytes.slice(0);
    structuredClone(null, { transfer: [detached] });
    expect(canvasPngAssetTransferV1Schema.safeParse({ ...current.payload, bytes: detached }).success).toBe(false);
    expect(canvasPngAssetTransfersV1Schema.safeParse([current.payload, current.payload]).success).toBe(false);
    expect(canvasPngAssetTransferV1Schema.safeParse({ ...current.payload, path: "/tmp/image.png" }).success).toBe(
      false,
    );
    expect(
      canvasPngAssetTransferV1Schema.safeParse({ ...current.payload, url: "https://example.test/a.png" }).success,
    ).toBe(false);
    expect(canvasPngAssetTransferV1Schema.safeParse({ ...current.payload, bytesBase64: "AQIDBA==" }).success).toBe(
      false,
    );

    const installed = await prepareCanvasPngAssetTransfersV1({
      decodeDimensions,
      manifest: current.manifest,
      payloads: [current.payload],
    });
    const conflict = await fixture(new Uint8Array([1, 2, 3, 4]).buffer, {
      id: "asset:alias",
      pixelWidth: 4,
    });
    await expect(
      prepareCanvasPngAssetTransfersV1({ manifest: conflict.manifest, registry: installed.nextRegistry }),
    ).rejects.toThrow(/conflicting immutable metadata/i);
  });

  it("removes absent digests and requires a verified transfer before reintroduction", async () => {
    const current = await fixture(new Uint8Array([1, 2, 3, 4]).buffer);
    const installed = await prepareCanvasPngAssetTransfersV1({
      decodeDimensions,
      manifest: current.manifest,
      payloads: [current.payload],
    });
    const emptyDraft: AssetManifestV1 = {
      assets: [],
      manifestDigest: "0".repeat(64),
      manifestId: "manifest:empty",
      schema: "poietra.asset-manifest",
      version: 1,
    };
    const empty = { ...emptyDraft, manifestDigest: await digestAssetManifestV1(emptyDraft) };
    const removed = await prepareCanvasPngAssetTransfersV1({ manifest: empty, registry: installed.nextRegistry });
    expect(removed.nextRegistry.byDigest.size).toBe(0);
    await expect(
      prepareCanvasPngAssetTransfersV1({
        manifest: current.manifest,
        registry: removed.nextRegistry,
      }),
    ).rejects.toThrow(/missing/i);
  });
});
