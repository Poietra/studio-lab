import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProgramRenderRequest } from "./contracts";
import {
  exportManimSource,
  isMissingManimSession,
  loadManimRender,
  loadManimProjects,
  loadManimWorkspace,
  runManimRenderAction,
  startManimRender,
} from "./client";

afterEach(() => vi.unstubAllGlobals());

function session(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    canCancel: false,
    canCommit: true,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    error: null,
    id: "render-id",
    logTail: "done",
    patch: { anchorLine: 4, anchorLines: [4], insertedCode: "self.wait(1)", sourceHash: "a".repeat(64) },
    projectId: "default",
    programBatchId: "tx",
    programTransactionId: "tx",
    progress: 1,
    sceneName: "SceneOne",
    sourcePath: "scene.py",
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
      command: ["manim"],
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      projectId: "default",
      projectName: "Demo",
      sources: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(workspace), { status: 200 })));

    await expect(loadManimWorkspace()).resolves.toEqual(workspace);
  });

  it("rejects undeclared workspace fields instead of exposing server paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      command: ["manim"],
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      projectId: "default",
      projectName: "Demo",
      projectRoot: "/private/project",
      sources: [],
    }), { status: 200 })));

    await expect(loadManimWorkspace()).rejects.toThrow(/does not match the API contract/i);
  });

  it("loads only opaque project descriptors", async () => {
    const projects = {
      defaultProjectId: "project-a",
      projects: [{ id: "project-a", name: "Demo" }],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(projects), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimProjects()).resolves.toEqual(projects);
    expect(fetch).toHaveBeenCalledWith("/api/manim/projects", { signal: undefined });
  });

  it("loads a selected project workspace without sending a filesystem path", async () => {
    const workspace = {
      command: ["manim"],
      commandAvailable: false,
      frame: { height: 8, width: 14.222 },
      projectId: "project-a",
      projectName: "Demo",
      sources: [],
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(workspace), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimWorkspace("project-a")).resolves.toEqual(workspace);
    expect(fetch).toHaveBeenCalledWith("/api/manim/projects/project-a/workspace", { signal: undefined });
  });

  it("rejects a filesystem path where an opaque project ID is required", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(loadManimWorkspace("/private/project")).rejects.toThrow(/project ID.*API contract/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a render session matching the runtime contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(session()), { status: 200 })));

    await expect(loadManimRender("render-id")).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a successful response with an invalid runtime shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(session({ progress: "done" })), { status: 200 })));

    await expect(loadManimRender("render-id")).rejects.toThrow(/does not match the API contract/i);
  });

  it("preserves a missing-session status so the editor can recover", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Render session not found." }),
      { status: 404 },
    )));

    const error = await loadManimRender("expired").catch((caught: unknown) => caught);
    expect(isMissingManimSession(error)).toBe(true);
    expect(error).toMatchObject({ status: 404 });
  });

  it("reports malformed JSON without masking the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 502 })));

    await expect(loadManimRender("render-id")).rejects.toThrow(/502.*malformed JSON/i);
  });

  it("validates render requests before contacting the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(startManimRender({} as ProgramRenderRequest)).rejects.toThrow(/request.*API contract/i);
    expect(fetch).not.toHaveBeenCalled();
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
          "content-disposition": "attachment; filename=\"scene.poietra.py\"",
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

  it("encodes render identities and forwards abort signals to mutation requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/manim/renders/render%2Fid/cancel");
      expect(init.signal).toBe(controller.signal);
      return new Response(JSON.stringify(session()), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(runManimRenderAction("render/id", "cancel", controller.signal)).resolves.toMatchObject({
      status: "ready",
    });
  });
});
