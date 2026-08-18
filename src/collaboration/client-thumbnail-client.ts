import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import {
  CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1,
  type ClientThumbnailFinalizeMetadataV1,
  type ClientThumbnailPublicationViewV1,
  clientThumbnailFinalizeMetadataSchemaV1,
  clientThumbnailImagePathV1,
  clientThumbnailPublicationViewSchemaV1,
  encodeClientThumbnailFinalizeBodyV1,
} from "./client-thumbnail-http-contract";

export interface ClientThumbnailPublicationClientV1 {
  publish(
    input: Readonly<{
      metadata: ClientThumbnailFinalizeMetadataV1;
      organizationId: string;
      png: Uint8Array;
    }>,
    signal?: AbortSignal,
  ): Promise<ClientThumbnailPublicationViewV1>;
}

export class FetchClientThumbnailPublicationClientV1 implements ClientThumbnailPublicationClientV1 {
  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)) {}

  async publish(input: Parameters<ClientThumbnailPublicationClientV1["publish"]>[0], signal?: AbortSignal) {
    const organizationId = accountOrganizationIdSchemaV1.parse(input.organizationId);
    const metadata = clientThumbnailFinalizeMetadataSchemaV1.parse(input.metadata);
    manimProjectIdSchema.parse(metadata.projectId);
    const response = await this.fetchImpl(`/api/projects/${encodeURIComponent(metadata.projectId)}/thumbnails`, {
      body: encodeClientThumbnailFinalizeBodyV1(metadata, input.png),
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1,
        [POIETRA_ORGANIZATION_HEADER_V1]: organizationId,
      },
      method: "POST",
      signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("The thumbnail publication service returned malformed JSON.");
    }
    const parsed = clientThumbnailPublicationViewSchemaV1.safeParse(value);
    if (
      !parsed.success ||
      ![200, 201].includes(response.status) ||
      parsed.data.replayed !== (response.status === 200) ||
      parsed.data.projectId !== metadata.projectId ||
      parsed.data.publicationId !== metadata.publicationId ||
      parsed.data.contentDigest !== metadata.contentDigest ||
      parsed.data.byteSize !== metadata.byteSize ||
      parsed.data.documentEpoch !== metadata.documentEpoch ||
      parsed.data.documentKey !== metadata.documentKey ||
      parsed.data.documentRevision !== metadata.documentRevision ||
      parsed.data.producerKind !== metadata.producerKind ||
      parsed.data.representativeFrameRule !== metadata.representativeFrameRule ||
      parsed.data.sceneContractVersion !== metadata.sceneContractVersion ||
      parsed.data.sceneRevisionHash !== metadata.sceneRevisionHash ||
      parsed.data.imagePath !== clientThumbnailImagePathV1(metadata.projectId)
    ) {
      throw new Error("The thumbnail publication service returned an unexpected response.");
    }
    return parsed.data;
  }
}
