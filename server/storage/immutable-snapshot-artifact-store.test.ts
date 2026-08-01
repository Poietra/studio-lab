import { describe, expect, it } from "vitest";

import {
  completeImmutableSnapshotArtifactIdentityV1,
  IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1,
  IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
  immutableSnapshotArtifactDeletionTargetV1,
  immutableSnapshotArtifactMetadataV1,
  immutableSnapshotArtifactObjectKeyV1,
  parseImmutableSnapshotArtifactDeletionTargetV1,
  parseImmutableSnapshotArtifactIdentityV1,
  parseImmutableSnapshotArtifactObjectKeyV1,
  parseImmutableSnapshotArtifactReceiptV1,
} from "./immutable-snapshot-artifact-store";

const TENANT = "tenant-a";
const SOURCE = "a".repeat(64);
const RUNTIME_CONFIG = "b".repeat(64);
const PROFILE = "c".repeat(64);
const RUNTIME_DIGEST = "d".repeat(64);
const RESULT = "e".repeat(64);
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";

const legacyIdentity = {
  kind: "legacy",
  profileDigest: PROFILE,
  resultDigest: RESULT,
  runtimeConfigHash: RUNTIME_CONFIG,
  sourceDigest: SOURCE,
} as const;

const runtimeIdentity = {
  ...legacyIdentity,
  kind: "runtime-digest",
  runtimeDigest: RUNTIME_DIGEST,
} as const;

function receipt(identity = runtimeIdentity) {
  return {
    byteSize: 4,
    etag: '"etag-a"',
    identity,
    objectGeneration: GENERATION,
    objectKey: immutableSnapshotArtifactObjectKeyV1(TENANT, identity, GENERATION),
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    version: 1,
  } as const;
}

describe("immutable snapshot artifact contract", () => {
  it("keeps legacy and runtime-digest identities structurally and physically distinct", () => {
    const legacyKey = immutableSnapshotArtifactObjectKeyV1(TENANT, legacyIdentity, GENERATION);
    const runtimeKey = immutableSnapshotArtifactObjectKeyV1(TENANT, runtimeIdentity, GENERATION);

    expect(legacyKey).toBe(
      `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RESULT}/g/${GENERATION}`,
    );
    expect(runtimeKey).toBe(
      `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RUNTIME_DIGEST}/${RESULT}/g/${GENERATION}`,
    );
    expect(runtimeKey).not.toBe(legacyKey);
    expect(parseImmutableSnapshotArtifactObjectKeyV1(TENANT, legacyKey)).toEqual({
      identity: legacyIdentity,
      objectGeneration: GENERATION,
      objectKey: legacyKey,
    });
    expect(parseImmutableSnapshotArtifactObjectKeyV1(TENANT, runtimeKey)).toEqual({
      identity: runtimeIdentity,
      objectGeneration: GENERATION,
      objectKey: runtimeKey,
    });
  });

  it("rejects ambiguous, non-canonical, or reserved runtime identities", () => {
    expect(() =>
      parseImmutableSnapshotArtifactIdentityV1({ ...legacyIdentity, runtimeDigest: RUNTIME_DIGEST }),
    ).toThrow(/legacy snapshot identity/i);
    expect(() => parseImmutableSnapshotArtifactIdentityV1({ ...runtimeIdentity, kind: "legacy" })).toThrow(
      /legacy snapshot identity/i,
    );
    expect(() =>
      parseImmutableSnapshotArtifactIdentityV1({ ...runtimeIdentity, runtimeDigest: "0".repeat(64) }),
    ).toThrow(/reserved legacy/i);
    expect(() => parseImmutableSnapshotArtifactObjectKeyV1("tenant-b", receipt().objectKey)).toThrow(/object key/i);
    expect(() => parseImmutableSnapshotArtifactObjectKeyV1(TENANT, `${receipt().objectKey}/extra`)).toThrow(
      /object key/i,
    );
  });

  it("completes upload identities only with the verified result digest", () => {
    expect(
      completeImmutableSnapshotArtifactIdentityV1(
        {
          kind: "runtime-digest",
          profileDigest: PROFILE,
          runtimeConfigHash: RUNTIME_CONFIG,
          runtimeDigest: RUNTIME_DIGEST,
          sourceDigest: SOURCE,
        },
        RESULT,
      ),
    ).toEqual(runtimeIdentity);
    expect(() =>
      completeImmutableSnapshotArtifactIdentityV1(
        {
          kind: "legacy",
          profileDigest: PROFILE,
          resultDigest: RESULT,
          runtimeConfigHash: RUNTIME_CONFIG,
          sourceDigest: SOURCE,
        },
        RESULT,
      ),
    ).toThrow(/upload identity/i);
  });

  it("parses a strict receipt and rejects tenant, generation, key, digest, and extra-field mismatch", () => {
    const value = receipt();
    expect(parseImmutableSnapshotArtifactReceiptV1(TENANT, value)).toEqual(value);
    expect(() => parseImmutableSnapshotArtifactReceiptV1("tenant-b", value)).toThrow(/locator|key/i);
    expect(() =>
      parseImmutableSnapshotArtifactReceiptV1(TENANT, { ...value, objectGeneration: GENERATION.replace(/0$/, "1") }),
    ).toThrow(/locator/i);
    expect(() =>
      parseImmutableSnapshotArtifactReceiptV1(TENANT, {
        ...value,
        identity: { ...value.identity, resultDigest: "f".repeat(64) },
      }),
    ).toThrow(/locator/i);
    expect(() => parseImmutableSnapshotArtifactReceiptV1(TENANT, { ...value, versionId: "forbidden" })).toThrow(
      /receipt/i,
    );
    expect(() => parseImmutableSnapshotArtifactReceiptV1(TENANT, { ...value, byteSize: 0 })).toThrow(/byte size/i);
  });

  it("derives a strict provider-neutral deletion target from the exact receipt", () => {
    const target = immutableSnapshotArtifactDeletionTargetV1(TENANT, receipt());
    expect(target).toEqual({
      identity: runtimeIdentity,
      objectGeneration: GENERATION,
      objectKey: receipt().objectKey,
      schema: IMMUTABLE_SNAPSHOT_ARTIFACT_DELETION_SCHEMA_V1,
      tenantId: TENANT,
      version: 1,
    });
    expect(target).not.toHaveProperty("etag");
    expect(target).not.toHaveProperty("versionId");
    expect(parseImmutableSnapshotArtifactDeletionTargetV1(TENANT, target)).toEqual(target);
    expect(() => parseImmutableSnapshotArtifactDeletionTargetV1("tenant-b", target)).toThrow(/deletion target/i);
    expect(() =>
      parseImmutableSnapshotArtifactDeletionTargetV1(TENANT, {
        ...target,
        objectGeneration: GENERATION.replace(/0$/, "1"),
      }),
    ).toThrow(/deletion target/i);
    expect(() => parseImmutableSnapshotArtifactDeletionTargetV1(TENANT, { ...target, etag: '"etag"' })).toThrow(
      /deletion target/i,
    );
  });

  it("binds exact object metadata to tenant, identity, and generation", () => {
    expect(immutableSnapshotArtifactMetadataV1(TENANT, legacyIdentity, GENERATION)).toEqual({
      "artifact-schema": IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
      "identity-kind": "legacy",
      "object-generation": GENERATION,
      "profile-digest": PROFILE,
      "result-digest": RESULT,
      "runtime-config-hash": RUNTIME_CONFIG,
      "source-digest": SOURCE,
      "tenant-id": TENANT,
    });
    expect(immutableSnapshotArtifactMetadataV1(TENANT, runtimeIdentity, GENERATION)).toMatchObject({
      "identity-kind": "runtime-digest",
      "runtime-digest": RUNTIME_DIGEST,
    });
  });
});
