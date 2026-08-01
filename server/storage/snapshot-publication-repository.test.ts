import { describe, expect, it } from "vitest";

import type { ImmutableSnapshotArtifactReceiptV1 } from "./immutable-snapshot-artifact-store";
import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  parseSnapshotArtifactReceiptV1,
  sameSnapshotArtifactContentV1,
  sameSnapshotArtifactReceiptV1,
  snapshotArtifactObjectKeyV1,
  type VersionedSnapshotArtifactReceiptV1,
} from "./snapshot-publication-repository";

const TENANT = "tenant-a";
const SOURCE = "1".repeat(64);
const RUNTIME = "2".repeat(64);
const PROFILE = "3".repeat(64);
const RESULT = "4".repeat(64);
const RUNTIME_DIGEST = "5".repeat(64);
const GENERATION = "00000000-0000-4000-8000-000000000001";

function receipt(overrides: Partial<VersionedSnapshotArtifactReceiptV1> = {}): VersionedSnapshotArtifactReceiptV1 {
  return {
    byteSize: 42,
    etag: '"etag-a"',
    objectKey: `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME}/${PROFILE}/${RUNTIME_DIGEST}/${RESULT}`,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash: RUNTIME,
    runtimeDigest: RUNTIME_DIGEST,
    sourceDigest: SOURCE,
    versionId: "version-a",
    ...overrides,
  };
}

function immutableReceipt(): ImmutableSnapshotArtifactReceiptV1 {
  return {
    byteSize: 42,
    etag: '"etag-a"',
    identity: {
      kind: "runtime-digest",
      profileDigest: PROFILE,
      resultDigest: RESULT,
      runtimeConfigHash: RUNTIME,
      runtimeDigest: RUNTIME_DIGEST,
      sourceDigest: SOURCE,
    },
    objectGeneration: GENERATION,
    objectKey: `${receipt().objectKey}/g/${GENERATION}`,
    schema: "poietra.immutable-snapshot-artifact-receipt",
    version: 1,
  };
}

describe("snapshot artifact receipt helpers", () => {
  it("builds the tenant-bound key and returns only validated receipt fields", () => {
    expect(snapshotArtifactObjectKeyV1(TENANT, receipt())).toBe(receipt().objectKey);
    expect(parseSnapshotArtifactReceiptV1(TENANT, { ...receipt(), ignored: true })).toEqual(receipt());
    expect(() => snapshotArtifactObjectKeyV1("../tenant", receipt())).toThrow(/tenant id/i);
    const legacy = receipt({
      objectKey: `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME}/${PROFILE}/${RESULT}`,
      runtimeDigest: LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
    });
    expect(parseSnapshotArtifactReceiptV1(TENANT, legacy)).toEqual(legacy);
  });

  it.each([
    ["object key", { objectKey: receipt().objectKey.replace(TENANT, "tenant-b") }],
    ["empty body", { byteSize: 0 }],
    ["oversized body", { byteSize: MAX_SNAPSHOT_ARTIFACT_BYTES_V1 + 1 }],
    ["empty ETag", { etag: "" }],
    ["oversized ETag", { etag: "e".repeat(513) }],
    ["empty version", { versionId: "" }],
    ["oversized version", { versionId: "v".repeat(1_025) }],
    ["source digest", { sourceDigest: "A".repeat(64) }],
    ["runtime digest", { runtimeConfigHash: "2".repeat(63) }],
    ["sandbox runtime digest", { runtimeDigest: "5".repeat(63) }],
    ["profile digest", { profileDigest: "3".repeat(65) }],
    ["result digest", { resultDigest: "not-a-digest" }],
  ])("rejects an invalid %s", (_name, override) => {
    expect(() => parseSnapshotArtifactReceiptV1(TENANT, receipt(override))).toThrow();
  });

  it("compares every exact receipt field", () => {
    const original = receipt();
    expect(sameSnapshotArtifactReceiptV1(original, receipt())).toBe(true);
    for (const field of Object.keys(original) as (keyof VersionedSnapshotArtifactReceiptV1)[]) {
      const value = original[field];
      const changed = typeof value === "number" ? value + 1 : `${value}-different`;
      expect(sameSnapshotArtifactReceiptV1(original, receipt({ [field]: changed }))).toBe(false);
    }
  });

  it("parses immutable receipts as a distinct locator mode and rejects mixed locators", () => {
    const immutable = immutableReceipt();
    expect(parseSnapshotArtifactReceiptV1(TENANT, immutable)).toEqual(immutable);
    expect(sameSnapshotArtifactReceiptV1(immutable, immutableReceipt())).toBe(true);
    expect(sameSnapshotArtifactReceiptV1(receipt(), immutable)).toBe(false);
    expect(sameSnapshotArtifactContentV1(receipt(), immutable)).toBe(true);
    expect(() => parseSnapshotArtifactReceiptV1(TENANT, { ...immutable, versionId: "mixed" })).toThrow(/ambiguous/i);
    const { versionId: _versionId, ...withoutLocator } = receipt();
    expect(() => parseSnapshotArtifactReceiptV1(TENANT, withoutLocator)).toThrow(/ambiguous/i);
  });
});
