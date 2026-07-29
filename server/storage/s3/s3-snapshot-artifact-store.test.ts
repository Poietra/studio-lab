import { createHash } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
  MAX_SNAPSHOT_ARTIFACT_BYTES_V1,
  SnapshotArtifactReadErrorV1,
  type SnapshotArtifactReceiptV1,
} from "../snapshot-publication-repository";
import { S3SnapshotArtifactStoreV1 } from "./s3-snapshot-artifact-store";

const BUCKET = "poietra-private-snapshots";
const TENANT = "tenant-a";
const SOURCE = "a".repeat(64);
const RUNTIME = "b".repeat(64);
const PROFILE = "c".repeat(64);
const RUNTIME_DIGEST = "e".repeat(64);
const BYTES = new Uint8Array([0, 1, 2, 255]);
const RESULT = createHash("sha256").update(BYTES).digest("hex");
const KEY = `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME}/${PROFILE}/${RUNTIME_DIGEST}/${RESULT}`;

function body(bytes = BYTES) {
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield bytes.slice(0, 2);
      yield bytes.slice(2);
    },
  };
}

function testStore(send: (command: Readonly<{ input: Record<string, unknown> }>) => Promise<unknown>) {
  const mock = vi.fn(send);
  return {
    send: mock,
    store: new S3SnapshotArtifactStoreV1({
      bucket: BUCKET,
      client: { destroy() {}, send: mock } as unknown as S3Client,
      deployment: "test",
    }),
  };
}

function receipt(overrides: Partial<SnapshotArtifactReceiptV1> = {}): SnapshotArtifactReceiptV1 {
  return {
    byteSize: BYTES.byteLength,
    etag: '"etag-a"',
    objectKey: KEY,
    profileDigest: PROFILE,
    resultDigest: RESULT,
    runtimeConfigHash: RUNTIME,
    runtimeDigest: RUNTIME_DIGEST,
    sourceDigest: SOURCE,
    versionId: "version-a",
    ...overrides,
  };
}

describe("S3SnapshotArtifactStoreV1", () => {
  it("writes the exact immutable key and checksum, then verifies and reads the pinned version", async () => {
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        expect(command.input).toMatchObject({
          Bucket: BUCKET,
          ChecksumSHA256: Buffer.from(RESULT, "hex").toString("base64"),
          ContentLength: BYTES.byteLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Key: KEY,
        });
        expect(command.input.Body).toEqual(BYTES);
        return { ETag: '"etag-a"', VersionId: "version-a" };
      }
      expect(command.constructor.name).toBe("GetObjectCommand");
      expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY, VersionId: "version-a" });
      return {
        Body: body(),
        ContentLength: BYTES.byteLength,
        ETag: '"etag-a"',
        VersionId: "version-a",
      };
    });

    const stored = await store.put(TENANT, {
      bytes: BYTES,
      profileDigest: PROFILE,
      runtimeConfigHash: RUNTIME,
      runtimeDigest: RUNTIME_DIGEST,
      sourceDigest: SOURCE,
    });
    expect(stored).toEqual(receipt());
    expect(await store.read(TENANT, stored)).toEqual(BYTES);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("resolves an immutable-key conflict only after verifying the exact current version", async () => {
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        throw Object.assign(new Error("already exists"), { $metadata: { httpStatusCode: 412 } });
      }
      expect(command.constructor.name).toBe("GetObjectCommand");
      expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY });
      return {
        Body: body(),
        ContentLength: BYTES.byteLength,
        ETag: '"current-etag"',
        VersionId: "current-version",
      };
    });

    await expect(
      store.put(TENANT, {
        bytes: BYTES,
        profileDigest: PROFILE,
        runtimeConfigHash: RUNTIME,
        runtimeDigest: RUNTIME_DIGEST,
        sourceDigest: SOURCE,
      }),
    ).resolves.toEqual(receipt({ etag: '"current-etag"', versionId: "current-version" }));
    expect(send).toHaveBeenCalledTimes(2);

    const mismatched = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        throw Object.assign(new Error("already exists"), { name: "PreconditionFailed" });
      }
      return {
        Body: body(new Uint8Array([9, 9, 9, 9])),
        ContentLength: BYTES.byteLength,
        ETag: '"current-etag"',
        VersionId: "current-version",
      };
    }).store;
    await expect(
      mismatched.put(TENANT, {
        bytes: BYTES,
        profileDigest: PROFILE,
        runtimeConfigHash: RUNTIME,
        runtimeDigest: RUNTIME_DIGEST,
        sourceDigest: SOURCE,
      }),
    ).rejects.toMatchObject({ code: "corrupt", name: "SnapshotArtifactReadErrorV1" });
  });

  it("retries a bounded conditional-write conflict before verifying the uploaded version", async () => {
    let putAttempts = 0;
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        putAttempts += 1;
        if (putAttempts < 3) {
          throw Object.assign(new Error("conditional request conflict"), {
            $metadata: { httpStatusCode: 409 },
            name: "ConditionalRequestConflict",
          });
        }
        return { ETag: '"etag-a"', VersionId: "version-a" };
      }
      return {
        Body: body(),
        ContentLength: BYTES.byteLength,
        ETag: '"etag-a"',
        VersionId: "version-a",
      };
    });

    await expect(
      store.put(TENANT, {
        bytes: BYTES,
        profileDigest: PROFILE,
        runtimeConfigHash: RUNTIME,
        runtimeDigest: RUNTIME_DIGEST,
        sourceDigest: SOURCE,
      }),
    ).resolves.toEqual(receipt());
    expect(putAttempts).toBe(3);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("retries when an immutable-key conflict is deleted before its verification read", async () => {
    let putAttempts = 0;
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        putAttempts += 1;
        if (putAttempts === 1) {
          throw Object.assign(new Error("already exists"), { $metadata: { httpStatusCode: 412 } });
        }
        return { ETag: '"etag-a"', VersionId: "version-a" };
      }
      if (command.input.VersionId === undefined) {
        throw Object.assign(new Error("deleted before read"), { name: "NoSuchKey" });
      }
      return {
        Body: body(),
        ContentLength: BYTES.byteLength,
        ETag: '"etag-a"',
        VersionId: "version-a",
      };
    });

    await expect(
      store.put(TENANT, {
        bytes: BYTES,
        profileDigest: PROFILE,
        runtimeConfigHash: RUNTIME,
        runtimeDigest: RUNTIME_DIGEST,
        sourceDigest: SOURCE,
      }),
    ).resolves.toEqual(receipt());
    expect(putAttempts).toBe(2);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid identities and oversized or empty artifacts before contacting S3", async () => {
    const { send, store } = testStore(async () => {
      throw new Error("unexpected S3 request");
    });
    const valid = {
      bytes: BYTES,
      profileDigest: PROFILE,
      runtimeConfigHash: RUNTIME,
      runtimeDigest: RUNTIME_DIGEST,
      sourceDigest: SOURCE,
    };

    await expect(store.put("Tenant-A", valid)).rejects.toThrow(/tenant/i);
    await expect(store.put(TENANT, { ...valid, sourceDigest: "A".repeat(64) })).rejects.toThrow(/source digest/i);
    await expect(store.put(TENANT, { ...valid, runtimeConfigHash: "short" })).rejects.toThrow(/runtime-config/i);
    await expect(store.put(TENANT, { ...valid, runtimeDigest: "short" })).rejects.toThrow(/runtime digest/i);
    await expect(store.put(TENANT, { ...valid, runtimeDigest: LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 })).rejects.toThrow(
      /reserved legacy/i,
    );
    await expect(store.put(TENANT, { ...valid, profileDigest: `${PROFILE}0` })).rejects.toThrow(/profile digest/i);
    await expect(store.put(TENANT, { ...valid, bytes: new Uint8Array() })).rejects.toThrow(/between 1 byte/i);
    await expect(
      store.put(TENANT, { ...valid, bytes: new Uint8Array(MAX_SNAPSHOT_ARTIFACT_BYTES_V1 + 1) }),
    ).rejects.toThrow(/16 MiB/i);
    await expect(store.put(TENANT, { ...valid, bytes: "not-bytes" } as never)).rejects.toThrow(/input/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("lists bounded tenant versions with an opaque resumable cursor", async () => {
    const secondResult = "d".repeat(64);
    const secondKey = `tenants/${TENANT}/snapshots/${SOURCE}/${RUNTIME}/${PROFILE}/${secondResult}`;
    const cutoff = new Date("2026-07-28T00:00:00.000Z");
    const old = new Date("2026-07-27T00:00:00.000Z");
    const { send, store } = testStore(async (command) => {
      expect(command.constructor.name).toBe("ListObjectVersionsCommand");
      expect(command.input).toMatchObject({ Bucket: BUCKET, MaxKeys: 1, Prefix: `tenants/${TENANT}/snapshots/` });
      if (command.input.KeyMarker === undefined) {
        return {
          IsTruncated: true,
          NextKeyMarker: KEY,
          NextVersionIdMarker: "version-a",
          Versions: [{ ETag: '"etag-a"', Key: KEY, LastModified: old, Size: 4, VersionId: "version-a" }],
        };
      }
      expect(command.input).toMatchObject({ KeyMarker: KEY, VersionIdMarker: "version-a" });
      return {
        IsTruncated: false,
        Versions: [{ ETag: '"etag-b"', Key: secondKey, LastModified: old, Size: 7, VersionId: "version-b" }],
      };
    });

    const first = await store.listVersions(TENANT, cutoff, 1);
    expect(first.versions).toEqual([{ artifact: receipt(), lastModified: old }]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.nextCursor).not.toContain("tenants");

    send.mockClear();
    await expect(store.listVersions("tenant-b", cutoff, 1, first.nextCursor)).rejects.toThrow(/cursor is invalid/i);
    expect(send).not.toHaveBeenCalled();

    const second = await store.listVersions(TENANT, cutoff, 1, first.nextCursor);
    expect(second).toEqual({
      nextCursor: null,
      versions: [
        {
          artifact: {
            byteSize: 7,
            etag: '"etag-b"',
            objectKey: secondKey,
            profileDigest: PROFILE,
            resultDigest: secondResult,
            runtimeConfigHash: RUNTIME,
            runtimeDigest: LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1,
            sourceDigest: SOURCE,
            versionId: "version-b",
          },
          lastModified: old,
        },
      ],
    });
  });

  it("rejects a cycling S3 cursor within the bounded scan", async () => {
    let requests = 0;
    const { store } = testStore(async () => {
      requests += 1;
      return {
        DeleteMarkers: [{}],
        IsTruncated: true,
        NextKeyMarker: KEY,
        NextVersionIdMarker: "same-version",
        Versions: [],
      };
    });

    await expect(store.listVersions(TENANT, new Date(), 1)).rejects.toThrow(/cycling/i);
    expect(requests).toBe(2);
  });

  it("pins exact versions for reads and deletes and rejects cross-tenant receipts", async () => {
    const mismatchedBody = body();
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "GetObjectCommand") {
        return {
          Body: mismatchedBody,
          ContentLength: BYTES.byteLength,
          ETag: '"etag-a"',
          VersionId: "wrong-version",
        };
      }
      expect(command.constructor.name).toBe("DeleteObjectCommand");
      expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY, VersionId: "version-a" });
      return {};
    });

    await expect(store.read(TENANT, receipt())).rejects.toMatchObject({
      code: "corrupt",
      name: "SnapshotArtifactReadErrorV1",
    });
    expect(mismatchedBody.destroy).toHaveBeenCalledOnce();
    await store.deleteVersion(TENANT, receipt());
    expect(send).toHaveBeenCalledTimes(2);

    send.mockClear();
    await expect(store.read("tenant-b", receipt())).rejects.toThrow(/receipt is invalid/i);
    await expect(store.deleteVersion("tenant-b", receipt())).rejects.toThrow(/receipt is invalid/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("classifies missing versions without hiding transport failures", async () => {
    const missingErrors = [
      Object.assign(new Error("missing key"), { name: "NoSuchKey" }),
      Object.assign(new Error("missing version"), { Code: "NoSuchVersion" }),
      Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } }),
    ];
    for (const missing of missingErrors) {
      const { store } = testStore(async () => {
        throw missing;
      });
      await expect(store.read(TENANT, receipt())).rejects.toEqual(new SnapshotArtifactReadErrorV1("missing"));
    }

    const transportFailure = Object.assign(new Error("connection reset"), {
      $metadata: { httpStatusCode: 503 },
      name: "TimeoutError",
    });
    const transportStore = testStore(async () => {
      throw transportFailure;
    }).store;
    await expect(transportStore.read(TENANT, receipt())).rejects.toBe(transportFailure);

    const streamFailure = new Error("response stream reset");
    const streamStore = testStore(async () => ({
      Body: {
        destroy() {},
        async *[Symbol.asyncIterator]() {
          yield await Promise.reject(streamFailure);
        },
      },
      ContentLength: BYTES.byteLength,
      ETag: '"etag-a"',
      VersionId: "version-a",
    })).store;
    await expect(streamStore.read(TENANT, receipt())).rejects.toBe(streamFailure);
  });

  it("enforces production transport hardening", async () => {
    expect(
      () =>
        new S3SnapshotArtifactStoreV1({
          bucket: BUCKET,
          client: { destroy() {} } as S3Client,
          deployment: "development",
        } as never),
    ).toThrow(/deployment mode/i);
    const injected = new S3Client({ region: "us-east-1" });
    try {
      expect(
        () =>
          new S3SnapshotArtifactStoreV1({
            bucket: BUCKET,
            client: injected,
            deployment: "production",
          }),
      ).toThrow(/inspectable client configuration/i);
    } finally {
      injected.destroy();
    }
    const invalidConfigs = [
      { endpoint: "http://127.0.0.1:9000", ignoreConfiguredEndpointUrls: true },
      { ignoreConfiguredEndpointUrls: true, requestHandler: {} },
      { endpointProvider: async () => ({}), ignoreConfiguredEndpointUrls: true },
      { ignoreConfiguredEndpointUrls: true, tls: false },
      { forcePathStyle: true, ignoreConfiguredEndpointUrls: true },
      {},
    ];
    for (const config of invalidConfigs) {
      expect(
        () =>
          new S3SnapshotArtifactStoreV1({
            bucket: BUCKET,
            clientConfig: { region: "us-east-1", ...config } as never,
            deployment: "production",
          }),
      ).toThrow(/loopback tests|verified-HTTPS transport|path-style/i);
    }

    const valid = new S3SnapshotArtifactStoreV1({
      bucket: BUCKET,
      clientConfig: {
        endpoint: "https://snapshots.example.com",
        forcePathStyle: false,
        ignoreConfiguredEndpointUrls: true,
        region: "us-east-1",
      },
      deployment: "production",
    });
    await valid.close();
  });

  it("requires a private versioned bucket without an artifact-expiring lifecycle", async () => {
    const readiness = (versioning: string, lifecycle: unknown = null) =>
      testStore(async (command) => {
        switch (command.constructor.name) {
          case "HeadBucketCommand":
            return {};
          case "GetBucketVersioningCommand":
            return { Status: versioning };
          case "GetBucketAclCommand":
            return {
              Grants: [{ Grantee: { Type: "CanonicalUser" }, Permission: "FULL_CONTROL" }],
              Owner: { ID: "" },
            };
          case "GetBucketPolicyStatusCommand":
            return { PolicyStatus: { IsPublic: false } };
          case "GetBucketLifecycleConfigurationCommand":
            if (lifecycle === null) throw Object.assign(new Error("absent"), { name: "NoSuchLifecycleConfiguration" });
            return lifecycle;
          default:
            throw new Error("Unexpected readiness command.");
        }
      }).store.ready();

    await expect(readiness("Enabled")).resolves.toBe(true);
    await expect(readiness("Suspended")).resolves.toBe(false);
    await expect(readiness("Enabled", { Rules: [] })).resolves.toBe(false);
  });
});
