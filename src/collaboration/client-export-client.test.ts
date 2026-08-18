import { describe, expect, it, vi } from "vitest";

import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import {
  ClientExportHttpClientErrorV1,
  type ClientExportPublishInputV1,
  FetchClientExportPublicationClientV1,
} from "./client-export-client";
import { CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1, decodeClientExportFinalizeBodyV1 } from "./client-export-http-contract";

const VIDEO = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
const PUBLICATION_ID = "00000000-0000-4000-8000-000000000002";
const ENCODER_EVIDENCE = {
  codec: "h264-mp4",
  frameRate: 30,
  resolution: "854x480",
  schema: "poietra.browser-webcodecs-encoder-evidence",
  version: 1,
} as const;

function input(): ClientExportPublishInputV1 {
  return {
    identity: { organizationId: "organization-a", projectId: "project-a" },
    metadata: {
      byteSize: VIDEO.byteLength,
      contentDigest: "a".repeat(64),
      documentEpoch: "00000000-0000-4000-8000-000000000001",
      documentKey: "b".repeat(64),
      documentRevision: "7",
      encoderEvidence: ENCODER_EVIDENCE,
      exportProfile: { schema: "poietra.export-profile" },
      projectId: "project-a",
      publicationId: PUBLICATION_ID,
      schema: "poietra.client-export-finalize",
      sceneRevisionHash: "c".repeat(64),
      version: 1,
    },
    video: VIDEO,
  };
}

function acceptedResponse(replayed = false) {
  const request = input().metadata;
  return {
    byteSize: request.byteSize,
    contentDigest: request.contentDigest,
    createdBySubjectId: "00000000-0000-4000-8000-000000000003",
    documentEpoch: request.documentEpoch,
    documentKey: request.documentKey,
    documentRevision: request.documentRevision,
    encoderEvidenceVersion: 1,
    expiresAt: "2026-09-01T00:00:00.000Z",
    exportProfileHash: "d".repeat(64),
    producerKind: "browser-webcodecs",
    projectId: request.projectId,
    publicationId: request.publicationId,
    publishedAt: "2026-08-18T00:00:00.000Z",
    replayed,
    sceneContractVersion: 1,
    sceneRevisionHash: request.sceneRevisionHash,
    videoPath: `/api/projects/project-a/exports/${PUBLICATION_ID}/video`,
  };
}

describe("client export publication HTTP client", () => {
  it("posts the exact binary envelope to the tenant-scoped neutral route", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(acceptedResponse(), { status: 201 }),
    );
    const client = new FetchClientExportPublicationClientV1(fetchImpl);

    await expect(client.publish(input())).resolves.toEqual(acceptedResponse());
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/projects/project-a/exports");
    expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin", method: "POST" });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe(CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1);
    expect(headers.get(POIETRA_ORGANIZATION_HEADER_V1)).toBe("organization-a");
    const decoded = decodeClientExportFinalizeBodyV1(init?.body as Uint8Array);
    expect(decoded.metadata).toEqual(input().metadata);
    expect([...decoded.video]).toEqual([...VIDEO]);
  });

  it("accepts an exact replay only with the replay status pairing", async () => {
    const client = new FetchClientExportPublicationClientV1(async () =>
      Response.json(acceptedResponse(true), { status: 200 }),
    );
    await expect(client.publish(input())).resolves.toMatchObject({ publicationId: PUBLICATION_ID, replayed: true });
  });

  it("fails closed on cross-lineage and inconsistent status responses", async () => {
    const wrongLineage = { ...acceptedResponse(), documentRevision: "8" };
    await expect(
      new FetchClientExportPublicationClientV1(async () => Response.json(wrongLineage, { status: 201 })).publish(
        input(),
      ),
    ).rejects.toBeInstanceOf(ClientExportHttpClientErrorV1);
    await expect(
      new FetchClientExportPublicationClientV1(async () =>
        Response.json(acceptedResponse(true), { status: 201 }),
      ).publish(input()),
    ).rejects.toBeInstanceOf(ClientExportHttpClientErrorV1);
  });

  it("marks transport failures outcome-unknown so callers can replay the same publication", async () => {
    const client = new FetchClientExportPublicationClientV1(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(client.publish(input())).rejects.toMatchObject({ outcomeMayBeUnknown: true, status: null });
  });

  it("refuses a project mismatch before issuing a request", async () => {
    const fetchImpl = vi.fn();
    const value = input();
    const client = new FetchClientExportPublicationClientV1(fetchImpl);
    await expect(client.publish({ ...value, identity: { ...value.identity, projectId: "project-b" } })).rejects.toThrow(
      /does not match/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
