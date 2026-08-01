import { describe, expect, it } from "vitest";

import {
  type ImmutableRenderArtifactIdentityV1,
  type ImmutableRenderArtifactReceiptV1,
  immutableRenderArtifactContentAddressedKeyV1,
  immutableRenderArtifactMetadataMatchesV1,
  immutableRenderArtifactMetadataV1,
  immutableRenderArtifactObjectKeyV1,
  parseImmutableRenderArtifactIdentityV1,
  parseImmutableRenderArtifactObjectKeyV1,
  parseImmutableRenderArtifactReceiptV1,
  sameImmutableRenderArtifactReceiptV1,
} from "./immutable-render-artifact-storage";
import { MAX_RENDER_THUMBNAIL_BYTES_V1 } from "./render-artifact-repository";

const TENANT = "tenant-a";
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";

function identity(overrides: Partial<ImmutableRenderArtifactIdentityV1> = {}): ImmutableRenderArtifactIdentityV1 {
  return {
    artifactDigest: "a".repeat(64),
    byteSize: 42,
    kind: "video",
    mediaType: "video/mp4",
    profileDigest: "b".repeat(64),
    requestDigest: "c".repeat(64),
    runtimeDigest: "d".repeat(64),
    sourceDigest: "e".repeat(64),
    ...overrides,
  };
}

function receipt(overrides: Partial<ImmutableRenderArtifactReceiptV1> = {}): ImmutableRenderArtifactReceiptV1 {
  const artifact = identity();
  return {
    ...artifact,
    etag: '"opaque-etag"',
    objectGeneration: GENERATION,
    objectKey: immutableRenderArtifactObjectKeyV1(TENANT, artifact, GENERATION),
    ...overrides,
  };
}

describe("immutable render artifact storage contract", () => {
  it("binds a strict receipt to the exact application-owned generation key", () => {
    const artifact = identity();
    const baseKey = `tenants/${TENANT}/media/video/${artifact.sourceDigest}/${artifact.runtimeDigest}/${artifact.profileDigest}/${artifact.requestDigest}/${artifact.artifactDigest}`;
    const objectKey = `${baseKey}/g/${GENERATION}`;

    expect(immutableRenderArtifactContentAddressedKeyV1(TENANT, artifact)).toBe(baseKey);
    expect(immutableRenderArtifactObjectKeyV1(TENANT, artifact, GENERATION)).toBe(objectKey);
    expect(parseImmutableRenderArtifactReceiptV1(TENANT, receipt())).toEqual(receipt());
    expect(parseImmutableRenderArtifactObjectKeyV1(TENANT, objectKey)).toEqual({
      artifactDigest: artifact.artifactDigest,
      kind: artifact.kind,
      objectGeneration: GENERATION,
      objectKey,
      profileDigest: artifact.profileDigest,
      requestDigest: artifact.requestDigest,
      runtimeDigest: artifact.runtimeDigest,
      sourceDigest: artifact.sourceDigest,
    });
  });

  it("rejects provider version IDs, unknown fields, and locator mismatches", () => {
    expect(() =>
      parseImmutableRenderArtifactIdentityV1(TENANT, { ...identity(), versionId: "provider-version" }),
    ).toThrow(/identity/i);
    expect(() =>
      parseImmutableRenderArtifactReceiptV1(TENANT, { ...receipt(), versionId: "provider-version" }),
    ).toThrow(/receipt/i);
    expect(() =>
      parseImmutableRenderArtifactReceiptV1(TENANT, {
        ...receipt(),
        objectGeneration: "223e4567-e89b-42d3-a456-426614174000",
      }),
    ).toThrow(/locator/i);
    expect(() => parseImmutableRenderArtifactReceiptV1("tenant-b", receipt())).toThrow(/locator/i);
  });

  it("enforces digest, media type, size, ETag, and generation bounds", () => {
    expect(() => parseImmutableRenderArtifactIdentityV1(TENANT, identity({ artifactDigest: "z".repeat(64) }))).toThrow(
      /digest/i,
    );
    expect(() => parseImmutableRenderArtifactIdentityV1(TENANT, identity({ mediaType: "image/png" }))).toThrow(
      /identity/i,
    );
    expect(() =>
      parseImmutableRenderArtifactIdentityV1(
        TENANT,
        identity({ byteSize: MAX_RENDER_THUMBNAIL_BYTES_V1 + 1, kind: "thumbnail", mediaType: "image/png" }),
      ),
    ).toThrow(/identity/i);
    expect(() => parseImmutableRenderArtifactReceiptV1(TENANT, receipt({ etag: "bad\nvalue" }))).toThrow(/ETag/i);
    expect(() =>
      immutableRenderArtifactObjectKeyV1(TENANT, identity(), "123e4567-e89b-42d3-7456-426614174000"),
    ).toThrow(/generation/i);
  });

  it("uses an exact metadata binding and receipt equality", () => {
    const value = receipt();
    const metadata = immutableRenderArtifactMetadataV1(value);
    expect(metadata).toEqual({
      "artifact-digest": value.artifactDigest,
      "artifact-kind": value.kind,
      "object-generation": value.objectGeneration,
      "profile-digest": value.profileDigest,
      "request-digest": value.requestDigest,
      "runtime-digest": value.runtimeDigest,
      "source-digest": value.sourceDigest,
    });
    expect(immutableRenderArtifactMetadataMatchesV1(metadata, value)).toBe(true);
    expect(immutableRenderArtifactMetadataMatchesV1({ ...metadata, unexpected: "value" }, value)).toBe(false);
    expect(immutableRenderArtifactMetadataMatchesV1({ ...metadata, "artifact-kind": "thumbnail" }, value)).toBe(false);
    expect(sameImmutableRenderArtifactReceiptV1(value, { ...value })).toBe(true);
    expect(sameImmutableRenderArtifactReceiptV1(value, { ...value, etag: '"other"' })).toBe(false);
  });
});
