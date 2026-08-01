import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrivateImmutableS3BucketTransportV1 } from "./s3-private-immutable-bucket-transport";

const REQUIRED_ENVIRONMENT = [
  "POIETRA_STORAGE_E2E_S3_ENDPOINT",
  "POIETRA_STORAGE_E2E_S3_BUCKET",
  "POIETRA_STORAGE_E2E_S3_ACCESS_KEY",
  "POIETRA_STORAGE_E2E_S3_SECRET_KEY",
] as const;
const environmentAvailable = REQUIRED_ENVIRONMENT.every((name) => process.env[name]);
const TENANT = "tenant-a";
const BYTES = Uint8Array.from([0, 1, 2, 3, 4, 255]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const OBJECT_GENERATION = randomUUID();
const OBJECT_KEY = `tenants/${TENANT}/sources/${DIGEST}/g/${OBJECT_GENERATION}`;
const PREFIX = `tenants/${TENANT}/sources/`;

function clientConfig(): S3ClientConfig {
  return {
    credentials: {
      accessKeyId: process.env.POIETRA_STORAGE_E2E_S3_ACCESS_KEY!,
      secretAccessKey: process.env.POIETRA_STORAGE_E2E_S3_SECRET_KEY!,
    },
    endpoint: process.env.POIETRA_STORAGE_E2E_S3_ENDPOINT!,
    forcePathStyle: true,
    region: "us-east-1",
  };
}

async function readBody(value: unknown) {
  if (!value || typeof value !== "object" || !(Symbol.asyncIterator in value)) {
    throw new TypeError("The immutable storage E2E body is not readable.");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of value as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("The immutable storage E2E chunk is invalid.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

describe.skipIf(!environmentAvailable)("private immutable S3 transport", () => {
  const bucket = process.env.POIETRA_STORAGE_E2E_S3_BUCKET!;
  const admin = new S3Client(clientConfig());
  let transport: PrivateImmutableS3BucketTransportV1;
  let lease: ReturnType<PrivateImmutableS3BucketTransportV1["acquire"]>;

  beforeAll(async () => {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    transport = new PrivateImmutableS3BucketTransportV1({
      bucket,
      clientConfig: clientConfig(),
      deployment: "test",
    });
    lease = transport.acquire();
  });

  afterAll(async () => {
    await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: OBJECT_KEY })).catch(() => undefined);
    await lease?.close();
    await transport?.close();
    await admin.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    admin.destroy();
  });

  it("publishes, pins, ranges, lists, and deletes without bucket versioning", async () => {
    await expect(lease.ready()).resolves.toBe(true);
    const versioning = await admin.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    expect(versioning.Status).toBeUndefined();
    expect(versioning.MFADelete).toBeUndefined();

    const operation = lease.operation();
    const metadata = { digest: DIGEST, "object-generation": OBJECT_GENERATION };
    const created = await operation.putObject({
      body: BYTES,
      contentType: "application/octet-stream",
      metadata,
      objectKey: OBJECT_KEY,
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") throw new Error("The immutable object was not created.");

    await expect(
      operation.putObject({
        body: Uint8Array.of(9),
        contentType: "application/octet-stream",
        metadata,
        objectKey: OBJECT_KEY,
      }),
    ).resolves.toEqual({ kind: "already-exists" });

    await expect(
      operation.headObject({ byteSize: BYTES.byteLength, etag: created.etag, objectKey: OBJECT_KEY }),
    ).resolves.toMatchObject({
      byteSize: BYTES.byteLength,
      contentType: "application/octet-stream",
      etag: created.etag,
      metadata,
    });

    const full = await operation.getObject({
      byteSize: BYTES.byteLength,
      etag: created.etag,
      objectKey: OBJECT_KEY,
    });
    await expect(readBody(full.body)).resolves.toEqual(Buffer.from(BYTES));

    const partial = await operation.getObject({
      byteSize: BYTES.byteLength,
      etag: created.etag,
      objectKey: OBJECT_KEY,
      range: { end: 4, start: 2 },
    });
    expect(partial.contentRange).toBe(`bytes 2-4/${BYTES.byteLength}`);
    await expect(readBody(partial.body)).resolves.toEqual(Buffer.from([2, 3, 4]));

    await expect(operation.listObjectsPage({ maximum: 1, prefix: PREFIX })).resolves.toMatchObject({
      nextCursor: null,
      objects: [{ byteSize: BYTES.byteLength, etag: created.etag, objectKey: OBJECT_KEY }],
    });

    await operation.deleteObject(OBJECT_KEY);
    await expect(
      operation.headObject({ byteSize: BYTES.byteLength, etag: created.etag, objectKey: OBJECT_KEY }),
    ).rejects.toBeTruthy();
  });
});
