import { request as createRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
  MAX_BROWSER_MANIM_SOURCE_BYTES_V1,
  type ProgramRenderRequest,
  RENDER_SESSION_CONTRACT_VERSION_HEADER,
  RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
  RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE,
  type RenderSessionView,
} from "../src/render-pipeline/contracts";
import { createStructuredLogger, type StructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import { handleManimRequest, type ManimApi, type ManimRequestPolicy, resolveByteRange } from "./manim-render-http";

async function listen(api: ManimApi, policy?: ManimRequestPolicy, logger?: StructuredLogger) {
  const server = createServer((request, response) => {
    void handleManimRequest(createTrustedLocalManimRequestContext(api, "test"), request, response, logger, policy);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function send(
  port: number,
  path: string,
  options: Readonly<{ body?: string; headers?: Record<string, string>; method?: string }> = {},
) {
  return new Promise<Readonly<{ body: Buffer; headers: import("node:http").IncomingHttpHeaders; status: number }>>(
    (resolve, reject) => {
      const request = createRequest(
        { headers: options.headers, host: "127.0.0.1", method: options.method, path, port },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.once("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: incoming.headers,
              status: incoming.statusCode ?? 0,
            }),
          );
        },
      );
      request.once("error", reject);
      request.end(options.body);
    },
  );
}

function renderSession(overrides: Partial<RenderSessionView> = {}): RenderSessionView {
  return {
    actionInProgress: false,
    canCancel: false,
    canCommit: false,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-07-29T00:00:00.000Z",
    error: "Render exceeded its memory limit.",
    failureCode: "memory-limit",
    id: "00000000-0000-4000-8000-000000000001",
    logTail: "",
    patch: {
      anchorLine: 1,
      anchorLines: [1],
      insertedCode: "self.wait(1)",
      patchedSourceHash: "b".repeat(64),
      sourceHash: "a".repeat(64),
    },
    programBatchId: "batch-1",
    programTransactionId: "transaction-1",
    progress: 1,
    projectId: "project-a",
    renderRequestId: "render-request-1",
    sceneName: "SceneOne",
    sourceAction: null,
    sourcePath: "scene.py",
    status: "failed",
    updatedAt: "2026-07-29T00:00:01.000Z",
    videoUrl: null,
    ...overrides,
  };
}

function programRenderRequest(sceneName: string): ProgramRenderRequest {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: "tx/operation:motion",
    interval: { end: 2, start: 1 },
    kind: "CreateMotion" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    targetEntityIds: ["equation"],
  };
  return {
    destination: null,
    program: {
      anchor: {
        capturedPlayhead: 1,
        evidence: [],
        resolvedSeconds: 1,
        source: { kind: "playhead", referenceSeconds: 1 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "tx",
      version: 1,
    },
    projectId: "project-a",
    sceneName,
    sourceBindings: [{ entityId: "equation", sourceVariable: "equation" }],
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    viewport: { height: 360, width: 640 },
  };
}

describe("render session contract negotiation", () => {
  it("routes a bounded source-only browser import without accepting tenant or object identifiers", async () => {
    const imported = {
      catalog: {
        defaultProjectId: "project-browser-import",
        projects: [{ id: "project-browser-import", kind: "managed" as const, name: "Imported demo" }],
      },
      project: { id: "project-browser-import", kind: "managed" as const, name: "Imported demo" },
    };
    const importBrowserProject = vi.fn(async () => imported);
    const api = {
      importBrowserProject,
      storageBoundary: { kind: "shared-durable", namespace: "browser-import-http-test" },
      tenantId: "tenant-a",
    } as unknown as ManimApi;
    const server = await listen(api);
    const source = "from manim import *\nclass ImportedScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    try {
      const port = (server.address() as AddressInfo).port;
      const accepted = await send(port, "/api/manim/project-imports", {
        body: JSON.stringify({ name: "Imported demo", source, sourceName: "lesson.py" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(accepted.status).toBe(201);
      expect(JSON.parse(accepted.body.toString("utf8"))).toEqual(imported);
      expect(importBrowserProject).toHaveBeenCalledWith(
        { name: "Imported demo", source, sourceName: "lesson.py" },
        expect.any(AbortSignal),
      );

      const traversal = await send(port, "/api/manim/project-imports", {
        body: JSON.stringify({ name: "Traversal", source, sourceName: "../lesson.py" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(traversal.status).toBe(400);
      expect(importBrowserProject).toHaveBeenCalledOnce();

      const escapedSource = `${source}${"\u0001".repeat(MAX_BROWSER_MANIM_SOURCE_BYTES_V1 - Buffer.byteLength(source))}`;
      const worstCaseBody = JSON.stringify({ name: "Escaped source", source: escapedSource, sourceName: "scene.py" });
      expect(Buffer.byteLength(escapedSource)).toBe(MAX_BROWSER_MANIM_SOURCE_BYTES_V1);
      expect(Buffer.byteLength(worstCaseBody)).toBeLessThanOrEqual(MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1);
      const worstCase = await send(port, "/api/manim/project-imports", {
        body: worstCaseBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(worstCase.status).toBe(201);
      expect(importBrowserProject).toHaveBeenCalledTimes(2);
      expect(importBrowserProject).toHaveBeenNthCalledWith(
        2,
        { name: "Escaped source", source: escapedSource, sourceName: "scene.py" },
        expect.any(AbortSignal),
      );

      const oversizedBody = JSON.stringify({
        name: "Oversized transport",
        source: "\u0001".repeat(Math.ceil(MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1 / 6) + 1_024),
        sourceName: "scene.py",
      });
      expect(Buffer.byteLength(oversizedBody)).toBeGreaterThan(MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1);
      const oversized = await send(port, "/api/manim/project-imports", {
        body: oversizedBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(oversized.status).toBe(413);
      expect(importBrowserProject).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("omits failureCode for legacy clients, downmaps CPU for v2, and preserves it in v3", async () => {
    const view = vi.fn(async () =>
      renderSession({
        error: "Render exceeded its CPU budget.",
        failureCode: "cpu-limit",
      }),
    );
    const api = {
      storageBoundary: { kind: "shared-durable", namespace: "http-render-contract-test" },
      tenantId: "tenant-render-contract",
      view,
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      const path = "/api/manim/renders/00000000-0000-4000-8000-000000000001";
      const legacy = JSON.parse((await send(port, path)).body.toString("utf8")) as Record<string, unknown>;
      const unsupportedVersion = JSON.parse(
        (
          await send(port, path, {
            headers: { [RENDER_SESSION_CONTRACT_VERSION_HEADER]: "1" },
          })
        ).body.toString("utf8"),
      ) as Record<string, unknown>;
      const v2 = JSON.parse(
        (
          await send(port, path, {
            headers: {
              [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE,
            },
          })
        ).body.toString("utf8"),
      ) as Record<string, unknown>;
      const v3 = JSON.parse(
        (
          await send(port, path, {
            headers: {
              [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
            },
          })
        ).body.toString("utf8"),
      ) as Record<string, unknown>;
      view.mockResolvedValueOnce(renderSession());
      const v2ExistingCode = JSON.parse(
        (
          await send(port, path, {
            headers: { [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE },
          })
        ).body.toString("utf8"),
      ) as Record<string, unknown>;

      expect(legacy).not.toHaveProperty("failureCode");
      expect(unsupportedVersion).not.toHaveProperty("failureCode");
      expect(v2.failureCode).toBe("render-failed");
      expect(v3.failureCode).toBe("cpu-limit");
      expect(v2ExistingCode.failureCode).toBe("memory-limit");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("applies the same negotiation to a nested source-action cancellation session", async () => {
    const actionId = "00000000-0000-4000-8000-000000000002";
    const api = {
      cancelSourceAction: vi.fn(async () => ({
        action: { id: actionId, kind: "commit", outcome: null, state: "cancelled" },
        session: renderSession({ error: "Render exceeded its CPU budget.", failureCode: "cpu-limit" }),
      })),
      storageBoundary: { kind: "shared-durable", namespace: "http-render-contract-test" },
      tenantId: "tenant-render-contract",
    } as unknown as ManimApi;
    const server = await listen(api);
    const path = "/api/manim/renders/00000000-0000-4000-8000-000000000001/cancel-source-action";
    const body = JSON.stringify({ actionId, kind: "commit" });
    try {
      const port = (server.address() as AddressInfo).port;
      const legacy = JSON.parse(
        (
          await send(port, path, {
            body,
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        ).body.toString("utf8"),
      ) as { session: Record<string, unknown> };
      const v2 = JSON.parse(
        (
          await send(port, path, {
            body,
            headers: {
              "content-type": "application/json",
              [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE,
            },
            method: "POST",
          })
        ).body.toString("utf8"),
      ) as { session: Record<string, unknown> };
      const v3 = JSON.parse(
        (
          await send(port, path, {
            body,
            headers: {
              "content-type": "application/json",
              [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
            },
            method: "POST",
          })
        ).body.toString("utf8"),
      ) as { session: Record<string, unknown> };

      expect(legacy.session).not.toHaveProperty("failureCode");
      expect(v2.session.failureCode).toBe("render-failed");
      expect(v3.session.failureCode).toBe("cpu-limit");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

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
  it("accepts Scene names through 240 characters and rejects 241 before the render adapter", async () => {
    const start = vi.fn(async (request: ProgramRenderRequest) =>
      renderSession({ projectId: request.projectId, sceneName: request.sceneName }),
    );
    const api = {
      start,
      storageBoundary: { kind: "shared-durable", namespace: "http-scene-name-boundary-test" },
      tenantId: "tenant-scene-name-boundary",
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      for (const length of [128, 129, 240]) {
        const sceneName = `S${"a".repeat(length - 1)}`;
        const response = await send(port, "/api/manim/projects/project-a/renders", {
          body: JSON.stringify(programRenderRequest(sceneName)),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        expect(response.status, `${length}-character Scene name`).toBe(202);
      }

      const rejected = await send(port, "/api/manim/projects/project-a/renders", {
        body: JSON.stringify(programRenderRequest(`S${"a".repeat(240)}`)),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.byteLength).toBeLessThan(1_024);
      expect(JSON.parse(rejected.body.toString("utf8"))).toEqual({
        error: "Scene names accept at most 240 characters.",
      });
      expect(start).toHaveBeenCalledTimes(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("serves authenticated digest-addressed snapshot PNG bytes without storage identity", async () => {
    const digest = "a".repeat(64);
    const sceneSnapshotAsset = vi.fn(async () => ({
      body: Uint8Array.of(137, 80, 78, 71),
      digest,
      mediaType: "image/png" as const,
    }));
    const api = {
      sceneSnapshotAsset,
      storageBoundary: { kind: "shared-durable", namespace: "http-snapshot-asset-test" },
      tenantId: "tenant-snapshot-asset",
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      const path = `/api/manim/projects/project-a/scene-snapshot-assets/${digest}`;
      const get = await send(port, path);
      expect(get).toMatchObject({ body: Buffer.from([137, 80, 78, 71]), status: 200 });
      expect(get.headers["content-type"]).toBe("image/png");
      expect(get.headers.etag).toBe(`"sha256:${digest}"`);
      expect(get.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(JSON.stringify(get.headers)).not.toContain("objectKey");

      const head = await send(port, path, { method: "HEAD" });
      expect(head).toMatchObject({ body: Buffer.alloc(0), status: 200 });
      expect(head.headers["content-length"]).toBe("4");
      expect(sceneSnapshotAsset).toHaveBeenNthCalledWith(1, "project-a", digest, expect.any(AbortSignal));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

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

  it("holds and releases one authorized media handle across HEAD and Range GET", async () => {
    const close = vi.fn(async () => undefined);
    const open = vi.fn(async () =>
      (async function* () {
        yield new Uint8Array([1, 2]);
      })(),
    );
    const api = {
      storageBoundary: { kind: "shared-durable", namespace: "http-media-test" },
      tenantId: "tenant-media",
      video: vi.fn(async () => ({ byteSize: 4, close, mediaType: "video/mp4", open })),
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      const path = "/api/manim/renders/00000000-0000-4000-8000-000000000001/video";
      const head = await send(port, path, { method: "HEAD" });
      expect(head).toMatchObject({ body: Buffer.alloc(0), status: 200 });
      expect(head.headers["content-length"]).toBe("4");
      expect(open).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();

      close.mockClear();
      const range = await send(port, path, { headers: { range: "bytes=1-2" } });
      expect(range).toMatchObject({ body: Buffer.from([1, 2]), status: 206 });
      expect(range.headers["content-range"]).toBe("bytes 1-2/4");
      expect(open).toHaveBeenCalledWith({ end: 2, start: 1 }, expect.any(AbortSignal));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("validates stream policy before acquiring an authorized media handle", async () => {
    const video = vi.fn();
    const api = {
      storageBoundary: { kind: "shared-durable", namespace: "http-media-policy-test" },
      tenantId: "tenant-media",
      video,
    } as unknown as ManimApi;
    const server = await listen(api, {
      allowExistingProjectRegistration: true,
      mediaStreamIdleTimeoutMs: 999,
    });
    try {
      const response = await send(
        (server.address() as AddressInfo).port,
        "/api/manim/renders/00000000-0000-4000-8000-000000000001/video",
      );
      expect(response.status).toBe(500);
      expect(video).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("propagates a disconnected thumbnail request to durable storage", async () => {
    const records: StructuredLogRecord[] = [];
    let startedResolve!: () => void;
    let abortedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    const api = {
      storageBoundary: { kind: "shared-durable", namespace: "http-thumbnail-abort-test" },
      tenantId: "tenant-thumbnail",
      thumbnail: vi.fn((_projectId: string, signal?: AbortSignal) => {
        if (!signal) throw new Error("Thumbnail storage received no abort signal.");
        startedResolve();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortedResolve();
              reject(new DOMException("Downstream request aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }),
    } as unknown as ManimApi;
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const server = await listen(api, undefined, logger);
    try {
      const request = createRequest({
        host: "127.0.0.1",
        path: "/api/manim/projects/project-a/thumbnail",
        port: (server.address() as AddressInfo).port,
      });
      request.on("error", () => undefined);
      request.end();
      await started;
      request.destroy();
      await aborted;
      expect(api.thumbnail).toHaveBeenCalledWith("project-a", expect.any(AbortSignal));
      await vi.waitFor(() =>
        expect(records.find(({ event }) => event === "request.aborted")?.data).toEqual({ kind: "ExpectedAbort" }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
