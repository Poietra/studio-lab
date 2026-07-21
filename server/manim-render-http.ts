import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import { programRenderRequestSchema } from "../src/render-pipeline/contracts";
import { ManimPipelineError } from "./manim-pipeline-error";
import type { ManimRenderManager } from "./manim-render-pipeline";

const MAX_BODY_BYTES = 64 * 1024;
const RENDER_ROUTE = /^\/api\/manim\/renders\/([0-9a-f-]+)(?:\/(cancel|commit|discard|undo|video))?$/;

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ManimPipelineError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ManimPipelineError(400, "Request body must be valid JSON.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function pipeVideo(response: ServerResponse, path: string, range?: Readonly<{ end: number; start: number }>) {
  const stream = createReadStream(path, range);
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
  const metadata = await stat(path);
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

async function runRenderAction(manager: ManimRenderManager, id: string, action: string | undefined) {
  switch (action) {
    case "cancel": return manager.cancel(id);
    case "commit": return manager.commit(id);
    case "discard": return manager.discard(id);
    case "undo": return manager.undo(id);
    default: throw new ManimPipelineError(405, "Method not allowed.");
  }
}

async function routeManimRequest(
  manager: ManimRenderManager,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/manim/workspace") {
    sendJson(response, 200, await manager.workspace());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/manim/renders") {
    const parsed = programRenderRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      throw new ManimPipelineError(400, parsed.error.issues[0]?.message ?? "Invalid canonical EditProgram render request.");
    }
    sendJson(response, 202, await manager.start(parsed.data));
    return;
  }
  const match = url.pathname.match(RENDER_ROUTE);
  if (!match) throw new ManimPipelineError(404, "Manim endpoint not found.");
  const [, id, action] = match;
  if (request.method === "GET" && !action) {
    sendJson(response, 200, manager.view(id));
    return;
  }
  if (request.method === "GET" && action === "video") {
    await streamVideo(request, response, manager.videoPath(id));
    return;
  }
  if (request.method !== "POST") throw new ManimPipelineError(405, "Method not allowed.");
  sendJson(response, 200, await runRenderAction(manager, id, action));
}

export async function handleManimRequest(
  manager: ManimRenderManager,
  request: IncomingMessage,
  response: ServerResponse,
) {
  try {
    await routeManimRequest(manager, request, response);
  } catch (error) {
    const status = error instanceof ManimPipelineError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Manim render pipeline failed.";
    sendJson(response, status, { error: message });
  }
}
