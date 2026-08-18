import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1,
  type ClientExportFinalizeMetadataV1,
  clientExportPublicationVideoPathV1,
  decodeClientExportFinalizeBodyV1,
  MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1,
} from "../src/collaboration/client-export-http-contract";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import { accountUserIdSchemaV1 } from "./accounts/account-domain";
import { HttpError, sendJson } from "./http/json";
import { streamHttpMediaV1 } from "./http/media-stream";
import { isVerifiedManimPrincipal, type VerifiedManimPrincipal } from "./manim-request-principal";
import type { ClientExportPublicationV1 } from "./storage/client-export-contract";
import type { ClientExportPublisherV1, PublishClientExportResultV1 } from "./storage/client-export-publisher";
import type { ClientExportReaderV1 } from "./storage/client-export-reader";

const EXPORTS_ROUTE_V1 = /^\/api\/projects\/([^/]+)\/exports$/u;
const EXPORT_ITEM_ROUTE_V1 = /^\/api\/projects\/([^/]+)\/exports\/([^/]+)$/u;
const EXPORT_VIDEO_ROUTE_V1 = /^\/api\/projects\/([^/]+)\/exports\/([^/]+)\/video$/u;
const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DEFAULT_MEDIA_STREAM_IDLE_TIMEOUT_MS_V1 = 30_000;
const MAX_MEDIA_STREAM_IDLE_TIMEOUT_MS_V1 = 120_000;

const MAX_ACTIVE_CLIENT_EXPORT_FINALIZES = 2;
const CLIENT_EXPORT_FINALIZE_MEMORY_COPIES = 2;

/**
 * One request body plus one verifier copy per active request. The reader
 * below writes directly into one fixed-size Buffer, so it never retains a
 * chunk list and a concatenated copy at the same time.
 */
export const MAX_CLIENT_EXPORT_FINALIZE_PROCESS_MEMORY_BYTES =
  MAX_ACTIVE_CLIENT_EXPORT_FINALIZES * CLIENT_EXPORT_FINALIZE_MEMORY_COPIES * MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1;

export type ClientExportHttpServiceV1 = Readonly<{
  publisher: Pick<ClientExportPublisherV1, "publish">;
  reader: Pick<ClientExportReaderV1, "publication" | "publicationVideo">;
  tenantId: string;
}>;

export type ClientExportHttpOptionsV1 = Readonly<{
  expectedMutationOrigin?: string;
  mediaStreamIdleTimeoutMs?: number;
  requestSignal?: AbortSignal;
}>;

export function isClientExportRequest(pathname: string) {
  return EXPORTS_ROUTE_V1.test(pathname) || EXPORT_ITEM_ROUTE_V1.test(pathname) || EXPORT_VIDEO_ROUTE_V1.test(pathname);
}

/**
 * TenantCell storage lane (ADR 0005 §"Tenant Cell decision"): every client
 * export route is served entirely by durable storage, so production admission
 * gates all of them on storage/tenant readiness alone.
 */
export function isTenantCellStorageLaneClientExportRequest(method: string | undefined, pathname: string) {
  if (method === "POST" && EXPORTS_ROUTE_V1.test(pathname)) return true;
  if (method === "GET" && EXPORT_ITEM_ROUTE_V1.test(pathname)) return true;
  return (method === "GET" || method === "HEAD") && EXPORT_VIDEO_ROUTE_V1.test(pathname);
}

export function isClientExportFinalizeRequest(method: string | undefined, pathname: string) {
  return method === "POST" && EXPORTS_ROUTE_V1.test(pathname);
}

export function isClientExportVideoRequest(method: string | undefined, pathname: string) {
  return (method === "GET" || method === "HEAD") && EXPORT_VIDEO_ROUTE_V1.test(pathname);
}

function parseProjectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("Client export project identity is invalid.", 400);
  return parsed.data;
}

function parsePublicationIdV1(value: string) {
  if (!UUID_V1.test(value)) throw new HttpError("Client export publication identity is invalid.", 400);
  return value;
}

function methodNotAllowedV1(response: ServerResponse, allow: string) {
  response.setHeader("allow", allow);
  sendJson(response, 405, { error: "Method not allowed." });
}

function requireAccountSubjectV1(principal: VerifiedManimPrincipal, request: IncomingMessage) {
  if (!accountUserIdSchemaV1.safeParse(principal.subjectId).success) {
    request.resume();
    throw new HttpError("Client export publication requires an account actor.", 403);
  }
  return principal.subjectId;
}

function requireSameOriginFinalizeMutationV1(request: IncomingMessage, expectedOrigin?: string) {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1) {
    request.resume();
    throw new HttpError(`Client export finalize requires a ${CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1} request.`, 415);
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin client export mutations are not allowed.", 403);
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
      throw new HttpError("Client export mutations require the configured public Origin.", 403);
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
    throw new HttpError("Client export mutations require a same-origin request.", 403);
  }
}

function mediaStreamIdleTimeoutV1(value: number | undefined) {
  const timeout = value ?? DEFAULT_MEDIA_STREAM_IDLE_TIMEOUT_MS_V1;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > MAX_MEDIA_STREAM_IDLE_TIMEOUT_MS_V1) {
    throw new RangeError("Media stream idle timeout must be between one and 120 seconds.");
  }
  return timeout;
}

function publicationViewV1(publication: ClientExportPublicationV1) {
  return {
    byteSize: publication.artifact.receipt.byteSize,
    contentDigest: publication.artifact.receipt.contentDigest,
    createdBySubjectId: publication.createdBySubjectId,
    documentEpoch: publication.lineage.documentEpoch,
    documentKey: publication.lineage.documentKey,
    documentRevision: publication.lineage.documentRevision.toString(),
    encoderEvidenceVersion: publication.lineage.encoderEvidenceVersion,
    expiresAt: publication.expiresAt.toISOString(),
    exportProfileHash: publication.lineage.exportProfileHash,
    producerKind: publication.lineage.producerKind,
    projectId: publication.projectId,
    publicationId: publication.publicationId,
    publishedAt: publication.publishedAt.toISOString(),
    sceneContractVersion: publication.lineage.sceneContractVersion,
    sceneRevisionHash: publication.lineage.sceneRevisionHash,
    videoPath: clientExportPublicationVideoPathV1(publication.projectId, publication.publicationId),
  };
}

type FinalizeAdmissionResult =
  | Readonly<{ kind: "admitted"; release: () => void }>
  | Readonly<{ kind: "refused"; reason: "process-memory" | "process-saturated" | "tenant-busy" }>;

/** Process-wide admission: one upload per tenant and two tenants at once. */
export class ClientExportFinalizeAdmission {
  readonly #activeTenants = new Set<string>();
  readonly #maxActive: number;
  readonly #maxMemoryBytes: number;
  #reservedMemoryBytes = 0;

  constructor(
    maxActive = MAX_ACTIVE_CLIENT_EXPORT_FINALIZES,
    maxMemoryBytes = MAX_CLIENT_EXPORT_FINALIZE_PROCESS_MEMORY_BYTES,
  ) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new RangeError("Client export finalize maxActive must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes < 1) {
      throw new RangeError("Client export finalize maxMemoryBytes must be a positive integer.");
    }
    this.#maxActive = maxActive;
    this.#maxMemoryBytes = maxMemoryBytes;
  }

  acquire(tenantId: string, contentLength: number): FinalizeAdmissionResult {
    if (!tenantId) throw new TypeError("Client export finalize tenant identity is required.");
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1
    ) {
      throw new RangeError("Client export finalize content length is out of bounds.");
    }
    if (this.#activeTenants.has(tenantId)) return { kind: "refused", reason: "tenant-busy" };
    if (this.#activeTenants.size >= this.#maxActive) return { kind: "refused", reason: "process-saturated" };
    const reservedMemoryBytes = contentLength * CLIENT_EXPORT_FINALIZE_MEMORY_COPIES;
    if (this.#reservedMemoryBytes + reservedMemoryBytes > this.#maxMemoryBytes) {
      return { kind: "refused", reason: "process-memory" };
    }
    this.#activeTenants.add(tenantId);
    this.#reservedMemoryBytes += reservedMemoryBytes;
    let released = false;
    return {
      kind: "admitted",
      release: () => {
        if (released) return;
        released = true;
        this.#activeTenants.delete(tenantId);
        this.#reservedMemoryBytes -= reservedMemoryBytes;
      },
    };
  }
}

const finalizeAdmission = new ClientExportFinalizeAdmission();

function finalizeContentLength(request: IncomingMessage) {
  const value = request.headers["content-length"];
  if (value === undefined) {
    request.resume();
    throw new HttpError("Client export finalize requires a bounded Content-Length header.", 411);
  }
  if (!/^\d+$/u.test(value)) {
    request.resume();
    throw new HttpError("Client export finalize Content-Length is invalid.", 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1) {
    request.resume();
    throw new HttpError("Request body is too large.", 413);
  }
  return parsed;
}

/** Reads exactly Content-Length bytes into one allocation; no Buffer.concat copy. */
function readFinalizeBody(request: IncomingMessage, contentLength: number, signal?: AbortSignal) {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const body = Buffer.allocUnsafe(contentLength);
    let offset = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal?.removeEventListener("abort", onSignalAborted);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBody(error);
    };
    const onAborted = () => rejectOnce(new HttpError("Request body was interrupted.", 400));
    const onClose = () => {
      if (!request.complete) rejectOnce(new HttpError("Request body was interrupted.", 400));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (offset + bytes.byteLength > contentLength) {
        request.resume();
        rejectOnce(new HttpError("Request body does not match Content-Length.", 400));
        return;
      }
      bytes.copy(body, offset);
      offset += bytes.byteLength;
    };
    const onEnd = () => {
      cleanup();
      if (settled) return;
      if (offset !== contentLength) {
        settled = true;
        rejectBody(new HttpError("Request body does not match Content-Length.", 400));
        return;
      }
      settled = true;
      resolveBody(body);
    };
    const onError = () => rejectOnce(new HttpError("Request body could not be read.", 400));
    const onSignalAborted = () => {
      request.resume();
      rejectOnce(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    request.on("aborted", onAborted);
    request.on("close", onClose);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal?.addEventListener("abort", onSignalAborted, { once: true });
    if (signal?.aborted) onSignalAborted();
  });
}

async function finalizeExportV1(
  service: ClientExportHttpServiceV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: ClientExportHttpOptionsV1,
) {
  const subjectId = requireAccountSubjectV1(principal, request);
  requireSameOriginFinalizeMutationV1(request, options.expectedMutationOrigin);
  const contentLength = finalizeContentLength(request);
  options.requestSignal?.throwIfAborted();
  const admission = finalizeAdmission.acquire(principal.tenantId, contentLength);
  if (admission.kind === "refused") {
    request.resume();
    const reason = admission.reason === "tenant-busy" ? "tenant is busy" : "process capacity is exhausted";
    throw new HttpError(`Client export finalize admission refused: ${reason}.`, 503);
  }
  try {
    options.requestSignal?.throwIfAborted();
    const body = await readFinalizeBody(request, contentLength, options.requestSignal);
    let metadata: ClientExportFinalizeMetadataV1;
    let video: Uint8Array;
    try {
      ({ metadata, video } = decodeClientExportFinalizeBodyV1(body));
    } catch (error) {
      throw new HttpError(
        error instanceof TypeError ? error.message : "The client export finalize envelope is invalid.",
        400,
      );
    }
    if (metadata.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    options.requestSignal?.throwIfAborted();
    const result: PublishClientExportResultV1 = await service.publisher.publish(
      {
        bytes: video,
        contentDigest: metadata.contentDigest,
        createdBySubjectId: subjectId,
        documentEpoch: metadata.documentEpoch,
        documentKey: metadata.documentKey,
        documentRevision: BigInt(metadata.documentRevision),
        encoderEvidence: metadata.encoderEvidence,
        exportProfile: metadata.exportProfile,
        projectId,
        publicationId: metadata.publicationId,
        sceneRevisionHash: metadata.sceneRevisionHash,
        tenantId: principal.tenantId,
      },
      options.requestSignal,
    );
    const publication = result.publication;
    if (
      publication.tenantId !== principal.tenantId ||
      publication.projectId !== projectId ||
      publication.publicationId !== metadata.publicationId
    ) {
      throw new TypeError("Client export storage returned a publication outside the authenticated request identity.");
    }
    sendJson(response, result.replayed ? 200 : 201, { ...publicationViewV1(publication), replayed: result.replayed });
  } finally {
    admission.release();
  }
}

async function readPublicationV1(
  service: ClientExportHttpServiceV1,
  principal: VerifiedManimPrincipal,
  projectId: string,
  publicationId: string,
  response: ServerResponse,
  options: ClientExportHttpOptionsV1,
) {
  const publication = await service.reader.publication(projectId, publicationId, options.requestSignal);
  if (publication.tenantId !== principal.tenantId) {
    throw new TypeError("Client export storage returned a publication outside the authenticated request identity.");
  }
  sendJson(response, 200, publicationViewV1(publication));
}

async function streamPublicationVideoV1(
  service: ClientExportHttpServiceV1,
  projectId: string,
  publicationId: string,
  request: IncomingMessage,
  response: ServerResponse,
  options: ClientExportHttpOptionsV1,
) {
  const idleTimeoutMs = mediaStreamIdleTimeoutV1(options.mediaStreamIdleTimeoutMs);
  const signal = options.requestSignal ?? new AbortController().signal;
  const asset = await service.reader.publicationVideo(projectId, publicationId, options.requestSignal);
  await streamHttpMediaV1(request, response, asset, signal, idleTimeoutMs);
}

/** Serves the neutral client-export publication routes for one authenticated tenant. */
export async function handleClientExportRequest(
  service: ClientExportHttpServiceV1,
  principal: VerifiedManimPrincipal,
  request: IncomingMessage,
  response: ServerResponse,
  options: ClientExportHttpOptionsV1 = {},
) {
  try {
    if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
    if (principal.tenantId !== service.tenantId) throw new HttpError("Tenant access is not available.", 403);
    options.requestSignal?.throwIfAborted();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.hash || url.search) throw new HttpError("Client export request URL is invalid.", 400);

    const collection = EXPORTS_ROUTE_V1.exec(url.pathname);
    if (collection) {
      if (request.method !== "POST") {
        request.resume();
        return methodNotAllowedV1(response, "POST");
      }
      await finalizeExportV1(service, principal, parseProjectIdV1(collection[1]!), request, response, options);
      return;
    }

    const video = EXPORT_VIDEO_ROUTE_V1.exec(url.pathname);
    if (video) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        request.resume();
        return methodNotAllowedV1(response, "GET, HEAD");
      }
      await streamPublicationVideoV1(
        service,
        parseProjectIdV1(video[1]!),
        parsePublicationIdV1(video[2]!),
        request,
        response,
        options,
      );
      return;
    }

    const item = EXPORT_ITEM_ROUTE_V1.exec(url.pathname);
    if (!item) {
      request.resume();
      sendJson(response, 404, { error: "Client export endpoint not found." });
      return;
    }
    if (request.method !== "GET") {
      request.resume();
      return methodNotAllowedV1(response, "GET");
    }
    await readPublicationV1(
      service,
      principal,
      parseProjectIdV1(item[1]!),
      parsePublicationIdV1(item[2]!),
      response,
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
