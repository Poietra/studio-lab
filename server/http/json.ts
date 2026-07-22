import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function isJsonMediaType(header: string | undefined) {
  const mediaType = header?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

function readBody(request: IncomingMessage, maxBytes: number) {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let draining = false;
    let settled = false;
    let size = 0;
    const cleanup = () => {
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };
    const onAborted = () => {
      rejectOnce(new HttpError("Request body was interrupted.", 400));
    };
    const onClose = () => {
      if (!request.complete) rejectOnce(new HttpError("Request body was interrupted.", 400));
      cleanup();
    };
    const onData = (chunk: Buffer | string) => {
      if (draining) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        draining = true;
        chunks.length = 0;
        rejectOnce(new HttpError("Request body is too large.", 413));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks, size));
    };
    const onError = () => {
      rejectOnce(new HttpError("Request body could not be read.", 400));
      cleanup();
    };
    request.on("aborted", onAborted);
    request.on("close", onClose);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

export async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Maximum JSON request size must be a positive integer.");
  }
  if (!isJsonMediaType(request.headers["content-type"])) {
    request.resume();
    throw new HttpError("Request content type must be application/json.", 415);
  }
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError("Request body must be valid JSON.");
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return false;
  const payload = JSON.stringify(body) ?? "null";
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
  return true;
}
