import { request as createRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import { handleManimRequest, type ManimApi, resolveByteRange } from "./manim-render-http";

describe("Manim video byte ranges", () => {
  it("supports full, bounded, open-ended, and suffix requests", () => {
    expect(resolveByteRange(undefined, 1_000)).toEqual({ kind: "full" });
    expect(resolveByteRange("bytes=10-19", 1_000)).toEqual({ end: 19, kind: "partial", start: 10 });
    expect(resolveByteRange("bytes=900-", 1_000)).toEqual({ end: 999, kind: "partial", start: 900 });
    expect(resolveByteRange("bytes=-100", 1_000)).toEqual({ end: 999, kind: "partial", start: 900 });
  });

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(resolveByteRange("items=0-1", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=-", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=1000-", 1_000)).toEqual({ kind: "invalid" });
    expect(resolveByteRange("bytes=20-10", 1_000)).toEqual({ kind: "invalid" });
  });
});

describe("async Manim API port", () => {
  it("awaits a durable project-list adapter before serializing the response", async () => {
    let resolved = false;
    const api = {
      async projects() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        resolved = true;
        return { defaultProjectId: null, projects: [] };
      },
      storageBoundary: { kind: "shared-durable", namespace: "http-async-test" },
      tenantId: "tenant-async",
    } as unknown as ManimApi;
    const server = createServer((request, response) => {
      void handleManimRequest(createTrustedLocalManimRequestContext(api, "test"), request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address() as AddressInfo;
      const response = await new Promise<Readonly<{ body: string; status: number }>>((resolve, reject) => {
        const request = createRequest(
          { host: "127.0.0.1", path: "/api/manim/projects", port: address.port },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.once("end", () =>
              resolve({ body: Buffer.concat(chunks).toString("utf8"), status: incoming.statusCode ?? 0 }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(resolved).toBe(true);
      expect(response).toEqual({ body: '{"defaultProjectId":null,"projects":[]}', status: 200 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
