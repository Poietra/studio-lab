import { accountOrganizationIdSchemaV1 } from "../accounts/account-session-contract";
import { POIETRA_ORGANIZATION_HEADER_V1 } from "../accounts/organization-scoped-manim-fetch";
import { manimProjectIdSchema } from "../render-pipeline/contracts";
import {
  type EditorDocumentCommitRequestV1,
  type EditorDocumentCommitResultViewV1,
  type EditorDocumentOpenRequestV1,
  type EditorDocumentOpenResultViewV1,
  type EditorDocumentSessionPutRequestV1,
  type EditorDocumentSessionPutResultViewV1,
  type EditorDocumentSessionReadResultViewV1,
  type EditorDocumentTailResultViewV1,
  editorDocumentCommitRequestSchemaV1,
  editorDocumentCommitResultViewSchemaV1,
  editorDocumentKeySchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentOpenResultViewSchemaV1,
  editorDocumentSessionPutRequestSchemaV1,
  editorDocumentSessionPutResultViewSchemaV1,
  editorDocumentSessionQuerySchemaV1,
  editorDocumentSessionReadResultViewSchemaV1,
  editorDocumentTailResultViewSchemaV1,
  editorRevisionStringSchemaV1,
} from "./editor-document-http-contract";
import { canonicalEditorSessionSnapshotJsonV1 } from "./editor-session-contract";

type FetchV1 = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const MAX_EDITOR_SESSION_KEEPALIVE_BODY_BYTES_V1 = 64 * 1024;

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
  putSession(
    identity: EditorDocumentClientIdentityV1,
    documentKey: string,
    request: EditorDocumentSessionPutRequestV1,
    signal?: AbortSignal,
  ): Promise<EditorDocumentSessionPutResultViewV1>;
  readSession(
    identity: EditorDocumentClientIdentityV1,
    documentKey: string,
    request: Readonly<{ epoch: string }>,
    signal?: AbortSignal,
  ): Promise<EditorDocumentSessionReadResultViewV1>;
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

function prepareSessionPutV1(
  identityValue: EditorDocumentClientIdentityV1,
  documentKeyValue: string,
  requestValue: EditorDocumentSessionPutRequestV1,
) {
  const identity = parseIdentityV1(identityValue);
  const documentKey = editorDocumentKeySchemaV1.parse(documentKeyValue);
  const request = editorDocumentSessionPutRequestSchemaV1.parse(requestValue);
  const query = new URLSearchParams({ epoch: request.epoch });
  return {
    body: JSON.stringify(request),
    documentKey,
    identity,
    path: `${editorPathV1(identity.projectId, `documents/${encodeURIComponent(documentKey)}/session`)}?${query}`,
    request,
  } as const;
}

/**
 * Starts one bounded session PUT that may outlive the current page. A true
 * return value means only that fetch was invoked; it is never an
 * acknowledgement, so the exact local journal entry must remain retained.
 */
export function attemptEditorDocumentSessionKeepaliveV1(
  identityValue: EditorDocumentClientIdentityV1,
  documentKeyValue: string,
  requestValue: EditorDocumentSessionPutRequestV1,
  fetchImpl: FetchV1 = globalThis.fetch.bind(globalThis),
) {
  const prepared = prepareSessionPutV1(identityValue, documentKeyValue, requestValue);
  if (new TextEncoder().encode(prepared.body).byteLength > MAX_EDITOR_SESSION_KEEPALIVE_BODY_BYTES_V1) {
    return false;
  }
  try {
    const response = fetchImpl(prepared.path, {
      body: prepared.body,
      cache: "no-store",
      credentials: "same-origin",
      headers: requestHeadersV1(prepared.identity.organizationId, true),
      keepalive: true,
      method: "PUT",
    });
    void response.catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function sessionIdentityMatchesV1(
  session: Readonly<{ documentKey: string; epoch: string; projectId: string; tenantId: string }>,
  expected: Readonly<{ documentKey: string; epoch: string; organizationId: string; projectId: string }>,
) {
  return (
    session.tenantId === expected.organizationId &&
    session.projectId === expected.projectId &&
    session.documentKey === expected.documentKey &&
    session.epoch === expected.epoch
  );
}

async function sessionSnapshotEvidenceMatchesV1(
  snapshot: unknown,
  evidence: Readonly<{ snapshotByteSize: number; snapshotDigest: string }>,
) {
  const bytes = new TextEncoder().encode(canonicalEditorSessionSnapshotJsonV1(snapshot));
  if (bytes.byteLength !== evidence.snapshotByteSize) return false;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const digestHex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return digestHex === evidence.snapshotDigest;
}

export class FetchEditorDocumentClientV1 implements EditorDocumentClientV1 {
  constructor(private readonly fetchImpl: FetchV1 = globalThis.fetch.bind(globalThis)) {}

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
    if (parsed.data.kind === "committed") {
      if ((request.sessionUpdate === undefined) !== (parsed.data.sessionUpdate === undefined)) {
        return unexpectedResponseV1(response);
      }
      if (request.sessionUpdate !== undefined && parsed.data.sessionUpdate !== undefined) {
        if (
          parsed.data.sessionUpdate.documentRevision !== request.sessionUpdate.documentRevision ||
          BigInt(parsed.data.sessionUpdate.sessionGeneration) !==
            BigInt(request.sessionUpdate.expectedSessionGeneration) + 1n ||
          parsed.data.sessionUpdate.snapshotVersion !== request.sessionUpdate.snapshotVersion ||
          !(await sessionSnapshotEvidenceMatchesV1(request.sessionUpdate.snapshot, parsed.data.sessionUpdate))
        ) {
          return unexpectedResponseV1(response);
        }
      }
    }
    return parsed.data;
  }

  async readSession(
    identityValue: EditorDocumentClientIdentityV1,
    documentKeyValue: string,
    requestValue: Readonly<{ epoch: string }>,
    signal?: AbortSignal,
  ) {
    const identity = parseIdentityV1(identityValue);
    const documentKey = editorDocumentKeySchemaV1.parse(documentKeyValue);
    const request = editorDocumentSessionQuerySchemaV1.parse(requestValue);
    const query = new URLSearchParams(request);
    const response = await this.fetchImpl(
      `${editorPathV1(identity.projectId, `documents/${encodeURIComponent(documentKey)}/session`)}?${query}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        headers: requestHeadersV1(identity.organizationId, false),
        signal,
      },
    );
    const parsed = editorDocumentSessionReadResultViewSchemaV1.safeParse(await jsonBodyV1(response));
    if (!parsed.success) return unexpectedResponseV1(response);
    if (
      (parsed.data.kind === "unavailable" && response.status !== 404) ||
      (parsed.data.kind === "available" && response.status !== 200)
    ) {
      return unexpectedResponseV1(response);
    }
    if (
      parsed.data.kind === "available" &&
      (!sessionIdentityMatchesV1(parsed.data.session, { documentKey, epoch: request.epoch, ...identity }) ||
        !(await sessionSnapshotEvidenceMatchesV1(parsed.data.session.snapshot, parsed.data.session)))
    ) {
      return unexpectedResponseV1(response);
    }
    return parsed.data;
  }

  async putSession(
    identityValue: EditorDocumentClientIdentityV1,
    documentKeyValue: string,
    requestValue: EditorDocumentSessionPutRequestV1,
    signal?: AbortSignal,
  ) {
    const prepared = prepareSessionPutV1(identityValue, documentKeyValue, requestValue);
    const response = await this.fetchImpl(prepared.path, {
      body: prepared.body,
      cache: "no-store",
      credentials: "same-origin",
      headers: requestHeadersV1(prepared.identity.organizationId, true),
      method: "PUT",
      signal,
    });
    const parsed = editorDocumentSessionPutResultViewSchemaV1.safeParse(await jsonBodyV1(response));
    if (!parsed.success) return unexpectedResponseV1(response);
    const statusMatches =
      (parsed.data.kind === "stored" && response.status === 200) ||
      (parsed.data.kind === "conflict" &&
        response.status ===
          (parsed.data.reason === "forbidden" ? 403 : parsed.data.reason === "not-found" ? 404 : 409));
    if (!statusMatches) return unexpectedResponseV1(response);
    if (parsed.data.kind === "stored") {
      if (
        !sessionIdentityMatchesV1(parsed.data.session, {
          documentKey: prepared.documentKey,
          epoch: prepared.request.epoch,
          ...prepared.identity,
        }) ||
        parsed.data.session.documentRevision !== prepared.request.documentRevision ||
        BigInt(parsed.data.session.sessionGeneration) !== BigInt(prepared.request.expectedSessionGeneration) + 1n ||
        parsed.data.session.snapshotVersion !== prepared.request.snapshotVersion ||
        canonicalEditorSessionSnapshotJsonV1(parsed.data.session.snapshot) !==
          canonicalEditorSessionSnapshotJsonV1(prepared.request.snapshot) ||
        !(await sessionSnapshotEvidenceMatchesV1(parsed.data.session.snapshot, parsed.data.session))
      ) {
        return unexpectedResponseV1(response);
      }
    }
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
  return !(error instanceof EditorDocumentHttpClientErrorV1) || error.outcomeMayBeUnknown;
}
