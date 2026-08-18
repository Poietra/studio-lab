import { describe, expect, it, vi } from "vitest";

import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { FetchClientThumbnailPublicationClientV1 } from "./client-thumbnail-client";
import {
  CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1,
  type ClientThumbnailFinalizeMetadataV1,
  decodeClientThumbnailFinalizeBodyV1,
} from "./client-thumbnail-http-contract";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const metadata: ClientThumbnailFinalizeMetadataV1 = {
  byteSize: PNG.byteLength,
  contentDigest: "a".repeat(64),
  documentEpoch: "00000000-0000-4000-8000-000000000001",
  documentKey: "b".repeat(64),
  documentRevision: "7",
  producerKind: "browser-wasm-wgpu",
  projectId: "project-a",
  publicationId: "00000000-0000-4000-8000-000000000002",
  representativeFrameRule: "last-representable-in-duration",
  sceneContractVersion: 1,
  sceneRevisionHash: "c".repeat(64),
  schema: "poietra.client-thumbnail-finalize",
  version: 1,
};

function response(replayed = false) {
  const { schema: _schema, version: _version, ...published } = metadata;
  return {
    ...published,
    createdBySubjectId: "00000000-0000-4000-8000-000000000003",
    imagePath: "/api/projects/project-a/thumbnail",
    publishedAt: "2026-08-18T00:00:00.000Z",
    replayed,
  };
}

describe("client thumbnail publication HTTP client", () => {
  it("posts the exact PNG envelope to the tenant-scoped project route", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(response(), { status: 201 }),
    );
    const client = new FetchClientThumbnailPublicationClientV1(fetchImpl);
    await expect(client.publish({ metadata, organizationId: "organization-a", png: PNG })).resolves.toEqual(response());
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/api/projects/project-a/thumbnails");
    expect(new Headers(init?.headers).get("content-type")).toBe(CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1);
    expect(new Headers(init?.headers).get(POIETRA_ORGANIZATION_HEADER_V1)).toBe("organization-a");
    expect(decodeClientThumbnailFinalizeBodyV1(init?.body as Uint8Array).metadata).toEqual(metadata);
  });

  it("fails closed on a cross-lineage response or inconsistent replay status", async () => {
    await expect(
      new FetchClientThumbnailPublicationClientV1(async () =>
        Response.json({ ...response(), documentRevision: "8" }, { status: 201 }),
      ).publish({ metadata, organizationId: "organization-a", png: PNG }),
    ).rejects.toThrow(/unexpected response/i);
    await expect(
      new FetchClientThumbnailPublicationClientV1(async () => Response.json(response(true), { status: 201 })).publish({
        metadata,
        organizationId: "organization-a",
        png: PNG,
      }),
    ).rejects.toThrow(/unexpected response/i);
  });
});
