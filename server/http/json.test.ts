import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { HttpError, readJsonBody, sendJson } from "./json";

async function withJsonServer(
  maxBytes: number,
  call: (url: string) => Promise<void>,
) {
  const server = createServer(async (request, response) => {
    try {
      sendJson(response, 200, { body: await readJsonBody(request, maxBytes) });
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await call(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("JSON HTTP boundary", () => {
  it("accepts JSON media types and parses the request exactly once", async () => {
    await withJsonServer(128, async (url) => {
      const response = await fetch(url, {
        body: JSON.stringify({ value: 42 }),
        headers: { "content-type": "application/problem+json; charset=utf-8" },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ body: { value: 42 } });
    });
  });

  it("rejects unsupported content types", async () => {
    await withJsonServer(128, async (url) => {
      const response = await fetch(url, {
        body: "{}",
        headers: { "content-type": "text/plain" },
        method: "POST",
      });

      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        error: "Request content type must be application/json.",
      });
    });
  });

  it("returns a 413 response while safely draining an oversized body", async () => {
    await withJsonServer(8, async (url) => {
      const response = await fetch(url, {
        body: JSON.stringify({ value: "too large" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    });
  });
});
