import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  type ImmutableProjectPngReceiptV1,
  type ImmutableSourceBlobReceiptV1,
  immutableProjectPngObjectKeyV1,
  immutableSourceBlobObjectKeyV1,
} from "../immutable-source-png-storage";
import { inspectProjectPngBytesV1 } from "../project-png-storage";
import { ImmutableS3ProjectPngStoreV1, ImmutableS3SourceBlobStoreV1 } from "./s3-immutable-source-png-store";
import { PrivateImmutableS3BucketTransportV1 } from "./s3-private-immutable-bucket-transport";

const BUCKET = "poietra-private-objects";
const TENANT = "tenant-a";
const PROJECT = "project-a";
const ETAG = '"opaque-etag"';
const GENERATIONS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174000",
  "323e4567-e89b-42d3-a456-426614174000",
  "423e4567-e89b-42d3-a456-426614174000",
] as const;
const SOURCE = "from manim import *\n";
const SOURCE_BYTES = new TextEncoder().encode(SOURCE);
const SOURCE_DIGEST = createHash("sha256").update(SOURCE_BYTES).digest("hex");

type SentCommand = Readonly<{ input: Record<string, unknown> }>;

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

const PNG_BYTES = png();
const PNG_INSPECTED = inspectProjectPngBytesV1(PNG_BYTES);

function stream(bytes: Uint8Array) {
  return {
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      const middle = Math.floor(bytes.byteLength / 2);
      yield bytes.subarray(0, middle);
      yield bytes.subarray(middle);
    },
  };
}

function mockTransport(
  sendImplementation: (
    command: SentCommand,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ) => Promise<unknown> | unknown,
) {
  const send = vi.fn(sendImplementation);
  const transport = new PrivateImmutableS3BucketTransportV1({
    bucket: BUCKET,
    client: { destroy() {}, send } as unknown as S3Client,
    deployment: "test",
  });
  return { send, transport };
}

function generationFactory(values: readonly string[]) {
  let index = 0;
  return vi.fn(() => values[index++] ?? GENERATIONS[3]);
}

function sourceMetadata(generation: string, digest = SOURCE_DIGEST) {
  return {
    "content-digest": digest,
    "object-generation": generation,
    "object-kind": "source-blob",
    "source-encoding": "utf-8",
  };
}

function pngMetadata(generation: string, digest = PNG_INSPECTED.digest, projectId = PROJECT) {
  return {
    "content-digest": digest,
    "object-generation": generation,
    "object-kind": "project-png",
    "project-id": projectId,
  };
}

function sourceReceipt(generation: string = GENERATIONS[0], overrides: Partial<ImmutableSourceBlobReceiptV1> = {}) {
  return {
    byteSize: SOURCE_BYTES.byteLength,
    digest: SOURCE_DIGEST,
    etag: ETAG,
    objectGeneration: generation,
    objectKey: immutableSourceBlobObjectKeyV1(TENANT, SOURCE_DIGEST, generation),
    ...overrides,
  };
}

function pngReceipt(generation: string = GENERATIONS[0], overrides: Partial<ImmutableProjectPngReceiptV1> = {}) {
  return {
    byteSize: PNG_INSPECTED.byteSize,
    digest: PNG_INSPECTED.digest,
    etag: ETAG,
    objectGeneration: generation,
    objectKey: immutableProjectPngObjectKeyV1(TENANT, PROJECT, PNG_INSPECTED.digest, generation),
    ...overrides,
  };
}

describe("ImmutableS3SourceBlobStoreV1", () => {
  it("conditionally creates, GET-verifies, reads, lists, and exactly deletes a generated source object", async () => {
    const receipt = sourceReceipt();
    const modified = new Date("2026-08-01T00:00:00.000Z");
    const { send, transport } = mockTransport(async (command) => {
      switch (command.constructor.name) {
        case "PutObjectCommand":
          return { ETag: ETAG };
        case "HeadObjectCommand":
          return {
            ContentLength: receipt.byteSize,
            ContentType: "text/x-python",
            ETag: ETAG,
            Metadata: sourceMetadata(receipt.objectGeneration),
          };
        case "GetObjectCommand":
          return {
            Body: stream(SOURCE_BYTES),
            ContentLength: receipt.byteSize,
            ContentType: "text/x-python",
            ETag: ETAG,
            Metadata: sourceMetadata(receipt.objectGeneration),
          };
        case "ListObjectsV2Command":
          return {
            Contents: [{ ETag: ETAG, Key: receipt.objectKey, LastModified: modified, Size: receipt.byteSize }],
            IsTruncated: true,
            KeyCount: 1,
            NextContinuationToken: "next-source-page",
          };
        case "DeleteObjectCommand":
          return {};
        default:
          throw new Error(`Unexpected ${command.constructor.name}.`);
      }
    });
    const store = new ImmutableS3SourceBlobStoreV1(
      { transport },
      { createObjectGeneration: generationFactory([receipt.objectGeneration]) },
    );

    await expect(store.putSource(TENANT, SOURCE)).resolves.toEqual(receipt);
    await expect(store.headSource(TENANT, receipt)).resolves.toBeUndefined();
    await expect(store.readSource(TENANT, receipt)).resolves.toBe(SOURCE);
    await expect(store.listOrphanCandidates(TENANT, 2, "source-page")).resolves.toEqual({
      candidates: [{ lastModified: modified, receipt }],
      nextCursor: "next-source-page",
    });
    await expect(store.deleteObject(TENANT, receipt)).resolves.toBeUndefined();

    const commands = send.mock.calls.map(([command]) => ({ input: command.input, name: command.constructor.name }));
    expect(commands[0]).toEqual({
      input: {
        Body: SOURCE_BYTES,
        Bucket: BUCKET,
        ContentLength: SOURCE_BYTES.byteLength,
        ContentType: "text/x-python",
        IfNoneMatch: "*",
        Key: receipt.objectKey,
        Metadata: sourceMetadata(receipt.objectGeneration),
      },
      name: "PutObjectCommand",
    });
    expect(commands.filter(({ name }) => name === "HeadObjectCommand").map(({ input }) => input)).toEqual([
      { Bucket: BUCKET, IfMatch: ETAG, Key: receipt.objectKey },
    ]);
    expect(commands.filter(({ name }) => name === "GetObjectCommand").map(({ input }) => input)).toEqual([
      { Bucket: BUCKET, IfMatch: ETAG, Key: receipt.objectKey },
      { Bucket: BUCKET, IfMatch: ETAG, Key: receipt.objectKey },
    ]);
    expect(commands.find(({ name }) => name === "ListObjectsV2Command")?.input).toEqual({
      Bucket: BUCKET,
      ContinuationToken: "source-page",
      MaxKeys: 2,
      Prefix: `tenants/${TENANT}/sources/`,
    });
    expect(commands.at(-1)).toEqual({
      input: { Bucket: BUCKET, Key: receipt.objectKey },
      name: "DeleteObjectCommand",
    });
    await store.close();
  });

  it("allocates a fresh application generation for each bounded conditional-create collision", async () => {
    const createGeneration = generationFactory(GENERATIONS);
    let puts = 0;
    const expected = sourceReceipt(GENERATIONS[2]);
    const { send, transport } = mockTransport(async (command) => {
      if (command.constructor.name === "PutObjectCommand") {
        puts += 1;
        if (puts < 3) throw Object.assign(new Error("collision"), { name: "PreconditionFailed" });
        return { ETag: ETAG };
      }
      expect(command.constructor.name).toBe("GetObjectCommand");
      expect(command.input.Key).toBe(expected.objectKey);
      return {
        Body: stream(SOURCE_BYTES),
        ContentLength: expected.byteSize,
        ContentType: "text/x-python",
        ETag: ETAG,
        Metadata: sourceMetadata(expected.objectGeneration),
      };
    });
    const store = new ImmutableS3SourceBlobStoreV1({ transport }, { createObjectGeneration: createGeneration });

    await expect(store.putSource(TENANT, SOURCE)).resolves.toEqual(expected);
    expect(createGeneration).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls
        .filter(([command]) => command.constructor.name === "PutObjectCommand")
        .map(([command]) => command.input.Key),
    ).toEqual(GENERATIONS.slice(0, 3).map((generation) => sourceReceipt(generation).objectKey));
    expect(send.mock.calls.filter(([command]) => command.constructor.name === "GetObjectCommand")).toHaveLength(1);
    await store.close();
  });

  it("refuses a receipt when the newly created source object fails full-byte verification", async () => {
    const receipt = sourceReceipt();
    const changed = new TextEncoder().encode("from manim import X\n");
    const responseBody = stream(changed);
    const { send, transport } = mockTransport(async (command) => {
      if (command.constructor.name === "PutObjectCommand") return { ETag: ETAG };
      expect(command.constructor.name).toBe("GetObjectCommand");
      return {
        Body: responseBody,
        ContentLength: receipt.byteSize,
        ContentType: "text/x-python",
        ETag: ETAG,
        Metadata: sourceMetadata(receipt.objectGeneration),
      };
    });
    const store = new ImmutableS3SourceBlobStoreV1(
      { transport },
      { createObjectGeneration: generationFactory([receipt.objectGeneration]) },
    );

    await expect(store.putSource(TENANT, SOURCE)).rejects.toThrow(/bytes/i);
    expect(send.mock.calls.map(([command]) => ({ input: command.input, name: command.constructor.name }))).toEqual([
      {
        input: expect.objectContaining({ IfNoneMatch: "*", Key: receipt.objectKey }),
        name: "PutObjectCommand",
      },
      {
        input: { Bucket: BUCKET, IfMatch: ETAG, Key: receipt.objectKey },
        name: "GetObjectCommand",
      },
    ]);
    expect(responseBody.destroy).toHaveBeenCalledOnce();
    await store.close();
  });

  it("stops after three collisions and rejects invalid source locators before I/O", async () => {
    const { send, transport } = mockTransport(async () => {
      throw Object.assign(new Error("collision"), { name: "ConditionalRequestConflict" });
    });
    const store = new ImmutableS3SourceBlobStoreV1(
      { transport },
      { createObjectGeneration: generationFactory(GENERATIONS) },
    );

    await expect(store.putSource(TENANT, SOURCE)).rejects.toThrow(/3 consecutive/i);
    expect(send).toHaveBeenCalledTimes(3);
    send.mockClear();
    await expect(store.readSource("tenant-b", sourceReceipt())).rejects.toThrow(/locator/i);
    await expect(store.deleteObject(TENANT, sourceReceipt(GENERATIONS[0], { digest: "b".repeat(64) }))).rejects.toThrow(
      /locator/i,
    );
    await expect(store.putSource(TENANT, "\ud800")).rejects.toThrow(/surrogate/i);
    expect(send).not.toHaveBeenCalled();
    await store.close();
  });

  it("destroys bodies and fails closed for metadata, digest, and UTF-8 drift", async () => {
    const metadataBody = stream(SOURCE_BYTES);
    const metadataFixture = mockTransport(async () => ({
      Body: metadataBody,
      ContentLength: SOURCE_BYTES.byteLength,
      ContentType: "text/plain",
      ETag: ETAG,
      Metadata: sourceMetadata(GENERATIONS[0]),
    }));
    const metadataStore = new ImmutableS3SourceBlobStoreV1({ transport: metadataFixture.transport });
    await expect(metadataStore.readSource(TENANT, sourceReceipt())).rejects.toThrow(/metadata/i);
    expect(metadataBody.destroy).toHaveBeenCalledOnce();
    await metadataStore.close();

    const changed = new TextEncoder().encode("from manim import X\n");
    const digestBody = stream(changed);
    const digestFixture = mockTransport(async () => ({
      Body: digestBody,
      ContentLength: changed.byteLength,
      ContentType: "text/x-python",
      ETag: ETAG,
      Metadata: sourceMetadata(GENERATIONS[0]),
    }));
    const digestStore = new ImmutableS3SourceBlobStoreV1({ transport: digestFixture.transport });
    await expect(
      digestStore.readSource(TENANT, sourceReceipt(GENERATIONS[0], { byteSize: changed.byteLength })),
    ).rejects.toThrow(/bytes/i);
    expect(digestBody.destroy).toHaveBeenCalledOnce();
    await digestStore.close();

    const invalidUtf8 = Uint8Array.of(0xff);
    const invalidDigest = createHash("sha256").update(invalidUtf8).digest("hex");
    const utf8Receipt = sourceReceipt(GENERATIONS[0], {
      byteSize: 1,
      digest: invalidDigest,
      objectKey: immutableSourceBlobObjectKeyV1(TENANT, invalidDigest, GENERATIONS[0]),
    });
    const utf8Fixture = mockTransport(async () => ({
      Body: stream(invalidUtf8),
      ContentLength: 1,
      ContentType: "text/x-python",
      ETag: ETAG,
      Metadata: sourceMetadata(GENERATIONS[0], invalidDigest),
    }));
    const utf8Store = new ImmutableS3SourceBlobStoreV1({ transport: utf8Fixture.transport });
    await expect(utf8Store.readSource(TENANT, utf8Receipt)).rejects.toThrow(/UTF-8/i);
    await utf8Store.close();
  });
});

describe("ImmutableS3ProjectPngStoreV1", () => {
  it("pins PNG metadata, validates bytes, lists tenant objects, and deletes only the exact generation", async () => {
    const receipt = pngReceipt();
    const modified = new Date("2026-08-01T00:00:00.000Z");
    const { send, transport } = mockTransport(async (command) => {
      switch (command.constructor.name) {
        case "PutObjectCommand":
          return { ETag: ETAG };
        case "HeadObjectCommand":
          return {
            ContentLength: receipt.byteSize,
            ContentType: "image/png",
            ETag: ETAG,
            Metadata: pngMetadata(receipt.objectGeneration),
          };
        case "GetObjectCommand":
          return {
            Body: stream(PNG_BYTES),
            ContentLength: receipt.byteSize,
            ContentType: "image/png",
            ETag: ETAG,
            Metadata: pngMetadata(receipt.objectGeneration),
          };
        case "ListObjectsV2Command":
          return {
            Contents: [{ ETag: ETAG, Key: receipt.objectKey, LastModified: modified, Size: receipt.byteSize }],
            IsTruncated: false,
            KeyCount: 1,
          };
        case "DeleteObjectCommand":
          return {};
        default:
          throw new Error(`Unexpected ${command.constructor.name}.`);
      }
    });
    const store = new ImmutableS3ProjectPngStoreV1(
      { transport },
      { createObjectGeneration: generationFactory([receipt.objectGeneration]) },
    );

    await expect(store.put(TENANT, PROJECT, PNG_BYTES)).resolves.toEqual(receipt);
    await expect(store.head(TENANT, PROJECT, receipt)).resolves.toBeUndefined();
    await expect(store.read(TENANT, PROJECT, receipt)).resolves.toEqual(Uint8Array.from(PNG_BYTES));
    await expect(store.listOrphanCandidates(TENANT, 1)).resolves.toEqual({
      candidates: [{ lastModified: modified, projectId: PROJECT, receipt }],
      nextCursor: null,
    });
    await expect(store.deleteObject(TENANT, PROJECT, receipt)).resolves.toBeUndefined();

    const commands = send.mock.calls.map(([command]) => ({ input: command.input, name: command.constructor.name }));
    expect(commands[0]).toEqual({
      input: {
        Body: Uint8Array.from(PNG_BYTES),
        Bucket: BUCKET,
        ContentLength: PNG_BYTES.byteLength,
        ContentType: "image/png",
        IfNoneMatch: "*",
        Key: receipt.objectKey,
        Metadata: pngMetadata(receipt.objectGeneration),
      },
      name: "PutObjectCommand",
    });
    expect(commands.find(({ name }) => name === "GetObjectCommand")?.input).toEqual({
      Bucket: BUCKET,
      IfMatch: ETAG,
      Key: receipt.objectKey,
    });
    expect(commands.find(({ name }) => name === "ListObjectsV2Command")?.input).toEqual({
      Bucket: BUCKET,
      MaxKeys: 1,
      Prefix: `tenants/${TENANT}/projects/`,
    });
    expect(commands.at(-1)).toEqual({
      input: { Bucket: BUCKET, Key: receipt.objectKey },
      name: "DeleteObjectCommand",
    });
    await store.close();
  });

  it("rejects invalid PNGs and foreign project locators before storage I/O", async () => {
    const { send, transport } = mockTransport(async () => {
      throw new Error("storage must not be contacted");
    });
    const store = new ImmutableS3ProjectPngStoreV1({ transport });

    await expect(store.put(TENANT, PROJECT, Uint8Array.of(1, 2, 3))).rejects.toThrow(/PNG|truncated/i);
    await expect(store.read(TENANT, "project-b", pngReceipt())).rejects.toThrow(/locator/i);
    await expect(store.deleteObject("tenant-b", PROJECT, pngReceipt())).rejects.toThrow(/locator/i);
    await expect(store.listOrphanCandidates(TENANT, 257)).rejects.toThrow(/maximum/i);
    expect(send).not.toHaveBeenCalled();
    await store.close();
  });

  it("refuses a receipt when the newly created PNG fails the full PNG validator", async () => {
    const receipt = pngReceipt();
    const corrupt = Uint8Array.from(PNG_BYTES);
    const finalByte = corrupt.byteLength - 1;
    corrupt[finalByte] = corrupt[finalByte]! ^ 1;
    const responseBody = stream(corrupt);
    const { send, transport } = mockTransport(async (command) => {
      if (command.constructor.name === "PutObjectCommand") return { ETag: ETAG };
      expect(command.constructor.name).toBe("GetObjectCommand");
      return {
        Body: responseBody,
        ContentLength: receipt.byteSize,
        ContentType: "image/png",
        ETag: ETAG,
        Metadata: pngMetadata(receipt.objectGeneration),
      };
    });
    const store = new ImmutableS3ProjectPngStoreV1(
      { transport },
      { createObjectGeneration: generationFactory([receipt.objectGeneration]) },
    );

    await expect(store.put(TENANT, PROJECT, PNG_BYTES)).rejects.toThrow(/PNG|CRC|chunk/i);
    expect(send.mock.calls.map(([command]) => ({ input: command.input, name: command.constructor.name }))).toEqual([
      {
        input: expect.objectContaining({ IfNoneMatch: "*", Key: receipt.objectKey }),
        name: "PutObjectCommand",
      },
      {
        input: { Bucket: BUCKET, IfMatch: ETAG, Key: receipt.objectKey },
        name: "GetObjectCommand",
      },
    ]);
    expect(responseBody.destroy).toHaveBeenCalledOnce();
    await store.close();
  });

  it("fails closed and destroys the response body when PNG metadata or bytes drift", async () => {
    const wrongMetadataBody = stream(PNG_BYTES);
    const metadataFixture = mockTransport(async () => ({
      Body: wrongMetadataBody,
      ContentLength: PNG_BYTES.byteLength,
      ContentType: "image/png",
      ETag: ETAG,
      Metadata: pngMetadata(GENERATIONS[0], PNG_INSPECTED.digest, "project-b"),
    }));
    const metadataStore = new ImmutableS3ProjectPngStoreV1({ transport: metadataFixture.transport });
    await expect(metadataStore.read(TENANT, PROJECT, pngReceipt())).rejects.toThrow(/metadata/i);
    expect(wrongMetadataBody.destroy).toHaveBeenCalledOnce();
    await metadataStore.close();

    const changed = png(255);
    const changedBody = stream(changed);
    const changedFixture = mockTransport(async () => ({
      Body: changedBody,
      ContentLength: changed.byteLength,
      ContentType: "image/png",
      ETag: ETAG,
      Metadata: pngMetadata(GENERATIONS[0]),
    }));
    const changedStore = new ImmutableS3ProjectPngStoreV1({ transport: changedFixture.transport });
    await expect(
      changedStore.read(TENANT, PROJECT, pngReceipt(GENERATIONS[0], { byteSize: changed.byteLength })),
    ).rejects.toThrow(/bytes/i);
    expect(changedBody.destroy).toHaveBeenCalledOnce();
    await changedStore.close();
  });

  it("rejects a malformed same-tenant listing instead of widening the orphan scan", async () => {
    const invalidKey = `tenants/${TENANT}/projects/${PROJECT}/assets/not-image.png/${PNG_INSPECTED.digest}/g/${GENERATIONS[0]}`;
    const { transport } = mockTransport(async () => ({
      Contents: [{ ETag: ETAG, Key: invalidKey, LastModified: new Date(), Size: 1 }],
      IsTruncated: false,
      KeyCount: 1,
    }));
    const store = new ImmutableS3ProjectPngStoreV1({ transport });

    await expect(store.listOrphanCandidates(TENANT, 1)).rejects.toThrow();
    await store.close();
  });
});
