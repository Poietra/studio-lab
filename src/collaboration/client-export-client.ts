import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import {
  CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1,
  type ClientExportFinalizeMetadataV1,
  type ClientExportFinalizeResponseV1,
  clientExportFinalizeMetadataSchemaV1,
  clientExportFinalizeResponseSchemaV1,
  clientExportPublicationVideoPathV1,
  encodeClientExportFinalizeBodyV1,
} from "./client-export-http-contract";

type FetchV1 = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ClientExportPublicationIdentityV1 = Readonly<{
  organizationId: string;
  projectId: string;
}>;

export type ClientExportPublishInputV1 = Readonly<{
  identity: ClientExportPublicationIdentityV1;
  metadata: ClientExportFinalizeMetadataV1;
  video: Uint8Array;
}>;

export interface ClientExportPublicationClientV1 {
  publish(input: ClientExportPublishInputV1, signal?: AbortSignal): Promise<ClientExportFinalizeResponseV1>;
}

export class ClientExportHttpClientErrorV1 extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly outcomeMayBeUnknown: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientExportHttpClientErrorV1";
  }
}

function responseMatchesRequestV1(response: ClientExportFinalizeResponseV1, request: ClientExportFinalizeMetadataV1) {
  return (
    response.byteSize === request.byteSize &&
    response.contentDigest === request.contentDigest &&
    response.documentEpoch === request.documentEpoch &&
    response.documentKey === request.documentKey &&
    response.documentRevision === request.documentRevision &&
    response.projectId === request.projectId &&
    response.publicationId === request.publicationId &&
    response.sceneRevisionHash === request.sceneRevisionHash &&
    response.videoPath === clientExportPublicationVideoPathV1(request.projectId, request.publicationId)
  );
}

export class FetchClientExportPublicationClientV1 implements ClientExportPublicationClientV1 {
  constructor(private readonly fetchImpl: FetchV1 = globalThis.fetch.bind(globalThis)) {}

  async publish(input: ClientExportPublishInputV1, signal?: AbortSignal) {
    const identity = {
      organizationId: accountOrganizationIdSchemaV1.parse(input.identity.organizationId),
      projectId: manimProjectIdSchema.parse(input.identity.projectId),
    };
    const metadata = clientExportFinalizeMetadataSchemaV1.parse(input.metadata);
    if (identity.projectId !== metadata.projectId) {
      throw new TypeError("The client export project does not match its publication identity.");
    }
    const body = encodeClientExportFinalizeBodyV1(metadata, input.video);
    let response: Response;
    try {
      response = await this.fetchImpl(`/api/projects/${encodeURIComponent(identity.projectId)}/exports`, {
        body,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1,
          [POIETRA_ORGANIZATION_HEADER_V1]: identity.organizationId,
        },
        method: "POST",
        signal,
      });
    } catch (cause) {
      throw new ClientExportHttpClientErrorV1(
        "The export publication request did not receive an acknowledgement.",
        null,
        true,
        { cause },
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (cause) {
      throw new ClientExportHttpClientErrorV1(
        "The export publication service returned malformed JSON.",
        response.status,
        response.ok || response.status >= 500,
        { cause },
      );
    }
    const parsed = clientExportFinalizeResponseSchemaV1.safeParse(value);
    if (
      !parsed.success ||
      !((response.status === 200 && parsed.data.replayed) || (response.status === 201 && !parsed.data.replayed)) ||
      !responseMatchesRequestV1(parsed.data, metadata)
    ) {
      throw new ClientExportHttpClientErrorV1(
        "The export publication service returned an unexpected response.",
        response.status,
        response.ok || response.status >= 500,
      );
    }
    return parsed.data;
  }
}
