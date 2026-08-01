import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { PrivateImmutableS3BucketTransportV1 } from "./s3-private-immutable-bucket-transport";

const BUCKET = "poietra-private-objects";
const GENERATION = "123e4567-e89b-42d3-a456-426614174000";
const PREFIX = "tenants/tenant-a/sources/";
const KEY = `${PREFIX}${"a".repeat(64)}/g/${GENERATION}`;
const ETAG = '"opaque-etag"';

type SentCommand = Readonly<{ input: Record<string, unknown> }>;

function testTransport(send: (command: SentCommand, options?: Readonly<{ abortSignal?: AbortSignal }>) => unknown) {
  const destroy = vi.fn();
  const transport = new PrivateImmutableS3BucketTransportV1({
    bucket: BUCKET,
    client: { destroy, send } as unknown as S3Client,
    deployment: "test",
  });
  const lease = transport.acquire();
  return { destroy, lease, operation: lease.operation(), transport };
}

function body() {
  return { destroy: vi.fn() };
}

describe("PrivateImmutableS3BucketTransportV1", () => {
  it("builds a narrow conditional-create command and returns an opaque ETag", async () => {
    const send = vi.fn(async (command: SentCommand) => {
      expect(command.constructor.name).toBe("PutObjectCommand");
      expect(command.input).toEqual({
        Body: new Uint8Array([1, 2, 3]),
        Bucket: BUCKET,
        ContentLength: 3,
        ContentType: "application/octet-stream",
        IfNoneMatch: "*",
        Key: KEY,
        Metadata: { "content-digest": "a".repeat(64) },
      });
      return { ETag: ETAG, VersionId: "must-not-escape" };
    });
    const { operation } = testTransport(send);

    await expect(
      operation.putObject({
        body: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream",
        metadata: { "content-digest": "a".repeat(64) },
        objectKey: KEY,
      }),
    ).resolves.toEqual({ etag: ETAG, kind: "created" });
  });

  it("distinguishes conditional-create collisions without hiding provider failures", async () => {
    const errors = [
      Object.assign(new Error("exists"), { name: "PreconditionFailed" }),
      Object.assign(new Error("race"), { name: "ConditionalRequestConflict" }),
      Object.assign(new Error("provider unavailable"), { $metadata: { httpStatusCode: 409 } }),
    ];
    const { operation } = testTransport(async () => {
      throw errors.shift();
    });
    const input = { body: new Uint8Array(), contentType: "application/octet-stream", objectKey: KEY } as const;

    await expect(operation.putObject(input)).resolves.toEqual({ kind: "already-exists" });
    await expect(operation.putObject(input)).resolves.toEqual({ kind: "already-exists" });
    await expect(operation.putObject(input)).rejects.toThrow("provider unavailable");
  });

  it("gives caller cancellation precedence over a colliding provider response", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const { lease } = testTransport(async () => {
      controller.abort(reason);
      throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    });

    await expect(
      lease.operation(controller.signal).putObject({
        body: new Uint8Array(),
        contentType: "application/octet-stream",
        objectKey: KEY,
      }),
    ).rejects.toBe(reason);
  });

  it("pins full and Range GET plus HEAD to the exact ETag", async () => {
    const responses = [
      { Body: body(), ContentLength: 10, ContentType: "video/mp4", ETag: ETAG, Metadata: { kind: "video" } },
      {
        Body: body(),
        ContentLength: 3,
        ContentRange: "bytes 2-4/10",
        ContentType: "video/mp4",
        ETag: ETAG,
        Metadata: { kind: "video" },
      },
      { ContentLength: 10, ContentType: "video/mp4", ETag: ETAG, Metadata: { kind: "video" } },
    ];
    const send = vi.fn(async (_command: SentCommand) => responses.shift());
    const { operation } = testTransport(send);

    await expect(operation.getObject({ byteSize: 10, etag: ETAG, objectKey: KEY })).resolves.toMatchObject({
      byteSize: 10,
      contentType: "video/mp4",
      etag: ETAG,
      metadata: { kind: "video" },
    });
    await expect(
      operation.getObject({ byteSize: 10, etag: ETAG, objectKey: KEY, range: { end: 4, start: 2 } }),
    ).resolves.toMatchObject({ byteSize: 3, contentRange: "bytes 2-4/10", etag: ETAG });
    await expect(operation.headObject({ byteSize: 10, etag: ETAG, objectKey: KEY })).resolves.toEqual({
      byteSize: 10,
      contentType: "video/mp4",
      etag: ETAG,
      metadata: { kind: "video" },
    });

    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      { Bucket: BUCKET, IfMatch: ETAG, Key: KEY },
      { Bucket: BUCKET, IfMatch: ETAG, Key: KEY, Range: "bytes=2-4" },
      { Bucket: BUCKET, IfMatch: ETAG, Key: KEY },
    ]);
  });

  it("clears the GET header deadline while preserving caller cancellation for the body", async () => {
    vi.useFakeTimers();
    try {
      let sdkSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const { lease } = testTransport(async (_command, options) => {
        sdkSignal = options?.abortSignal;
        return { Body: body(), ContentLength: 10, ETag: ETAG, Metadata: {} };
      });

      await lease.operation(controller.signal).getObject({ byteSize: 10, etag: ETAG, objectKey: KEY });
      await vi.advanceTimersByTimeAsync(30_001);
      expect(sdkSignal?.aborted).toBe(false);

      const reason = new Error("stop streaming");
      controller.abort(reason);
      expect(sdkSignal?.aborted).toBe(true);
      expect(sdkSignal?.reason).toBe(reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller abort reasons for bounded non-streaming operations", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped HEAD");
    const { lease } = testTransport(async () => {
      controller.abort(reason);
      throw new Error("provider AbortError");
    });

    await expect(
      lease.operation(controller.signal).headObject({ byteSize: 10, etag: ETAG, objectKey: KEY }),
    ).rejects.toBe(reason);
  });

  it.each([
    { ContentLength: 9, ContentRange: undefined, ETag: ETAG },
    { ContentLength: 10, ContentRange: undefined, ETag: '"different"' },
    { ContentLength: 3, ContentRange: undefined, ETag: ETAG },
    { ContentLength: 3, ContentRange: "bytes 2-5/10", ETag: ETAG },
  ])("destroys a GET body before rejecting mismatched immutable headers: %j", async (headers) => {
    const responseBody = body();
    const { operation } = testTransport(async () => ({ Body: responseBody, ...headers }));
    const request =
      headers.ContentLength === 3
        ? { byteSize: 10, etag: ETAG, objectKey: KEY, range: { end: 4, start: 2 } }
        : { byteSize: 10, etag: ETAG, objectKey: KEY };

    await expect(operation.getObject(request)).rejects.toThrow(/immutable read contract/i);
    expect(responseBody.destroy).toHaveBeenCalledOnce();
  });

  it("uses exact-key deletion without a provider version identifier", async () => {
    const send = vi.fn(async (_command: SentCommand) => ({}));
    const { operation } = testTransport(send);

    await operation.deleteObject(KEY);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].constructor.name).toBe("DeleteObjectCommand");
    expect(send.mock.calls[0]?.[0].input).toEqual({ Bucket: BUCKET, Key: KEY });
  });

  it("returns a bounded ListObjectsV2 page with an opaque continuation token", async () => {
    const nextCursor = "opaque+/cursor==";
    const modified = new Date("2026-08-01T00:00:00.000Z");
    const send = vi.fn(async (command: SentCommand) => {
      expect(command.constructor.name).toBe("ListObjectsV2Command");
      expect(command.input).toEqual({ Bucket: BUCKET, ContinuationToken: "first+/token=", MaxKeys: 2, Prefix: PREFIX });
      return {
        Contents: [{ ETag: ETAG, Key: KEY, LastModified: modified, Size: 3 }],
        IsTruncated: true,
        KeyCount: 1,
        NextContinuationToken: nextCursor,
      };
    });
    const { operation } = testTransport(send);

    await expect(operation.listObjectsPage({ cursor: "first+/token=", maximum: 2, prefix: PREFIX })).resolves.toEqual({
      nextCursor,
      objects: [{ byteSize: 3, etag: ETAG, lastModified: modified, objectKey: KEY }],
    });
  });

  it.each([
    {
      Contents: [{ ETag: ETAG, Key: KEY.replace("tenant-a", "tenant-b"), LastModified: new Date(), Size: 1 }],
      IsTruncated: false,
    },
    { Contents: [], IsTruncated: true, NextContinuationToken: "next" },
    {
      Contents: [{ ETag: ETAG, Key: KEY, LastModified: new Date(), Size: 1 }],
      IsTruncated: true,
      NextContinuationToken: "same",
    },
    {
      Contents: [{ ETag: ETAG, Key: KEY, LastModified: new Date(), Size: 1 }],
      IsTruncated: false,
      NextContinuationToken: "unexpected",
    },
    { Contents: [{ ETag: ETAG, Key: KEY, LastModified: new Date(), Size: 1 }] },
  ])("fails closed for an invalid ListObjectsV2 page: %j", async (page) => {
    const { operation } = testTransport(async () => page);

    await expect(operation.listObjectsPage({ cursor: "same", maximum: 1, prefix: PREFIX })).rejects.toThrow();
  });

  it("rejects invalid keys, ranges, metadata, and bounds before sending", async () => {
    const send = vi.fn();
    const { operation } = testTransport(send);

    await expect(operation.deleteObject(`${PREFIX}${"a".repeat(64)}`)).rejects.toThrow(/key/i);
    await expect(
      operation.getObject({ byteSize: 10, etag: ETAG, objectKey: KEY, range: { end: 10, start: 0 } }),
    ).rejects.toThrow(/range/i);
    await expect(
      operation.putObject({
        body: new Uint8Array(),
        contentType: "application/octet-stream",
        metadata: { "Invalid-Key": "value" },
        objectKey: KEY,
      }),
    ).rejects.toThrow(/metadata/i);
    await expect(operation.listObjectsPage({ maximum: 257, prefix: PREFIX })).rejects.toThrow(/maximum/i);
    await expect(operation.listObjectsPage({ maximum: 1, prefix: "tenants/" })).rejects.toThrow(/prefix/i);
    await expect(operation.listObjectsPage({ maximum: 1, prefix: "tenants/../sources/" })).rejects.toThrow(/prefix/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses only HeadBucket for readiness and preserves lease ownership", async () => {
    const send = vi.fn(async (command: SentCommand) => {
      expect(command.constructor.name).toBe("HeadBucketCommand");
      return {};
    });
    const { destroy, lease, transport } = testTransport(send);
    const second = transport.acquire();

    await expect(lease.ready()).resolves.toBe(true);
    const closing = transport.close();
    await lease.close();
    expect(destroy).not.toHaveBeenCalled();
    await second.close();
    await closing;
    expect(destroy).not.toHaveBeenCalled();
    expect(() => transport.acquire()).toThrow(/closed/i);
  });

  it("aborts an in-flight readiness probe when its lease closes", async () => {
    const { lease } = testTransport(
      async (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
        }),
    );

    const readiness = lease.ready();
    await lease.close();

    await expect(readiness).rejects.toThrow(/lease is closed/i);
  });

  it("uses a closed production provider contract instead of raw SDK configuration", async () => {
    expect(
      () =>
        new PrivateImmutableS3BucketTransportV1({
          bucket: BUCKET,
          clientConfig: { endpoint: "https://account.r2.cloudflarestorage.com", region: "auto" },
          deployment: "production",
        } as never),
    ).toThrow(/provider|configuration/i);
    expect(
      () =>
        new PrivateImmutableS3BucketTransportV1({
          bucket: BUCKET,
          deployment: "production",
          provider: {
            accountId: "not-an-account-id",
            credentials: { accessKeyId: "access", secretAccessKey: "secret" },
            kind: "cloudflare-r2",
          },
        }),
    ).toThrow(/account ID/i);
    expect(
      () =>
        new PrivateImmutableS3BucketTransportV1({
          bucket: BUCKET,
          deployment: "production",
          provider: { credentials: { source: "aws-default-chain" }, kind: "aws-s3", region: "auto" },
        }),
    ).toThrow(/region/i);

    const r2 = new PrivateImmutableS3BucketTransportV1({
      bucket: BUCKET,
      deployment: "production",
      provider: {
        accountId: "a".repeat(32),
        credentials: { accessKeyId: "access", secretAccessKey: "secret", sessionToken: "temporary" },
        jurisdiction: "eu",
        kind: "cloudflare-r2",
      },
    });
    const aws = new PrivateImmutableS3BucketTransportV1({
      bucket: BUCKET,
      deployment: "production",
      provider: {
        credentials: { source: "aws-default-chain" },
        kind: "aws-s3",
        region: "ap-northeast-1",
      },
    });
    await Promise.all([r2.close(), aws.close()]);
  });
});
