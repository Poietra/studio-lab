import { describe, expect, it } from "vitest";

import {
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  parseSnapshotArtifactReceiptV1,
  sameSnapshotArtifactReceiptV1,
  snapshotArtifactObjectKeyV1,
  type SnapshotArtifactReceiptV1,
} from "./snapshot-publication-repository";

const TENANT = "tenant-a";
const SOURCE = "1".repeat(64);
const RUNTIME = "2".repeat(64);
const PROFILE = "3".repeat(64);
const RESULT = "4".repeat(64);

function receipt(overrides: Partial<SnapshotArtifactReceiptV1> = {}): SnapshotArtifactReceiptV1 {
  return {
    byteSize: 42,
    etag: '"etag-a"',
    objectKey: `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME}/${PROFILE}/${RESULT}`,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash: RUNTIME,
    sourceDigest: SOURCE,
    versionId: "version-a",
    ...overrides,
  };
}

describe("snapshot artifact receipt helpers", () => {
  it("builds the tenant-bound key and returns only validated receipt fields", () => {
    expect(snapshotArtifactObjectKeyV1(TENANT, receipt())).toBe(receipt().objectKey);
    expect(parseSnapshotArtifactReceiptV1(TENANT, { ...receipt(), ignored: true })).toEqual(receipt());
    expect(() => snapshotArtifactObjectKeyV1("../tenant", receipt())).toThrow(/tenant id/i);
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
    ["profile digest", { profileDigest: "3".repeat(65) }],
    ["result digest", { resultDigest: "not-a-digest" }],
  ])("rejects an invalid %s", (_name, override) => {
    expect(() => parseSnapshotArtifactReceiptV1(TENANT, receipt(override))).toThrow();
  });

  it("compares every exact receipt field", () => {
    const original = receipt();
    expect(sameSnapshotArtifactReceiptV1(original, receipt())).toBe(true);
    for (const field of Object.keys(original) as (keyof SnapshotArtifactReceiptV1)[]) {
      const value = original[field];
      const changed = typeof value === "number" ? value + 1 : `${value}-different`;
      expect(sameSnapshotArtifactReceiptV1(original, receipt({ [field]: changed }))).toBe(false);
    }
  });
});
