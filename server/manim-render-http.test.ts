import { request as createRequest, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1,
  MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1,
  MAX_BROWSER_MANIM_SOURCE_BYTES_V1,
  type ProgramRenderRequest,
  RENDER_SESSION_CONTRACT_VERSION_HEADER,
  RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
  RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE,
  type RenderSessionView,
} from "../src/render-pipeline/contracts";
import type {
  FastManimRuntimeTraceRunViewV1,
  FastManimRuntimeTraceRunViewV2,
} from "../src/render-pipeline/runtime-trace-preview-contract";
import {
  digestFastManimRuntimeTraceIdentityV3,
  lowerVerifiedFastManimRuntimeTraceV3,
} from "./fast-manim-runtime-trace-v3-lowering";
import {
  digestFastManimRuntimeTraceSourceBindingsV3,
  fastManimRuntimeTraceV3Schema,
} from "./fast-manim-runtime-trace-v3-result-contract";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import { createStructuredLogger, type StructuredLogger, type StructuredLogRecord } from "./logging/structured-logger";
import { createTrustedLocalManimRequestContext } from "./manim-local-request-context";
import {
  canonicalManimRoutePathname,
  handleManimRequest,
  isManimBrowserProjectImportRequest,
  isManimRenderStartRequest,
  isManimVideoRequest,
  isManimWorkspaceBootstrapRequest,
  isNeutralTenantRouteAlias,
  isTenantCellStorageLaneManimRequest,
  type ManimApi,
  type ManimRequestPolicy,
  resolveByteRange,
} from "./manim-render-http";
import genericRuntimeTraceFixture from "./test-fixtures/fast-manim-runtime-trace-v3-generic.json";

type FastManimRuntimeTraceRunViewV2WithBundle = Omit<FastManimRuntimeTraceRunViewV2, "bundle"> & {
  bundle: Awaited<ReturnType<typeof lowerVerifiedFastManimRuntimeTraceV3>>;
};

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
  it("routes bounded source and optional image browser imports without accepting storage identifiers", async () => {
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
        body: JSON.stringify({ imagePngBase64: null, name: "Imported demo", source, sourceName: "lesson.py" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(accepted.status).toBe(201);
      expect(JSON.parse(accepted.body.toString("utf8"))).toEqual(imported);
      expect(importBrowserProject).toHaveBeenCalledWith(
        { imagePngBase64: null, name: "Imported demo", source, sourceName: "lesson.py" },
        expect.any(AbortSignal),
      );

      const traversal = await send(port, "/api/manim/project-imports", {
        body: JSON.stringify({ imagePngBase64: null, name: "Traversal", source, sourceName: "../lesson.py" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(traversal.status).toBe(400);
      expect(importBrowserProject).toHaveBeenCalledOnce();

      const escapedSource = `${source}${"\u0001".repeat(MAX_BROWSER_MANIM_SOURCE_BYTES_V1 - Buffer.byteLength(source))}`;
      const maximumPngBase64 = Buffer.alloc(MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1).toString("base64");
      const worstCaseBody = JSON.stringify({
        imagePngBase64: maximumPngBase64,
        name: "Escaped source",
        source: escapedSource,
        sourceName: "scene.py",
      });
      expect(Buffer.byteLength(escapedSource)).toBe(MAX_BROWSER_MANIM_SOURCE_BYTES_V1);
      expect(Buffer.from(maximumPngBase64, "base64")).toHaveLength(MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1);
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
        { imagePngBase64: maximumPngBase64, name: "Escaped source", source: escapedSource, sourceName: "scene.py" },
        expect.any(AbortSignal),
      );

      const oversizedBody = JSON.stringify({
        imagePngBase64: null,
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

  it("routes the studio-native project kind only to adapters that provide the native lane", async () => {
    const created = {
      catalog: {
        defaultProjectId: "project-native",
        projects: [{ id: "project-native", kind: "managed" as const, name: "Native demo" }],
      },
      project: { id: "project-native", kind: "managed" as const, name: "Native demo" },
    };
    const createManagedProject = vi.fn(async () => created);
    const createNativeStudioProject = vi.fn(async () => created);
    const registry = {
      createManagedProject,
      createProject: vi.fn(async () => created),
      renameProject: vi.fn(async () => created),
      unregisterProject: vi.fn(async () => created),
    };
    const api = {
      ...registry,
      createNativeStudioProject,
      storageBoundary: { kind: "shared-durable", namespace: "native-project-http-test" },
      tenantId: "tenant-a",
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      const accepted = await send(port, "/api/manim/projects", {
        body: JSON.stringify({ kind: "studio-native", name: "Native demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(accepted.status).toBe(201);
      expect(JSON.parse(accepted.body.toString("utf8"))).toEqual(created);
      expect(createNativeStudioProject).toHaveBeenCalledWith("Native demo", expect.any(AbortSignal));
      expect(createManagedProject).not.toHaveBeenCalled();

      const managed = await send(port, "/api/manim/projects", {
        body: JSON.stringify({ kind: "managed", name: "Starter demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(managed.status).toBe(201);
      expect(createManagedProject).toHaveBeenCalledWith("Starter demo", expect.any(AbortSignal));
      expect(createNativeStudioProject).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    const withoutNativeLane = {
      ...registry,
      storageBoundary: { kind: "shared-durable", namespace: "native-project-unsupported-http-test" },
      tenantId: "tenant-a",
    } as unknown as ManimApi;
    const fallbackServer = await listen(withoutNativeLane);
    try {
      const port = (fallbackServer.address() as AddressInfo).port;
      const rejected = await send(port, "/api/manim/projects", {
        body: JSON.stringify({ kind: "studio-native", name: "Native demo" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(rejected.status).toBe(403);
      expect(createManagedProject).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        fallbackServer.close((error) => (error ? reject(error) : resolve())),
      );
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

describe("Runtime Trace preview routing", () => {
  const trace = fastManimRuntimeTraceV3Schema.parse(genericRuntimeTraceFixture);
  const requestBody = {
    projectId: trace.projectId,
    requestId: trace.requestId,
    sceneName: trace.sceneName,
    sourceHash: trace.sourceHash,
    sourcePath: trace.sourcePath,
  } as const;

  async function verifiedGenericView(): Promise<FastManimRuntimeTraceRunViewV2WithBundle> {
    const genericTrace = fastManimRuntimeTraceV3Schema.parse(genericRuntimeTraceFixture);
    const bundle = await lowerVerifiedFastManimRuntimeTraceV3(genericTrace);
    const source = bundle.scene.source;
    if (source.kind !== "imported-manim-runtime-trace") throw new Error("Expected Runtime Trace source evidence.");
    return {
      bundle,
      producerEvidence: {
        correlationSha256: genericTrace.producer.correlationSha256,
        semanticsSha256: genericTrace.producer.semanticsSha256,
      },
      projectId: genericTrace.projectId,
      requestId: genericTrace.requestId,
      roots: genericTrace.sourceBindings.map(({ binding, endpoints, rootId, updaterStatus }) => ({
        binding,
        entityId: rootId,
        evidence: { endpoints, updaterStatus },
      })),
      runtimeConfigHash: genericTrace.runtimeConfigHash,
      sceneId: genericTrace.sceneId,
      sceneName: genericTrace.sceneName,
      schema: "poietra.fast-manim-runtime-trace-run",
      sourceHash: genericTrace.sourceHash,
      sourcePath: genericTrace.sourcePath,
      status: "verified",
      traceDigest: source.traceDigest,
      version: 2,
    } as const satisfies FastManimRuntimeTraceRunViewV2;
  }

  function resealGenericAuthorityView(view: FastManimRuntimeTraceRunViewV2WithBundle) {
    const correlationSha256 = digestFastManimRuntimeTraceSourceBindingsV3(
      view.sourceHash,
      view.sceneId,
      view.roots.map(({ binding, entityId, evidence }) => ({
        binding,
        endpoints: evidence.endpoints,
        rootId: entityId,
        updaterStatus: evidence.updaterStatus,
      })),
    );
    const traceDigest = digestFastManimRuntimeTraceIdentityV3({
      correlationSha256,
      runtimeConfigHash: view.runtimeConfigHash,
      sceneId: view.sceneId,
      semanticsSha256: view.producerEvidence.semanticsSha256,
      sourceHash: view.sourceHash,
    });
    const source = view.bundle.scene.source;
    if (source.kind !== "imported-manim-runtime-trace") throw new Error("Expected Runtime Trace source evidence.");
    view.producerEvidence.correlationSha256 = correlationSha256;
    view.traceDigest = traceDigest;
    source.traceDigest = traceDigest;
    return view;
  }

  async function postGenericBackendValue(value: unknown, correlatedView: FastManimRuntimeTraceRunViewV2) {
    const server = await listen({
      runRuntimeTrace: async () => value,
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-v3-authority" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi);
    try {
      return await send(
        (server.address() as AddressInfo).port,
        `/api/manim/projects/${correlatedView.projectId}/runtime-traces`,
        {
          body: JSON.stringify({
            projectId: correlatedView.projectId,
            requestId: correlatedView.requestId,
            sceneName: correlatedView.sceneName,
            sourceHash: correlatedView.sourceHash,
            sourcePath: correlatedView.sourcePath,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }

  it("routes one correlated POST and leaves the endpoint unpublished", async () => {
    const view = await verifiedGenericView();
    const genericRequestBody = {
      projectId: view.projectId,
      requestId: view.requestId,
      sceneName: view.sceneName,
      sourceHash: view.sourceHash,
      sourcePath: view.sourcePath,
    } as const;
    const runRuntimeTrace = vi.fn(async () => view);
    const api = {
      runRuntimeTrace,
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-test" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi;
    const server = await listen(api);
    try {
      const port = (server.address() as AddressInfo).port;
      const path = `/api/manim/projects/${view.projectId}/runtime-traces`;
      const posted = await send(port, path, {
        body: JSON.stringify(genericRequestBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(posted.status).toBe(200);
      expect(JSON.parse(posted.body.toString("utf8"))).toEqual(view);
      expect(runRuntimeTrace).toHaveBeenCalledWith(genericRequestBody, expect.any(AbortSignal));

      const get = await send(port, path);
      expect(get.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("admits a correlated generic V3 authority envelope", async () => {
    const view = await verifiedGenericView();
    const response = await postGenericBackendValue(view, view);

    expect(view.version).toBe(2);
    expect(view.roots).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual(view);
  });

  it("rejects the retired rootless generic wire V1 response", async () => {
    const authorityView = await verifiedGenericView();
    const { producerEvidence: _producerEvidence, ...withoutProducerEvidence } = authorityView;
    const legacyView = { ...withoutProducerEvidence, roots: [], version: 1 } as const;
    const response = await postGenericBackendValue(legacyView, authorityView);

    expect(response.status).toBe(502);
  });

  it("rejects V3 authority version and closed-shape tampering", async () => {
    const view = await verifiedGenericView();
    const downgraded = structuredClone(view) as Record<string, unknown>;
    downgraded.version = 1;
    const widened = structuredClone(view) as FastManimRuntimeTraceRunViewV2;
    Object.assign(widened.roots[0]!.evidence, { editAuthority: true });

    for (const tampered of [downgraded, widened]) {
      const response = await postGenericBackendValue(tampered, view);
      expect(response.status).toBe(502);
    }
  });

  it("rejects duplicate V3 binding identities, names, roots, and non-ordinal ordering", async () => {
    const original = await verifiedGenericView();
    const addRootEntity = (view: FastManimRuntimeTraceRunViewV2WithBundle) => {
      const sourceRoot = view.bundle.scene.entities.find(({ id }) => id === view.roots[0]!.entityId)!;
      const entityId = `${view.sceneId}/runtime-v3-root:1`;
      view.bundle.scene.entities.push({
        ...structuredClone(sourceRoot),
        id: entityId,
        sceneOrder: Math.max(...view.bundle.scene.entities.map(({ sceneOrder }) => sceneOrder)) + 1,
      });
      return entityId;
    };
    const distinctBinding = (view: FastManimRuntimeTraceRunViewV2WithBundle, name: string, ordinal: number) => {
      const binding = {
        ...structuredClone(view.roots[0]!.binding),
        name,
        ordinal,
        span: { endColumn: 20 + ordinal, endLine: 5, startColumn: 10 + ordinal, startLine: 5 },
      };
      binding.id = fastManimSourceBindingIdentifierV1(view.sourceHash, view.sceneId, binding);
      return binding;
    };

    const duplicateBinding = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    duplicateBinding.roots.push({
      ...structuredClone(duplicateBinding.roots[0]!),
      entityId: addRootEntity(duplicateBinding),
    });
    resealGenericAuthorityView(duplicateBinding);

    const duplicateName = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    duplicateName.roots.push({
      ...structuredClone(duplicateName.roots[0]!),
      binding: distinctBinding(duplicateName, duplicateName.roots[0]!.binding.name, 2),
      entityId: addRootEntity(duplicateName),
    });
    resealGenericAuthorityView(duplicateName);

    const duplicateRoot = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    duplicateRoot.roots.push({
      ...structuredClone(duplicateRoot.roots[0]!),
      binding: distinctBinding(duplicateRoot, "circle", 2),
    });
    resealGenericAuthorityView(duplicateRoot);

    const nonOrdinal = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    nonOrdinal.roots.push({
      ...structuredClone(nonOrdinal.roots[0]!),
      binding: distinctBinding(nonOrdinal, "circle", 2),
      entityId: addRootEntity(nonOrdinal),
    });
    nonOrdinal.roots.reverse();
    resealGenericAuthorityView(nonOrdinal);

    for (const tampered of [duplicateBinding, duplicateName, duplicateRoot, nonOrdinal]) {
      const response = await postGenericBackendValue(tampered, original);
      expect(response.status).toBe(502);
    }
  });

  it("rejects a nested root substitution and endpoint lifetime drift after digest resealing", async () => {
    const original = await verifiedGenericView();
    const nestedRoot = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    nestedRoot.roots[0]!.entityId = nestedRoot.bundle.scene.entities.find(({ parentId }) => parentId !== null)!.id;
    resealGenericAuthorityView(nestedRoot);

    const staleEndpoint = structuredClone(original) as FastManimRuntimeTraceRunViewV2WithBundle;
    staleEndpoint.roots[0]!.evidence.endpoints.terminal.frameIndex = 1;
    staleEndpoint.roots[0]!.evidence.endpoints.terminal.sampleTime = Number((1 / 60).toFixed(13));
    resealGenericAuthorityView(staleEndpoint);

    for (const tampered of [nestedRoot, staleEndpoint]) {
      const response = await postGenericBackendValue(tampered, original);
      expect(response.status).toBe(502);
    }
  });

  it("preserves updater conflicts as verified identity evidence", async () => {
    const view = structuredClone(await verifiedGenericView()) as FastManimRuntimeTraceRunViewV2WithBundle;
    view.roots[0]!.evidence.updaterStatus = "conflict";
    resealGenericAuthorityView(view);

    const response = await postGenericBackendValue(view, view);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString("utf8"))).toEqual(view);
  });

  it("does not expose legacy profile selection through public requests", async () => {
    for (const [index, sceneName] of ["UpdatersExample", "OpeningManim"].entries()) {
      const runRuntimeTrace = vi.fn(async () => ({}));
      const server = await listen({
        runRuntimeTrace,
        storageBoundary: { kind: "shared-durable", namespace: `http-runtime-trace-legacy-${index}` },
        tenantId: "tenant-runtime-trace",
      } as unknown as ManimApi);
      const body = { ...requestBody, sceneName };
      try {
        const response = await send(
          (server.address() as AddressInfo).port,
          `/api/manim/projects/${requestBody.projectId}/runtime-traces`,
          {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        expect(response.status).toBe(502);
        expect(runRuntimeTrace).toHaveBeenCalledWith(body, expect.any(AbortSignal));
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    }
  });

  it("rejects path mismatch and an unconfigured API before execution", async () => {
    const view = await verifiedGenericView();
    const runRuntimeTrace = vi.fn(async () => view);
    const configured = await listen({
      runRuntimeTrace,
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-mismatch" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi);
    const unavailable = await listen({
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-unavailable" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi);
    try {
      const mismatch = await send(
        (configured.address() as AddressInfo).port,
        "/api/manim/projects/project-b/runtime-traces",
        {
          body: JSON.stringify(requestBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(mismatch.status).toBe(409);
      expect(runRuntimeTrace).not.toHaveBeenCalled();

      const missing = await send(
        (unavailable.address() as AddressInfo).port,
        `/api/manim/projects/${requestBody.projectId}/runtime-traces`,
        {
          body: JSON.stringify(requestBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(missing.status).toBe(501);
    } finally {
      await Promise.all(
        [configured, unavailable].map(
          (server) =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        ),
      );
    }
  });

  it("preserves a correlated fail-closed result for the browser fallback", async () => {
    const failed = {
      failure: { code: "unsupported-profile", message: "This profile is unavailable." },
      projectId: requestBody.projectId,
      requestId: requestBody.requestId,
      runtimeConfigHash: "e".repeat(64),
      sceneId: trace.sceneId,
      sceneName: requestBody.sceneName,
      schema: "poietra.fast-manim-runtime-trace-run",
      sourceHash: requestBody.sourceHash,
      sourcePath: requestBody.sourcePath,
      status: "failed",
      version: 1,
    } as const satisfies FastManimRuntimeTraceRunViewV1;
    const server = await listen({
      runRuntimeTrace: async () => failed,
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-fallback" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi);
    try {
      const response = await send(
        (server.address() as AddressInfo).port,
        `/api/manim/projects/${requestBody.projectId}/runtime-traces`,
        {
          body: JSON.stringify(requestBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual(failed);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("rejects malformed verified evidence without returning backend-controlled data", async () => {
    const view = await verifiedGenericView();
    const leakedSource = "private source text must not cross the HTTP boundary";
    const runRuntimeTrace = vi.fn(async () => ({
      ...view,
      bundle: { absolutePath: "/private/workspace/basic.py", leakedSource },
    }));
    const server = await listen({
      runRuntimeTrace,
      storageBoundary: { kind: "shared-durable", namespace: "http-runtime-trace-invalid-output" },
      tenantId: "tenant-runtime-trace",
    } as unknown as ManimApi);
    try {
      const response = await send(
        (server.address() as AddressInfo).port,
        `/api/manim/projects/${requestBody.projectId}/runtime-traces`,
        {
          body: JSON.stringify(requestBody),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      expect(response.status).toBe(502);
      expect(response.body.toString("utf8")).not.toContain(leakedSource);
      expect(response.body.toString("utf8")).not.toContain("/private/workspace");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("neutral tenant route aliases (#712)", () => {
  const digest = "c".repeat(64);
  const mutationView = {
    catalog: { defaultProjectId: "project-a", projects: [{ id: "project-a", kind: "managed", name: "Demo" }] },
    project: { id: "project-a", kind: "managed", name: "Demo" },
  };
  const thumbnailStatusView = {
    cachedSourceHash: null,
    error: null,
    generatedAt: null,
    imageKind: "empty",
    projectId: "project-a",
    sceneName: null,
    sourceHash: null,
    sourcePath: null,
    state: "missing",
  };
  const jsonHeaders = { "content-type": "application/json" };

  function aliasApi() {
    return {
      createManagedProject: vi.fn(async () => mutationView),
      createProject: vi.fn(async () => mutationView),
      generateThumbnail: vi.fn(async () => ({ ...thumbnailStatusView, state: "generating" })),
      importBrowserProject: vi.fn(async () => mutationView),
      projects: vi.fn(async () => ({ defaultProjectId: "project-a", projects: mutationView.catalog.projects })),
      renameProject: vi.fn(async () => mutationView),
      sceneSnapshotAsset: vi.fn(async () => ({
        body: Uint8Array.from([137, 80, 78, 71]),
        digest,
        mediaType: "image/png",
      })),
      start: vi.fn(),
      storageBoundary: { kind: "shared-durable", namespace: "neutral-alias-test" },
      tenantId: "tenant-alias",
      thumbnail: vi.fn(async () => ({
        body: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8"),
        kind: "semantic",
        mediaType: "image/svg+xml; charset=utf-8",
        state: "current",
        status: 200,
      })),
      thumbnailStatus: vi.fn(async () => thumbnailStatusView),
      unregisterProject: vi.fn(async () => ({ ...mutationView, project: null })),
      workspace: vi.fn(async () => ({
        commandAvailable: false,
        frame: { height: 8, width: 14.222 },
        projectId: "project-a",
        projectName: "Demo",
        renderCapability: {
          available: false,
          kind: "durable-sandbox",
          unavailableReason: "durable-render-unavailable",
        },
        sources: [],
      })),
    };
  }

  const VOLATILE_HEADERS = new Set(["date", "x-poietra-request-id"]);
  function comparable(
    response: Readonly<{ body: Buffer; headers: import("node:http").IncomingHttpHeaders; status: number }>,
  ) {
    return {
      body: response.body.toString("base64"),
      headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => !VOLATILE_HEADERS.has(name))),
      status: response.status,
    };
  }

  it("serves every aliased generic surface byte-identically through both route families", async () => {
    const api = aliasApi();
    const server = await listen(api as unknown as ManimApi);
    const port = (server.address() as AddressInfo).port;
    const cases: readonly {
      body?: string;
      handler: () => ReturnType<typeof vi.fn>;
      headers?: Record<string, string>;
      legacy: string;
      method?: string;
      neutral: string;
      status: number;
    }[] = [
      { handler: () => api.projects, legacy: "/api/manim/projects", neutral: "/api/projects", status: 200 },
      {
        body: JSON.stringify({ kind: "managed", name: "Demo" }),
        handler: () => api.createManagedProject,
        headers: jsonHeaders,
        legacy: "/api/manim/projects",
        method: "POST",
        neutral: "/api/projects",
        status: 201,
      },
      {
        body: JSON.stringify({ name: "Renamed" }),
        handler: () => api.renameProject,
        headers: jsonHeaders,
        legacy: "/api/manim/projects/project-a",
        method: "PATCH",
        neutral: "/api/projects/project-a",
        status: 200,
      },
      {
        handler: () => api.unregisterProject,
        headers: jsonHeaders,
        legacy: "/api/manim/projects/project-a",
        method: "DELETE",
        neutral: "/api/projects/project-a",
        status: 200,
      },
      {
        handler: () => api.workspace,
        legacy: "/api/manim/projects/project-a/workspace",
        neutral: "/api/projects/project-a/workspace",
        status: 200,
      },
      {
        handler: () => api.thumbnail,
        legacy: "/api/manim/projects/project-a/thumbnail",
        neutral: "/api/projects/project-a/thumbnail",
        status: 200,
      },
      {
        handler: () => api.thumbnailStatus,
        legacy: "/api/manim/projects/project-a/thumbnail/status",
        neutral: "/api/projects/project-a/thumbnail/status",
        status: 200,
      },
      {
        body: "{}",
        handler: () => api.generateThumbnail,
        headers: jsonHeaders,
        legacy: "/api/manim/projects/project-a/thumbnail/generate",
        method: "POST",
        neutral: "/api/projects/project-a/thumbnail/generate",
        status: 202,
      },
      {
        handler: () => api.sceneSnapshotAsset,
        legacy: `/api/manim/projects/project-a/scene-snapshot-assets/${digest}`,
        neutral: `/api/projects/project-a/scene-snapshot-assets/${digest}`,
        status: 200,
      },
    ];
    try {
      for (const route of cases) {
        const options = { body: route.body, headers: route.headers, method: route.method };
        const handler = route.handler();
        const callsBefore = handler.mock.calls.length;
        const legacyResponse = await send(port, route.legacy, options);
        const neutralResponse = await send(port, route.neutral, options);
        expect(legacyResponse.status, route.legacy).toBe(route.status);
        expect(comparable(neutralResponse), route.neutral).toEqual(comparable(legacyResponse));
        expect(handler.mock.calls.length, route.neutral).toBe(callsBefore + 2);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("propagates handler errors and method rejections byte-identically to both families", async () => {
    const api = {
      projects: vi.fn(async () => {
        throw new Error("Catalog storage failed.");
      }),
      storageBoundary: { kind: "shared-durable", namespace: "neutral-alias-error-test" },
      tenantId: "tenant-alias",
    } as unknown as ManimApi;
    const server = await listen(api);
    const port = (server.address() as AddressInfo).port;
    try {
      const legacyFailure = await send(port, "/api/manim/projects");
      const neutralFailure = await send(port, "/api/projects");
      expect(legacyFailure.status).toBe(500);
      expect(comparable(neutralFailure)).toEqual(comparable(legacyFailure));

      const legacyMethod = await send(port, "/api/manim/projects/project-a/workspace", {
        body: "{}",
        headers: jsonHeaders,
        method: "POST",
      });
      const neutralMethod = await send(port, "/api/projects/project-a/workspace", {
        body: "{}",
        headers: jsonHeaders,
        method: "POST",
      });
      expect(legacyMethod.status).toBe(405);
      expect(comparable(neutralMethod)).toEqual(comparable(legacyMethod));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("does not alias the frozen Manim execution lane onto neutral routes", async () => {
    const api = aliasApi();
    const server = await listen(api as unknown as ManimApi);
    const port = (server.address() as AddressInfo).port;
    const unaliased: readonly (readonly [string, string])[] = [
      ["POST", "/api/projects/project-a/renders"],
      ["POST", "/api/projects/project-a/export"],
      ["GET", "/api/projects/project-a/scene-snapshots"],
      ["POST", "/api/projects/project-a/scene-snapshots"],
      ["POST", "/api/projects/project-a/runtime-traces"],
      ["POST", "/api/renders"],
      ["GET", "/api/renders/00000000-0000-4000-8000-000000000001"],
      ["GET", "/api/renders/00000000-0000-4000-8000-000000000001/video"],
      ["GET", "/api/workspace"],
      ["POST", "/api/project-imports"],
      ["GET", `/api/projects/project-a/scene-snapshot-assets/${"c".repeat(63)}`],
      ["GET", "/api/projects/project-a/thumbnail/refresh"],
    ];
    try {
      for (const [method, path] of unaliased) {
        const response = await send(port, path, {
          ...(method === "POST" ? { body: "{}", headers: jsonHeaders } : {}),
          method,
        });
        expect(response.status, path).toBe(404);
        expect(JSON.parse(response.body.toString("utf8")), path).toEqual({ error: "Manim endpoint not found." });
      }
      expect(api.start).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("canonicalizes exactly the aliased neutral surfaces", () => {
    expect(canonicalManimRoutePathname("/api/projects")).toBe("/api/manim/projects");
    expect(canonicalManimRoutePathname("/api/projects/project-a")).toBe("/api/manim/projects/project-a");
    expect(canonicalManimRoutePathname("/api/projects/project-a/workspace")).toBe(
      "/api/manim/projects/project-a/workspace",
    );
    expect(canonicalManimRoutePathname("/api/projects/project-a/thumbnail")).toBe(
      "/api/manim/projects/project-a/thumbnail",
    );
    expect(canonicalManimRoutePathname(`/api/projects/project-a/scene-snapshot-assets/${digest}`)).toBe(
      `/api/manim/projects/project-a/scene-snapshot-assets/${digest}`,
    );
    expect(canonicalManimRoutePathname("/api/project-imports")).toBe("/api/project-imports");
    // The legacy family and non-aliased paths pass through unchanged.
    expect(canonicalManimRoutePathname("/api/manim/projects")).toBe("/api/manim/projects");
    expect(canonicalManimRoutePathname("/api/manim/renders")).toBe("/api/manim/renders");
    expect(canonicalManimRoutePathname("/api/projects/project-a/renders")).toBe("/api/projects/project-a/renders");
    expect(canonicalManimRoutePathname("/api/projects/project-a/export")).toBe("/api/projects/project-a/export");
    expect(canonicalManimRoutePathname("/api/workspace")).toBe("/api/workspace");
    expect(isNeutralTenantRouteAlias("/api/projects/Bad")).toBe(false);
    expect(isNeutralTenantRouteAlias("/api/projectsx")).toBe(false);
    expect(isNeutralTenantRouteAlias("/api/projects/project-a/thumbnail/generate")).toBe(true);
  });

  it("classifies neutral aliases through the same production admission predicates", () => {
    expect(isManimWorkspaceBootstrapRequest("GET", "/api/projects")).toBe(true);
    expect(isManimWorkspaceBootstrapRequest("GET", "/api/projects/project-a/workspace")).toBe(true);
    expect(isManimWorkspaceBootstrapRequest("GET", "/api/workspace")).toBe(false);
    expect(isManimBrowserProjectImportRequest("POST", "/api/project-imports")).toBe(false);
    expect(isManimBrowserProjectImportRequest("POST", "/api/manim/project-imports")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("POST", "/api/projects")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("PATCH", "/api/projects/project-a")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("DELETE", "/api/projects/project-a")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("GET", "/api/projects/project-a/thumbnail")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("GET", "/api/projects/project-a/thumbnail/status")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("POST", "/api/projects/project-a/thumbnail/generate")).toBe(true);
    expect(isTenantCellStorageLaneManimRequest("GET", `/api/projects/project-a/scene-snapshot-assets/${digest}`)).toBe(
      true,
    );
    expect(isTenantCellStorageLaneManimRequest("GET", "/api/projects")).toBe(false);
    // The render lane is never reachable through a neutral path.
    expect(isManimRenderStartRequest("POST", "/api/projects/project-a/renders")).toBe(false);
    expect(isManimRenderStartRequest("POST", "/api/renders")).toBe(false);
    expect(isManimRenderStartRequest("POST", "/api/manim/projects/project-a/renders")).toBe(true);
    expect(isManimVideoRequest("GET", "/api/renders/00000000-0000-4000-8000-000000000001/video")).toBe(false);
    expect(isManimVideoRequest("GET", "/api/manim/renders/00000000-0000-4000-8000-000000000001/video")).toBe(true);
  });

  it("logs each route family under its own request route template", async () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({ sinks: [{ write: (record) => records.push(record) }] });
    const api = aliasApi();
    const server = await listen(api as unknown as ManimApi, undefined, logger);
    const port = (server.address() as AddressInfo).port;
    try {
      await send(port, "/api/manim/projects");
      await send(port, "/api/projects");
      await send(port, "/api/manim/projects/project-a/workspace");
      await send(port, "/api/projects/project-a/workspace");
      await send(port, "/api/projects/project-a/thumbnail/status");
      const routes = records
        .filter((record) => record.event === "request.started")
        .map((record) => record.context.route);
      expect(routes).toEqual([
        "/api/manim/projects",
        "/api/projects",
        "/api/manim/projects/:projectId/:action",
        "/api/projects/:projectId/workspace",
        "/api/projects/:projectId/thumbnail/:action?",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
