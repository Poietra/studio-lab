import { createHash } from "node:crypto";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  type ImmutableRenderArtifactIdentityV1,
  type ImmutableRenderArtifactReceiptV1,
  immutableRenderArtifactMetadataV1,
  immutableRenderArtifactObjectKeyV1,
} from "../immutable-render-artifact-storage";
import { S3ImmutableRenderArtifactStoreV1 } from "./s3-immutable-render-artifact-store";

const BUCKET = "poietra-private-media";
const TENANT = "tenant-a";
const ETAG = '"opaque-etag"';
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_GENERATION = "223e4567-e89b-42d3-a456-426614174000";
const BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6]);

type SentCommand = Readonly<{ input: Record<string, unknown> }>;

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function identity(overrides: Partial<ImmutableRenderArtifactIdentityV1> = {}): ImmutableRenderArtifactIdentityV1 {
  return {
    artifactDigest: digest(BYTES),
    byteSize: BYTES.byteLength,
    kind: "video",
    mediaType: "video/mp4",
    profileDigest: "b".repeat(64),
    requestDigest: "c".repeat(64),
    runtimeDigest: "d".repeat(64),
    sourceDigest: "e".repeat(64),
    ...overrides,
  };
}

function receipt(
  overrides: Partial<ImmutableRenderArtifactReceiptV1> = {},
  generation = GENERATION,
): ImmutableRenderArtifactReceiptV1 {
  const artifact = identity();
  return {
    ...artifact,
    etag: ETAG,
    objectGeneration: generation,
    objectKey: immutableRenderArtifactObjectKeyV1(TENANT, artifact, generation),
    ...overrides,
  };
}

function body(bytes = BYTES) {
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      const split = Math.max(1, Math.floor(bytes.byteLength / 2));
      yield bytes.subarray(0, split);
      yield bytes.subarray(split);
    },
  };
}

async function collect(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    byteSize += chunk.byteLength;
  }
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function testStore(
  implementation: (command: SentCommand, options?: Readonly<{ abortSignal?: AbortSignal }>) => unknown,
) {
  const send = vi.fn(implementation);
  return {
    send,
    store: new S3ImmutableRenderArtifactStoreV1({
      bucket: BUCKET,
      client: { destroy() {}, send } as unknown as S3Client,
      deployment: "test",
    }),
  };
}

function completeResponse(value: ImmutableRenderArtifactReceiptV1, responseBody = body()) {
  return {
    Body: responseBody,
    ContentLength: value.byteSize,
    ContentType: value.mediaType,
    ETag: value.etag,
    Metadata: immutableRenderArtifactMetadataV1(value),
  };
}

describe("S3ImmutableRenderArtifactStoreV1", () => {
  it("allocates a new generation after every collision and never reads a collided key", async () => {
    const putInputs: Record<string, unknown>[] = [];
    let createdInput: Record<string, unknown> | undefined;
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        putInputs.push(command.input);
        if (putInputs.length < 3) throw Object.assign(new Error("collision"), { name: "PreconditionFailed" });
        createdInput = command.input;
        return { ETag: ETAG, VersionId: "must-not-escape" };
      }
      expect(command.constructor.name).toBe("GetObjectCommand");
      expect(command.input.Key).toBe(createdInput?.Key);
      return {
        Body: body(),
        ContentLength: BYTES.byteLength,
        ContentType: "video/mp4",
        ETag: ETAG,
        Metadata: createdInput?.Metadata,
        VersionId: "must-not-escape",
      };
    });

    const value = await store.put(TENANT, { ...identity(), bytes: BYTES });
    const attemptedKeys = putInputs.map((input) => input.Key);

    expect(new Set(attemptedKeys).size).toBe(3);
    expect(attemptedKeys.every((key) => typeof key === "string" && /\/g\/[0-9a-f-]{36}$/u.test(key))).toBe(true);
    expect(value.objectKey).toBe(attemptedKeys[2]);
    expect(value.objectGeneration).toBe(String(attemptedKeys[2]).split("/").at(-1));
    expect(value).not.toHaveProperty("versionId");
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "PutObjectCommand",
      "PutObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand",
    ]);
    for (const [command] of send.mock.calls) expect(command.input).not.toHaveProperty("VersionId");
  });

  it("stops after three generation collisions without reading any colliding object", async () => {
    const { send, store } = testStore(async () => {
      throw Object.assign(new Error("collision"), { name: "PreconditionFailed" });
    });

    await expect(store.put(TENANT, { ...identity(), bytes: BYTES })).rejects.toThrow(/three attempts/i);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "PutObjectCommand",
      "PutObjectCommand",
      "PutObjectCommand",
    ]);
    expect(new Set(send.mock.calls.map(([command]) => command.input.Key)).size).toBe(3);
  });

  it("uses the same immutable lane for bounded PNG thumbnails", async () => {
    const thumbnail = identity({ kind: "thumbnail", mediaType: "image/png" });
    let putInput: Record<string, unknown> | undefined;
    const { store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        putInput = command.input;
        return { ETag: ETAG };
      }
      return {
        Body: body(),
        ContentLength: thumbnail.byteSize,
        ContentType: thumbnail.mediaType,
        ETag: ETAG,
        Metadata: putInput?.Metadata,
      };
    });

    const value = await store.put(TENANT, { ...thumbnail, bytes: BYTES });

    expect(value.kind).toBe("thumbnail");
    expect(value.objectKey).toContain(`/media/thumbnail/`);
    expect(putInput).toMatchObject({ ContentType: "image/png", IfNoneMatch: "*", Key: value.objectKey });
  });

  it("pins HEAD, full GET, and Range GET to the receipt ETag and immutable key", async () => {
    const value = receipt();
    const bodies = [body(), body(BYTES.subarray(2, 5))];
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "HeadObjectCommand") {
        const { Body: _, ...head } = completeResponse(value);
        return head;
      }
      const responseBody = bodies.shift();
      if (command.input.Range === undefined) return completeResponse(value, responseBody);
      return {
        ...completeResponse(value, responseBody),
        ContentLength: 3,
        ContentRange: `bytes 2-4/${value.byteSize}`,
      };
    });

    await expect(store.head(TENANT, value)).resolves.toBeUndefined();
    await expect(collect(await store.open(TENANT, value, null))).resolves.toEqual(BYTES);
    await expect(collect(await store.open(TENANT, value, { end: 4, start: 2 }))).resolves.toEqual(BYTES.subarray(2, 5));
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: BUCKET, IfMatch: ETAG, Key: value.objectKey },
      { Bucket: BUCKET, IfMatch: ETAG, Key: value.objectKey },
      { Bucket: BUCKET, IfMatch: ETAG, Key: value.objectKey, Range: "bytes=2-4" },
    ]);
  });

  it("fails closed and destroys bodies on digest, size, media type, and metadata mismatches", async () => {
    const value = receipt();
    const corruptBody = body(Uint8Array.from([6, 5, 4, 3, 2, 1]));
    const corrupt = testStore(async () => completeResponse(value, corruptBody)).store;
    await expect(collect(await corrupt.open(TENANT, value, null))).rejects.toMatchObject({ code: "corrupt" });
    expect(corruptBody.destroy).toHaveBeenCalledOnce();

    const oversizedBody = body(Uint8Array.from([...BYTES, 7]));
    const oversized = testStore(async () => completeResponse(value, oversizedBody)).store;
    await expect(collect(await oversized.open(TENANT, value, null))).rejects.toMatchObject({ code: "corrupt" });
    expect(oversizedBody.destroy).toHaveBeenCalledOnce();

    const metadataBody = body();
    const wrongMetadata = testStore(async () => ({
      ...completeResponse(value, metadataBody),
      Metadata: { ...immutableRenderArtifactMetadataV1(value), unexpected: "value" },
    })).store;
    await expect(wrongMetadata.open(TENANT, value, null)).rejects.toMatchObject({ code: "corrupt" });
    expect(metadataBody.destroy).toHaveBeenCalledOnce();

    const mediaBody = body();
    const wrongMedia = testStore(async () => ({
      ...completeResponse(value, mediaBody),
      ContentType: "image/png",
    })).store;
    await expect(wrongMedia.open(TENANT, value, null)).rejects.toMatchObject({ code: "corrupt" });
    expect(mediaBody.destroy).toHaveBeenCalledOnce();
  });

  it("maps missing and conditional read failures without hiding provider outages", async () => {
    const value = receipt();
    const errors = [
      Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } }),
      Object.assign(new Error("changed"), { name: "PreconditionFailed" }),
      new Error("provider unavailable"),
    ];
    const { store } = testStore(async () => {
      throw errors.shift();
    });

    await expect(store.head(TENANT, value)).rejects.toMatchObject({ code: "missing" });
    await expect(store.head(TENANT, value)).rejects.toMatchObject({ code: "corrupt" });
    await expect(store.head(TENANT, value)).rejects.toThrow("provider unavailable");
  });

  it("lists a bounded orphan page and deletes only the exact generation key", async () => {
    const old = new Date("2026-07-30T00:00:00.000Z");
    const fresh = new Date("2026-08-01T00:00:00.000Z");
    const cutoff = new Date("2026-07-31T00:00:00.000Z");
    const oldReceipt = receipt();
    const freshReceipt = receipt({}, OTHER_GENERATION);
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: [
            {
              ETag: oldReceipt.etag,
              Key: oldReceipt.objectKey,
              LastModified: old,
              Size: oldReceipt.byteSize,
            },
            {
              ETag: freshReceipt.etag,
              Key: freshReceipt.objectKey,
              LastModified: fresh,
              Size: freshReceipt.byteSize,
            },
          ],
          IsTruncated: true,
          KeyCount: 2,
          NextContinuationToken: "opaque-next-cursor",
        };
      }
      expect(command.constructor.name).toBe("DeleteObjectCommand");
      return {};
    });

    await expect(store.listObjects(TENANT, cutoff, 2, "opaque-current-cursor")).resolves.toEqual({
      nextCursor: "opaque-next-cursor",
      objects: [{ lastModified: old, receipt: oldReceipt }],
    });
    await store.deleteObject(TENANT, oldReceipt);

    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: BUCKET,
      ContinuationToken: "opaque-current-cursor",
      MaxKeys: 2,
      Prefix: `tenants/${TENANT}/media/`,
    });
    expect(send.mock.calls[1]?.[0].input).toEqual({ Bucket: BUCKET, Key: oldReceipt.objectKey });
    expect(send.mock.calls[1]?.[0].input).not.toHaveProperty("VersionId");
  });

  it("rejects invalid identities, tenants, receipts, ranges, and list bounds before S3 I/O", async () => {
    const { send, store } = testStore(async () => {
      throw new Error("S3 must not be contacted");
    });
    const value = receipt();

    await expect(store.put(TENANT, { ...identity({ artifactDigest: "a".repeat(64) }), bytes: BYTES })).rejects.toThrow(
      /digest/i,
    );
    await expect(store.head("tenant-b", value)).rejects.toThrow(/locator/i);
    await expect(store.open(TENANT, value, { end: value.byteSize, start: 0 })).rejects.toThrow(/range/i);
    await expect(store.listObjects(TENANT, new Date(Number.NaN), 1)).rejects.toThrow(/cutoff/i);
    await expect(store.listObjects(TENANT, new Date(), 257)).rejects.toThrow(/maximum/i);
    expect(send).not.toHaveBeenCalled();
  });
});
