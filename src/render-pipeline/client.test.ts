import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonManimRender,
  cancelManimRenderSourceAction,
  createManimProject,
  exportManimSource,
  exportOriginalManimSource,
  generateManimThumbnail,
  isMissingManimSession,
  isNativeWorkspacePickerCancelled,
  loadManimProjects,
  loadManimRender,
  loadManimThumbnailStatus,
  loadManimWorkspace,
  renameManimProject,
  runManimRenderAction,
  startManimRender,
  unregisterManimProject,
} from "./client";
import {
  MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1,
  MAX_BROWSER_MANIM_SOURCE_BYTES_V1,
  type ProgramRenderRequest,
  RENDER_SESSION_CONTRACT_VERSION_HEADER,
  RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
} from "./contracts";

afterEach(() => vi.unstubAllGlobals());

function session(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    actionInProgress: false,
    canCancel: false,
    canCommit: true,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    error: null,
    failureCode: null,
    id: "render-id",
    logTail: "done",
    patch: {
      anchorLine: 4,
      anchorLines: [4],
      insertedCode: "self.wait(1)",
      patchedSourceHash: "b".repeat(64),
      sourceHash: "a".repeat(64),
    },
    projectId: "default",
    programBatchId: "tx",
    programTransactionId: "tx",
    progress: 1,
    sceneName: "SceneOne",
    sourceAction: null,
    sourcePath: "scene.py",
    renderRequestId: "render-abc-def",
    status: "ready",
    updatedAt: "2026-01-01T00:00:01.000Z",
    videoUrl: "/api/manim/renders/render-id/video",
    ...overrides,
  };
}

function renderRequest(projectId = "project-a"): ProgramRenderRequest {
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
    projectId,
    sceneName: "SceneOne",
    sourceBindings: [{ entityId: "equation", sourceVariable: "equation" }],
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    viewport: { height: 360, width: 640 },
  };
}

describe("Manim API client contracts", () => {
  it("accepts a workspace matching the runtime contract", async () => {
    const workspace = {
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      projectId: "default",
      projectName: "Demo",
      renderCapability: { available: true, kind: "local-command", unavailableReason: null },
      sources: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(workspace), { status: 200 })),
    );

    await expect(loadManimWorkspace()).resolves.toEqual(workspace);
  });

  it("rejects undeclared workspace fields instead of exposing server paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              commandAvailable: true,
              frame: { height: 8, width: 14.222 },
              projectId: "default",
              projectName: "Demo",
              projectRoot: "/private/project",
              renderCapability: { available: true, kind: "local-command", unavailableReason: null },
              sources: [],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(loadManimWorkspace()).rejects.toThrow(/does not match the API contract/i);
  });

  it("rejects contradictory render capability state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              commandAvailable: false,
              frame: { height: 8, width: 14.222 },
              projectId: "default",
              projectName: "Demo",
              renderCapability: {
                available: true,
                kind: "durable-sandbox",
                unavailableReason: "durable-render-unavailable",
              },
              sources: [],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(loadManimWorkspace()).rejects.toThrow(/does not match the API contract/i);
  });

  it("loads only opaque project descriptors", async () => {
    const projects = {
      defaultProjectId: "project-a",
      projects: [{ id: "project-a", kind: "existing", name: "Demo" }],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(projects), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimProjects()).resolves.toEqual(projects);
    expect(fetch).toHaveBeenCalledWith("/api/projects", { signal: undefined });
  });

  it("creates, renames, and unregisters workspaces through opaque project responses", async () => {
    const existingCreated = {
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "existing", name: "Demo" }],
      },
      project: { id: "project-a", kind: "existing", name: "Demo" },
    };
    const managedCreated = {
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "managed", name: "Demo" }],
      },
      project: { id: "project-a", kind: "managed", name: "Demo" },
    };
    const renamed = {
      ...existingCreated,
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "existing", name: "Renamed" }],
      },
      project: { id: "project-a", kind: "existing", name: "Renamed" },
    };
    const removed = { catalog: { defaultProjectId: null, projects: [] }, project: null };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(managedCreated), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(existingCreated), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(renamed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(removed), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createManimProject({ kind: "managed", name: " Demo " })).resolves.toEqual(managedCreated);
    await expect(createManimProject({ kind: "existing", name: " Demo ", root: " /tmp/demo " })).resolves.toEqual(
      existingCreated,
    );
    await expect(renameManimProject("project-a", " Renamed ")).resolves.toEqual(renamed);
    await expect(unregisterManimProject("project-a")).resolves.toEqual(removed);

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/projects", {
      body: JSON.stringify({ kind: "managed", name: "Demo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined,
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/projects", {
      body: JSON.stringify({ kind: "existing", name: "Demo", root: "/tmp/demo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined,
    });
    expect(fetch).toHaveBeenNthCalledWith(3, "/api/projects/project-a", {
      body: JSON.stringify({ name: "Renamed" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
      signal: undefined,
    });
    expect(fetch).toHaveBeenNthCalledWith(4, "/api/projects/project-a", {
      headers: { "content-type": "application/json" },
      method: "DELETE",
      signal: undefined,
    });
  });

  it("imports one bounded browser-selected Python file without sending a host path", async () => {
    const imported = {
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "managed", name: "Imported demo" }],
      },
      project: { id: "project-a", kind: "managed", name: "Imported demo" },
    };
    const source =
      "\ufefffrom manim import *\n\nclass ImportedScene(Scene):\n    def construct(self):\n        self.wait(1)\n";
    const bytes = new TextEncoder().encode(source);
    const fetch = vi.fn(async () => new Response(JSON.stringify(imported), { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      createManimProject({
        file: { arrayBuffer: async () => bytes.slice().buffer, name: "scene.py", size: bytes.byteLength },
        kind: "browser-import",
        name: " Imported demo ",
      }),
    ).resolves.toEqual(imported);

    expect(fetch).toHaveBeenCalledWith("/api/project-imports", {
      body: JSON.stringify({ imagePngBase64: null, name: "Imported demo", source, sourceName: "scene.py" }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined,
    });
  });

  it("encodes one exact optional image.png in canonical base64 without sending a client-owned asset path", async () => {
    const imported = {
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "managed", name: "Imported image" }],
      },
      project: { id: "project-a", kind: "managed", name: "Imported image" },
    };
    const source = "from manim import *\nclass ImportedScene(Scene):\n    pass\n";
    const sourceBytes = new TextEncoder().encode(source);
    const imageBytes = Uint8Array.from({ length: 12 * 1024 + 5 }, (_, index) => index % 251);
    const fetch = vi.fn(async () => new Response(JSON.stringify(imported), { status: 201 }));
    vi.stubGlobal("fetch", fetch);

    await createManimProject({
      file: { arrayBuffer: async () => sourceBytes.slice().buffer, name: "scene.py", size: sourceBytes.byteLength },
      imageFile: {
        arrayBuffer: async () => imageBytes.slice().buffer,
        name: "image.png",
        size: imageBytes.byteLength,
      },
      kind: "browser-import",
      name: "Imported image",
    });

    const request = (fetch.mock.calls as unknown as readonly (readonly [string, RequestInit])[])[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      imagePngBase64: Buffer.from(imageBytes).toString("base64"),
      name: "Imported image",
      source,
      sourceName: "scene.py",
    });
    expect(body).not.toHaveProperty("imageName");
    expect(body).not.toHaveProperty("imagePath");
    expect(body).not.toHaveProperty("objectKey");
  });

  it("rejects oversized browser files before reading or uploading them", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      createManimProject({
        file: { arrayBuffer, name: "scene.py", size: MAX_BROWSER_MANIM_SOURCE_BYTES_V1 + 1 },
        kind: "browser-import",
        name: "Imported demo",
      }),
    ).rejects.toThrow(/non-empty Python file/i);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unstable or non-UTF-8 browser file bytes before upload", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      createManimProject({
        file: { arrayBuffer: async () => new Uint8Array([0x61]).buffer, name: "scene.py", size: 2 },
        kind: "browser-import",
        name: "Changed file",
      }),
    ).rejects.toThrow(/changed while Studio was reading/i);
    await expect(
      createManimProject({
        file: { arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer, name: "scene.py", size: 2 },
        kind: "browser-import",
        name: "Invalid encoding",
      }),
    ).rejects.toThrow(/valid UTF-8/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid image.png metadata or unstable bytes before upload", async () => {
    const source = new TextEncoder().encode("from manim import *\nclass SceneOne(Scene):\n    pass\n");
    const sourceFile = {
      arrayBuffer: vi.fn(async () => source.slice().buffer),
      name: "scene.py",
      size: source.byteLength,
    };
    const wrongNameRead = vi.fn(async () => new Uint8Array([1]).buffer);
    const emptyRead = vi.fn(async () => new ArrayBuffer(0));
    const oversizedRead = vi.fn(async () => new ArrayBuffer(0));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      createManimProject({
        file: sourceFile,
        imageFile: { arrayBuffer: wrongNameRead, name: "diagram.png", size: 1 },
        kind: "browser-import",
        name: "Wrong image name",
      }),
    ).rejects.toThrow(/exact filename image[.]png/i);
    await expect(
      createManimProject({
        file: sourceFile,
        imageFile: { arrayBuffer: emptyRead, name: "image.png", size: 0 },
        kind: "browser-import",
        name: "Empty image",
      }),
    ).rejects.toThrow(/non-empty image[.]png/i);
    await expect(
      createManimProject({
        file: sourceFile,
        imageFile: {
          arrayBuffer: oversizedRead,
          name: "image.png",
          size: MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1 + 1,
        },
        kind: "browser-import",
        name: "Large image",
      }),
    ).rejects.toThrow(/non-empty image[.]png/i);
    await expect(
      createManimProject({
        file: sourceFile,
        imageFile: { arrayBuffer: async () => new Uint8Array([1]).buffer, name: "image.png", size: 2 },
        kind: "browser-import",
        name: "Changed image",
      }),
    ).rejects.toThrow(/image[.]png file changed/i);

    expect(wrongNameRead).not.toHaveBeenCalled();
    expect(emptyRead).not.toHaveBeenCalled();
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("registers a native-picked workspace without exposing its filesystem path", async () => {
    const created = {
      catalog: {
        defaultProjectId: "project-a",
        projects: [{ id: "project-a", kind: "existing", name: "Demo" }],
      },
      project: { id: "project-a", kind: "existing", name: "Demo" },
    };
    const registerExistingWorkspace = vi.fn(async () => ({
      body: created,
      cancelled: false as const,
      status: 201,
    }));
    const fetch = vi.fn();
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace,
        savePythonSource: vi.fn(),
      },
    });
    vi.stubGlobal("fetch", fetch);

    await expect(createManimProject({ kind: "native-existing", name: " Demo " })).resolves.toEqual(created);
    expect(registerExistingWorkspace).toHaveBeenCalledWith("Demo");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves native folder-picker cancellation as a non-HTTP outcome", async () => {
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(async () => ({ cancelled: true as const })),
        savePythonSource: vi.fn(),
      },
    });

    const error = await createManimProject({ kind: "native-existing", name: "Demo" }).catch(
      (caught: unknown) => caught,
    );
    expect(isNativeWorkspacePickerCancelled(error)).toBe(true);
  });

  it("loads a selected project workspace without sending a filesystem path", async () => {
    const workspace = {
      commandAvailable: false,
      frame: { height: 8, width: 14.222 },
      projectId: "project-a",
      projectName: "Demo",
      renderCapability: {
        available: false,
        kind: "local-command",
        unavailableReason: "local-command-unavailable",
      },
      sources: [],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(workspace), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimWorkspace("project-a")).resolves.toEqual(workspace);
    expect(fetch).toHaveBeenCalledWith("/api/projects/project-a/workspace", { signal: undefined });
  });

  it("loads and explicitly generates project-bound thumbnail status", async () => {
    const status = {
      cachedSourceHash: null,
      error: null,
      generatedAt: null,
      imageKind: "semantic",
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      state: "missing",
    };
    const fetch = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === "POST" ? { ...status, state: "generating" } : status), {
          status: init?.method === "POST" ? 202 : 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimThumbnailStatus("project-a")).resolves.toEqual(status);
    await expect(generateManimThumbnail("project-a")).resolves.toMatchObject({ state: "generating" });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/projects/project-a/thumbnail/status", { signal: undefined });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/projects/project-a/thumbnail/generate", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined,
    });
  });

  it.each([
    {
      cachedSourceHash: "a".repeat(64),
      error: null,
      generatedAt: "2026-07-23T10:00:00.000Z",
      imageKind: "semantic",
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      state: "current",
    },
    {
      cachedSourceHash: null,
      error: null,
      generatedAt: null,
      imageKind: "semantic",
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceHash: null,
      sourcePath: "scene.py",
      state: "missing",
    },
    {
      cachedSourceHash: "a".repeat(64),
      error: null,
      generatedAt: "2026-07-23T10:00:00.000Z",
      imageKind: "semantic",
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
      state: "stale",
    },
    {
      cachedSourceHash: null,
      error: null,
      generatedAt: null,
      imageKind: "semantic",
      projectId: "project-a",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "../scene.py",
      state: "missing",
    },
  ])("rejects thumbnail status that violates lifecycle invariants", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
    );
    await expect(loadManimThumbnailStatus("project-a")).rejects.toThrow(/API contract/i);
  });

  it("rejects thumbnail status for another project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              cachedSourceHash: null,
              error: null,
              generatedAt: null,
              imageKind: "empty",
              projectId: "project-b",
              sceneName: null,
              sourceHash: null,
              sourcePath: null,
              state: "missing",
            }),
          ),
      ),
    );

    await expect(loadManimThumbnailStatus("project-a")).rejects.toThrow(/different project/i);
  });

  it("rejects a filesystem path where an opaque project ID is required", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimWorkspace("/private/project")).rejects.toThrow(/project ID.*API contract/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a render session matching the runtime contract", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimRender("render-id")).resolves.toMatchObject({ status: "ready" });
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          session({
            canCommit: false,
            error: "Render exceeded its memory limit.",
            failureCode: "memory-limit",
            status: "failed",
            videoUrl: null,
          }),
        ),
        { status: 200 },
      ),
    );
    await expect(loadManimRender("failed-render")).resolves.toMatchObject({ failureCode: "memory-limit" });
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          session({
            canCommit: false,
            error: "Render exceeded its CPU budget.",
            failureCode: "cpu-limit",
            status: "failed",
            videoUrl: null,
          }),
        ),
        { status: 200 },
      ),
    );
    await expect(loadManimRender("cpu-limited-render")).resolves.toMatchObject({ failureCode: "cpu-limit" });
  });

  it("opts into failure codes while normalizing an old server omission to null", async () => {
    const { failureCode: _failureCode, ...legacySession } = session({
      canCommit: false,
      error: "Render failed.",
      status: "failed",
      videoUrl: null,
    });
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
      });
      return new Response(JSON.stringify(legacySession), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimRender("legacy-render")).resolves.toMatchObject({ failureCode: null, status: "failed" });
  });

  it("rejects a successful response with an invalid runtime shape", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session({ progress: "done" })), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(session({ failureCode: "raw-kernel-message", status: "failed" })), { status: 200 }),
    );
    await expect(loadManimRender("invalid-failure")).rejects.toThrow(/does not match the API contract/i);
  });

  it.each([
    { anchorLine: 4, anchorLines: [5], label: "a primary anchor outside the evidence anchors" },
    { anchorLine: 5, anchorLines: [5, 4], label: "source evidence anchors outside final source order" },
  ])("rejects render and commit responses with $label", async ({ anchorLine, anchorLines }) => {
    const malformedPatch = { ...session().patch, anchorLine, anchorLines };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(session({ patch: malformedPatch })), { status: 200 })),
    );

    await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
    await expect(
      runManimRenderAction("render-id", "commit", undefined, {
        actionId: "00000000-0000-4000-8000-000000000001",
        programBatchId: "batch-1-abc-def",
        projectId: "project-a",
        renderRequestId: "render-request-abc-def",
        sceneName: "SceneOne",
        sourceHash: "a".repeat(64),
        sourcePath: "scene.py",
      }),
    ).rejects.toThrow(/does not match the API contract/i);
  });

  it.each(["https://attacker.example/video.mp4", "/api/manim/renders/another-render/video"])(
    "rejects a render video URL outside its exact authenticated session route: %s",
    async (videoUrl) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(session({ videoUrl })), { status: 200 })),
      );

      await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
    },
  );

  it("rejects a video URL before its render artifact is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              session({
                canCancel: true,
                canCommit: false,
                canDiscard: false,
                progress: 0.5,
                status: "rendering",
              }),
            ),
            { status: 200 },
          ),
      ),
    );

    await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
  });

  it("preserves a missing-session status so the editor can recover", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Render session not found." }), { status: 404 })),
    );

    const error = await loadManimRender("expired").catch((caught: unknown) => caught);
    expect(isMissingManimSession(error)).toBe(true);
    expect(error).toMatchObject({ status: 404 });
  });

  it("reports malformed JSON without masking the HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not-json", { status: 502 })),
    );

    await expect(loadManimRender("render-id")).rejects.toThrow(/502.*malformed JSON/i);
  });

  it("validates render requests before contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(startManimRender({} as ProgramRenderRequest)).rejects.toThrow(/request.*API contract/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [128, true],
    [129, true],
    [240, true],
    [241, false],
  ] as const)("enforces the canonical %i-character Scene-name boundary before fetch", async (length, accepted) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session({ projectId: "project-a" })), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const request = { ...renderRequest(), sceneName: `S${"a".repeat(length - 1)}` };

    if (accepted) {
      await expect(startManimRender(request)).resolves.toMatchObject({ projectId: "project-a" });
      expect(fetch).toHaveBeenCalledOnce();
    } else {
      await expect(startManimRender(request)).rejects.toThrow(/request.*API contract/i);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("starts a render through the request's configured project", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("/api/manim/projects/project-a/renders");
      return new Response(JSON.stringify(session({ projectId: "project-a" })), { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(startManimRender(renderRequest())).resolves.toMatchObject({ projectId: "project-a" });
  });

  it("sends an ordered Program batch and rejects a mismatched compatibility Program", async () => {
    const first = renderRequest();
    const firstOperation = first.program.operations[0]!;
    const secondOperation = { ...firstOperation, id: "tx-2/operation:motion" };
    const second = {
      ...first.program,
      operations: [secondOperation],
      schedule: { ...first.program.schedule, order: [secondOperation.id] },
      transactionId: "tx-2",
    };
    const batch: ProgramRenderRequest = {
      ...first,
      programs: [first.program, second],
    };
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        program: { transactionId: "tx" },
        programs: [{ transactionId: "tx" }, { transactionId: "tx-2" }],
      });
      return new Response(JSON.stringify(session({ projectId: "project-a" })), { status: 202 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(startManimRender(batch)).resolves.toMatchObject({ projectId: "project-a" });
    await expect(startManimRender({ ...batch, program: second })).rejects.toThrow(/request.*API contract/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("downloads a lowered Python export from its bound project", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/projects/project-a/export");
      expect(init.method).toBe("POST");
      return new Response("from manim import *\n", {
        headers: {
          "content-disposition": 'attachment; filename="scene.poietra.py"',
          "content-type": "text/x-python; charset=utf-8",
          "x-poietra-project-id": "project-a",
        },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(exportManimSource(renderRequest())).resolves.toEqual({
      fileName: "scene.poietra.py",
      projectId: "project-a",
      source: "from manim import *\n",
    });
  });

  it("downloads an unchanged Python source when there is no EditProgram", async () => {
    const source = "\ufefffrom manim import *\n";
    const sourceBytes = new TextEncoder().encode(source);
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/projects/project-a/export");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        projectId: "project-a",
        sourceHash: "a".repeat(64),
        sourcePath: "nested/scene.py",
      });
      return new Response(sourceBytes, {
        headers: {
          "content-length": String(sourceBytes.byteLength),
          "content-disposition": 'attachment; filename="scene.py"',
          "content-type": "text/x-python; charset=utf-8",
          "x-poietra-project-id": "project-a",
        },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      exportOriginalManimSource({
        projectId: "project-a",
        sourceHash: "a".repeat(64),
        sourcePath: "nested/scene.py",
      }),
    ).resolves.toEqual({
      fileName: "scene.py",
      projectId: "project-a",
      source,
    });
  });

  it("preserves an AbortError raised while reading an export body", async () => {
    const aborted = new DOMException("The operation was aborted.", "AbortError");
    const response = new Response("from manim import *\n", {
      headers: {
        "content-disposition": 'attachment; filename="scene.py"',
        "content-type": "text/x-python; charset=utf-8",
        "x-poietra-project-id": "project-a",
      },
      status: 200,
    });
    vi.spyOn(response, "arrayBuffer").mockRejectedValue(aborted);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(
      exportOriginalManimSource({
        projectId: "project-a",
        sourceHash: "a".repeat(64),
        sourcePath: "nested/scene.py",
      }),
    ).rejects.toBe(aborted);
  });

  it("encodes render identities and forwards abort signals to mutation requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/renders/render%2Fid/cancel");
      expect(init.body).toBe("{}");
      expect(init.headers).toEqual({
        "content-type": "application/json",
        [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
      });
      expect(init.signal).toBe(controller.signal);
      return new Response(JSON.stringify(session()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(runManimRenderAction("render/id", "cancel", controller.signal)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("sends a correlated Undo action instead of an ambiguous empty mutation", async () => {
    const actionId = "00000000-0000-4000-8000-000000000002";
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/renders/render-id/undo");
      expect(JSON.parse(String(init.body))).toEqual({ actionId });
      return new Response(
        JSON.stringify(
          session({
            canCommit: false,
            canDiscard: true,
            canUndo: false,
            sourceAction: { id: actionId, kind: "undo", outcome: "undone", state: "succeeded" },
            status: "undone",
          }),
        ),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(runManimRenderAction("render-id", "undo", undefined, { actionId })).resolves.toMatchObject({
      sourceAction: { id: actionId, outcome: "undone" },
      status: "undone",
    });
  });

  it("cancels and waits for the exact source action", async () => {
    const actionId = "00000000-0000-4000-8000-000000000003";
    const { failureCode: _failureCode, ...legacySession } = session({
      sourceAction: { id: actionId, kind: "commit", outcome: null, state: "cancelled" },
    });
    const response = {
      action: { id: actionId, kind: "commit", outcome: null, state: "cancelled" },
      session: legacySession,
    };
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/renders/render-id/cancel-source-action");
      expect(JSON.parse(String(init.body))).toEqual({ actionId, kind: "commit" });
      expect(init.headers).toEqual({
        "content-type": "application/json",
        [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
      });
      return new Response(JSON.stringify(response), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(cancelManimRenderSourceAction("render-id", actionId, "commit")).resolves.toEqual({
      ...response,
      session: { ...legacySession, failureCode: null },
    });
  });

  it("abandons only the exact stale render request", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/renders/render-id/abandon");
      expect(JSON.parse(String(init.body))).toEqual({ renderRequestId: "render-request-abc-def" });
      return new Response(JSON.stringify({ abandoned: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(abandonManimRender("render-id", "render-request-abc-def")).resolves.toEqual({ abandoned: true });
  });

  it("correlates Commit with the exact rendered candidate", async () => {
    const expected = {
      actionId: "00000000-0000-4000-8000-000000000001",
      programBatchId: "batch-1-abc-def",
      projectId: "project-a",
      renderRequestId: "render-request-abc-def",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
    };
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual(expected);
      return new Response(
        JSON.stringify(
          session({
            canCommit: false,
            canDiscard: false,
            canUndo: true,
            programBatchId: expected.programBatchId,
            projectId: expected.projectId,
            sourceAction: {
              id: expected.actionId,
              kind: "commit",
              outcome: "committed",
              state: "succeeded",
            },
            status: "committed",
          }),
        ),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(runManimRenderAction("render-id", "commit", undefined, expected)).resolves.toMatchObject({
      programBatchId: expected.programBatchId,
      projectId: expected.projectId,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/manim/renders/render-id/commit",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          [RENDER_SESSION_CONTRACT_VERSION_HEADER]: RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT,
        },
        method: "POST",
      }),
    );
  });

  it("rejects a source-action response without the exact terminal action outcome", async () => {
    const expected = {
      actionId: "00000000-0000-4000-8000-000000000004",
      programBatchId: "batch-1-abc-def",
      projectId: "project-a",
      renderRequestId: "render-request-abc-def",
      sceneName: "SceneOne",
      sourceHash: "a".repeat(64),
      sourcePath: "scene.py",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(session({ projectId: expected.projectId })), { status: 200 })),
    );

    await expect(runManimRenderAction("render-id", "commit", undefined, expected)).rejects.toThrow(
      /did not confirm the exact source action/i,
    );
  });

  it("rejects a cancellation with a semantically invalid action outcome", async () => {
    const actionId = "00000000-0000-4000-8000-000000000005";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              action: { id: actionId, kind: "commit", outcome: null, state: "succeeded" },
              session: session({ sourceAction: null }),
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(cancelManimRenderSourceAction("render-id", actionId, "commit")).rejects.toThrow(
      /does not match the API contract/i,
    );
  });
});
