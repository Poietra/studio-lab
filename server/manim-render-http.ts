import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createManimProjectRequestSchema,
  programRenderRequestSchema,
  renameManimProjectRequestSchema,
  type ManimSourceExport,
} from "../src/render-pipeline/contracts";
import { HttpError, readJsonBody, sendJson } from "./http/json";
import { nullLogger, type StructuredLogger } from "./logging/structured-logger";
import type { ManimProjectRegistry, ManimRenderManager } from "./manim-render-pipeline";
import { EMPTY_MANIM_THUMBNAIL_SVG } from "./manim-thumbnail";

const RENDER_ROUTE = /^\/api\/manim\/renders\/([0-9a-f-]+)(?:\/(cancel|commit|discard|undo|video))?$/;
const PROJECT_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})\/(workspace|renders|export|thumbnail)$/;
const PROJECT_ITEM_ROUTE = /^\/api\/manim\/projects\/([a-z][a-z0-9_-]{0,63})$/;
type ManimApi = ManimRenderManager | ManimProjectRegistry;

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
    }
    else response.destroy();
  });
  stream.pipe(response);
}

export function resolveByteRange(header: string | undefined, size: number): Readonly<{ kind: "full" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ end: number; kind: "partial"; start: number }> {
  if (!header) return { kind: "full" };
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return { kind: "invalid" };
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = suffixLength === null && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || (suffixLength !== null && (!Number.isInteger(suffixLength) || suffixLength <= 0))
    || start < 0
    || end < start
    || start >= size
  ) return { kind: "invalid" };
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
    case "cancel": return manager.cancel(id);
    case "commit": return manager.commit(id);
    case "discard": return manager.discard(id);
    case "undo": return manager.undo(id);
    default: throw new HttpError("Method not allowed.", 405);
  }
}

function sendPythonAttachment(
  response: ServerResponse,
  exported: ManimSourceExport,
) {
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

function sendThumbnailSvg(response: ServerResponse, status: 200 | 404, svg: string) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(svg));
  response.setHeader("content-security-policy", "default-src 'none'; sandbox");
  response.setHeader("content-type", "image/svg+xml; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(svg);
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
    if (!await sendJsonAndWaitForFinish(response, 202, started)) {
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
  const projectMatch = url.pathname.match(PROJECT_ROUTE);
  if (projectMatch) {
    const [, projectId, endpoint] = projectMatch;
    if (request.method === "GET" && endpoint === "thumbnail") {
      let thumbnail: string | null;
      try {
        thumbnail = await manager.thumbnailSvg(projectId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        thumbnail = null;
      }
      sendThumbnailSvg(response, thumbnail ? 200 : 404, thumbnail ?? EMPTY_MANIM_THUMBNAIL_SVG);
      return;
    }
    if (request.method === "GET" && endpoint === "workspace") {
      sendJson(response, 200, await manager.workspace(projectId));
      return;
    }
    if (request.method !== "POST" || endpoint === "workspace" || endpoint === "thumbnail") {
      throw new HttpError("Method not allowed.", 405);
    }
    const parsed = programRenderRequestSchema.safeParse(await readJsonBody(request, 512 * 1024));
    if (!parsed.success) {
      throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram request.", 400);
    }
    if (parsed.data.projectId !== projectId) {
      throw new HttpError("The request project does not match the project endpoint.", 409);
    }
    if (endpoint === "export") {
      sendPythonAttachment(response, await manager.exportSource(parsed.data, signal));
      return;
    }
    const started = await manager.start(parsed.data, signal);
    if (!await sendJsonAndWaitForFinish(response, 202, started)) {
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
    await routeManimRequest(manager, request, response, requestAbort.signal);
    logger.info("response.sent", { status: response.statusCode });
  } catch (error) {
    if (requestAbort.signal.aborted || (response.destroyed && error instanceof Error && error.name === "AbortError")) {
      const expectedAbort = error === requestAbort.signal.reason
        || (error instanceof Error && error.name === "AbortError")
        || (error instanceof HttpError && error.message === "Request body was interrupted.");
      const details = error instanceof Error ? { message: error.message, name: error.name } : { error };
      if (expectedAbort) logger.info("request.aborted", details);
      else logger.error("request.abort_cleanup_failed", details);
      return;
    }
    const expected = error instanceof HttpError;
    const status = expected ? error.status : 500;
    const message = expected ? error.message : "Manim render pipeline failed.";
    const details = error instanceof Error
      ? { error, message: error.message, name: error.name, status }
      : { error, status };
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
