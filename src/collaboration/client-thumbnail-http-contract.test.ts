import { describe, expect, it } from "vitest";

import {
  type ClientThumbnailFinalizeMetadataV1,
  decodeClientThumbnailFinalizeBodyV1,
  encodeClientThumbnailFinalizeBodyV1,
  MAX_CLIENT_THUMBNAIL_FINALIZE_BODY_BYTES_V1,
  MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1,
  MAX_CLIENT_THUMBNAIL_PNG_BYTES_V1,
} from "./client-thumbnail-http-contract";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function metadata(overrides: Partial<ClientThumbnailFinalizeMetadataV1> = {}): ClientThumbnailFinalizeMetadataV1 {
  return {
    byteSize: PNG.byteLength,
    contentDigest: "a".repeat(64),
    documentEpoch: "00000000-0000-4000-8000-000000000001",
    documentKey: "b".repeat(64),
    documentRevision: "7",
    producerKind: "browser-wasm-wgpu",
    projectId: "project-a",
    publicationId: "00000000-0000-4000-8000-000000000002",
    representativeFrameRule: "last-representable-in-duration",
    sceneContractVersion: 1,
    sceneRevisionHash: "c".repeat(64),
    schema: "poietra.client-thumbnail-finalize",
    version: 1,
    ...overrides,
  };
}

describe("client thumbnail finalize envelope", () => {
  it("round-trips the exact bounded metadata and PNG", () => {
    const decoded = decodeClientThumbnailFinalizeBodyV1(encodeClientThumbnailFinalizeBodyV1(metadata(), PNG));
    expect(decoded.metadata).toEqual(metadata());
    expect([...decoded.png]).toEqual([...PNG]);
  });

  it("aligns the envelope bound with a 4 MiB PNG and 16 KiB metadata", () => {
    expect(MAX_CLIENT_THUMBNAIL_FINALIZE_BODY_BYTES_V1).toBe(
      4 + MAX_CLIENT_THUMBNAIL_METADATA_BYTES_V1 + MAX_CLIENT_THUMBNAIL_PNG_BYTES_V1,
    );
  });

  it("refuses byte-size disagreement and widened metadata", () => {
    expect(() => encodeClientThumbnailFinalizeBodyV1(metadata({ byteSize: PNG.byteLength + 1 }), PNG)).toThrow(
      /byte size/i,
    );
    const body = encodeClientThumbnailFinalizeBodyV1(metadata(), PNG);
    const widenedBytes = new TextEncoder().encode(JSON.stringify({ ...metadata(), extra: true }));
    const widened = new Uint8Array(4 + widenedBytes.byteLength + PNG.byteLength);
    new DataView(widened.buffer).setUint32(0, widenedBytes.byteLength, false);
    widened.set(widenedBytes, 4);
    widened.set(PNG, 4 + widenedBytes.byteLength);
    expect(() => decodeClientThumbnailFinalizeBodyV1(widened)).toThrow(/versioned contract/i);
    expect(() => decodeClientThumbnailFinalizeBodyV1(body.subarray(0, body.byteLength - 1))).toThrow(/byte size/i);
  });
});
