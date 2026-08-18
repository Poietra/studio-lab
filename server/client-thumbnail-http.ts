import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1,
  clientThumbnailImagePathV1,
  decodeClientThumbnailFinalizeBodyV1,
  MAX_CLIENT_THUMBNAIL_FINALIZE_BODY_BYTES_V1,
} from "../src/collaboration/client-thumbnail-http-contract";
import { manimProjectIdSchema } from "../src/render-pipeline/contracts";
import { accountUserIdSchemaV1 } from "./accounts/account-domain";
import { HttpError, readRawBody, sendJson } from "./http/json";
import { isVerifiedManimPrincipal, type VerifiedManimPrincipal } from "./manim-request-principal";
import type { ClientThumbnailPublisherV1 } from "./storage/client-thumbnail-publisher";

const THUMBNAILS_ROUTE = /^\/api\/projects\/([^/]+)\/thumbnails$/u;

export type ClientThumbnailHttpServiceV1 = Readonly<{
  publisher: Pick<ClientThumbnailPublisherV1, "publish">;
  tenantId: string;
}>;

export function isClientThumbnailPublicationRequest(method: string | undefined, pathname: string) {
  return method === "POST" && THUMBNAILS_ROUTE.test(pathname);
}

function projectIdV1(value: string) {
  const parsed = manimProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new HttpError("Client thumbnail project identity is invalid.", 400);
  return parsed.data;
}

function requireSameOriginV1(request: IncomingMessage, expectedOrigin?: string) {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1) {
    request.resume();
    throw new HttpError(`Thumbnail publication requires a ${CLIENT_THUMBNAIL_FINALIZE_MEDIA_TYPE_V1} request.`, 415);
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin thumbnail mutations are not allowed.", 403);
  }
  const origin = request.headers.origin;
  if (expectedOrigin !== undefined) {
    let actual: string | null = null;
    try {
      const parsed = typeof origin === "string" ? new URL(origin) : null;
      actual = parsed && parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : null;
    } catch {
      // Use the fixed public error below.
    }
    if (actual !== expectedOrigin) {
      request.resume();
      throw new HttpError("Thumbnail mutations require the configured public Origin.", 403);
    }
    return;
  }
  if (origin === undefined) return;
  const host = request.headers.host;
  try {
    const parsed = new URL(origin);
    const protocol = "encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:";
    if (
      !host ||
      parsed.protocol !== protocol ||
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
    throw new HttpError("Thumbnail mutations require a same-origin request.", 403);
  }
}

/** Accepts one bounded browser-rendered PNG for the authenticated tenant/project. */
export async function handleClientThumbnailRequest(
  service: ClientThumbnailHttpServiceV1,
  principal: VerifiedManimPrincipal,
  request: IncomingMessage,
  response: ServerResponse,
  options: Readonly<{ expectedMutationOrigin?: string; requestSignal?: AbortSignal }> = {},
) {
  try {
    if (!isVerifiedManimPrincipal(principal)) throw new HttpError("Authentication is required.", 401);
    if (principal.tenantId !== service.tenantId) throw new HttpError("Tenant access is not available.", 403);
    if (!accountUserIdSchemaV1.safeParse(principal.subjectId).success) {
      request.resume();
      throw new HttpError("Thumbnail publication requires an account actor.", 403);
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.hash || url.search) throw new HttpError("Client thumbnail request URL is invalid.", 400);
    const match = THUMBNAILS_ROUTE.exec(url.pathname);
    if (!match) {
      request.resume();
      return sendJson(response, 404, { error: "Client thumbnail endpoint not found." });
    }
    if (request.method !== "POST") {
      request.resume();
      response.setHeader("allow", "POST");
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    const projectId = projectIdV1(match[1]!);
    requireSameOriginV1(request, options.expectedMutationOrigin);
    options.requestSignal?.throwIfAborted();
    const body = await readRawBody(request, MAX_CLIENT_THUMBNAIL_FINALIZE_BODY_BYTES_V1);
    let decoded;
    try {
      decoded = decodeClientThumbnailFinalizeBodyV1(body);
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : "The thumbnail envelope is invalid.", 400);
    }
    if (decoded.metadata.projectId !== projectId) {
      throw new HttpError("The thumbnail project does not match the project endpoint.", 409);
    }
    const result = await service.publisher.publish(
      {
        bytes: decoded.png,
        contentDigest: decoded.metadata.contentDigest,
        createdBySubjectId: principal.subjectId,
        documentEpoch: decoded.metadata.documentEpoch,
        documentKey: decoded.metadata.documentKey,
        documentRevision: BigInt(decoded.metadata.documentRevision),
        projectId,
        publicationId: decoded.metadata.publicationId,
        sceneRevisionHash: decoded.metadata.sceneRevisionHash,
        tenantId: principal.tenantId,
      },
      options.requestSignal,
    );
    const publication = result.publication;
    sendJson(response, result.replayed ? 200 : 201, {
      byteSize: publication.artifact.receipt.byteSize,
      contentDigest: publication.artifact.receipt.contentDigest,
      createdBySubjectId: publication.createdBySubjectId,
      documentEpoch: publication.lineage.documentEpoch,
      documentKey: publication.lineage.documentKey,
      documentRevision: publication.lineage.documentRevision.toString(),
      imagePath: clientThumbnailImagePathV1(projectId),
      producerKind: publication.lineage.producerKind,
      projectId,
      publicationId: publication.publicationId,
      publishedAt: publication.publishedAt.toISOString(),
      representativeFrameRule: publication.lineage.representativeFrameRule,
      replayed: result.replayed,
      sceneContractVersion: publication.lineage.sceneContractVersion,
      sceneRevisionHash: publication.lineage.sceneRevisionHash,
    });
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
