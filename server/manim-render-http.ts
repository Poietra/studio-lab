import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createManimProjectRequestSchema,
  manimThumbnailGenerateRequestSchema,
  originalManimSourceExportRequestSchema,
  programRenderRequestSchema,
  renameManimProjectRequestSchema,
  type ManimSourceExport,
} from "../src/render-pipeline/contracts";
import { AmbiguousSourceSceneError } from "../src/render-pipeline/source-import";
import { HttpError, readJsonBody, sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimRenderManager } from "./manim-render-manager";
import type { ManimProjectRegistry } from "./manim-project-registry";
import { EMPTY_MANIM_THUMBNAIL_SVG } from "./manim-thumbnail";
import type { ThumbnailAsset } from "./manim-thumbnail-cache";

const RENDER_ROUTE = /^\/api\/manim\/renders\/([0-9a-f-]+)(?:\/(cancel|commit|discard|undo|video))?$/;
const PROJECT_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/(workspace|renders|export)$/;
const PROJECT_THUMBNAIL_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/thumbnail(?:\/(status|generate))?$/;
const PROJECT_ITEM_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})$/;
type ManimApi = ManimRenderManager | ManimProjectRegistry;
export type ManimRequestPolicy = Readonly<{
  allowExistingProjectRegistration: boolean;
}>;

const DEFAULT_MANIM_REQUEST_POLICY: ManimRequestPolicy = {
  allowExistingProjectRegistration: true,
};

function requireSameOriginJsonMutation(request: IncomingMessage) {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    request.resume();
    throw new HttpError("Request content type must be application/json.", 415);
  }
  const fetchSite = request.headers["sec-fetch-site"]?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    request.resume();
    throw new HttpError("Cross-origin thumbnail generation is not allowed.", 403);
  }
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  try {
    const parsedOrigin = new URL(origin);
    if (
      !host ||
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.protocol !== ("encrypted" in request.socket && request.socket.encrypted ? "https:" : "http:") ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedOrigin.host.toLowerCase() !== host.toLowerCase()
    )
      throw new Error("Origin does not match Host.");
  } catch {
    request.resume();
    throw new HttpError("Thumbnail generation requires a same-origin request.", 403);
  }
}

function mutableProjectRegistry(manager: ManimApi) {
  if (!("createProject" in manager)) {
    throw new HttpError("Workspace registry mutations are not configured.", 405);
  }
  return manager;
}

function pipeVideo(response: ServerResponse, path: string, range?: Readonly<{ end: number; start: number }>) {
  const stream = createReadStream(path, range);
  const closeStream = () => stream.destroy();
  response.once("close", closeStream);
  stream.once("close", () => response.removeListener("close", closeStream));
  stream.once("error", () => {
    if (!response.headersSent) {
      response.removeHeader("content-length");
      sendJson(response, 500, { error: "Could not read the rendered video." });
    } else response.destroy();
  });
  stream.pipe(response);
}

export function resolveByteRange(
  header: string | undefined,
  size: number,
):
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ end: number; kind: "partial"; start: number }> {
  if (!header) return { kind: "full" };
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return { kind: "invalid" };
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = suffixLength === null && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (suffixLength !== null && (!Number.isInteger(suffixLength) || suffixLength <= 0)) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return { kind: "invalid" };
  return { end, kind: "partial", start };
}

async function streamVideo(request: IncomingMessage, response: ServerResponse, path: string) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new HttpError("Rendered video not found.", 404);
  }
  if (!metadata.isFile()) throw new HttpError("Rendered video not found.", 404);
  const range = resolveByteRange(request.headers.range, metadata.size);
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "video/mp4");
  if (range.kind === "full") {
    response.statusCode = 200;
    response.setHeader("content-length", metadata.size);
    pipeVideo(response, path);
    return;
  }
  if (range.kind === "invalid") {
    response.statusCode = 416;
    response.setHeader("content-range", `bytes */${metadata.size}`);
    response.end();
    return;
  }
  response.statusCode = 206;
  response.setHeader("content-length", range.end - range.start + 1);
  response.setHeader("content-range", `bytes ${range.start}-${range.end}/${metadata.size}`);
  pipeVideo(response, path, { end: range.end, start: range.start });
}

async function runRenderAction(manager: ManimApi, id: string, action: string | undefined) {
  switch (action) {
    case "cancel":
      return manager.cancel(id);
    case "commit":
      return manager.commit(id);
    case "discard":
      return manager.discard(id);
    case "undo":
      return manager.undo(id);
    default:
      throw new HttpError("Method not allowed.", 405);
  }
}

function sendPythonAttachment(response: ServerResponse, exported: ManimSourceExport) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.statusCode = 200;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-disposition", `attachment; filename="${exported.fileName}"`);
  response.setHeader("content-length", Buffer.byteLength(exported.source));
  response.setHeader("content-type", "text/x-python; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-poietra-project-id", exported.projectId);
  response.end(exported.source);
  return true;
}

function sendThumbnailAsset(response: ServerResponse, asset: ThumbnailAsset) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  const body = asset.status === 404 ? Buffer.from(EMPTY_MANIM_THUMBNAIL_SVG, "utf8") : asset.body;
  response.statusCode = asset.status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", body.byteLength);
  if (asset.mediaType.startsWith("image/svg+xml")) {
    response.setHeader("content-security-policy", "default-src 'none'; sandbox");
  }
  response.setHeader("content-type", asset.mediaType);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-poietra-thumbnail-kind", asset.kind);
  response.setHeader("x-poietra-thumbnail-state", asset.state);
  response.end(body);
  return true;
}

function sendJsonAndWaitForFinish(response: ServerResponse, status: number, body: unknown) {
  return new Promise<boolean>((resolveDelivery, rejectDelivery) => {
    let settled = false;
    const cleanup = () => {
      response.removeListener("close", onClose);
      response.removeListener("finish", onFinish);
    };
    const settle = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDelivery(delivered);
    };
    const onClose = () => settle(false);
    const onFinish = () => settle(true);
    response.once("close", onClose);
    response.once("finish", onFinish);
    try {
      if (!sendJson(response, status, body)) settle(false);
    } catch (error) {
      cleanup();
      rejectDelivery(error);
    }
  });
}

async function routeManimRequest(
  manager: ManimApi,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  policy: ManimRequestPolicy,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/manim/projects") {
    if (request.method === "GET") {
      sendJson(response, 200, manager.projects());
      return;
    }
    if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
    const parsed = createManimProjectRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid workspace registration.", 400);
    if (parsed.data.kind === "existing" && !policy.allowExistingProjectRegistration) {
      throw new HttpError("Existing-folder registration requires the native folder picker.", 403);
    }
    signal.throwIfAborted();
    const registry = mutableProjectRegistry(manager);
    sendJson(
      response,
      201,
      parsed.data.kind === "managed"
        ? registry.createManagedProject(parsed.data.name)
        : registry.createProject(parsed.data.name, parsed.data.root),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/manim/workspace") {
    sendJson(response, 200, await manager.workspace());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/manim/renders") {
    const parsed = programRenderRequestSchema.safeParse(await readJsonBody(request, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram render request.", 400);
    }
    const started = await manager.start(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 202, started))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const projectItemMatch = url.pathname.match(PROJECT_ITEM_ROUTE);
  if (projectItemMatch) {
    const projectId = projectItemMatch[1]!;
    const registry = mutableProjectRegistry(manager);
    if (request.method === "PATCH") {
      const parsed = renameManimProjectRequestSchema.safeParse(await readJsonBody(request));
      if (!parsed.success) throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid workspace name.", 400);
      signal.throwIfAborted();
      sendJson(response, 200, registry.renameProject(projectId, parsed.data.name));
      return;
    }
    if (request.method === "DELETE") {
      signal.throwIfAborted();
      sendJson(response, 200, await registry.unregisterProject(projectId));
      return;
    }
    throw new HttpError("Method not allowed.", 405);
  }
  const thumbnailMatch = url.pathname.match(PROJECT_THUMBNAIL_ROUTE);
  if (thumbnailMatch) {
    const [, projectId, action] = thumbnailMatch;
    if (!action && request.method === "GET") {
      try {
        sendThumbnailAsset(response, await manager.thumbnail(projectId));
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        sendThumbnailAsset(response, {
          body: Buffer.from("", "utf8"),
          kind: "empty",
          mediaType: "image/svg+xml; charset=utf-8",
          state: "missing",
          status: 404,
        });
      }
      return;
    }
    if (action === "status" && request.method === "GET") {
      sendJson(response, 200, await manager.thumbnailStatus(projectId));
      return;
    }
    if (action === "generate" && request.method === "POST") {
      requireSameOriginJsonMutation(request);
      const parsed = manimThumbnailGenerateRequestSchema.safeParse(await readJsonBody(request, 1_024));
      if (!parsed.success) throw new HttpError("Thumbnail generation requires an empty JSON object.", 400);
      signal.throwIfAborted();
      sendJson(response, 202, await manager.generateThumbnail(projectId));
      return;
    }
    throw new HttpError("Method not allowed.", 405);
  }
  const projectMatch = url.pathname.match(PROJECT_ROUTE);
  if (projectMatch) {
    const [, projectId, endpoint] = projectMatch;
    if (request.method === "GET" && endpoint === "workspace") {
      sendJson(response, 200, await manager.workspace(projectId));
      return;
    }
    if (request.method !== "POST" || endpoint === "workspace") {
      throw new HttpError("Method not allowed.", 405);
    }
    if (endpoint === "export") {
      const body = await readJsonBody(request, 512 * 1024);
      const programRequest = programRenderRequestSchema.safeParse(body);
      const originalRequest = originalManimSourceExportRequestSchema.safeParse(body);
      let exported: ManimSourceExport;
      if (programRequest.success) {
        if (programRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        exported = await manager.exportSource(programRequest.data, signal);
      } else {
        if (!originalRequest.success) {
          throw new HttpError(originalRequest.error.issues[0]?.message ?? "Invalid Python export request.", 400);
        }
        if (originalRequest.data.projectId !== projectId) {
          throw new HttpError("The request project does not match the project endpoint.", 409);
        }
        exported = await manager.exportOriginalSource(originalRequest.data, signal);
      }
      sendPythonAttachment(response, exported);
      return;
    }
    const parsed = programRenderRequestSchema.safeParse(await readJsonBody(request, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram request.", 400);
    }
    if (parsed.data.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    const started = await manager.start(parsed.data, signal);
    if (!(await sendJsonAndWaitForFinish(response, 202, started))) {
      await manager.abandonStart(started.id);
      const error = new Error("The render request was disconnected before its response was sent.");
      error.name = "AbortError";
      throw error;
    }
    return;
  }
  const match = url.pathname.match(RENDER_ROUTE);
  if (!match) throw new HttpError("Manim endpoint not found.", 404);
  const [, id, action] = match;
  if (request.method === "GET" && !action) {
    sendJson(response, 200, manager.view(id));
    return;
  }
  if (request.method === "GET" && action === "video") {
    await streamVideo(request, response, manager.videoPath(id));
    return;
  }
  if (request.method !== "POST") throw new HttpError("Method not allowed.", 405);
  sendJson(response, 200, await runRenderAction(manager, id, action));
}

export async function handleManimRequest(
  manager: ManimApi,
  request: IncomingMessage,
  response: ServerResponse,
  baseLogger: StructuredLogger = nullLogger,
  policy: ManimRequestPolicy = DEFAULT_MANIM_REQUEST_POLICY,
) {
  const requestId = randomUUID();
  const logger = baseLogger.child({
    method: request.method,
    requestId,
    route: request.url,
  });
  response.setHeader("x-poietra-request-id", requestId);
  const requestAbort = new AbortController();
  let responseFinished = false;
  const abortRequest = () => requestAbort.abort();
  const markResponseFinished = () => {
    responseFinished = true;
  };
  const abortOnClosedResponse = () => {
    if (!responseFinished) abortRequest();
  };
  request.once("aborted", abortRequest);
  response.once("close", abortOnClosedResponse);
  response.once("finish", markResponseFinished);
  logger.info("request.started");
  try {
    await routeManimRequest(manager, request, response, requestAbort.signal, policy);
    logger.info("response.sent", { status: response.statusCode });
  } catch (error) {
    if (requestAbort.signal.aborted || (response.destroyed && error instanceof Error && error.name === "AbortError")) {
      const expectedAbort =
        error === requestAbort.signal.reason ||
        (error instanceof Error && error.name === "AbortError") ||
        (error instanceof HttpError && error.message === "Request body was interrupted.");
      const details = error instanceof Error ? { message: error.message, name: error.name } : { error };
      if (expectedAbort) logger.info("request.aborted", details);
      else logger.error("request.abort_cleanup_failed", details);
      return;
    }
    const ambiguousScene = error instanceof AmbiguousSourceSceneError;
    const expected = error instanceof HttpError || ambiguousScene;
    const status = error instanceof HttpError ? error.status : ambiguousScene ? 409 : 500;
    const message = expected && error instanceof Error ? error.message : "Manim render pipeline failed.";
    const details =
      error instanceof Error ? { error, message: error.message, name: error.name, status } : { error, status };
    if (expected) logger.warn("request.rejected", details);
    else logger.error("request.failed", details);
    if (!sendJson(response, status, { error: message })) {
      logger.warn("response.abandoned", { status });
    }
  } finally {
    request.removeListener("aborted", abortRequest);
    response.removeListener("close", abortOnClosedResponse);
    response.removeListener("finish", markResponseFinished);
  }
}
