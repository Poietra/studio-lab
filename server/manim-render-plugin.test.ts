import { request as createRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { manimRenderPipeline } from "./manim-render-plugin";

const PASSED_THROUGH_STATUS = 418;

/**
 * Boots only the middleware prefix gate: without `configResolved` the plugin
 * has no registry, so every request it claims is answered with the bounded
 * 503 "not configured" JSON error, while unclaimed requests reach the next
 * middleware. That separates the routing decision (#712 both route families)
 * from workspace bootstrap.
 */
type DevMiddleware = (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  next: () => void,
) => void | Promise<void>;

async function listenWithMiddleware() {
  const plugin = manimRenderPipeline();
  const handlers: DevMiddleware[] = [];
  const configureServer = plugin.configureServer as (server: unknown) => void;
  configureServer({
    middlewares: {
      use: (handler: DevMiddleware) => {
        handlers.push(handler);
      },
    },
  });
  const registered = handlers[0];
  if (!registered) throw new Error("The Manim render plugin did not register its middleware.");
  const server = createServer((request, response) => {
    void registered(request, response, () => {
      response.statusCode = PASSED_THROUGH_STATUS;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function send(port: number, path: string, method = "GET") {
  return new Promise<Readonly<{ body: string; status: number }>>((resolve, reject) => {
    const request = createRequest({ host: "127.0.0.1", method, path, port }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () =>
        resolve({ body: Buffer.concat(chunks).toString("utf8"), status: incoming.statusCode ?? 0 }),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

describe("Manim render dev middleware routing", () => {
  it("claims the legacy prefix and the neutral tenant aliases, and passes everything else through (#712)", async () => {
    const server = await listenWithMiddleware();
    const port = (server.address() as AddressInfo).port;
    const claimed = [
      "/api/manim/projects",
      "/api/manim/projects/project-a/renders",
      "/api/projects",
      "/api/projects/project-a",
      "/api/projects/project-a/workspace",
      "/api/projects/project-a/thumbnail",
      "/api/projects/project-a/thumbnail/status",
      "/api/projects/project-a/thumbnail?v=2026-07-23T10:00:00.000Z",
      `/api/projects/project-a/scene-snapshot-assets/${"a".repeat(64)}`,
    ];
    const passedThrough = [
      "/",
      "/api/editor/projects/project-a/documents/open",
      "/api/projectsx",
      "/api/project-imports",
      "/api/project-imports/extra",
      "/api/projects/project-a/renders",
      "/api/projects/project-a/export",
      "/api/projects/project-a/scene-snapshots",
      "/api/projects/project-a/runtime-traces",
      "/api/renders/00000000-0000-4000-8000-000000000001",
      "/api/workspace",
    ];
    try {
      for (const path of claimed) {
        const response = await send(port, path);
        expect(response.status, path).toBe(503);
        expect(JSON.parse(response.body), path).toEqual({ error: "Manim render pipeline is not configured." });
      }
      for (const path of passedThrough) {
        const response = await send(port, path);
        expect(response.status, path).toBe(PASSED_THROUGH_STATUS);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
