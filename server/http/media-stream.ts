import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type HttpMediaAssetV1 = Readonly<{
  byteSize: number;
  close: () => Promise<void>;
  mediaType: string;
  open: (
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ) => Promise<AsyncIterable<Uint8Array>>;
}>;

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
  ) {
    return { kind: "invalid" };
  }
  return { end, kind: "partial", start };
}

/** Streams one neutral immutable media asset with range and idle-deadline handling. */
export async function streamHttpMediaV1(
  request: IncomingMessage,
  response: ServerResponse,
  asset: HttpMediaAssetV1,
  signal: AbortSignal,
  idleTimeoutMs: number,
) {
  const idleAbort = new AbortController();
  const streamSignal = AbortSignal.any([signal, idleAbort.signal]);
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdleTimeout = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => idleAbort.abort(new Error("Media stream stalled beyond its idle deadline.")),
      idleTimeoutMs,
    );
    idleTimer.unref();
  };
  try {
    const range = resolveByteRange(request.headers.range, asset.byteSize);
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", asset.mediaType);
    response.setHeader("x-content-type-options", "nosniff");
    if (range.kind === "invalid") {
      response.statusCode = 416;
      response.setHeader("content-range", `bytes */${asset.byteSize}`);
      response.end();
      return;
    }
    const selected = range.kind === "partial" ? { end: range.end, start: range.start } : null;
    response.statusCode = selected ? 206 : 200;
    response.setHeader("content-length", selected ? selected.end - selected.start + 1 : asset.byteSize);
    if (selected) response.setHeader("content-range", `bytes ${selected.start}-${selected.end}/${asset.byteSize}`);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    armIdleTimeout();
    const body = await asset.open(selected, streamSignal);
    const boundedBody = (async function* () {
      for await (const chunk of body) {
        streamSignal.throwIfAborted();
        armIdleTimeout();
        yield chunk;
      }
    })();
    await pipeline(Readable.from(boundedBody), response, { signal: streamSignal });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await asset.close();
  }
}
