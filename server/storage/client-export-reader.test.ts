import { describe, expect, it, vi } from "vitest";

import type {
  ClientExportArtifactStoreV1,
  ClientExportPublicationV1,
  ClientExportRepositoryV1,
} from "./client-export-contract";
import { ClientExportReaderV1 } from "./client-export-reader";

const PUBLICATION_ID = "00000000-0000-4000-8000-000000000010";

function publication(expiresAt: Date): ClientExportPublicationV1 {
  return {
    artifact: {
      artifactId: "00000000-0000-4000-8000-000000000020",
      receipt: {
        byteSize: 1,
        contentDigest: "a".repeat(64),
        etag: "etag",
        mediaType: "video/mp4",
        objectKey: `tenants/tenant-a/client-exports/video/${"a".repeat(64)}/g/00000000-0000-4000-8000-000000000030`,
        objectLocatorToken: "00000000-0000-4000-8000-000000000030",
      },
    },
    createdBySubjectId: "00000000-0000-4000-8000-000000000040",
    expiresAt,
    lineage: {
      documentEpoch: "00000000-0000-4000-8000-000000000050",
      documentKey: "b".repeat(64),
      documentRevision: 0n,
      encoderEvidence: {},
      encoderEvidenceVersion: 1,
      exportProfileHash: "c".repeat(64),
      producerKind: "browser-webcodecs",
      sceneContractVersion: 1,
      sceneRevisionHash: "d".repeat(64),
    },
    projectId: "project-a",
    publicationId: PUBLICATION_ID,
    publishedAt: new Date("2026-08-18T00:00:00.000Z"),
    tenantId: "tenant-a",
  };
}

function reader(stored: ClientExportPublicationV1) {
  const repository = {
    readPublication: vi.fn(async () => stored),
  } as unknown as ClientExportRepositoryV1;
  return new ClientExportReaderV1({
    repository,
    store: {} as ClientExportArtifactStoreV1,
    tenantId: "tenant-a",
  });
}

describe("ClientExportReaderV1", () => {
  it("returns a live publication", async () => {
    await expect(
      reader(publication(new Date("2999-01-01T00:00:00.000Z"))).publication("project-a", PUBLICATION_ID),
    ).resolves.toMatchObject({ publicationId: PUBLICATION_ID });
  });

  it("does not address an expired publication while its GC row still exists", async () => {
    await expect(
      reader(publication(new Date("2000-01-01T00:00:00.000Z"))).publication("project-a", PUBLICATION_ID),
    ).rejects.toMatchObject({ status: 404 });
  });
});
