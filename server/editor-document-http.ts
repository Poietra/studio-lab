import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  editorDocumentCommitRequestSchemaV1,
  editorDocumentKeySchemaV1,
  editorDocumentOpenRequestSchemaV1,
  editorDocumentSessionPutRequestSchemaV1,
  parseEditorDocumentSessionQueryV1,
  parseEditorDocumentTailQueryV1,
  serializeEditorDocumentCommitResultV1,
  serializeEditorDocumentOpenResultV1,
  serializeEditorDocumentSessionPutResultV1,
  serializeEditorDocumentSessionViewV1,
  serializeEditorDocumentTailResultV1,
} from "../src/collaboration/editor-document-http-contract";
import {
  canonicalEditorSessionSnapshotJsonV1,
  editorSessionSnapshotByteSizeV1,
} from "../src/collaboration/editor-session-contract";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import { accountUserIdSchemaV1 } from "./accounts/account-domain";
import { fastManimSnapshotSceneIdV1 } from "./fast-manim-snapshot-contract";
import { HttpError, readJsonBody, sendJson } from "./http/json";
import { isVerifiedManimPrincipal, type VerifiedManimPrincipal } from "./manim-request-principal";
import type {
  EditorDocumentRepositoryV1,
  EditorDocumentV1,
  EditorEditEventV1,
} from "./storage/editor-document-repository";
import { createEditorDocumentKeyV1, MAX_EDITOR_PROGRAM_BYTES_V1 } from "./storage/editor-document-repository";

const OPEN_ROUTE_V1 = /^\/api\/editor\/projects\/([^/]+)\/documents\/open$/u;
const EVENT_ROUTE_V1 = /^\/api\/editor\/projects\/([^/]+)\/documents\/([^/]+)\/events$/u;
const SESSION_ROUTE_V1 = /^\/api\/editor\/projects\/([^/]+)\/documents\/([^/]+)\/session$/u;
const MAX_OPEN_BODY_BYTES_V1 = 16 * 1024;
export const MAX_EDITOR_DOCUMENT_COMMIT_BODY_BYTES_V1 = 672 * 1024;
const MAX_SESSION_PUT_BODY_BYTES_V1 = 416 * 1024;

export type EditorDocumentHttpOptionsV1 = Readonly<{
  expectedMutationOrigin?: string;
  maxJsonBodyBytes?: number;
  requestSignal?: AbortSignal;
}>;

export function isEditorDocumentRequest(pathname: string) {
  return OPEN_ROUTE_V1.test(pathname) || EVENT_ROUTE_V1.test(pathname) || SESSION_ROUTE_V1.test(pathname);
}

function bodyLimitV1(configured: number | undefined, routeLimit: number) {
  if (configured === undefined) return routeLimit;
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new RangeError("Maximum Editor JSON request size must be a positive integer.");
  }
  return Math.min(configured, routeLimit);
}

function requireSameOriginJsonMutationV1(request: IncomingMessage, expectedOrigin?: string) {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    request.resume();
    throw new HttpError("Editor mutations require an application/json request.", 415);
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin Editor mutations are not allowed.", 403);
  }

  const origin = request.headers.origin;
  if (expectedOrigin !== undefined) {
    let actualOrigin: string | null = null;
    try {
      const parsed = typeof origin === "string" ? new URL(origin) : null;
      actualOrigin =
        parsed && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
          ? parsed.origin
          : null;
    } catch {
      // The fixed public error below intentionally does not echo an untrusted Origin.
    }
    if (actualOrigin !== expectedOrigin) {
      request.resume();
      throw new HttpError("Editor mutations require the configured public Origin.", 403);
    }
    return;
  }
  if (origin === undefined) return;
  const host = request.headers.host;
  try {
    const parsed = new URL(origin);
    const requestProtocol = "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
    if (
      !host ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.protocol !== requestProtocol ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.host.toLowerCase() !== host.toLowerCase()
    ) {
      throw new Error("Origin does not match Host.");
    }
  } catch {
    request.resume();
    throw new HttpError("Editor mutations require a same-origin request.", 403);
  }
}

function documentIdentityV1(
  document: EditorDocumentV1,
  expected: Readonly<{ documentKey?: string; epoch?: string; projectId: string; tenantId: string }>,
) {
  if (
    document.tenantId !== expected.tenantId ||
    document.projectId !== expected.projectId ||
    (expected.documentKey !== undefined && document.documentKey !== expected.documentKey) ||
    (expected.epoch !== undefined && document.epoch !== expected.epoch)
  ) {
    throw new TypeError("Editor storage returned a document outside the authenticated request identity.");
  }
}

function eventIdentityV1(
  event: EditorEditEventV1,
  expected: Readonly<{ documentKey: string; epoch: string; projectId: string; tenantId: string }>,
) {
  if (
    event.tenantId !== expected.tenantId ||
    event.projectId !== expected.projectId ||
    event.documentKey !== expected.documentKey ||
    event.epoch !== expected.epoch
  ) {
    throw new TypeError("Editor storage returned an event outside the authenticated request identity.");
  }
}

type EditorSessionIdentityShapeV1 = Readonly<{
  documentKey: string;
  documentRevision: bigint;
  epoch: string;
  projectId: string;
  sessionGeneration: bigint;
  snapshot: unknown;
  snapshotVersion: number;
  subjectId: string;
  tenantId: string;
}>;

function sessionIdentityV1(
  session: EditorSessionIdentityShapeV1,
  expected: Readonly<{
    documentKey: string;
    documentRevision?: bigint;
    epoch: string;
    projectId: string;
    subjectId: string;
    tenantId: string;
  }>,
) {
  if (
    session.tenantId !== expected.tenantId ||
    session.projectId !== expected.projectId ||
    session.documentKey !== expected.documentKey ||
    session.subjectId !== expected.subjectId ||
    session.epoch !== expected.epoch ||
    (expected.documentRevision !== undefined && session.documentRevision !== expected.documentRevision)
  ) {
    throw new TypeError("Editor storage returned a session outside the authenticated request identity.");
  }
}

function sessionSnapshotEvidenceV1(
  session: EditorSessionIdentityShapeV1 & { snapshotByteSize: number; snapshotDigest: string },
) {
  const canonical = canonicalEditorSessionSnapshotJsonV1(session.snapshot);
  if (
    session.snapshotByteSize !== Buffer.byteLength(canonical, "utf8") ||
    session.snapshotDigest !== createHash("sha256").update(canonical, "utf8").digest("hex")
  ) {
    throw new TypeError("Editor storage returned inconsistent session snapshot evidence.");
  }
}

function requireAccountSubjectV1(principal: VerifiedManimPrincipal, request: IncomingMessage) {
  if (!accountUserIdSchemaV1.safeParse(principal.subjectId).success) {
    request.resume();
    throw new HttpError("Editor sessions and mutations require an account actor.", 403);
  }
  return principal.subjectId;
}

function methodNotAllowedV1(response: ServerResponse, allow: string) {
  response.setHeader("allow", allow);
  sendJson(response, 405, { error: "Method not allowed." });
}

function parseProjectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("Editor project identity is invalid.", 400);
  return parsed.data;
}

function parseDocumentKeyV1(value: string) {
  const parsed = editorDocumentKeySchemaV1.safeParse(value);
  if (!parsed.success) throw new HttpError("Editor document identity is invalid.", 400);
  return parsed.data;
}

async function openDocumentV1(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal | undefined,
  options: EditorDocumentHttpOptionsV1,
) {
  if (request.method !== "POST") {
    request.resume();
    return methodNotAllowedV1(response, "POST");
  }
  requireSameOriginJsonMutationV1(request, options.expectedMutationOrigin);
  const parsed = editorDocumentOpenRequestSchemaV1.safeParse(
    await readJsonBody(request, bodyLimitV1(options.maxJsonBodyBytes, MAX_OPEN_BODY_BYTES_V1)),
  );
  if (!parsed.success) throw new HttpError("Editor document open request is invalid.", 400);
  signal?.throwIfAborted();
  const sceneId = fastManimSnapshotSceneIdV1(parsed.data.sourcePath, parsed.data.sceneName);
  const result = await repository.openDocument(
    {
      projectId,
      sceneId,
      sourceHash: parsed.data.sourceHash,
      sourcePath: parsed.data.sourcePath,
      tenantId: principal.tenantId,
    },
    signal,
  );
  if (result.kind === "opened") {
    documentIdentityV1(result.document, {
      documentKey: createEditorDocumentKeyV1(parsed.data.sourcePath, sceneId),
      projectId,
      tenantId: principal.tenantId,
    });
    if (
      result.document.sourcePath !== parsed.data.sourcePath ||
      result.document.sourceHash !== parsed.data.sourceHash ||
      result.document.sealedAt !== null ||
      result.projection.revision !== result.document.revision
    ) {
      throw new TypeError("Editor storage returned an inconsistent open document.");
    }
  }
  const view = serializeEditorDocumentOpenResultV1(result);
  sendJson(
    response,
    result.kind === "opened" ? (result.created ? 201 : 200) : result.kind === "not-found" ? 404 : 409,
    view,
  );
}

async function readTailV1(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  documentKey: string,
  url: URL,
  response: ServerResponse,
  signal: AbortSignal | undefined,
) {
  let query: ReturnType<typeof parseEditorDocumentTailQueryV1>;
  try {
    query = parseEditorDocumentTailQueryV1(url.searchParams);
  } catch {
    throw new HttpError("Editor event-tail query is invalid.", 400);
  }
  const requestedLimit = Number(query.limit);
  signal?.throwIfAborted();
  const result = await repository.readEventTail(
    {
      afterRevision: BigInt(query.afterRevision),
      documentKey,
      epoch: query.epoch,
      limit: requestedLimit,
      projectId,
      tenantId: principal.tenantId,
    },
    signal,
  );
  if (result !== null) {
    if (result.events.length > requestedLimit) {
      throw new TypeError("Editor storage returned an event tail beyond the requested limit.");
    }
    const identity = { documentKey, epoch: query.epoch, projectId, tenantId: principal.tenantId };
    documentIdentityV1(result.document, identity);
    const afterRevision = BigInt(query.afterRevision);
    if (afterRevision > result.document.revision) {
      throw new HttpError("Editor event-tail revision is ahead of the document.", 409);
    }
    if (result.events.length === 0 && afterRevision < result.document.revision) {
      throw new TypeError("Editor storage returned an incomplete event tail.");
    }
    let expectedBaseRevision = afterRevision;
    for (const event of result.events) {
      eventIdentityV1(event, identity);
      if (event.baseRevision !== expectedBaseRevision || event.revision !== event.baseRevision + 1n) {
        throw new TypeError("Editor storage returned a non-contiguous event tail.");
      }
      expectedBaseRevision = event.revision;
    }
    if (expectedBaseRevision > result.document.revision) {
      throw new TypeError("Editor storage returned an event tail ahead of its document.");
    }
  }
  sendJson(response, result === null ? 404 : 200, serializeEditorDocumentTailResultV1(result));
}

async function commitEventV1(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  documentKey: string,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal | undefined,
  options: EditorDocumentHttpOptionsV1,
) {
  requireSameOriginJsonMutationV1(request, options.expectedMutationOrigin);
  const subjectId = requireAccountSubjectV1(principal, request);
  const parsed = editorDocumentCommitRequestSchemaV1.safeParse(
    await readJsonBody(request, bodyLimitV1(options.maxJsonBodyBytes, MAX_EDITOR_DOCUMENT_COMMIT_BODY_BYTES_V1)),
  );
  if (!parsed.success) throw new HttpError("Editor mutation request is invalid.", 400);
  if (Buffer.byteLength(canonicalJsonV1(parsed.data.mutation.program), "utf8") > MAX_EDITOR_PROGRAM_BYTES_V1) {
    throw new HttpError("Editor mutation request is invalid.", 400);
  }
  signal?.throwIfAborted();
  const result = await repository.commitMutation(
    {
      baseRevision: BigInt(parsed.data.baseRevision),
      clientMutationId: parsed.data.clientMutationId,
      documentKey,
      epoch: parsed.data.epoch,
      mutation: parsed.data.mutation,
      projectId,
      ...(parsed.data.sessionUpdate === undefined
        ? {}
        : {
            sessionUpdate: {
              documentRevision: BigInt(parsed.data.sessionUpdate.documentRevision),
              expectedSessionGeneration: BigInt(parsed.data.sessionUpdate.expectedSessionGeneration),
              snapshot: parsed.data.sessionUpdate.snapshot,
              snapshotVersion: parsed.data.sessionUpdate.snapshotVersion,
            },
          }),
      subjectId,
      tenantId: principal.tenantId,
    },
    signal,
  );
  if (result.kind === "committed") {
    const identity = { documentKey, epoch: parsed.data.epoch, projectId, tenantId: principal.tenantId };
    documentIdentityV1(result.document, identity);
    eventIdentityV1(result.event, identity);
    const revisionIsConsistent = result.replayed
      ? result.document.revision >= result.event.revision
      : result.document.revision === result.event.revision;
    if (
      result.event.subjectId !== subjectId ||
      result.event.clientMutationId !== parsed.data.clientMutationId ||
      result.event.baseRevision !== BigInt(parsed.data.baseRevision) ||
      result.event.revision !== result.event.baseRevision + 1n ||
      !revisionIsConsistent ||
      canonicalJsonV1(result.event.mutation) !== canonicalJsonV1(parsed.data.mutation)
    ) {
      throw new TypeError("Editor storage returned an event inconsistent with the mutation request.");
    }
    if ((parsed.data.sessionUpdate === undefined) !== (result.sessionUpdate === undefined)) {
      throw new TypeError("Editor storage returned an inconsistent atomic session result.");
    }
    if (parsed.data.sessionUpdate !== undefined && result.sessionUpdate !== undefined) {
      const expectedGeneration = BigInt(parsed.data.sessionUpdate.expectedSessionGeneration) + 1n;
      const canonicalSnapshot = canonicalEditorSessionSnapshotJsonV1(parsed.data.sessionUpdate.snapshot);
      if (
        result.sessionUpdate.documentRevision !== BigInt(parsed.data.sessionUpdate.documentRevision) ||
        result.sessionUpdate.sessionGeneration !== expectedGeneration ||
        result.sessionUpdate.snapshotVersion !== parsed.data.sessionUpdate.snapshotVersion ||
        result.sessionUpdate.snapshotByteSize !== editorSessionSnapshotByteSizeV1(parsed.data.sessionUpdate.snapshot) ||
        result.sessionUpdate.snapshotDigest !== createHash("sha256").update(canonicalSnapshot, "utf8").digest("hex")
      ) {
        throw new TypeError("Editor storage returned a session inconsistent with the atomic mutation request.");
      }
    }
  }
  const view = serializeEditorDocumentCommitResultV1(result);
  const status =
    result.kind === "committed"
      ? result.replayed
        ? 200
        : 201
      : result.reason === "forbidden"
        ? 403
        : result.reason === "not-found"
          ? 404
          : 409;
  sendJson(response, status, view);
}

async function readSessionV1(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  documentKey: string,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  signal: AbortSignal | undefined,
) {
  const subjectId = requireAccountSubjectV1(principal, request);
  let query: ReturnType<typeof parseEditorDocumentSessionQueryV1>;
  try {
    query = parseEditorDocumentSessionQueryV1(url.searchParams);
  } catch {
    throw new HttpError("Editor session query is invalid.", 400);
  }
  signal?.throwIfAborted();
  const result = await repository.readSessionSnapshot(
    { documentKey, epoch: query.epoch, projectId, subjectId, tenantId: principal.tenantId },
    signal,
  );
  if (result !== null) {
    sessionIdentityV1(result, {
      documentKey,
      epoch: query.epoch,
      projectId,
      subjectId,
      tenantId: principal.tenantId,
    });
    sessionSnapshotEvidenceV1(result);
  }
  sendJson(
    response,
    result === null ? 404 : 200,
    result === null ? null : serializeEditorDocumentSessionViewV1(result),
  );
}

async function putSessionV1(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  documentKey: string,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  signal: AbortSignal | undefined,
  options: EditorDocumentHttpOptionsV1,
) {
  requireSameOriginJsonMutationV1(request, options.expectedMutationOrigin);
  const subjectId = requireAccountSubjectV1(principal, request);
  let query: ReturnType<typeof parseEditorDocumentSessionQueryV1>;
  try {
    query = parseEditorDocumentSessionQueryV1(url.searchParams);
  } catch {
    throw new HttpError("Editor session query is invalid.", 400);
  }
  const parsed = editorDocumentSessionPutRequestSchemaV1.safeParse(
    await readJsonBody(request, bodyLimitV1(options.maxJsonBodyBytes, MAX_SESSION_PUT_BODY_BYTES_V1)),
  );
  if (!parsed.success || parsed.data.epoch !== query.epoch) {
    throw new HttpError("Editor session update request is invalid.", 400);
  }
  signal?.throwIfAborted();
  const result = await repository.putSessionSnapshot(
    {
      documentKey,
      documentRevision: BigInt(parsed.data.documentRevision),
      epoch: query.epoch,
      expectedSessionGeneration: BigInt(parsed.data.expectedSessionGeneration),
      projectId,
      snapshot: parsed.data.snapshot,
      snapshotVersion: parsed.data.snapshotVersion,
      subjectId,
      tenantId: principal.tenantId,
    },
    signal,
  );
  if (result.kind === "stored") {
    sessionIdentityV1(result.session, {
      documentKey,
      documentRevision: BigInt(parsed.data.documentRevision),
      epoch: query.epoch,
      projectId,
      subjectId,
      tenantId: principal.tenantId,
    });
    sessionSnapshotEvidenceV1(result.session);
    if (
      result.session.sessionGeneration !== BigInt(parsed.data.expectedSessionGeneration) + 1n ||
      result.session.snapshotVersion !== parsed.data.snapshotVersion ||
      canonicalEditorSessionSnapshotJsonV1(result.session.snapshot) !==
        canonicalEditorSessionSnapshotJsonV1(parsed.data.snapshot)
    ) {
      throw new TypeError("Editor storage returned a session inconsistent with the update request.");
    }
  }
  const view = serializeEditorDocumentSessionPutResultV1(result);
  const status =
    result.kind === "stored" ? 200 : result.reason === "forbidden" ? 403 : result.reason === "not-found" ? 404 : 409;
  sendJson(response, status, view);
}

export async function handleEditorDocumentRequest(
  repository: EditorDocumentRepositoryV1,
  principal: VerifiedManimPrincipal,
  request: IncomingMessage,
  response: ServerResponse,
  options: EditorDocumentHttpOptionsV1 = {},
) {
  try {
    if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
    options.requestSignal?.throwIfAborted();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const open = OPEN_ROUTE_V1.exec(url.pathname);
    if (open) {
      if (url.search || url.hash) throw new HttpError("Editor document open request URL is invalid.", 400);
      await openDocumentV1(
        repository,
        principal,
        parseProjectIdV1(open[1]!),
        request,
        response,
        options.requestSignal,
        options,
      );
      return;
    }
    const session = SESSION_ROUTE_V1.exec(url.pathname);
    if (session) {
      const projectId = parseProjectIdV1(session[1]!);
      const documentKey = parseDocumentKeyV1(session[2]!);
      if (url.hash) throw new HttpError("Editor session request URL is invalid.", 400);
      if (request.method === "GET") {
        await readSessionV1(
          repository,
          principal,
          projectId,
          documentKey,
          request,
          url,
          response,
          options.requestSignal,
        );
        return;
      }
      if (request.method !== "PUT") {
        request.resume();
        methodNotAllowedV1(response, "GET, PUT");
        return;
      }
      await putSessionV1(
        repository,
        principal,
        projectId,
        documentKey,
        request,
        url,
        response,
        options.requestSignal,
        options,
      );
      return;
    }
    const events = EVENT_ROUTE_V1.exec(url.pathname);
    if (!events) {
      request.resume();
      sendJson(response, 404, { error: "Editor document endpoint not found." });
      return;
    }
    const projectId = parseProjectIdV1(events[1]!);
    const documentKey = parseDocumentKeyV1(events[2]!);
    if (url.hash) throw new HttpError("Editor event request URL is invalid.", 400);
    if (request.method === "GET") {
      await readTailV1(repository, principal, projectId, documentKey, url, response, options.requestSignal);
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      methodNotAllowedV1(response, "GET, POST");
      return;
    }
    if (url.search) throw new HttpError("Editor mutation request URL is invalid.", 400);
    await commitEventV1(
      repository,
      principal,
      projectId,
      documentKey,
      request,
      response,
      options.requestSignal,
      options,
    );
  } catch (error) {
    if (options.requestSignal?.aborted || response.destroyed || response.writableEnded) return;
    if (error instanceof HttpError) {
      request.resume();
      sendJson(response, error.status, { error: error.message });
      return;
    }
    throw error;
  }
}
