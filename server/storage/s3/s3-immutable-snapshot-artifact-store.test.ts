import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1,
  IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
  type ImmutableSnapshotArtifactReceiptV1,
  immutableSnapshotArtifactDeletionTargetV1,
  immutableSnapshotArtifactMetadataV1,
  immutableSnapshotArtifactObjectKeyV1,
} from "../immutable-snapshot-artifact-store";
import { S3ImmutableSnapshotArtifactStoreV1 } from "./s3-immutable-snapshot-artifact-store";

const BUCKET = "poietra-private-snapshots";
const TENANT = "tenant-a";
const SOURCE = "a".repeat(64);
const RUNTIME_CONFIG = "b".repeat(64);
const PROFILE = "c".repeat(64);
const RUNTIME_DIGEST = "d".repeat(64);
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const ETAG = '"opaque-etag"';
const BYTES = new Uint8Array([0, 1, 2, 255]);
const RESULT = createHash("sha256").update(BYTES).digest("hex");
const runtimeIdentity = {
  kind: "runtime-digest",
  profileDigest: PROFILE,
  resultDigest: RESULT,
  runtimeConfigHash: RUNTIME_CONFIG,
  runtimeDigest: RUNTIME_DIGEST,
  sourceDigest: SOURCE,
} as const;
const uploadIdentity = {
  kind: "runtime-digest",
  profileDigest: PROFILE,
  runtimeConfigHash: RUNTIME_CONFIG,
  runtimeDigest: RUNTIME_DIGEST,
  sourceDigest: SOURCE,
} as const;

type SentCommand = Readonly<{ input: Record<string, unknown> }>;

function body(bytes = BYTES) {
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield bytes.slice(0, 2);
      yield bytes.slice(2);
    },
  };
}

function testStore(send: (command: SentCommand, options?: Readonly<{ abortSignal?: AbortSignal }>) => unknown) {
  const mock = vi.fn(send);
  const store = new S3ImmutableSnapshotArtifactStoreV1({
    bucket: BUCKET,
    client: { destroy() {}, send: mock } as unknown as S3Client,
    deployment: "test",
  });
  onTestFinished(() => store.close());
  return { send: mock, store };
}

function storedReceipt(overrides: Partial<ImmutableSnapshotArtifactReceiptV1> = {}) {
  return {
    byteSize: BYTES.byteLength,
    etag: ETAG,
    identity: runtimeIdentity,
    objectGeneration: GENERATION,
    objectKey: immutableSnapshotArtifactObjectKeyV1(TENANT, runtimeIdentity, GENERATION),
    schema: IMMUTABLE_SNAPSHOT_ARTIFACT_RECEIPT_SCHEMA_V1,
    version: 1,
    ...overrides,
  } as ImmutableSnapshotArtifactReceiptV1;
}

function exactHeaders(receipt = storedReceipt()) {
  return {
    ContentLength: receipt.byteSize,
    ContentType: IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1,
    ETag: receipt.etag,
    Metadata: immutableSnapshotArtifactMetadataV1(TENANT, receipt.identity, receipt.objectGeneration),
  };
}

describe("S3ImmutableSnapshotArtifactStoreV1", () => {
  it("conditionally creates, HEAD-verifies, and digest-verifies a fresh generation without VersionId", async () => {
    let putInput: Record<string, unknown> | undefined;
    const { send, store } = testStore(async (command) => {
      expect(command.input).not.toHaveProperty("VersionId");
      if (command.constructor.name === "PutObjectCommand") {
        putInput = command.input;
        return { ETag: ETAG, VersionId: "must-not-escape" };
      }
      if (!putInput) throw new Error("PUT must happen first");
      const headers = {
        ContentLength: putInput.ContentLength,
        ContentType: putInput.ContentType,
        ETag: ETAG,
        Metadata: putInput.Metadata,
      };
      if (command.constructor.name === "HeadObjectCommand") return headers;
      if (command.constructor.name === "GetObjectCommand") return { ...headers, Body: body() };
      throw new Error(`Unexpected ${command.constructor.name}`);
    });

    const artifact = await store.put(TENANT, { bytes: BYTES, identity: uploadIdentity });

    expect(artifact.identity).toEqual(runtimeIdentity);
    expect(artifact.objectKey).toBe(
      `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RUNTIME_DIGEST}/${RESULT}/g/${artifact.objectGeneration}`,
    );
    expect(artifact).not.toHaveProperty("versionId");
    expect(putInput).toEqual({
      Body: BYTES,
      Bucket: BUCKET,
      ContentLength: BYTES.byteLength,
      ContentType: IMMUTABLE_SNAPSHOT_ARTIFACT_CONTENT_TYPE_V1,
      IfNoneMatch: "*",
      Key: artifact.objectKey,
      Metadata: immutableSnapshotArtifactMetadataV1(TENANT, runtimeIdentity, artifact.objectGeneration),
    });
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "PutObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
    ]);
    expect(send.mock.calls[1]?.[0].input).toEqual({ Bucket: BUCKET, IfMatch: ETAG, Key: artifact.objectKey });
    expect(send.mock.calls[2]?.[0].input).toEqual({ Bucket: BUCKET, IfMatch: ETAG, Key: artifact.objectKey });
  });

  it("uses a new application generation for each collision and stops after three attempts", async () => {
    const attemptedKeys: string[] = [];
    let createdInput: Record<string, unknown> | undefined;
    const { store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        attemptedKeys.push(command.input.Key as string);
        if (attemptedKeys.length < 3) {
          throw Object.assign(new Error("generation exists"), { name: "PreconditionFailed" });
        }
        createdInput = command.input;
        return { ETag: ETAG };
      }
      const headers = {
        ContentLength: createdInput?.ContentLength,
        ContentType: createdInput?.ContentType,
        ETag: ETAG,
        Metadata: createdInput?.Metadata,
      };
      return command.constructor.name === "GetObjectCommand" ? { ...headers, Body: body() } : headers;
    });

    const artifact = await store.put(TENANT, { bytes: BYTES, identity: uploadIdentity });
    expect(attemptedKeys).toHaveLength(3);
    expect(new Set(attemptedKeys)).toHaveLength(3);
    expect(artifact.objectKey).toBe(attemptedKeys[2]);

    const exhaustedKeys: string[] = [];
    const exhausted = testStore(async (command) => {
      exhaustedKeys.push(command.input.Key as string);
      throw Object.assign(new Error("generation exists"), { name: "PreconditionFailed" });
    }).store;
    await expect(exhausted.put(TENANT, { bytes: BYTES, identity: uploadIdentity })).rejects.toThrow(/collision bound/i);
    expect(exhaustedKeys).toHaveLength(3);
    expect(new Set(exhaustedKeys)).toHaveLength(3);
  });

  it("uploads a legacy identity without collapsing it into the runtime-digest key family", async () => {
    const legacyUpload = {
      kind: "legacy" as const,
      profileDigest: PROFILE,
      runtimeConfigHash: RUNTIME_CONFIG,
      sourceDigest: SOURCE,
    };
    let putInput: Record<string, unknown> | undefined;
    const { store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        putInput = command.input;
        return { ETag: ETAG };
      }
      const headers = {
        ContentLength: putInput?.ContentLength,
        ContentType: putInput?.ContentType,
        ETag: ETAG,
        Metadata: putInput?.Metadata,
      };
      return command.constructor.name === "GetObjectCommand" ? { ...headers, Body: body() } : headers;
    });

    const artifact = await store.put(TENANT, { bytes: BYTES, identity: legacyUpload });
    expect(artifact.identity.kind).toBe("legacy");
    expect(artifact.objectKey).toBe(
      `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME_CONFIG}/${PROFILE}/${RESULT}/g/${artifact.objectGeneration}`,
    );
    expect(putInput?.Metadata).toMatchObject({ "identity-kind": "legacy" });
    expect(putInput?.Metadata).not.toHaveProperty("runtime-digest");
  });

  it("pins public HEAD and read to ETag and verifies exact metadata and digest", async () => {
    const artifact = storedReceipt();
    const { send, store } = testStore(async (command) =>
      command.constructor.name === "GetObjectCommand"
        ? { ...exactHeaders(artifact), Body: body() }
        : exactHeaders(artifact),
    );

    await expect(store.head(TENANT, artifact)).resolves.toEqual(artifact);
    await expect(store.read(TENANT, artifact)).resolves.toEqual(BYTES);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: BUCKET, IfMatch: ETAG, Key: artifact.objectKey },
      { Bucket: BUCKET, IfMatch: ETAG, Key: artifact.objectKey },
    ]);
  });

  it("fails closed for metadata, media type, body digest, ETag precondition, and missing object mismatch", async () => {
    const artifact = storedReceipt();
    const wrongMetadataBody = body();
    const wrongMetadata = testStore(async () => ({
      ...exactHeaders(artifact),
      Body: wrongMetadataBody,
      Metadata: { ...exactHeaders(artifact).Metadata, "tenant-id": "tenant-b" },
    })).store;
    await expect(wrongMetadata.read(TENANT, artifact)).rejects.toMatchObject({ code: "corrupt" });
    expect(wrongMetadataBody.destroy).toHaveBeenCalledOnce();

    const wrongType = testStore(async () => ({
      ...exactHeaders(artifact),
      Body: body(),
      ContentType: "application/json",
    })).store;
    await expect(wrongType.read(TENANT, artifact)).rejects.toMatchObject({ code: "corrupt" });

    const wrongDigest = testStore(async () => ({
      ...exactHeaders(artifact),
      Body: body(new Uint8Array([9, 9, 9, 9])),
    })).store;
    await expect(wrongDigest.read(TENANT, artifact)).rejects.toMatchObject({ code: "corrupt" });

    const wrongSizeBody = body();
    const wrongSize = testStore(async () => ({
      ...exactHeaders(artifact),
      Body: wrongSizeBody,
      ContentLength: artifact.byteSize + 1,
    })).store;
    await expect(wrongSize.read(TENANT, artifact)).rejects.toThrow(/immutable read contract/i);
    expect(wrongSizeBody.destroy).toHaveBeenCalledOnce();

    const wrongEtagBody = body();
    const wrongEtag = testStore(async () => ({
      ...exactHeaders(artifact),
      Body: wrongEtagBody,
      ETag: '"different"',
    })).store;
    await expect(wrongEtag.read(TENANT, artifact)).rejects.toThrow(/immutable read contract/i);
    expect(wrongEtagBody.destroy).toHaveBeenCalledOnce();

    const staleEtag = testStore(async () => {
      throw Object.assign(new Error("stale ETag"), { $metadata: { httpStatusCode: 412 } });
    }).store;
    await expect(staleEtag.head(TENANT, artifact)).rejects.toMatchObject({ code: "corrupt" });

    const missing = testStore(async () => {
      throw Object.assign(new Error("gone"), { name: "NoSuchKey" });
    }).store;
    await expect(missing.read(TENANT, artifact)).rejects.toMatchObject({ code: "missing" });
  });

  it("lists a bounded tenant-family orphan page with a tenant-bound opaque cursor", async () => {
    const legacyIdentity = {
      kind: "legacy" as const,
      profileDigest: PROFILE,
      resultDigest: RESULT,
      runtimeConfigHash: RUNTIME_CONFIG,
      sourceDigest: SOURCE,
    };
    const legacyKey = immutableSnapshotArtifactObjectKeyV1(TENANT, legacyIdentity, GENERATION);
    const runtimeKey = storedReceipt().objectKey;
    const old = new Date("2026-07-01T00:00:00.000Z");
    const recent = new Date("2026-08-01T00:00:00.000Z");
    const providerCursor = "opaque+/provider==";
    const { send, store } = testStore(async (command) => {
      if (command.input.ContinuationToken === undefined) {
        return {
          Contents: [
            { ETag: ETAG, Key: legacyKey, LastModified: old, Size: 4 },
            { ETag: ETAG, Key: runtimeKey, LastModified: recent, Size: 4 },
          ],
          IsTruncated: true,
          KeyCount: 2,
          NextContinuationToken: providerCursor,
        };
      }
      expect(command.input.ContinuationToken).toBe(providerCursor);
      return { Contents: [], IsTruncated: false, KeyCount: 0 };
    });

    const first = await store.listOrphanCandidates(TENANT, recent, 2);
    expect(send.mock.calls[0]?.[0].constructor.name).toBe("ListObjectsV2Command");
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: BUCKET,
      MaxKeys: 2,
      Prefix: `tenants/${TENANT}/snapshots/`,
    });
    expect(first.candidates).toEqual([
      {
        artifact: expect.objectContaining({
          byteSize: 4,
          etag: ETAG,
          objectGeneration: GENERATION,
          objectKey: legacyKey,
        }),
        lastModified: old,
      },
    ]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.nextCursor).not.toContain(providerCursor);

    send.mockClear();
    await expect(store.listOrphanCandidates("tenant-b", recent, 2, first.nextCursor)).rejects.toThrow(/cursor/i);
    expect(send).not.toHaveBeenCalled();

    await expect(store.listOrphanCandidates(TENANT, recent, 2, first.nextCursor)).resolves.toEqual({
      candidates: [],
      nextCursor: null,
    });
  });

  it("deletes only the exact generation target and keeps provider success as the acknowledgment boundary", async () => {
    const artifact = storedReceipt();
    const target = immutableSnapshotArtifactDeletionTargetV1(TENANT, artifact);
    const { send, store } = testStore(async () => ({}));

    await store.deleteTarget(TENANT, target);
    await store.deleteTarget(TENANT, target);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: BUCKET, Key: artifact.objectKey },
      { Bucket: BUCKET, Key: artifact.objectKey },
    ]);
    expect(send.mock.calls.every(([command]) => !("VersionId" in command.input))).toBe(true);
    await expect(store.deleteTarget("tenant-b", target)).rejects.toThrow(/deletion target/i);

    const unavailable = testStore(async () => {
      throw Object.assign(new Error("bucket unavailable"), { name: "NoSuchBucket" });
    }).store;
    await expect(unavailable.deleteTarget(TENANT, target)).rejects.toThrow(/bucket unavailable/i);
  });

  it("rejects invalid upload, receipt, list, and cursor inputs before contacting S3", async () => {
    const { send, store } = testStore(async () => {
      throw new Error("Unexpected provider request");
    });
    await expect(store.put("Tenant-A", { bytes: BYTES, identity: uploadIdentity })).rejects.toThrow(/tenant/i);
    await expect(store.put(TENANT, { bytes: new Uint8Array(), identity: uploadIdentity })).rejects.toThrow(/1 byte/i);
    await expect(
      store.put(TENANT, { bytes: BYTES, identity: { ...uploadIdentity, resultDigest: RESULT } as never }),
    ).rejects.toThrow(/upload identity/i);
    await expect(store.head("tenant-b", storedReceipt())).rejects.toThrow(/locator/i);
    await expect(store.listOrphanCandidates(TENANT, new Date(Number.NaN), 1)).rejects.toThrow(/cutoff/i);
    await expect(store.listOrphanCandidates(TENANT, new Date(), 257)).rejects.toThrow(/maximum/i);
    await expect(store.listOrphanCandidates(TENANT, new Date(), 1, "not+base64")).rejects.toThrow(/cursor/i);
    expect(send).not.toHaveBeenCalled();
  });
});
