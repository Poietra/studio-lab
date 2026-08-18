import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
  type ClientThumbnailArtifactReceiptV1,
  type ClientThumbnailArtifactStoreV1,
  type ClientThumbnailPublicationV1,
  type ClientThumbnailRepositoryV1,
} from "./client-thumbnail-contract";
import { ClientThumbnailPublisherV1, type PublishClientThumbnailInputV1 } from "./client-thumbnail-publisher";

function partial<T>(value: Partial<T>): T {
  return value as T;
}

const TENANT = "tenant-a";
const PROJECT = "project-a";
const PUBLICATION = "00000000-0000-4000-8000-000000000001";
const ARTIFACT = "00000000-0000-4000-8000-000000000002";
const SUBJECT = "00000000-0000-4000-8000-000000000003";
const LOCATOR = "00000000-0000-4000-8000-000000000004";

function png(width = 854, height = 480) {
  const bytes = Buffer.alloc(24);
  bytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function input(bytes = png()): PublishClientThumbnailInputV1 {
  return {
    bytes,
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
    createdBySubjectId: SUBJECT,
    documentEpoch: "00000000-0000-4000-8000-000000000005",
    documentKey: "b".repeat(64),
    documentRevision: 7n,
    projectId: PROJECT,
    publicationId: PUBLICATION,
    sceneRevisionHash: "c".repeat(64),
    tenantId: TENANT,
  };
}

function receipt(value = input()): ClientThumbnailArtifactReceiptV1 {
  return {
    byteSize: value.bytes.byteLength,
    contentDigest: value.contentDigest,
    etag: '"thumbnail"',
    mediaType: CLIENT_THUMBNAIL_MEDIA_TYPE_V1,
    objectKey: `tenants/${TENANT}/client-thumbnails/image/${value.contentDigest}/g/${LOCATOR}`,
    objectLocatorToken: LOCATOR,
  };
}

function publication(value = input(), storedReceipt = receipt(value)): ClientThumbnailPublicationV1 {
  return {
    artifact: { artifactId: ARTIFACT, receipt: storedReceipt },
    createdBySubjectId: SUBJECT,
    lineage: {
      documentEpoch: value.documentEpoch,
      documentKey: value.documentKey,
      documentRevision: value.documentRevision,
      producerKind: "browser-wasm-wgpu",
      representativeFrameRule: "last-representable-in-duration",
      sceneContractVersion: 1,
      sceneRevisionHash: value.sceneRevisionHash,
    },
    projectId: PROJECT,
    publicationId: PUBLICATION,
    publishedAt: new Date("2026-08-18T00:00:00.000Z"),
    tenantId: TENANT,
  };
}

describe("ClientThumbnailPublisherV1", () => {
  it("publishes one exact 854x480 PNG and its Editor Document lineage", async () => {
    const value = input();
    const storedReceipt = receipt(value);
    const acceptPublication = vi.fn<ClientThumbnailRepositoryV1["acceptPublication"]>(async () => ({
      kind: "accepted" as const,
      publication: publication(value, storedReceipt),
      replayed: false,
    }));
    const put = vi.fn(async () => storedReceipt);
    const publisher = new ClientThumbnailPublisherV1({
      artifacts: partial<ClientThumbnailArtifactStoreV1>({ put, ready: async () => true }),
      publications: partial<ClientThumbnailRepositoryV1>({
        acceptPublication,
        readPublication: async () => null,
        ready: async () => true,
      }),
      tenantId: TENANT,
    });

    await expect(publisher.publish(value)).resolves.toMatchObject({ replayed: false });
    expect(put).toHaveBeenCalledWith(TENANT, { bytes: value.bytes, contentDigest: value.contentDigest }, undefined);
    expect(acceptPublication.mock.calls[0]?.[0]).toMatchObject({
      createdBySubjectId: SUBJECT,
      lineage: { documentRevision: 7n, representativeFrameRule: "last-representable-in-duration" },
      projectId: PROJECT,
    });
  });

  it("rejects wrong dimensions before writing an object", async () => {
    const put = vi.fn();
    const publisher = new ClientThumbnailPublisherV1({
      artifacts: partial<ClientThumbnailArtifactStoreV1>({ put, ready: async () => true }),
      publications: partial<ClientThumbnailRepositoryV1>({ ready: async () => true }),
      tenantId: TENANT,
    });
    await expect(publisher.publish(input(png(640, 360)))).rejects.toMatchObject({ status: 400 });
    expect(put).not.toHaveBeenCalled();
  });

  it("returns an exact replay without writing another object", async () => {
    const value = input();
    const put = vi.fn();
    const publisher = new ClientThumbnailPublisherV1({
      artifacts: partial<ClientThumbnailArtifactStoreV1>({ put, ready: async () => true }),
      publications: partial<ClientThumbnailRepositoryV1>({
        readPublication: async () => publication(value),
        ready: async () => true,
      }),
      tenantId: TENANT,
    });
    await expect(publisher.publish(value)).resolves.toMatchObject({ replayed: true });
    expect(put).not.toHaveBeenCalled();
  });
});
