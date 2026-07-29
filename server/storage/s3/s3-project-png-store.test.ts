import { deflateSync } from "node:zlib";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { inspectProjectPngBytesV1, type ProjectPngBlobReceiptV1 } from "../project-png-storage";
import { S3ProjectPngStoreV1 } from "./s3-project-png-store";

const BUCKET = "poietra-private-projects";
const TENANT = "tenant-a";
const PROJECT = "project-a";

function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type: string, data = new Uint8Array()) {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return result;
}

function png(red = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk("IEND"),
  ]);
}

const BYTES = png();
const DIGEST = inspectProjectPngBytesV1(BYTES).digest;
const KEY = `tenants/${TENANT}/projects/${PROJECT}/assets/image.png/${DIGEST}`;

function body(bytes = BYTES) {
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield bytes.subarray(0, 17);
      yield bytes.subarray(17);
    },
  };
}

function testStore(send: (command: Readonly<{ input: Record<string, unknown> }>) => Promise<unknown>) {
  const mock = vi.fn(send);
  return {
    send: mock,
    store: new S3ProjectPngStoreV1({
      bucket: BUCKET,
      client: { destroy() {}, send: mock } as unknown as S3Client,
      deployment: "test",
    }),
  };
}

function receipt(overrides: Partial<ProjectPngBlobReceiptV1> = {}): ProjectPngBlobReceiptV1 {
  return {
    byteSize: BYTES.byteLength,
    digest: DIGEST,
    etag: '"etag-a"',
    objectKey: KEY,
    versionId: "version-a",
    ...overrides,
  };
}

describe("S3ProjectPngStoreV1", () => {
  it("writes the content-addressed image.png and verifies its pinned version", async () => {
    const { send, store } = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        expect(command.input).toMatchObject({
          Bucket: BUCKET,
          ChecksumSHA256: Buffer.from(DIGEST, "hex").toString("base64"),
          ContentLength: BYTES.byteLength,
          ContentType: "image/png",
          IfNoneMatch: "*",
          Key: KEY,
        });
        return { ETag: '"etag-a"', VersionId: "version-a" };
      }
      expect(command.input).toEqual({ Bucket: BUCKET, Key: KEY, VersionId: "version-a" });
      return { Body: body(), ContentLength: BYTES.byteLength, ETag: '"etag-a"', VersionId: "version-a" };
    });

    await expect(store.put(TENANT, PROJECT, BYTES)).resolves.toEqual(receipt());
    await expect(store.read(TENANT, PROJECT, receipt())).resolves.toEqual(Uint8Array.from(BYTES));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("fails closed on version, digest, project, and byte mismatches", async () => {
    const versionMismatch = testStore(async () => ({
      Body: body(),
      ContentLength: BYTES.byteLength,
      ETag: '"etag-a"',
      VersionId: "different-version",
    })).store;
    await expect(versionMismatch.read(TENANT, PROJECT, receipt())).rejects.toThrow(/metadata/i);

    const corrupt = png(255);
    const byteMismatch = testStore(async () => ({
      Body: body(corrupt),
      ContentLength: corrupt.byteLength,
      ETag: '"etag-a"',
      VersionId: "version-a",
    })).store;
    await expect(byteMismatch.read(TENANT, PROJECT, receipt({ byteSize: corrupt.byteLength }))).rejects.toThrow(
      /bytes/i,
    );

    const isolated = testStore(async () => {
      throw new Error("S3 must not be contacted");
    });
    await expect(isolated.store.read(TENANT, "project-b", receipt())).rejects.toThrow(/receipt/i);
    await expect(isolated.store.read("tenant-b", PROJECT, receipt())).rejects.toThrow(/receipt/i);
    await expect(isolated.store.read(TENANT, PROJECT, receipt({ digest: "a".repeat(64) }))).rejects.toThrow(/receipt/i);
    expect(isolated.send).not.toHaveBeenCalled();
  });

  it("destroys unread response bodies when exact or duplicate-discovery metadata is incomplete", async () => {
    const exactBody = body();
    const exact = testStore(async () => ({
      Body: exactBody,
      ContentLength: BYTES.byteLength,
      VersionId: "version-a",
    })).store;
    await expect(exact.read(TENANT, PROJECT, receipt())).rejects.toThrow(/ETag/i);
    expect(exactBody.destroy).toHaveBeenCalledOnce();

    const discoveryBody = body();
    const duplicate = testStore(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        const error = new Error("already exists");
        error.name = "PreconditionFailed";
        throw error;
      }
      return {
        Body: discoveryBody,
        ContentLength: BYTES.byteLength,
        ETag: '"etag-a"',
      };
    }).store;
    await expect(duplicate.put(TENANT, PROJECT, BYTES)).rejects.toThrow(/receipt/i);
    expect(discoveryBody.destroy).toHaveBeenCalledOnce();
  });

  it("lists only bounded old tenant versions and produces a tenant-bound cursor", async () => {
    const old = new Date("2026-07-27T00:00:00.000Z");
    const cutoff = new Date("2026-07-28T00:00:00.000Z");
    const { send, store } = testStore(async (command) => {
      expect(command.constructor.name).toBe("ListObjectVersionsCommand");
      return {
        IsTruncated: true,
        NextKeyMarker: KEY,
        NextVersionIdMarker: "version-a",
        Versions: [
          {
            ETag: '"etag-a"',
            Key: KEY,
            LastModified: old,
            Size: BYTES.byteLength,
            VersionId: "version-a",
          },
        ],
      };
    });
    const page = await store.listVersions(TENANT, cutoff, 1);
    expect(page.versions).toEqual([{ lastModified: old, projectId: PROJECT, receipt: receipt() }]);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    send.mockClear();
    await expect(store.listVersions("tenant-b", cutoff, 1, page.nextCursor)).rejects.toThrow(/cursor/i);
    expect(send).not.toHaveBeenCalled();
  });
});
