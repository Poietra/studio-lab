import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import {
  type EditorDocumentCommitRequestV1,
  type EditorDocumentCommitResultViewV1,
  type EditorDocumentOpenRequestV1,
  type EditorDocumentOpenResultViewV1,
  type EditorDocumentTailResultViewV1,
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
  editorDocumentKeySchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentOpenResultViewSchemaV1,
  editorDocumentTailResultViewSchemaV1,
  editorRevisionStringSchemaV1,
} from "./editor-document-http-contract";

type FetchV1 = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class EditorDocumentHttpClientErrorV1 extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly outcomeMayBeUnknown: boolean,
  ) {
    super(message);
    this.name = "EditorDocumentHttpClientErrorV1";
  }
}

export type EditorDocumentClientIdentityV1 = Readonly<{
  organizationId: string;
  projectId: string;
}>;

export interface EditorDocumentClientV1 {
  commit(
    identity: EditorDocumentClientIdentityV1,
    documentKey: string,
    request: EditorDocumentCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentCommitResultViewV1>;
  open(
    identity: EditorDocumentClientIdentityV1,
    request: EditorDocumentOpenRequestV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentOpenResultViewV1>;
  tail(
    identity: EditorDocumentClientIdentityV1,
    documentKey: string,
    request: Readonly<{ afterRevision: string; epoch: string; limit?: string }>,
    signal?: AbortSignal,
  ): Promise<EditorDocumentTailResultViewV1>;
}

function parseIdentityV1(identity: EditorDocumentClientIdentityV1) {
  return {
    organizationId: accountOrganizationIdSchemaV1.parse(identity.organizationId),
    projectId: manimProjectIdSchema.parse(identity.projectId),
  };
}

function requestHeadersV1(organizationId: string, json: boolean) {
  const headers = new Headers({
    accept: "application/json",
    [POIETRA_ORGANIZATION_HEADER_V1]: organizationId,
  });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

async function jsonBodyV1(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new EditorDocumentHttpClientErrorV1(
      "The Editor service returned malformed JSON.",
      response.status,
      response.ok || response.status >= 500,
    );
  }
}

function unexpectedResponseV1(response: Response): never {
  throw new EditorDocumentHttpClientErrorV1(
    "The Editor service returned an unexpected response.",
    response.status,
    response.ok || response.status >= 500,
  );
}

function editorPathV1(projectId: string, suffix: string) {
  return `/api/editor/projects/${encodeURIComponent(projectId)}/${suffix}`;
}

export class FetchEditorDocumentClientV1 implements EditorDocumentClientV1 {
  constructor(private readonly fetchImpl: FetchV1 = fetch) {}

  async open(
    identityValue: EditorDocumentClientIdentityV1,
    requestValue: EditorDocumentOpenRequestV1,
    signal?: AbortSignal,
  ) {
    const identity = parseIdentityV1(identityValue);
    const request = editorDocumentOpenRequestSchemaV1.parse(requestValue);
    const response = await this.fetchImpl(editorPathV1(identity.projectId, "documents/open"), {
      body: JSON.stringify(request),
      cache: "no-store",
      credentials: "same-origin",
      headers: requestHeadersV1(identity.organizationId, true),
      method: "POST",
      signal,
    });
    const parsed = editorDocumentOpenResultViewSchemaV1.safeParse(await jsonBodyV1(response));
    if (!parsed.success) return unexpectedResponseV1(response);
    const statusMatches =
      (parsed.data.kind === "opened" && response.status === (parsed.data.created ? 201 : 200)) ||
      (parsed.data.kind === "not-found" && response.status === 404) ||
      (parsed.data.kind === "source-conflict" && response.status === 409);
    if (!statusMatches) return unexpectedResponseV1(response);
    return parsed.data;
  }

  async commit(
    identityValue: EditorDocumentClientIdentityV1,
    documentKeyValue: string,
    requestValue: EditorDocumentCommitRequestV1,
    signal?: AbortSignal,
  ) {
    const identity = parseIdentityV1(identityValue);
    const documentKey = editorDocumentKeySchemaV1.parse(documentKeyValue);
    const request = editorDocumentCommitRequestSchemaV1.parse(requestValue);
    const response = await this.fetchImpl(
      editorPathV1(identity.projectId, `documents/${encodeURIComponent(documentKey)}/events`),
      {
        body: JSON.stringify(request),
        cache: "no-store",
        credentials: "same-origin",
        headers: requestHeadersV1(identity.organizationId, true),
        method: "POST",
        signal,
      },
    );
    const parsed = editorDocumentCommitResultViewSchemaV1.safeParse(await jsonBodyV1(response));
    if (!parsed.success) return unexpectedResponseV1(response);
    const statusMatches =
      (parsed.data.kind === "committed" && response.status === (parsed.data.replayed ? 200 : 201)) ||
      (parsed.data.kind === "conflict" &&
        response.status ===
          (parsed.data.reason === "forbidden" ? 403 : parsed.data.reason === "not-found" ? 404 : 409));
    if (!statusMatches) return unexpectedResponseV1(response);
    return parsed.data;
  }

  async tail(
    identityValue: EditorDocumentClientIdentityV1,
    documentKeyValue: string,
    requestValue: Readonly<{ afterRevision: string; epoch: string; limit?: string }>,
    signal?: AbortSignal,
  ) {
    const identity = parseIdentityV1(identityValue);
    const documentKey = editorDocumentKeySchemaV1.parse(documentKeyValue);
    const afterRevision = editorRevisionStringSchemaV1.parse(requestValue.afterRevision);
    const limit = requestValue.limit ?? "32";
    if (!/^(?:[1-9]|[12][0-9]|3[0-2])$/u.test(limit)) {
      throw new TypeError("Editor tail limits must be canonical integers from 1 through 32.");
    }
    const query = new URLSearchParams({ afterRevision, epoch: requestValue.epoch, limit });
    const response = await this.fetchImpl(
      `${editorPathV1(identity.projectId, `documents/${encodeURIComponent(documentKey)}/events`)}?${query}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: requestHeadersV1(identity.organizationId, false),
        signal,
      },
    );
    const parsed = editorDocumentTailResultViewSchemaV1.safeParse(await jsonBodyV1(response));
    if (!parsed.success) return unexpectedResponseV1(response);
    if ((parsed.data === null && response.status !== 404) || (parsed.data !== null && response.status !== 200)) {
      return unexpectedResponseV1(response);
    }
    return parsed.data;
  }
}

export function editorCommitOutcomeMayBeUnknownV1(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return !(error instanceof EditorDocumentHttpClientErrorV1) || error.outcomeMayBeUnknown;
}
