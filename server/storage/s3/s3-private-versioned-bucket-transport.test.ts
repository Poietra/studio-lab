import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { S3ContentBlobStoreV1 } from "./s3-content-blob-store";
import { PrivateVersionedS3BucketTransportV1 } from "./s3-private-versioned-bucket-transport";
import { S3SnapshotArtifactStoreV1 } from "./s3-snapshot-artifact-store";

const BUCKET = "poietra-private-artifacts";

function testTransport(
  send: (
    command: Readonly<{ input: Record<string, unknown> }>,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ) => Promise<unknown> | unknown,
  destroy = vi.fn(),
) {
  const sendMock = vi.fn(send);
  return {
    destroy,
    send: sendMock,
    transport: new PrivateVersionedS3BucketTransportV1({
      bucket: BUCKET,
      client: { destroy, send: sendMock } as unknown as S3Client,
      deployment: "test",
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PrivateVersionedS3BucketTransportV1", () => {
  it("rejects abort before I/O and applies one bounded deadline to an operation", async () => {
    const { send, transport } = testTransport(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) throw new Error("The transport did not pass an abort signal.");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const lease = transport.acquire();
    const callerAbort = new Error("caller stopped");

    expect(() => lease.operation(AbortSignal.abort(callerAbort))).toThrow(callerAbort);
    expect(send).not.toHaveBeenCalled();

    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const operation = lease.operation();
    const request = operation.headObject({ Key: "tenants/tenant-a/videos/video-a" });
    const deadlineError = new Error("operation deadline");
    deadline.abort(deadlineError);

    await expect(request).rejects.toBe(deadlineError);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(send).toHaveBeenCalledOnce();
    await lease.close();
  });

  it("returns false for incomplete bucket evidence and propagates an already-aborted readiness signal", async () => {
    const { send, transport } = testTransport(async (command) => {
      switch (command.constructor.name) {
        case "HeadBucketCommand":
          return {};
        case "GetBucketVersioningCommand":
          return { Status: "Suspended" };
        case "GetBucketAclCommand":
          return {
            Grants: [{ Grantee: { Type: "CanonicalUser" }, Permission: "FULL_CONTROL" }],
            Owner: { ID: "" },
          };
        case "GetBucketPolicyStatusCommand":
          return { PolicyStatus: { IsPublic: false } };
        case "GetBucketLifecycleConfigurationCommand":
          throw Object.assign(new Error("absent"), { name: "NoSuchLifecycleConfiguration" });
        default:
          throw new Error("Unexpected readiness command.");
      }
    });
    const lease = transport.acquire();

    await expect(lease.ready()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(5);
    send.mockClear();

    const stopped = new Error("readiness stopped");
    await expect(lease.ready(AbortSignal.abort(stopped))).rejects.toBe(stopped);
    expect(send).not.toHaveBeenCalled();
    await lease.close();
  });

  it("shares one owned client until the final lease closes and never destroys an injected client", async () => {
    const destroyOwnedClient = vi.spyOn(S3Client.prototype, "destroy");
    const owned = new PrivateVersionedS3BucketTransportV1({
      bucket: BUCKET,
      clientConfig: { region: "us-east-1" },
      deployment: "test",
    });
    const first = owned.acquire();
    const second = owned.acquire();

    await first.close();
    expect(destroyOwnedClient).not.toHaveBeenCalled();
    await second.close();
    expect(destroyOwnedClient).toHaveBeenCalledOnce();
    expect(() => owned.acquire()).toThrow(/closed/i);

    const injectedDestroy = vi.fn();
    const injected = testTransport(async () => ({}), injectedDestroy).transport;
    await injected.acquire().close();
    expect(injectedDestroy).not.toHaveBeenCalled();
  });

  it("keeps a shared transport alive until both domain adapters close", async () => {
    const { send, transport } = testTransport(async (command) => {
      switch (command.constructor.name) {
        case "HeadBucketCommand":
          return {};
        case "GetBucketVersioningCommand":
          return { Status: "Enabled" };
        case "GetBucketAclCommand":
          return {
            Grants: [{ Grantee: { Type: "CanonicalUser" }, Permission: "FULL_CONTROL" }],
            Owner: { ID: "" },
          };
        case "GetBucketPolicyStatusCommand":
          return { PolicyStatus: { IsPublic: false } };
        case "GetBucketLifecycleConfigurationCommand":
          throw Object.assign(new Error("absent"), { name: "NoSuchLifecycleConfiguration" });
        default:
          throw new Error("Unexpected shared transport command.");
      }
    });
    const sources = new S3ContentBlobStoreV1({ transport });
    const snapshots = new S3SnapshotArtifactStoreV1({ transport });

    await expect(Promise.all([sources.ready(), snapshots.ready()])).resolves.toEqual([true, true]);
    expect(send).toHaveBeenCalledTimes(10);
    await sources.close();
    await expect(snapshots.ready()).resolves.toBe(true);
    await snapshots.close();
    expect(() => transport.acquire()).toThrow(/closed/i);
  });

  it("keeps Range bodies streaming while bounding version pages and version deletion", async () => {
    const body = { transformToWebStream: vi.fn() };
    const { send, transport } = testTransport(async (command) => {
      switch (command.constructor.name) {
        case "GetObjectCommand":
          return { Body: body, ContentLength: 2, ContentRange: "bytes 2-3/10" };
        case "HeadObjectCommand":
          return { ContentLength: 10, ContentType: "video/mp4" };
        case "ListObjectVersionsCommand":
          return { IsTruncated: false, Versions: [] };
        case "DeleteObjectCommand":
          return {};
        default:
          throw new Error("Unexpected transport command.");
      }
    });
    const lease = transport.acquire();
    const operation = lease.operation();
    const key = "tenants/tenant-a/videos/video-a";

    await expect(operation.getObject({ Key: key, Range: "bytes=2-3" })).resolves.toMatchObject({ Body: body });
    expect(body.transformToWebStream).not.toHaveBeenCalled();
    await expect(operation.headObject({ Key: key })).resolves.toMatchObject({ ContentLength: 10 });
    await expect(operation.listObjectVersionsPage({ MaxKeys: 1, Prefix: "tenants/tenant-a/videos/" })).resolves.toEqual(
      {
        IsTruncated: false,
        Versions: [],
      },
    );
    await expect(operation.deleteObjectVersion({ Key: key, VersionId: "version-a" })).resolves.toEqual({});

    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "GetObjectCommand",
      "HeadObjectCommand",
      "ListObjectVersionsCommand",
      "DeleteObjectCommand",
    ]);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: BUCKET, Key: key, Range: "bytes=2-3" });

    send.mockClear();
    await expect(
      operation.listObjectVersionsPage({ MaxKeys: 257, Prefix: "tenants/tenant-a/videos/" }),
    ).rejects.toThrow(/safely bounded/i);
    expect(() => operation.deleteObjectVersion({ Key: key, VersionId: "" })).toThrow(/deletion target/i);
    expect(send).not.toHaveBeenCalled();
    await lease.close();
  });

  it("centralizes production configuration validation", async () => {
    expect(
      () =>
        new PrivateVersionedS3BucketTransportV1({
          bucket: BUCKET,
          client: { destroy() {} } as S3Client,
          deployment: "development",
        } as never),
    ).toThrow(/deployment mode/i);
    expect(
      () =>
        new PrivateVersionedS3BucketTransportV1({
          bucket: BUCKET,
          clientConfig: { endpoint: "http://127.0.0.1:9000", ignoreConfiguredEndpointUrls: true },
          deployment: "production",
        }),
    ).toThrow(/loopback tests/i);

    const valid = new PrivateVersionedS3BucketTransportV1({
      bucket: BUCKET,
      clientConfig: {
        endpoint: "https://artifacts.example.com",
        forcePathStyle: false,
        ignoreConfiguredEndpointUrls: true,
        region: "us-east-1",
      },
      deployment: "production",
    });
    await valid.close();
  });
});
